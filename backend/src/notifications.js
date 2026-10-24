// Called inside the transaction that persists the associated event. The
// owning event row/advisory lock serializes creation, and this guard makes
// retries idempotent without changing the existing notifications schema.
async function createNotification(client, userId, notificationType, referenceType, referenceId) {
  if (!userId || !referenceId) return null
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
