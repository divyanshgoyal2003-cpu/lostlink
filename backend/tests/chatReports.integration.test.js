require('dotenv').config()
process.env.DB_NAME = 'lostlink_test'

const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const { before, after, test } = require('node:test')
const pool = require('../src/config/db')
const app = require('../src/server')

let server
let base
let target
let admin
let reporters = []
let fixtureIds = { items: [], reports: [], matches: [], claims: [], conversations: [], messages: [] }

async function api(path, { token, ...options } = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
}

async function register(label) {
  const response = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: label, email: `${label.toLowerCase().replace(/\W+/g, '-')}-${process.pid}-${Date.now()}-${Math.random()}@example.test`, password: 'Chat-Report-Test-123' }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

async function createReport(ownerId, itemId, type) {
  const result = await pool.query(
    `INSERT INTO reports(user_id,item_id,report_type,report_time,location_point,uncertainty_radius_m,location_source)
     VALUES($1,$2,$3,NOW(),ST_SetSRID(ST_MakePoint(145.0,-65.0),4326)::geography,50,'MAP_PIN') RETURNING report_id`,
    [ownerId, itemId, type]
  )
  fixtureIds.reports.push(result.rows[0].report_id)
  return result.rows[0].report_id
}

before(async () => {
  const db = await pool.query('SELECT current_database() AS name')
  assert.equal(db.rows[0].name, 'lostlink_test', 'Chat report tests must use lostlink_test')
  assert.ok(process.env.JWT_SECRET)
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  base = `http://127.0.0.1:${server.address().port}`

  target = await register('Abusive Chat Target')
  admin = await register('Chat Moderation Admin')
  await pool.query("UPDATE users SET role='ADMIN' WHERE user_id=$1", [admin.user.user_id])
  admin.token = jwt.sign({ userId: admin.user.user_id, role: 'ADMIN' }, process.env.JWT_SECRET)

  const foundItem = await pool.query("INSERT INTO items(category,title) VALUES('OTHER','Reported found item') RETURNING item_id")
  fixtureIds.items.push(foundItem.rows[0].item_id)
  const suffix = `${process.pid}-${Date.now()}`
  for (let index = 0; index < 5; index += 1) {
    const reporter = await register(`Chat Reporter ${index}`)
    reporters.push(reporter)
    const lostItem = await pool.query("INSERT INTO items(category,title) VALUES('OTHER',$1) RETURNING item_id", [`Lost item ${index}`])
    fixtureIds.items.push(lostItem.rows[0].item_id)
    const lostId = await createReport(reporter.user.user_id, lostItem.rows[0].item_id, 'LOST')
    const foundId = index === 0 ? await createReport(target.user.user_id, foundItem.rows[0].item_id, 'FOUND') : fixtureIds.reports.find((id) => id === fixtureIds.reports[1])
    if (index > 0) {
      const found = await pool.query("SELECT report_id FROM reports WHERE user_id=$1 AND report_type='FOUND' ORDER BY report_id DESC LIMIT 1", [target.user.user_id])
      fixtureIds.reports[1] = found.rows[0].report_id
    }
    const match = await pool.query(
      `INSERT INTO match_records(lost_report_id,found_report_id,location_score,item_score,time_score,description_score,total_score)
       VALUES($1,$2,90,90,90,90,90) RETURNING match_id`, [lostId, foundId]
    )
    fixtureIds.matches.push(match.rows[0].match_id)
    const claim = await pool.query("INSERT INTO claim_requests(match_id,claimant_user_id,claim_status) VALUES($1,$2,'SUBMITTED') RETURNING claim_id", [match.rows[0].match_id, reporter.user.user_id])
    fixtureIds.claims.push(claim.rows[0].claim_id)
    const conversation = await pool.query("INSERT INTO conversations(claim_id,conversation_status) VALUES($1,'OPEN') RETURNING conversation_id", [claim.rows[0].claim_id])
    fixtureIds.conversations.push(conversation.rows[0].conversation_id)
    const message = await pool.query("INSERT INTO messages(conversation_id,sender_user_id,message_body) VALUES($1,$2,$3) RETURNING message_id", [conversation.rows[0].conversation_id, target.user.user_id, `Rude test message ${suffix} ${index}`])
    fixtureIds.messages.push(message.rows[0].message_id)
  }
  const stranger = await register('Chat Report Stranger')
  reporters.push(stranger)
})

after(async () => {
  const userIds = [target?.user?.user_id, admin?.user?.user_id, ...reporters.map((reporter) => reporter.user.user_id)].filter(Boolean)
  if (fixtureIds.conversations.length) {
    await pool.query('DELETE FROM chat_user_reports WHERE conversation_id=ANY($1::bigint[])', [fixtureIds.conversations])
    await pool.query('DELETE FROM conversations WHERE conversation_id=ANY($1::bigint[])', [fixtureIds.conversations])
  }
  if (fixtureIds.claims.length) await pool.query('DELETE FROM claim_requests WHERE claim_id=ANY($1::bigint[])', [fixtureIds.claims])
  if (fixtureIds.matches.length) await pool.query('DELETE FROM match_records WHERE match_id=ANY($1::bigint[])', [fixtureIds.matches])
  if (fixtureIds.reports.length) await pool.query('DELETE FROM reports WHERE report_id=ANY($1::bigint[])', [fixtureIds.reports])
  if (fixtureIds.items.length) await pool.query('DELETE FROM items WHERE item_id=ANY($1::bigint[])', [fixtureIds.items])
  if (userIds.length) {
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id=ANY($1::bigint[]) OR (entity_type=\'USER\' AND entity_id=ANY($1::bigint[]))', [userIds])
    await pool.query('DELETE FROM users WHERE user_id=ANY($1::bigint[])', [userIds])
  }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  await pool.end()
})

test('chat reports require participants, count distinct people, suspend at five, and allow admin review and reinstatement', async () => {
  const firstClaimId = fixtureIds.claims[0]
  const firstMessageId = fixtureIds.messages[0]
  assert.equal((await api(`/api/conversations/claims/${firstClaimId}/user-reports`, { method: 'POST', body: JSON.stringify({ messageId: firstMessageId, category: 'ABUSIVE_LANGUAGE' }) })).status, 401)

  const denied = await api(`/api/conversations/claims/${firstClaimId}/user-reports`, {
    method: 'POST', token: reporters[5].token,
    body: JSON.stringify({ messageId: firstMessageId, category: 'ABUSIVE_LANGUAGE' }),
  })
  assert.equal(denied.status, 403)
  const invalid = await api(`/api/conversations/claims/${firstClaimId}/user-reports`, {
    method: 'POST', token: reporters[0].token,
    body: JSON.stringify({ messageId: firstMessageId, category: 'OTHER' }),
  })
  assert.equal(invalid.status, 400)

  const ownMessage = await pool.query("INSERT INTO messages(conversation_id,sender_user_id,message_body) VALUES($1,$2,'My own message') RETURNING message_id", [fixtureIds.conversations[0], reporters[0].user.user_id])
  fixtureIds.messages.push(ownMessage.rows[0].message_id)
  const selfReport = await api(`/api/conversations/claims/${firstClaimId}/user-reports`, {
    method: 'POST', token: reporters[0].token,
    body: JSON.stringify({ messageId: ownMessage.rows[0].message_id, category: 'RUDE_OR_HARASSING' }),
  })
  assert.equal(selfReport.status, 404)

  const secondTargetMessage = await pool.query("INSERT INTO messages(conversation_id,sender_user_id,message_body) VALUES($1,$2,'Another rude test message') RETURNING message_id", [fixtureIds.conversations[0], target.user.user_id])
  fixtureIds.messages.push(secondTargetMessage.rows[0].message_id)
  const repeatedReporter = await api(`/api/conversations/claims/${fixtureIds.claims[0]}/user-reports`, {
    method: 'POST', token: reporters[0].token,
    body: JSON.stringify({ messageId: secondTargetMessage.rows[0].message_id, category: 'RUDE_OR_HARASSING' }),
  })
  assert.equal(repeatedReporter.status, 201)
  const distinctCount = await pool.query("SELECT COUNT(DISTINCT reporter_user_id)::int AS n FROM chat_user_reports WHERE reported_user_id=$1", [target.user.user_id])
  assert.equal(distinctCount.rows[0].n, 1)
  const duplicate = await api(`/api/conversations/claims/${fixtureIds.claims[0]}/user-reports`, {
    method: 'POST', token: reporters[0].token,
    body: JSON.stringify({ messageId: secondTargetMessage.rows[0].message_id, category: 'RUDE_OR_HARASSING' }),
  })
  assert.equal(duplicate.status, 409)

  for (let index = 1; index < 3; index += 1) {
    const response = await api(`/api/conversations/claims/${fixtureIds.claims[index]}/user-reports`, {
      method: 'POST', token: reporters[index].token,
      body: JSON.stringify({ messageId: fixtureIds.messages[index], category: index % 2 ? 'ABUSIVE_LANGUAGE' : 'RUDE_OR_HARASSING', details: 'Private context for admin review' }),
    })
    assert.equal(response.status, 201)
    assert.equal((await pool.query('SELECT account_status FROM users WHERE user_id=$1', [target.user.user_id])).rows[0].account_status, 'ACTIVE')
  }
  const concurrentReports = await Promise.all([3, 4].map((index) => api(`/api/conversations/claims/${fixtureIds.claims[index]}/user-reports`, {
    method: 'POST', token: reporters[index].token,
    body: JSON.stringify({ messageId: fixtureIds.messages[index], category: 'RUDE_OR_HARASSING' }),
  })))
  assert.deepEqual(concurrentReports.map((response) => response.status), [201, 201])
  assert.equal((await pool.query('SELECT account_status FROM users WHERE user_id=$1', [target.user.user_id])).rows[0].account_status, 'SUSPENDED')
  assert.equal((await api('/api/conversations/inbox', { token: target.token })).status, 401)

  const nonAdminQueue = await api('/api/conversations/moderation/reports', { token: reporters[0].token })
  assert.equal(nonAdminQueue.status, 403)
  const queueResponse = await api('/api/conversations/moderation/reports', { token: admin.token })
  assert.equal(queueResponse.status, 200)
  const targetQueue = (await queueResponse.json()).users.find((item) => String(item.reported_user_id) === String(target.user.user_id))
  assert.equal(targetQueue.distinct_reporters, 5)
  assert.equal(targetQueue.reports.length, 5)
  assert.ok(targetQueue.reports.some((item) => item.details === 'Private context for admin review'))

  const reportId = targetQueue.reports[0].reportId
  const dismissDenied = await api(`/api/conversations/moderation/reports/${reportId}/dismiss`, { method: 'PATCH', token: reporters[0].token })
  assert.equal(dismissDenied.status, 403)
  const dismissed = await api(`/api/conversations/moderation/reports/${reportId}/dismiss`, { method: 'PATCH', token: admin.token })
  assert.equal(dismissed.status, 200)
  assert.equal((await api('/api/conversations/moderation/reports', { token: admin.token })).status, 200)

  const reinstated = await api(`/api/conversations/moderation/users/${target.user.user_id}/reinstate`, { method: 'POST', token: admin.token })
  assert.equal(reinstated.status, 200)
  assert.equal((await pool.query('SELECT account_status FROM users WHERE user_id=$1', [target.user.user_id])).rows[0].account_status, 'ACTIVE')
  const audit = await pool.query("SELECT action_type FROM audit_logs WHERE entity_type='USER' AND entity_id=$1 AND action_type IN ('CHAT_USER_AUTO_SUSPENDED','CHAT_USER_REINSTATED') ORDER BY action_type", [target.user.user_id])
  assert.deepEqual(audit.rows.map((row) => row.action_type), ['CHAT_USER_AUTO_SUSPENDED', 'CHAT_USER_REINSTATED'])
})
