
const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");

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
module.exports = router;
