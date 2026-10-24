require("dotenv").config()
process.env.DB_NAME = "lostlink_test"

const assert = require("node:assert/strict")
const { before, after, test } = require("node:test")
const pool = require("../src/config/db")
const app = require("../src/server")

let server
let baseUrl
let user
let other
const insertedNotificationIds = []

async function api(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
  })
}

async function register(name, email) {
  const response = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: "Notifications-Test-123" }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

before(async () => {
  const db = await pool.query("SELECT current_database() AS name")
  assert.equal(db.rows[0].name, "lostlink_test", "Notification tests must use lostlink_test")
  assert.ok(process.env.JWT_SECRET, "JWT_SECRET must be configured")
  server = app.listen(0, "127.0.0.1")
  await new Promise((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  const suffix = `${process.pid}-${Date.now()}`
  user = await register("Notification Test", `notify-${suffix}@example.test`)
  other = await register("Other Notification Test", `notify-other-${suffix}@example.test`)
})

after(async () => {
  if (insertedNotificationIds.length) {
    await pool.query("DELETE FROM notifications WHERE notification_id = ANY($1::bigint[])", [insertedNotificationIds])
  }
  if (server) await new Promise((resolve) => server.close(resolve))
  if (user?.user?.user_id && other?.user?.user_id) {
    await pool.query("DELETE FROM users WHERE user_id = ANY($1::bigint[])", [[user.user.user_id, other.user.user_id]])
  }
  await pool.end()
})

test("notification endpoints require authentication", async () => {
  for (const [path, method] of [
    ["/api/notifications", "GET"],
    ["/api/notifications/unread-count", "GET"],
    ["/api/notifications/1/read", "PATCH"],
    ["/api/notifications/read-all", "POST"],
    ["/api/notifications", "DELETE"],
  ]) {
    const response = await api(path, { method })
    assert.equal(response.status, 401, `${method} ${path}`)
  }
})

test("list, count, mark-one, and mark-all are private, bounded, and idempotent", async () => {
  const own = await pool.query(
    `INSERT INTO notifications (user_id, notification_type, reference_type, reference_id)
     VALUES ($1, 'MATCH_FOUND', 'MATCH', 900000001), ($1, 'CLAIM_APPROVED', 'CLAIM', 900000002)
     RETURNING notification_id`,
    [user.user.user_id]
  )
  const foreign = await pool.query(
    `INSERT INTO notifications (user_id, notification_type, reference_type, reference_id)
     VALUES ($1, 'NEW_CLAIM', 'CLAIM', 900000003) RETURNING notification_id`,
    [other.user.user_id]
  )
  insertedNotificationIds.push(...own.rows.map((row) => row.notification_id), foreign.rows[0].notification_id)

  const invalidLimit = await api("/api/notifications?limit=51", { token: user.token })
  assert.equal(invalidLimit.status, 400)

  const listResponse = await api("/api/notifications?limit=1&offset=0", { token: user.token })
  const list = await listResponse.json()
  assert.equal(listResponse.status, 200)
  assert.equal(list.notifications.length, 1)
  assert.equal(list.limit, 1)
  assert.equal(list.notifications[0].navigation_target, null)
  for (const row of list.notifications) {
    assert.equal(Object.hasOwn(row, "reference_id"), false)
    assert.equal(Object.hasOwn(row, "storage_key"), false)
    assert.equal(Object.hasOwn(row, "message_body"), false)
    assert.equal(Object.hasOwn(row, "private_note"), false)
  }

  const foreignMark = await api(`/api/notifications/${foreign.rows[0].notification_id}/read`, {
    method: "PATCH", token: user.token,
  })
  assert.equal(foreignMark.status, 404)

  const targetId = own.rows[0].notification_id
  const firstMark = await api(`/api/notifications/${targetId}/read`, { method: "PATCH", token: user.token })
  const firstBody = await firstMark.json()
  assert.equal(firstMark.status, 200)
  const secondMark = await api(`/api/notifications/${targetId}/read`, { method: "PATCH", token: user.token })
  const secondBody = await secondMark.json()
  assert.equal(secondBody.notification.read_at, firstBody.notification.read_at)

  const countResponse = await api("/api/notifications/unread-count", { token: user.token })
  const count = await countResponse.json()
  assert.equal(count.unreadCount, 1)
  const readAll = await api("/api/notifications/read-all", { method: "POST", token: user.token })
  assert.deepEqual(await readAll.json(), { updatedCount: 1 })
  const otherRow = await pool.query("SELECT read_at FROM notifications WHERE notification_id = $1", [foreign.rows[0].notification_id])
  assert.equal(otherRow.rows[0].read_at, null)

  const clearResponse = await api("/api/notifications", { method: "DELETE", token: user.token })
  assert.deepEqual(await clearResponse.json(), { deletedCount: 2 })
  const remainingOwn = await pool.query("SELECT notification_id FROM notifications WHERE user_id = $1", [user.user.user_id])
  const remainingForeign = await pool.query("SELECT notification_id FROM notifications WHERE notification_id = $1", [foreign.rows[0].notification_id])
  assert.equal(remainingOwn.rowCount, 0)
  assert.equal(remainingForeign.rowCount, 1)
  const clearedCountResponse = await api("/api/notifications/unread-count", { token: user.token })
  assert.equal((await clearedCountResponse.json()).unreadCount, 0)
})
