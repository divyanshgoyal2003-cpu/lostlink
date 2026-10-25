// Call inside the transaction that persists the event. A transaction-scoped
// advisory lock serializes application writers for the same notification key;
// the existence check makes retries idempotent without a schema change.
async function createNotification(client, userId, notificationType, referenceType, referenceId) {
  if (!userId || !referenceId) return null
  const lockKey = JSON.stringify([String(userId), notificationType, referenceType, String(referenceId)])
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [lockKey]
  )
  const result = await client.query(
    `INSERT INTO notifications (user_id, notification_type, reference_type, reference_id)
     SELECT $1::bigint, $2::varchar(40), $3::varchar(40), $4::bigint
     WHERE NOT EXISTS (
       SELECT 1 FROM notifications
       WHERE user_id = $1::bigint AND notification_type = $2::varchar(40)
         AND reference_type = $3::varchar(40) AND reference_id = $4::bigint
     )
     RETURNING notification_id`,
    [userId, notificationType, referenceType, referenceId]
  )
  return result.rows[0] || null
}

module.exports = { createNotification }
