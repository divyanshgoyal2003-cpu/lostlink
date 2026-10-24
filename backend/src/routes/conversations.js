const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const { createNotification } = require("../notifications");
const { currentUser } = require("../authorityAccess");

const router = express.Router();
router.use(authenticateToken);

function parseClaimId(value) {
  return /^[1-9]\d*$/.test(String(value || "")) ? String(value) : null;
}

async function loadContext(client, claimId, userId, lock = false) {
  const result = await client.query(
    `SELECT c.claim_id, c.claim_status, c.claimant_user_id,
            conv.conversation_id, conv.conversation_status,
            f.user_id AS finder_id, f.recovery_mode, f.authority_id,
            EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                    WHERE ctr.report_id=f.report_id AND ctr.custody_status='RECEIVED') AS custody_received
     FROM claim_requests c
     JOIN match_records m ON m.match_id=c.match_id
     JOIN reports f ON f.report_id=m.found_report_id
     LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
     WHERE c.claim_id=$1${lock ? " FOR UPDATE OF c, m, f" : ""}`,
    [claimId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (!row.conversation_id || row.conversation_status !== "OPEN" ||
      !["SUBMITTED", "IN_REVIEW", "APPROVED"].includes(row.claim_status)) return null;
  const user = await currentUser(client, userId);
  if (!user || user.account_status !== "ACTIVE") return null;
  if (Number(row.claimant_user_id) === Number(userId)) return { row, side: "CLAIMANT" };
  if (row.recovery_mode === "DIRECT" && Number(row.finder_id) === Number(userId)) {
    return { row, side: "FINDER" };
  }
  if (row.recovery_mode === "AUTHORITY" && row.custody_received && row.authority_id) {
    const membership = await client.query(
      `SELECT am.membership_id
       FROM authority_memberships am
       JOIN authority_destinations ad ON ad.authority_id=am.authority_id
       JOIN users u ON u.user_id=am.user_id
       WHERE am.user_id=$1 AND am.authority_id=$2 AND am.membership_status='ACTIVE'
         AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
         AND u.account_status='ACTIVE'
       FOR SHARE OF am, ad, u`,
      [userId, row.authority_id]
    );
    if (membership.rowCount) return { row, side: "AUTHORITY" };
  }
  return null;
}

router.get("/claims/:claimId", async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  if (!claimId) return res.status(400).json({ error: "Invalid claim ID" });
  try {
    const context = await loadContext(pool, claimId, req.user.userId);
    if (!context) return res.status(403).json({ error: "Conversation is not available to this account" });
    const messages = await pool.query(
      `SELECT m.message_id, m.message_body, m.sent_at, u.name AS sender_name, m.sender_user_id
       FROM conversations conv
       JOIN messages m ON m.conversation_id=conv.conversation_id
       JOIN users u ON u.user_id=m.sender_user_id
       WHERE conv.claim_id=$1
       ORDER BY m.sent_at ASC, m.message_id ASC LIMIT 200`,
      [claimId]
    );
    return res.json({
      claimId: Number(claimId),
      conversationStatus: context.row.conversation_status,
      participantType: context.side,
      messages: messages.rows.map((message) => ({
        messageId: Number(message.message_id),
        senderName: message.sender_name,
        sentAt: message.sent_at,
        body: message.message_body,
        isYou: Number(message.sender_user_id) === Number(req.user.userId),
      })),
    });
  } catch (error) {
    console.error("Read claim conversation failed:", error.message);
    return res.status(500).json({ error: "Unable to load conversation" });
  }
});

router.post("/claims/:claimId", async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  const body = req.body?.message;
  if (!claimId) return res.status(400).json({ error: "Invalid claim ID" });
  if (typeof body !== "string" || !body.trim() || body.trim().length > 2000) {
    return res.status(400).json({ error: "Message must contain 1 to 2000 characters" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const context = await loadContext(client, claimId, req.user.userId, true);
    if (!context) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Conversation is not available to this account" });
    }
    const locked = await client.query(
      "SELECT conversation_id, conversation_status FROM conversations WHERE claim_id=$1 FOR UPDATE",
      [claimId]
    );
    if (!locked.rowCount || locked.rows[0].conversation_status !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Conversation is closed" });
    }
    const inserted = await client.query(
      `INSERT INTO messages (conversation_id, sender_user_id, message_body)
       VALUES ($1,$2,$3) RETURNING message_id, sent_at`,
      [locked.rows[0].conversation_id, req.user.userId, body.trim()]
    );
    let recipients;
    if (context.side === "CLAIMANT") {
      if (context.row.recovery_mode === "AUTHORITY") {
        recipients = await client.query(
          `SELECT DISTINCT am.user_id FROM authority_memberships am
           JOIN authority_destinations ad ON ad.authority_id=am.authority_id
           JOIN users u ON u.user_id=am.user_id
           WHERE am.authority_id=$1 AND am.membership_status='ACTIVE'
             AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
             AND u.account_status='ACTIVE'`,
          [context.row.authority_id]
        );
      } else {
        recipients = { rows: [{ user_id: context.row.finder_id }] };
      }
    } else {
      recipients = { rows: [{ user_id: context.row.claimant_user_id }] };
    }
    for (const recipient of recipients.rows) {
      if (Number(recipient.user_id) !== Number(req.user.userId)) {
        await createNotification(client, recipient.user_id, "NEW_CLAIM_MESSAGE", "CLAIM", claimId);
      }
    }
    await client.query("COMMIT");
    return res.status(201).json({ message: { messageId: Number(inserted.rows[0].message_id), sentAt: inserted.rows[0].sent_at } });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* retain the original error */ }
    }
    console.error("Send claim conversation message failed:", error.message);
    return res.status(500).json({ error: "Unable to send message" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
