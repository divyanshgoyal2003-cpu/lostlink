
const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const crypto = require("node:crypto");
const { MATCH_SCORE_THRESHOLD } = require("../config/matching");
const { createNotification } = require("../notifications");
const { currentUser, isCurrentReviewer, isCurrentAdmin, canReviewClaim, hasActiveAuthorityMembership } = require("../authorityAccess");

const router = express.Router();

// GET /api/claims
// Return claims the authenticated user is involved in.
// Private verification evidence and reviewer notes are not exposed.
router.get("/", authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const result = await pool.query(
      `
        SELECT
          c.claim_id,
          c.match_id,
          c.claimant_user_id,
          c.claim_status,
          c.submitted_at,
          c.updated_at,
          m.match_status,
          m.total_score,
          lost.report_id AS lost_report_id,
          lost.user_id AS lost_report_owner_id,
          lost.status AS lost_report_status,
          found.report_id AS found_report_id,

          found.user_id AS found_report_owner_id,
          found.recovery_mode AS found_recovery_mode,
          found.authority_id AS found_authority_id,
          found_authority.name AS found_authority_name,
          EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                  WHERE ctr.report_id=found.report_id AND ctr.custody_status='RECEIVED') AS authority_custody_received,
          found.status AS found_report_status,
          conv.conversation_status,
          latest.verification_status AS latest_verification_status,
          handover.handover_status,
          handover.code_expires_at AS handover_code_expires_at,
          CASE
            WHEN c.claimant_user_id = $1 THEN 'CLAIMANT'
            ELSE 'FOUND_REPORT_OWNER'
          END AS current_user_relationship
        FROM claim_requests c
        JOIN match_records m
          ON m.match_id = c.match_id
        JOIN reports lost
          ON lost.report_id = m.lost_report_id
        JOIN reports found
          ON found.report_id = m.found_report_id
        LEFT JOIN authority_destinations found_authority ON found_authority.authority_id = found.authority_id
        LEFT JOIN conversations conv ON conv.claim_id = c.claim_id
        LEFT JOIN LATERAL (
          SELECT verification_status FROM claim_verifications
          WHERE claim_id = c.claim_id
          ORDER BY created_at DESC, verification_id DESC LIMIT 1
        ) latest ON TRUE
        LEFT JOIN handover_records handover ON handover.claim_id = c.claim_id
        WHERE c.claimant_user_id = $1
           OR (found.user_id = $1 AND found.recovery_mode = 'DIRECT')
        ORDER BY c.submitted_at DESC, c.claim_id DESC
      `,
      [userId]
    );

    return res.json({
      count: result.rowCount,
      claims: result.rows,
    });
  } catch (error) {
    console.error("Get claims failed.");

    return res.status(500).json({
      error: "Unable to retrieve claims",
    });
  }
});
// POST /api/claims
// Submit a claim for an eligible match.
router.post("/", authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const matchId = Number(req.body.matchId);

  if (!Number.isSafeInteger(matchId) || matchId <= 0) {
    return res.status(400).json({
      error: "A valid matchId is required",
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Lock the match while checking eligibility and creating the claim.
    const matchResult = await client.query(
      `
        SELECT
          m.match_id,
          m.match_status,
          m.total_score,
          l.report_id AS lost_report_id,
          l.user_id AS lost_report_owner_id,
          l.status AS lost_report_status,
          f.report_id AS found_report_id,
          f.user_id AS found_report_owner_id,
          f.authority_id AS found_authority_id,
          f.recovery_mode AS found_recovery_mode,
          EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                  WHERE ctr.report_id=f.report_id AND ctr.custody_status='RECEIVED') AS custody_received,
          f.status AS found_report_status
        FROM match_records m
        JOIN reports l
          ON l.report_id = m.lost_report_id
        JOIN reports f
          ON f.report_id = m.found_report_id
        WHERE m.match_id = $1
        FOR UPDATE OF m
      `,
      [matchId]
    );

    if (matchResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Match not found",
      });
    }

    const match = matchResult.rows[0];

    // Only the owner of the lost report can claim the found item.
    if (Number(match.lost_report_owner_id) !== userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "Only the owner of the lost report can submit this claim",
      });
    }

    if (Number(match.total_score) < MATCH_SCORE_THRESHOLD) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "This match is below the minimum score for claim submission",
      });
    }

    if (
      match.match_status !== "CANDIDATE" &&
      match.match_status !== "CHAT_ENABLED"
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "This match is not eligible for a new claim",
      });
    }

    if (
      match.lost_report_status !== "OPEN" ||
      match.found_report_status !== "OPEN"
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Both reports must be open to submit a claim",
      });
    }

    if (match.found_recovery_mode === "AUTHORITY" && !match.custody_received) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "The assigned authority must confirm physical receipt before a claim can proceed" });
    }

    // Do not allow the same user to submit a second active claim.
    const existingClaim = await client.query(
      `
        SELECT claim_id
        FROM claim_requests
        WHERE match_id = $1
          AND claimant_user_id = $2
          AND claim_status IN ('SUBMITTED', 'IN_REVIEW', 'APPROVED')
        LIMIT 1
      `,
      [matchId, userId]
    );

    if (existingClaim.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "You already have an active claim for this match",
      });
    }

    const claimResult = await client.query(
      `
        INSERT INTO claim_requests (
          match_id,
          claimant_user_id,
          claim_status
        )
        VALUES ($1, $2, 'SUBMITTED')
        RETURNING
          claim_id,
          match_id,
          claimant_user_id,
          claim_status,
          submitted_at,
          updated_at
      `,
      [matchId, userId]
    );

    await createNotification(client, userId, "CLAIM_SUBMITTED", "CLAIM", claimResult.rows[0].claim_id);
    if (!match.found_authority_id) {
      await createNotification(
        client,
        match.found_report_owner_id,
        "NEW_CLAIM",
        "CLAIM",
        claimResult.rows[0].claim_id
      );
    }
    if (match.found_authority_id) {
      const assignedMembers = await client.query(
        `SELECT DISTINCT am.user_id
         FROM authority_memberships am
         JOIN authority_destinations ad ON ad.authority_id=am.authority_id
         JOIN users u ON u.user_id=am.user_id
         WHERE am.authority_id=$1 AND am.membership_status='ACTIVE'
           AND u.account_status='ACTIVE' AND ad.verification_status='VERIFIED'
           AND ad.destination_status='ACTIVE'
           AND EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                       WHERE ctr.report_id=$2 AND ctr.custody_status='RECEIVED')`,
        [match.found_authority_id, match.found_report_id]
      );
      for (const member of assignedMembers.rows) {
        await createNotification(client, member.user_id, "NEW_AUTHORITY_CLAIM", "CLAIM", claimResult.rows[0].claim_id);
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Claim submitted successfully",
      claim: claimResult.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Claim rollback failed.");
      }
    }
    // Handle duplicate active claims enforced by PostgreSQL.
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You already have an active claim for this match",
      });
    }

    console.error("Submit claim failed.");

    return res.status(500).json({
      error: "Unable to submit claim",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

const REVIEW_DECISIONS = new Set(["IN_REVIEW", "APPROVED", "REJECTED"]);
const VERIFICATION_STATUSES = new Set(["PASSED", "FAILED", "NEEDS_REVIEW"]);
const HANDOVER_CODE_TTL_MINUTES = 15;

function parseClaimId(value) {
  const claimId = Number(value);
  return Number.isSafeInteger(claimId) && claimId > 0 ? claimId : null;
}

function hashHandoverCode(code) {
  // The JWT secret is already required by authentication and keeps a database
  // dump alone from enabling offline guessing of the short handover code.
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(code)
    .digest("hex");
}

function safeHashEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function rollback(client) {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("Claim workflow rollback failed.");
  }
}

// GET /api/claims/review-queue
// Reviewer-only queue. It intentionally omits evidence references and notes.
router.get("/review-queue", authenticateToken, async (req, res) => {
  try {
    const [userIsAdmin, userIsReviewer] = await Promise.all([
      isCurrentAdmin(pool, req.user.userId),
      isCurrentReviewer(pool, req.user.userId),
    ]);
    const authorityMembership = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM authority_memberships am
        JOIN authority_destinations ad ON ad.authority_id = am.authority_id
        JOIN users u ON u.user_id = am.user_id
        WHERE am.user_id = $1 AND am.membership_status = 'ACTIVE'
          AND ad.verification_status = 'VERIFIED' AND ad.destination_status = 'ACTIVE'
          AND u.account_status = 'ACTIVE'
      ) AS allowed
    `, [req.user.userId]);
    if (!userIsAdmin && !userIsReviewer && !authorityMembership.rows[0].allowed) {
      return res.status(403).json({ error: 'You are not authorized to access the claim review queue' });
    }
    const result = await pool.query(`
      SELECT
        c.claim_id,
        c.match_id,
        c.claimant_user_id,
        c.claim_status,
        c.submitted_at,
        c.updated_at,
        m.total_score,
        lost.report_id AS lost_report_id,
        lost.report_time AS lost_report_time,
        lost.location_description AS lost_location_description,
        lost_item.title AS lost_item_title,
        lost_item.category AS lost_item_category,
        lost_item.description AS lost_item_description,
        lost_item.color AS lost_item_color,
        lost_item.attributes_json->>'company' AS lost_item_company,
        lost_item.attributes_json->>'model' AS lost_item_model,
        found.report_id AS found_report_id,
        found.report_time AS found_report_time,
        found.location_description AS found_location_description,
        found_item.title AS found_item_title,
        found_item.category AS found_item_category,
        found_item.description AS found_item_description,
        found_item.color AS found_item_color,
        found_item.attributes_json->>'company' AS found_item_company,
        found_item.attributes_json->>'model' AS found_item_model,
        claimant.name AS claimant_name,
        found_authority.name AS found_authority_name,
        found.recovery_mode AS found_recovery_mode,
        EXISTS (SELECT 1 FROM custody_transfer_requests ctr WHERE ctr.report_id=found.report_id AND ctr.custody_status='RECEIVED') AS authority_custody_received,
        conv.conversation_status,

        latest.verification_status AS latest_verification_status
      FROM claim_requests c
      JOIN match_records m ON m.match_id = c.match_id
      JOIN reports lost ON lost.report_id = m.lost_report_id
      JOIN reports found ON found.report_id = m.found_report_id
      JOIN items lost_item ON lost_item.item_id=lost.item_id
      JOIN items found_item ON found_item.item_id=found.item_id
      JOIN users claimant ON claimant.user_id=c.claimant_user_id
      LEFT JOIN authority_destinations found_authority ON found_authority.authority_id=found.authority_id
      LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
      LEFT JOIN LATERAL (
        SELECT verification_status
        FROM claim_verifications
        WHERE claim_id = c.claim_id
        ORDER BY created_at DESC, verification_id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE c.claim_status IN ('SUBMITTED', 'IN_REVIEW')
        AND ($1::boolean OR (found.authority_id IS NULL AND $2::boolean) OR EXISTS (
          SELECT 1 FROM authority_memberships am
          JOIN authority_destinations ad ON ad.authority_id = am.authority_id
          JOIN users u ON u.user_id = am.user_id
          JOIN custody_transfer_requests ctr ON ctr.report_id = found.report_id
          WHERE am.user_id = $3 AND am.authority_id = found.authority_id
            AND am.membership_status = 'ACTIVE' AND u.account_status = 'ACTIVE'
            AND ad.verification_status = 'VERIFIED' AND ad.destination_status = 'ACTIVE'
            AND ctr.custody_status = 'RECEIVED'
        ))
      ORDER BY c.submitted_at ASC, c.claim_id ASC
      LIMIT 100
      `, [userIsAdmin, userIsReviewer, req.user.userId]);

    return res.json({ count: result.rowCount, claims: result.rows });
  } catch (error) {
    console.error("Get claim review queue failed.");
    return res.status(500).json({ error: "Unable to retrieve claim review queue" });
  }
});

// POST /api/claims/:claimId/conversation/open
// The finder enables direct-recovery chat; an assigned authority member enables authority cases after receipt.
router.post("/:claimId/conversation/open", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) return res.status(400).json({ error: "A valid claimId is required" });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const claimResult = await client.query(
      `SELECT c.claim_status, c.claimant_user_id, f.report_id AS found_report_id,
              f.user_id AS finder_id, f.recovery_mode, f.authority_id,
              EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                      WHERE ctr.report_id=f.report_id AND ctr.custody_status='RECEIVED') AS custody_received
       FROM claim_requests c
       JOIN match_records m ON m.match_id=c.match_id
       JOIN reports f ON f.report_id=m.found_report_id
       WHERE c.claim_id=$1 FOR UPDATE OF c, f`,
      [claimId]
    );
    if (!claimResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = claimResult.rows[0];
    const actor = await client.query("SELECT account_status FROM users WHERE user_id=$1 FOR SHARE", [req.user.userId]);
    const isFinder = claim.recovery_mode === "DIRECT" && Number(claim.finder_id) === req.user.userId;
    const isAssignedAuthority = claim.recovery_mode === "AUTHORITY" && claim.authority_id && claim.custody_received &&
      await hasActiveAuthorityMembership(client, req.user.userId, claim.authority_id, {
        requireCustody: true,
        reportId: claim.found_report_id,
      });
    if (actor.rows[0]?.account_status !== "ACTIVE" || (!isFinder && !isAssignedAuthority)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the finder or the assigned authority after receipt can enable this chat" });
    }
    if (!["SUBMITTED", "IN_REVIEW", "APPROVED"].includes(claim.claim_status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Chat cannot be enabled for an inactive claim" });
    }
    const existing = await client.query(
      "SELECT conversation_status FROM conversations WHERE claim_id=$1 FOR UPDATE",
      [claimId]
    );
    if (existing.rowCount && existing.rows[0].conversation_status !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This claim's conversation is closed" });
    }
    if (!existing.rowCount) {
      await client.query(
        "INSERT INTO conversations (claim_id, conversation_status) VALUES ($1, 'OPEN') ON CONFLICT (claim_id) DO NOTHING",
        [claimId]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
         VALUES ($1, 'CLAIM_CHAT_ENABLED', 'CLAIM', $2, '{}'::jsonb)`,
        [req.user.userId, claimId]
      );
      await createNotification(client, claim.claimant_user_id, "CLAIM_CHAT_ENABLED", "CLAIM", claimId);
    }
    await client.query("COMMIT");
    return res.json({ claimId: String(claimId), conversationStatus: "OPEN" });
  } catch (error) {
    await rollback(client);
    console.error("Enable claim conversation failed.");
    return res.status(500).json({ error: "Unable to enable chat for this claim" });
  } finally {
    client?.release();
  }
});

// GET /api/claims/:claimId/verifications
// Private review notes are available only to staff, assigned authorities, and the direct found-item owner.
router.get("/:claimId/verifications", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) {
    return res.status(400).json({ error: "A valid claimId is required" });
  }

  try {
    if (!(await canReviewClaim(pool, req.user.userId, claimId))) {
      return res.status(403).json({ error: "You are not authorized to review this claim" });
    }
    const result = await pool.query(
      `SELECT verification_id, claim_id, reviewer_user_id, verification_type,
              verification_status, review_notes_private, created_at, reviewed_at
       FROM claim_verifications
       WHERE claim_id = $1
       ORDER BY created_at ASC, verification_id ASC`,
      [claimId]
    );
    return res.json({ count: result.rowCount, verifications: result.rows });
  } catch (error) {
    console.error("Get claim verifications failed.");
    return res.status(500).json({ error: "Unable to retrieve claim verifications" });
  }
});

// POST /api/claims/:claimId/verifications
// Only staff/admin can create private verification records.
router.post("/:claimId/verifications", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  const verificationType = req.body?.verificationType;
  const verificationStatus = req.body?.status;
  const privateNote = req.body?.privateNote;

  if (!claimId) {
    return res.status(400).json({ error: "A valid claimId is required" });
  }
  if (
    typeof verificationType !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,39}$/.test(verificationType)
  ) {
    return res.status(400).json({ error: "A valid verificationType is required" });
  }
  if (!VERIFICATION_STATUSES.has(verificationStatus)) {
    return res.status(400).json({ error: "Invalid verification status" });
  }
  if (
    privateNote != null &&
    (typeof privateNote !== "string" || privateNote.length > 2000)
  ) {
    return res.status(400).json({ error: "privateNote must be 2000 characters or fewer" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const claimResult = await client.query(
      `SELECT c.claim_id, c.claim_status, c.claimant_user_id, m.match_id, m.match_status,
              m.lost_report_id, m.found_report_id,
              lost.status AS lost_status, found.status AS found_status
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports lost ON lost.report_id = m.lost_report_id
       JOIN reports found ON found.report_id = m.found_report_id
      LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, lost, found`,
      [claimId]
    );
    if (claimResult.rowCount === 0) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = claimResult.rows[0];
    if (!(await canReviewClaim(client, req.user.userId, claimId))) {
      await rollback(client);
      return res.status(403).json({ error: "You are not authorized to review this claim" });
    }
    if (!["SUBMITTED", "IN_REVIEW"].includes(claim.claim_status)) {
      await rollback(client);
      return res.status(409).json({ error: "Claim is not open for verification" });
    }
    if (
      !["CANDIDATE", "CHAT_ENABLED", "CLAIM_PENDING"].includes(claim.match_status) ||
      !["OPEN", "CLAIM_PENDING"].includes(claim.lost_status) ||
      !["OPEN", "CLAIM_PENDING"].includes(claim.found_status)
    ) {
      await rollback(client);
      return res.status(409).json({ error: "Match or reports are not available for verification" });
    }

    const inserted = await client.query(
      `INSERT INTO claim_verifications (
         claim_id, reviewer_user_id, verification_type, verification_status,
         review_notes_private, reviewed_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING verification_id, claim_id, verification_type,
         verification_status, created_at, reviewed_at`,
      [claimId, req.user.userId, verificationType, verificationStatus, privateNote ?? null]
    );

    if (claim.claim_status === "SUBMITTED") {
      await client.query(
        `UPDATE claim_requests SET claim_status = 'IN_REVIEW', updated_at = NOW()
         WHERE claim_id = $1 AND claim_status = 'SUBMITTED'
         RETURNING claimant_user_id`,
        [claimId]
      );
      const matchUpdate = await client.query(
        `UPDATE match_records
         SET match_status = 'CLAIM_PENDING'
         WHERE match_id = $1 AND match_status IN ('CANDIDATE', 'CHAT_ENABLED', 'CLAIM_PENDING')`,
        [claim.match_id]
      );
      if (!matchUpdate.rowCount) {
        throw new Error("Match status changed while starting claim review");
      }
      const reportUpdate = await client.query(
        `UPDATE reports
         SET status = 'CLAIM_PENDING'
         WHERE report_id IN ($1, $2) AND status IN ('OPEN', 'CLAIM_PENDING')`,
        [claim.lost_report_id, claim.found_report_id]
      );
      if (reportUpdate.rowCount !== 2) {
        throw new Error("Report statuses changed while starting claim review");
      }
      await createNotification(client, claim.claimant_user_id, "CLAIM_IN_REVIEW", "CLAIM", claimId);
    }

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'CLAIM_VERIFICATION_RECORDED', 'CLAIM', $2, $3::jsonb)`,
      [req.user.userId, claimId, JSON.stringify({ verificationType, verificationStatus })]
    );
    const verificationNotificationType = verificationStatus === "PASSED"
      ? "CLAIM_VERIFICATION_PASSED"
      : verificationStatus === "FAILED" ? "CLAIM_VERIFICATION_FAILED" : "CLAIM_VERIFICATION_UPDATED";
    await createNotification(
      client,
      claim.claimant_user_id,
      verificationNotificationType,
      "CLAIM_VERIFICATION",
      inserted.rows[0].verification_id
    );
    await client.query("COMMIT");

    // Private note and evidence fields are deliberately excluded from the response.
    return res.status(201).json({ verification: inserted.rows[0] });
  } catch (error) {
    await rollback(client);
    console.error("Record claim verification failed.");
    return res.status(500).json({ error: "Unable to record claim verification" });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/claims/:claimId/review
// Moves SUBMITTED -> IN_REVIEW (via verification) -> APPROVED/REJECTED.
router.patch("/:claimId/review", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  const decision = req.body?.decision;
  const privateNote = req.body?.privateNote;
  if (!claimId) {
    return res.status(400).json({ error: "A valid claimId is required" });
  }
  if (!REVIEW_DECISIONS.has(decision)) {
    return res.status(400).json({ error: "Invalid review decision" });
  }
  if (decision === "IN_REVIEW") {
    return res.status(409).json({ error: "Record a verification to move a claim into review" });
  }
  if (
    privateNote != null &&
    (typeof privateNote !== "string" || privateNote.length > 2000)
  ) {
    return res.status(400).json({ error: "privateNote must be 2000 characters or fewer" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT c.claim_id, c.claim_status, c.claimant_user_id, c.match_id,
              m.match_status, m.lost_report_id, m.found_report_id,
              lost.status AS lost_status, found.status AS found_status
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports lost ON lost.report_id = m.lost_report_id
       JOIN reports found ON found.report_id = m.found_report_id
      LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, lost, found`,
      [claimId]
    );
    if (result.rowCount === 0) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = result.rows[0];
    if (!(await canReviewClaim(client, req.user.userId, claimId))) {
      await rollback(client);
      return res.status(403).json({ error: "You are not authorized to review this claim" });
    }
    if (claim.claim_status !== "IN_REVIEW") {
      await rollback(client);
      return res.status(409).json({ error: "Only claims in review can be approved or rejected" });
    }
    if (decision === "APPROVED") {
      const passed = await client.query(
        `SELECT verification_status FROM claim_verifications
         WHERE claim_id = $1
         ORDER BY created_at DESC, verification_id DESC
         LIMIT 1`,
        [claimId]
      );
      if (!passed.rowCount || passed.rows[0].verification_status !== "PASSED") {
        await rollback(client);
        return res.status(409).json({ error: "A passed verification is required for approval" });
      }
      if (!["OPEN", "CLAIM_PENDING"].includes(claim.lost_status) ||
          !["OPEN", "CLAIM_PENDING"].includes(claim.found_status)) {
        await rollback(client);
        return res.status(409).json({ error: "Both reports must remain available for approval" });
      }
    }

    const updated = await client.query(
      `UPDATE claim_requests SET claim_status = $2, updated_at = NOW()
       WHERE claim_id = $1 AND claim_status = 'IN_REVIEW'
       RETURNING claim_id, match_id, claimant_user_id, claim_status, updated_at`,
      [claimId, decision]
    );
    if (!updated.rowCount) {
      await rollback(client);
      return res.status(409).json({ error: "Claim status changed; reload and try again" });
    }

    if (decision === "REJECTED") await client.query("UPDATE conversations SET conversation_status='CLOSED' WHERE claim_id=$1 AND conversation_status='OPEN'", [claimId]);
    const matchStatus = decision === "APPROVED" ? "CLAIM_PENDING" : "REJECTED";
    const matchUpdate = await client.query(
      `UPDATE match_records SET match_status = $2
       WHERE match_id = $1 AND match_status = 'CLAIM_PENDING'`,
      [claim.match_id, matchStatus]
    );
    if (!matchUpdate.rowCount) {
      throw new Error("Match status changed while finalizing claim review");
    }
    if (decision === "REJECTED") {
      const reportsUpdate = await client.query(
        `UPDATE reports SET status = 'OPEN'
         WHERE report_id IN ($1, $2) AND status = 'CLAIM_PENDING'`,
        [claim.lost_report_id, claim.found_report_id]
      );
      if (reportsUpdate.rowCount !== 2) {
        throw new Error("Report statuses changed while rejecting claim");
      }
    }

    await client.query(
      `INSERT INTO claim_verifications (
         claim_id, reviewer_user_id, verification_type, verification_status,
         review_notes_private, reviewed_at
       ) VALUES ($1, $2, 'CLAIM_REVIEW', $3, $4, NOW())`,
      [claimId, req.user.userId, decision === "APPROVED" ? "PASSED" : "FAILED", privateNote ?? null]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'CLAIM', $3, $4::jsonb)`,
      [req.user.userId, `CLAIM_${decision}`, claimId, JSON.stringify({ previousStatus: claim.claim_status })]
    );
    await createNotification(
      client,
      claim.claimant_user_id,
      decision === "APPROVED" ? "CLAIM_APPROVED" : "CLAIM_REJECTED",
      "CLAIM",
      claimId
    );
    await client.query("COMMIT");
    return res.json({ claim: updated.rows[0], matchStatus });
  } catch (error) {
    await rollback(client);
    console.error("Review claim failed.");
    return res.status(500).json({ error: "Unable to review claim" });
  } finally {
    if (client) client.release();
  }
});

// POST /api/claims/:claimId/handover/code
// The claimant retrieves a one-time code after approval and presents it to the item holder.
router.post("/:claimId/handover/code", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) {
    return res.status(400).json({ error: "A valid claimId is required" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT c.claim_id, c.claim_status, c.claimant_user_id, m.found_report_id, f.user_id AS found_owner_id,
              f.authority_id, f.recovery_mode,
              EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                      WHERE ctr.report_id = f.report_id AND ctr.custody_status = 'RECEIVED') AS custody_received
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports f ON f.report_id = m.found_report_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, f`,
      [claimId]
    );
    if (!result.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = result.rows[0];
    const actor = await currentUser(client, req.user.userId);
    if (!actor || actor.account_status !== "ACTIVE") {
      await rollback(client);
      return res.status(403).json({ error: "An active account is required to retrieve a handover code" });
    }
    if (Number(claim.claimant_user_id) !== req.user.userId) {
      await rollback(client);
      return res.status(403).json({ error: "Only the claimant can retrieve the handover code" });
    }
    if (claim.claim_status !== "APPROVED") {
      await rollback(client);
      return res.status(409).json({ error: "Only approved claims can begin handover" });
    }

    const existing = await client.query(
      `SELECT handover_id, handover_status, code_expires_at
       FROM handover_records WHERE claim_id = $1 FOR UPDATE`,
      [claimId]
    );
    if (existing.rowCount && existing.rows[0].handover_status === "COMPLETED") {
      await rollback(client);
      return res.status(409).json({ error: "Handover is already complete" });
    }
    if (
      existing.rowCount &&
      existing.rows[0].handover_status === "CODE_ISSUED" &&
      new Date(existing.rows[0].code_expires_at).getTime() > Date.now()
    ) {
      await rollback(client);
      return res.status(409).json({ error: "An active handover code already exists" });
    }

    const code = String(crypto.randomInt(0, 100000000)).padStart(8, "0");
    const codeHash = hashHandoverCode(code);
    if (existing.rowCount) {
      await client.query(
        `UPDATE handover_records
         SET handover_status = 'CODE_ISSUED', code_hash = $2,
             code_expires_at = NOW() + ($3 * INTERVAL '1 minute'),
             code_used_at = NULL, completed_at = NULL, verified_by_user_id = NULL
         WHERE handover_id = $1`,
        [existing.rows[0].handover_id, codeHash, HANDOVER_CODE_TTL_MINUTES]
      );
    } else {
      await client.query(
        `INSERT INTO handover_records (claim_id, handover_status, code_hash, code_expires_at)
         VALUES ($1, 'CODE_ISSUED', $2, NOW() + ($3 * INTERVAL '1 minute'))`,
        [claimId, codeHash, HANDOVER_CODE_TTL_MINUTES]
      );
    }
    const handoverAudit = await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'HANDOVER_CODE_ISSUED', 'CLAIM', $2, $3::jsonb)
       RETURNING audit_id`,
      [req.user.userId, claimId, JSON.stringify({ expiresInMinutes: HANDOVER_CODE_TTL_MINUTES })]
    );
    const handoverRecipients = claim.recovery_mode === "AUTHORITY"
      ? await client.query(
        `SELECT DISTINCT am.user_id
         FROM authority_memberships am
         JOIN authority_destinations ad ON ad.authority_id=am.authority_id
         JOIN users u ON u.user_id=am.user_id
         WHERE am.authority_id=$1 AND am.membership_status='ACTIVE'
           AND u.account_status='ACTIVE' AND ad.verification_status='VERIFIED'
           AND ad.destination_status='ACTIVE'
           AND EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                       WHERE ctr.report_id=$2 AND ctr.custody_status='RECEIVED')`,
        [claim.authority_id, claim.found_report_id]
      )
      : { rows: [{ user_id: claim.found_owner_id }] };
    for (const recipient of handoverRecipients.rows) {
      await createNotification(
        client,
        recipient.user_id,
        "HANDOVER_CODE_READY",
        "HANDOVER_CODE",
        handoverAudit.rows[0].audit_id
      );
    }
    await client.query("COMMIT");
    return res.status(existing.rowCount ? 200 : 201).json({
      message: "Handover code retrieved; show it only to the person completing the return",
      code,
      expiresInMinutes: HANDOVER_CODE_TTL_MINUTES,
    });
  } catch (error) {
    await rollback(client);
    console.error("Issue handover code failed.");
    return res.status(500).json({ error: "Unable to issue handover code" });
  } finally {
    if (client) client.release();
  }
});

// POST /api/claims/:claimId/handover/confirm
// The responsible finder or assigned authority confirms safe handover. The hash comparison and all status changes
// happen under row locks in one transaction to prevent replay or race wins.
router.post("/:claimId/handover/confirm", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  const code = req.body?.code;
  if (!claimId) {
    return res.status(400).json({ error: "A valid claimId is required" });
  }
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) {
    return res.status(400).json({ error: "A valid 8-digit handover code is required" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT c.claim_id, c.claim_status, c.claimant_user_id, c.match_id,
              m.lost_report_id, m.found_report_id, found.user_id AS found_report_owner_id,
              found.authority_id, found.recovery_mode,
              EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                      WHERE ctr.report_id = found.report_id AND ctr.custody_status = 'RECEIVED') AS custody_received,
              h.handover_id, h.handover_status, h.code_hash,
              h.code_expires_at, h.code_used_at
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports found ON found.report_id = m.found_report_id
      LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
       LEFT JOIN handover_records h ON h.claim_id = c.claim_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, found`,
      [claimId]
    );
    if (!result.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = result.rows[0];
    const actor = await currentUser(client, req.user.userId);
    const finderCanConfirm = actor?.account_status === "ACTIVE" && claim.recovery_mode === "DIRECT" && Number(claim.found_report_owner_id) === req.user.userId;
    const authorityCanConfirm = claim.recovery_mode === "AUTHORITY" && claim.custody_received &&
      await hasActiveAuthorityMembership(client, req.user.userId, claim.authority_id, {
        requireCustody: true,
        reportId: claim.found_report_id,
      });
    if (!finderCanConfirm && !authorityCanConfirm) {
      await rollback(client);
      return res.status(403).json({ error: "Only the responsible finder or assigned authority can confirm handover" });
    }
    if (claim.claim_status !== "APPROVED" || claim.handover_status !== "CODE_ISSUED" || claim.code_used_at) {
      await rollback(client);
      return res.status(409).json({ error: "No active handover code is available" });
    }
    if (!claim.code_expires_at || new Date(claim.code_expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE handover_records SET handover_status = 'EXPIRED'
         WHERE handover_id = $1 AND handover_status = 'CODE_ISSUED'`,
        [claim.handover_id]
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
         VALUES ($1, 'HANDOVER_CODE_EXPIRED', 'CLAIM', $2, '{}'::jsonb)`,
        [req.user.userId, claimId]
      );
      await client.query("COMMIT");
      return res.status(410).json({ error: "Handover code has expired" });
    }
    const attempts = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM audit_logs
       WHERE actor_user_id = $1 AND entity_type = 'CLAIM'
         AND entity_id = $2 AND action_type = 'HANDOVER_CODE_REJECTED'
         AND created_at > NOW() - INTERVAL '15 minutes'`,
      [req.user.userId, claimId]
    );
    if (attempts.rows[0].count >= 5) {
      await rollback(client);
      return res.status(429).json({ error: "Too many invalid handover code attempts" });
    }
    if (!safeHashEquals(claim.code_hash, hashHandoverCode(code))) {
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
         VALUES ($1, 'HANDOVER_CODE_REJECTED', 'CLAIM', $2, '{}'::jsonb)`,
        [req.user.userId, claimId]
      );
      await client.query("COMMIT");
      return res.status(400).json({ error: "Invalid handover code" });
    }

    const handover = await client.query(
      `UPDATE handover_records
       SET handover_status = 'COMPLETED', code_used_at = NOW(),
           completed_at = NOW(), verified_by_user_id = $2
       WHERE handover_id = $1 AND handover_status = 'CODE_ISSUED'
         AND code_used_at IS NULL AND code_expires_at > NOW()
       RETURNING handover_id, handover_status, completed_at`,
      [claim.handover_id, req.user.userId]
    );
    if (!handover.rowCount) {
      await rollback(client);
      return res.status(409).json({ error: "Handover code is no longer active" });
    }

    const claimUpdate = await client.query(
      `UPDATE claim_requests SET claim_status = 'COMPLETED', updated_at = NOW()
       WHERE claim_id = $1 AND claim_status = 'APPROVED'`,
      [claimId]
    );
    const matchUpdate = await client.query(
      `UPDATE match_records SET match_status = 'RETURNED'
       WHERE match_id = $1 AND match_status = 'CLAIM_PENDING'`,
      [claim.match_id]
    );
    const reportsUpdate = await client.query(
      `UPDATE reports SET status = 'RETURNED'
       WHERE report_id IN ($1, $2) AND status = 'CLAIM_PENDING'`,
      [claim.lost_report_id, claim.found_report_id]
    );
    if (!claimUpdate.rowCount || !matchUpdate.rowCount || reportsUpdate.rowCount !== 2) {
      throw new Error("Related statuses changed while completing handover");
    }
    await client.query("UPDATE conversations SET conversation_status='CLOSED' WHERE claim_id=$1 AND conversation_status='OPEN'", [claimId]);
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'HANDOVER_COMPLETED', 'CLAIM', $2, '{}'::jsonb)`,
      [req.user.userId, claimId]
    );
    await createNotification(client, claim.claimant_user_id, "HANDOVER_COMPLETED", "CLAIM", claimId);
    await createNotification(client, claim.found_report_owner_id, "HANDOVER_COMPLETED", "CLAIM", claimId);
    await client.query("COMMIT");
    return res.json({ handover: handover.rows[0], claimStatus: "COMPLETED" });
  } catch (error) {
    await rollback(client);
    console.error("Confirm handover failed.");
    return res.status(500).json({ error: "Unable to confirm handover" });
  } finally {
    if (client) client.release();
  }
});

// GET /api/claims/:claimId/photos
// Returns private/shared state and metadata to the claimant, finder, or reviewer.
router.get("/:claimId/photos", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) return res.status(400).json({ error: "A valid claimId is required" });
  try {
    const claimResult = await pool.query(
      `SELECT c.claimant_user_id, c.claim_status, m.found_report_id, f.item_id, f.authority_id,
              f.user_id AS finder_id, conv.conversation_status,
              share.granted_by_user_id, share.granted_at, share.revoked_at
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports f ON f.report_id = m.found_report_id AND f.report_type = 'FOUND'
       LEFT JOIN conversations conv ON conv.claim_id = c.claim_id
       LEFT JOIN LATERAL (
         SELECT granted_by_user_id, granted_at, revoked_at
         FROM claim_photo_shares WHERE claim_id = c.claim_id AND revoked_at IS NULL
         ORDER BY granted_at DESC LIMIT 1
       ) share ON TRUE
       WHERE c.claim_id = $1`,
      [claimId]
    );
    if (!claimResult.rowCount) return res.status(404).json({ error: "Claim not found" });
    const claim = claimResult.rows[0];
    const isFinder = Number(claim.finder_id) === req.user.userId;
    const isClaimant = Number(claim.claimant_user_id) === req.user.userId;
    const canReview = await canReviewClaim(pool, req.user.userId, claimId);
    const currentUser = await pool.query("SELECT role FROM users WHERE user_id=$1 AND account_status='ACTIVE'", [req.user.userId]);
    const isGlobalReviewer = canReview && (currentUser.rows[0]?.role === 'ADMIN' || (currentUser.rows[0]?.role === 'STAFF' && !claim.authority_id));
    const isAuthorityReviewer = canReview && !isGlobalReviewer;
    if (!isFinder && !isClaimant && !canReview) {
      return res.status(403).json({ error: "You are not authorized to view this claim's photo state" });
    }
    const shared = claim.revoked_at == null && claim.granted_at != null;
    const canViewPhotos = isFinder || (isClaimant && shared) ||
      (isGlobalReviewer && claim.conversation_status === "OPEN") ||
      (isAuthorityReviewer && shared && claim.conversation_status === "OPEN");
    const photosResult = canViewPhotos
      ? await pool.query(
        `SELECT p.photo_id, p.photo_type, p.uploaded_at
         FROM item_photos p JOIN reports f ON f.item_id = p.item_id
         WHERE f.report_id = $1 ORDER BY p.photo_type, p.photo_id`,
        [claim.found_report_id]
      )
      : { rows: [] };
    const requiredViews = await pool.query(
      `SELECT COUNT(DISTINCT photo_type)::int AS count
       FROM item_photos WHERE item_id = $1 AND photo_type IN ('FRONT', 'BACK', 'SIDE')`,
      [claim.item_id]
    );
    return res.json({
      sharingStatus: shared ? "SHARED" : "PRIVATE",
      conversationOpen: claim.conversation_status === "OPEN",
      requiredViewsComplete: requiredViews.rows[0].count === 3,
      canManage: isFinder || canReview,
      canGrant: claim.conversation_status === "OPEN" && (isFinder || canReview) && requiredViews.rows[0].count === 3,
      canRevoke: shared && (Number(claim.granted_by_user_id) === req.user.userId || canReview),
      photos: photosResult.rows.map((row) => ({
        photoId: String(row.photo_id), photoType: row.photo_type, uploadedAt: row.uploaded_at,
      })),
    });
  } catch (error) {
    console.error("Get claim photo access failed.");
    return res.status(500).json({ error: "Unable to retrieve claim photo access" });
  }
});

// POST /api/claims/:claimId/photo-sharing
// Explicit, claim-specific grant; an OPEN conversation is required.
router.post("/:claimId/photo-sharing", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) return res.status(400).json({ error: "A valid claimId is required" });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT c.claim_status, f.user_id AS finder_id, f.item_id, f.authority_id, conv.conversation_status
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports f ON f.report_id = m.found_report_id AND f.report_type = 'FOUND'
       LEFT JOIN conversations conv ON conv.claim_id = c.claim_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, f`,
      [claimId]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = result.rows[0];
    if (Number(claim.finder_id) !== req.user.userId && !(await canReviewClaim(client, req.user.userId, claimId))) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the found-item owner or staff/admin may share photos" });
    }
    if (claim.conversation_status !== "OPEN" || !["SUBMITTED", "IN_REVIEW", "APPROVED"].includes(claim.claim_status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Photo sharing requires an open conversation for an active claim" });
    }
    const requiredViews = await client.query(
      `SELECT COUNT(DISTINCT photo_type)::int AS count
       FROM item_photos WHERE item_id = $1 AND photo_type IN ('FRONT', 'BACK', 'SIDE')`,
      [claim.item_id]
    );
    if (requiredViews.rows[0].count !== 3) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Front, Back, and Side photos are required before sharing" });
    }
    const active = await client.query(
      `SELECT photo_share_id FROM claim_photo_shares
       WHERE claim_id = $1 AND revoked_at IS NULL FOR UPDATE`,
      [claimId]
    );
    if (active.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Photos are already shared for this claim" });
    }
    const grant = await client.query(
      `INSERT INTO claim_photo_shares (claim_id, granted_by_user_id)
       VALUES ($1, $2) RETURNING photo_share_id, granted_at`,
      [claimId, req.user.userId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'CLAIM_PHOTOS_SHARED', 'CLAIM', $2, $3::jsonb)`,
      [req.user.userId, claimId, JSON.stringify({ photoShareId: grant.rows[0].photo_share_id })]
    );
    await client.query("COMMIT");
    return res.status(201).json({ sharingStatus: "SHARED", grantedAt: grant.rows[0].granted_at });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* retain original error */ }
    }
    console.error("Grant claim photo access failed.");
    return res.status(error.code === "23505" ? 409 : 500).json({ error: error.code === "23505" ? "Photos are already shared for this claim" : "Unable to share claim photos" });
  } finally {
    if (client) client.release();
  }
});

// DELETE /api/claims/:claimId/photo-sharing
// Original grantor or STAFF/ADMIN may revoke; revocation is effective immediately.
router.delete("/:claimId/photo-sharing", authenticateToken, async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) return res.status(400).json({ error: "A valid claimId is required" });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const grant = await client.query(
      `SELECT s.photo_share_id, s.granted_by_user_id, f.user_id AS finder_id
       FROM claim_photo_shares s
       JOIN claim_requests c ON c.claim_id = s.claim_id
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports f ON f.report_id = m.found_report_id AND f.report_type = 'FOUND'
       WHERE s.claim_id = $1 AND s.revoked_at IS NULL
       FOR UPDATE OF s`,
      [claimId]
    );
    if (!grant.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Active photo share not found" });
    }
    if (
      Number(grant.rows[0].granted_by_user_id) !== req.user.userId &&
      Number(grant.rows[0].finder_id) !== req.user.userId &&
      !(await canReviewClaim(client, req.user.userId, claimId))
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the grantor or staff/admin may revoke photo access" });
    }
    await client.query(
      `UPDATE claim_photo_shares SET revoked_at = NOW(), revoked_by_user_id = $2
       WHERE photo_share_id = $1`,
      [grant.rows[0].photo_share_id, req.user.userId]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'CLAIM_PHOTOS_REVOKED', 'CLAIM', $2, $3::jsonb)`,
      [req.user.userId, claimId, JSON.stringify({ photoShareId: grant.rows[0].photo_share_id })]
    );
    await client.query("COMMIT");
    return res.json({ sharingStatus: "PRIVATE" });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* retain original error */ }
    }
    console.error("Revoke claim photo access failed.");
    return res.status(500).json({ error: "Unable to revoke claim photo access" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
