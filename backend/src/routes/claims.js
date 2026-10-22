
const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const crypto = require("node:crypto");
const { MATCH_SCORE_THRESHOLD } = require("../config/matching");

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
          found.status AS found_report_status,
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
        WHERE c.claimant_user_id = $1
           OR found.user_id = $1
        ORDER BY c.submitted_at DESC, c.claim_id DESC
      `,
      [userId]
    );

    return res.json({
      count: result.rowCount,
      claims: result.rows,
    });
  } catch (error) {
    console.error("Get claims failed:", error.message);

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
        console.error("Claim rollback failed:", rollbackError.message);
      }
    }
    // Handle duplicate active claims enforced by PostgreSQL.
    if (error.code === "23505") {
      return res.status(409).json({
        error: "You already have an active claim for this match",
      });
    }

    console.error("Submit claim failed:", error.message);

    return res.status(500).json({
      error: "Unable to submit claim",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

const REVIEW_ROLES = new Set(["STAFF", "ADMIN"]);
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

function isReviewer(req, res) {
  if (REVIEW_ROLES.has(req.user.role)) return true;
  res.status(403).json({ error: "A staff or admin role is required" });
  return false;
}

async function rollback(client) {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("Claim workflow rollback failed:", error.message);
  }
}

// GET /api/claims/review-queue
// Reviewer-only queue. It intentionally omits evidence references and notes.
router.get("/review-queue", authenticateToken, async (req, res) => {
  if (!isReviewer(req, res)) return;

  try {
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
        found.report_id AS found_report_id,
        latest.verification_status AS latest_verification_status
      FROM claim_requests c
      JOIN match_records m ON m.match_id = c.match_id
      JOIN reports lost ON lost.report_id = m.lost_report_id
      JOIN reports found ON found.report_id = m.found_report_id
      LEFT JOIN LATERAL (
        SELECT verification_status
        FROM claim_verifications
        WHERE claim_id = c.claim_id
        ORDER BY created_at DESC, verification_id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE c.claim_status IN ('SUBMITTED', 'IN_REVIEW')
      ORDER BY c.submitted_at ASC, c.claim_id ASC
      LIMIT 100
    `);

    return res.json({ count: result.rowCount, claims: result.rows });
  } catch (error) {
    console.error("Get claim review queue failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve claim review queue" });
  }
});

// GET /api/claims/:claimId/verifications
// Private review notes are available only to staff/admin reviewers.
router.get("/:claimId/verifications", authenticateToken, async (req, res) => {
  if (!isReviewer(req, res)) return;
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) {
    return res.status(400).json({ error: "A valid claimId is required" });
  }

  try {
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
    console.error("Get claim verifications failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve claim verifications" });
  }
});

// POST /api/claims/:claimId/verifications
// Only staff/admin can create private verification records.
router.post("/:claimId/verifications", authenticateToken, async (req, res) => {
  if (!isReviewer(req, res)) return;

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
      `SELECT c.claim_id, c.claim_status, m.match_id, m.match_status,
              m.lost_report_id, m.found_report_id,
              lost.status AS lost_status, found.status AS found_status
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports lost ON lost.report_id = m.lost_report_id
       JOIN reports found ON found.report_id = m.found_report_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, lost, found`,
      [claimId]
    );
    if (claimResult.rowCount === 0) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = claimResult.rows[0];
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
         WHERE claim_id = $1 AND claim_status = 'SUBMITTED'`,
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
    }

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'CLAIM_VERIFICATION_RECORDED', 'CLAIM', $2, $3::jsonb)`,
      [req.user.userId, claimId, JSON.stringify({ verificationType, verificationStatus })]
    );
    await client.query("COMMIT");

    // Private note and evidence fields are deliberately excluded from the response.
    return res.status(201).json({ verification: inserted.rows[0] });
  } catch (error) {
    await rollback(client);
    console.error("Record claim verification failed:", error.message);
    return res.status(500).json({ error: "Unable to record claim verification" });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/claims/:claimId/review
// Moves SUBMITTED -> IN_REVIEW (via verification) -> APPROVED/REJECTED.
router.patch("/:claimId/review", authenticateToken, async (req, res) => {
  if (!isReviewer(req, res)) return;

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
      `SELECT c.claim_id, c.claim_status, c.match_id,
              m.match_status, m.lost_report_id, m.found_report_id,
              lost.status AS lost_status, found.status AS found_status
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       JOIN reports lost ON lost.report_id = m.lost_report_id
       JOIN reports found ON found.report_id = m.found_report_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m, lost, found`,
      [claimId]
    );
    if (result.rowCount === 0) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = result.rows[0];
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
    await client.query("COMMIT");
    return res.json({ claim: updated.rows[0], matchStatus });
  } catch (error) {
    await rollback(client);
    console.error("Review claim failed:", error.message);
    return res.status(500).json({ error: "Unable to review claim" });
  } finally {
    if (client) client.release();
  }
});

// POST /api/claims/:claimId/handover/code
// The found-report owner issues a one-time code for an approved claim.
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
      `SELECT c.claim_id, c.claim_status, m.found_report_id, f.user_id AS found_owner_id
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
    if (Number(claim.found_owner_id) !== req.user.userId) {
      await rollback(client);
      return res.status(403).json({ error: "Only the found-report owner can issue a handover code" });
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
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'HANDOVER_CODE_ISSUED', 'CLAIM', $2, $3::jsonb)`,
      [req.user.userId, claimId, JSON.stringify({ expiresInMinutes: HANDOVER_CODE_TTL_MINUTES })]
    );
    await client.query("COMMIT");
    return res.status(existing.rowCount ? 200 : 201).json({
      message: "Handover code issued; share it only with the claimant",
      code,
      expiresInMinutes: HANDOVER_CODE_TTL_MINUTES,
    });
  } catch (error) {
    await rollback(client);
    console.error("Issue handover code failed:", error.message);
    return res.status(500).json({ error: "Unable to issue handover code" });
  } finally {
    if (client) client.release();
  }
});

// POST /api/claims/:claimId/handover/confirm
// The claimant confirms receipt. The hash comparison and all status changes
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
              m.lost_report_id, m.found_report_id,
              h.handover_id, h.handover_status, h.code_hash,
              h.code_expires_at, h.code_used_at
       FROM claim_requests c
       JOIN match_records m ON m.match_id = c.match_id
       LEFT JOIN handover_records h ON h.claim_id = c.claim_id
       WHERE c.claim_id = $1
       FOR UPDATE OF c, m`,
      [claimId]
    );
    if (!result.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Claim not found" });
    }
    const claim = result.rows[0];
    if (Number(claim.claimant_user_id) !== req.user.userId) {
      await rollback(client);
      return res.status(403).json({ error: "Only the claimant can confirm handover" });
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
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, 'HANDOVER_COMPLETED', 'CLAIM', $2, '{}'::jsonb)`,
      [req.user.userId, claimId]
    );
    await client.query("COMMIT");
    return res.json({ handover: handover.rows[0], claimStatus: "COMPLETED" });
  } catch (error) {
    await rollback(client);
    console.error("Confirm handover failed:", error.message);
    return res.status(500).json({ error: "Unable to confirm handover" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
