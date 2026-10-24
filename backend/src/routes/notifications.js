const express = require("express")
const pool = require("../config/db")
const authenticateToken = require("../middleware/auth")

const router = express.Router()
router.use(authenticateToken)

function authorizedTargetSql(userParameter = "$1") {
  return `CASE
    WHEN n.reference_type = 'MATCH' AND EXISTS (
      SELECT 1 FROM match_records m
      JOIN reports lost ON lost.report_id = m.lost_report_id
      WHERE m.match_id = n.reference_id AND lost.user_id = ${userParameter}
    ) THEN '#my-matches'
    WHEN n.reference_type = 'CLAIM' AND EXISTS (
      SELECT 1 FROM claim_requests c
      JOIN match_records m ON m.match_id = c.match_id
      JOIN reports found ON found.report_id = m.found_report_id
      WHERE c.claim_id = n.reference_id
        AND (
          c.claimant_user_id = ${userParameter}
          OR found.user_id = ${userParameter}
          OR EXISTS (
            SELECT 1 FROM authority_memberships am
            JOIN authority_destinations ad ON ad.authority_id=am.authority_id
            JOIN users u ON u.user_id=am.user_id
            JOIN custody_transfer_requests ctr ON ctr.report_id=found.report_id
            WHERE am.user_id=${userParameter} AND am.authority_id=found.authority_id
              AND am.membership_status='ACTIVE' AND u.account_status='ACTIVE'
              AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
              AND ctr.custody_status='RECEIVED'
          )
        )
    ) THEN '#my-claims'
    WHEN n.reference_type = 'REPORT' AND EXISTS (
      SELECT 1 FROM reports r WHERE r.report_id=n.reference_id AND r.user_id=${userParameter}
    ) THEN '#my-reports'
    WHEN n.reference_type = 'REPORT' AND EXISTS (
      SELECT 1 FROM reports r
      JOIN authority_memberships am ON am.authority_id=r.authority_id
      JOIN authority_destinations ad ON ad.authority_id=am.authority_id
      JOIN users u ON u.user_id=am.user_id
      WHERE r.report_id=n.reference_id AND am.user_id=${userParameter}
        AND am.membership_status='ACTIVE' AND u.account_status='ACTIVE'
        AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
    ) THEN '#authority-portal'
    ELSE NULL
  END`
}

router.get("/unread-count", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications
       WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.userId]
    )
    return res.json({ unreadCount: result.rows[0].count })
  } catch (error) {
    console.error("Get unread notification count failed:", error.message)
    return res.status(500).json({ error: "Unable to retrieve notifications" })
  }
})

router.get("/", async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 ||
      !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    return res.status(400).json({ error: "limit must be 1–50 and offset must be 0–10000" })
  }
  try {
    const result = await pool.query(
      `SELECT n.notification_id, n.notification_type, n.created_at, n.read_at,
              ${authorizedTargetSql()} AS navigation_target
       FROM notifications n
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC, n.notification_id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.userId, limit, offset]
    )
    return res.json({ notifications: result.rows, limit, offset })
  } catch (error) {
    console.error("List notifications failed:", error.message)
    return res.status(500).json({ error: "Unable to retrieve notifications" })
  }
})

router.patch("/:notificationId/read", async (req, res) => {
  const id = String(req.params.notificationId)
  if (!/^[1-9]\d{0,18}$/.test(id)) {
    return res.status(400).json({ error: "A valid notification ID is required" })
  }
  try {
    const result = await pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
       WHERE notification_id = $1 AND user_id = $2
       RETURNING notification_id, read_at`,
      [id, req.user.userId]
    )
    if (!result.rowCount) return res.status(404).json({ error: "Notification not found" })
    return res.json({ notification: result.rows[0] })
  } catch (error) {
    console.error("Mark notification read failed:", error.message)
    return res.status(500).json({ error: "Unable to update notification" })
  }
})

router.post("/read-all", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.userId]
    )
    return res.json({ updatedCount: result.rowCount })
  } catch (error) {
    console.error("Mark all notifications read failed:", error.message)
    return res.status(500).json({ error: "Unable to update notifications" })
  }
})

module.exports = router
