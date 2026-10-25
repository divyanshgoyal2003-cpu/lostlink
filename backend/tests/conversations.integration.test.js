require('dotenv').config()
process.env.DB_NAME = 'lostlink_test'
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
process.env.PRIVATE_PROOF_DIR = path.join(os.tmpdir(), `lostlink-proof-${process.pid}-${Date.now()}`)
const assert = require('node:assert/strict')
const { before, after, test } = require('node:test')
const pool = require('../src/config/db')
const app = require('../src/server')

let server, base, claimant, finder, stranger, claimId, matchId, lostId, foundId, itemIds=[], userIds=[]
async function api(url, { token, ...opts } = {}) {
  return fetch(`${base}${url}`, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers } })
}
async function register(email) {
  const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Chat Test', email, password: 'Chat-Test-Password-123' }) })
  assert.equal(r.status, 201)
  const data = await r.json(); userIds.push(data.user.user_id); return data
}

before(async () => {
  assert.equal((await pool.query('SELECT current_database() name')).rows[0].name, 'lostlink_test')
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`
  const suffix = `${process.pid}-${Date.now()}`
  claimant = await register(`chat-claimant-${suffix}@example.test`)
  finder = await register(`chat-finder-${suffix}@example.test`)
  stranger = await register(`chat-stranger-${suffix}@example.test`)
  const item = await pool.query("INSERT INTO items(category,title,description,color,attributes_json) VALUES('ELECTRONICS','Chat test lost item','description','Black','{}'),('ELECTRONICS','Chat test found item','description','Black','{}') RETURNING item_id")
  itemIds.push(...item.rows.map((row) => row.item_id))
  async function report(owner, type) {
    return (await pool.query(`INSERT INTO reports(user_id,item_id,report_type,report_time,location_point,uncertainty_radius_m,location_source)
      VALUES($1,$2,$3,NOW(),ST_SetSRID(ST_MakePoint(145.0,-65.0),4326)::geography,50,'MAP_PIN') RETURNING report_id`, [owner,type==='LOST'?itemIds[0]:itemIds[1],type])).rows[0].report_id
  }
  lostId = await report(claimant.user.user_id, 'LOST'); foundId = await report(finder.user.user_id, 'FOUND')
  matchId = (await pool.query(`INSERT INTO match_records(lost_report_id,found_report_id,location_score,item_score,time_score,description_score,total_score)
    VALUES($1,$2,90,90,90,90,90) RETURNING match_id`, [lostId,foundId])).rows[0].match_id
  claimId = (await pool.query("INSERT INTO claim_requests(match_id,claimant_user_id,claim_status) VALUES($1,$2,'SUBMITTED') RETURNING claim_id", [matchId,claimant.user.user_id])).rows[0].claim_id
  await pool.query("INSERT INTO conversations(claim_id,conversation_status) VALUES($1,'OPEN')", [claimId])
})

after(async () => {
  if (claimId) {
    const ids = await pool.query('SELECT proof_attachment_id,storage_key FROM conversation_proof_attachments WHERE proof_request_id IN (SELECT proof_request_id FROM conversation_proof_requests WHERE conversation_id=(SELECT conversation_id FROM conversations WHERE claim_id=$1))', [claimId])
    for (const row of ids.rows) await fs.unlink(path.join(process.env.PRIVATE_PROOF_DIR,row.storage_key)).catch(()=>{})
    const conv = await pool.query('SELECT conversation_id FROM conversations WHERE claim_id=$1', [claimId])
    if (conv.rowCount) {
      await pool.query('DELETE FROM conversation_proof_attachments WHERE conversation_id=$1', [conv.rows[0].conversation_id])
      await pool.query('DELETE FROM conversation_proof_requests WHERE conversation_id=$1', [conv.rows[0].conversation_id])
    }
    await pool.query('DELETE FROM conversations WHERE claim_id=$1', [claimId])
    await pool.query('DELETE FROM claim_requests WHERE claim_id=$1', [claimId])
    await pool.query('DELETE FROM match_records WHERE match_id=$1', [matchId])
    await pool.query('DELETE FROM reports WHERE report_id=ANY($1::bigint[])', [[lostId,foundId]])
  }
  if (userIds.length) {
    await pool.query('DELETE FROM audit_logs WHERE actor_user_id=ANY($1::bigint[])', [userIds])
    await pool.query('DELETE FROM users WHERE user_id=ANY($1::bigint[])', [userIds])
  }
  if(itemIds.length)await pool.query('DELETE FROM items WHERE item_id=ANY($1::bigint[])', [itemIds])
  await fs.rm(process.env.PRIVATE_PROOF_DIR,{recursive:true,force:true})
  if(server){server.closeAllConnections();await new Promise((resolve)=>server.close(resolve))}
  await pool.end()
})

test('conversation membership, idempotent messages, read cursors, and private proof lifecycle', async () => {
  assert.equal((await api('/api/conversations/inbox')).status, 401)
  assert.equal((await api(`/api/conversations/claims/${claimId}`, { token: stranger.token })).status, 403)
  assert.equal((await api(`/api/conversations/claims/${claimId}`, { token: finder.token })).status, 200)
  const initial = await api(`/api/conversations/claims/${claimId}`, { token: claimant.token })
  assert.equal(initial.status, 200)
  assert.equal(JSON.stringify(await initial.json()).includes('storage_key'), false)

  const messageKey = '11111111-1111-4111-8111-111111111111'
  assert.equal((await api(`/api/conversations/claims/${claimId}`, { token: claimant.token, method: 'POST', body: JSON.stringify({ message: '   ' }) })).status, 400)
  const first = await api(`/api/conversations/claims/${claimId}`, { token: claimant.token, method: 'POST', body: JSON.stringify({ message: '  Hello finder  ', clientMessageId: messageKey }) })
  const firstBody = await first.json(); assert.equal(first.status, 201)
  const retry = await api(`/api/conversations/claims/${claimId}`, { token: claimant.token, method: 'POST', body: JSON.stringify({ message: 'Hello finder', clientMessageId: messageKey }) })
  assert.equal(retry.status, 200); assert.equal((await retry.json()).message.messageId, firstBody.message.messageId)
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM messages WHERE sender_user_id=$1 AND client_message_id=$2', [claimant.user.user_id,messageKey])).rows[0].n,1)
  assert.equal((await api(`/api/conversations/claims/${claimId}/read`, { token: claimant.token, method: 'PATCH', body: JSON.stringify({ lastReadMessageId: firstBody.message.messageId }) })).status, 200)

  assert.equal((await api(`/api/conversations/claims/${claimId}/proof-requests`, { token: claimant.token, method: 'POST', body: JSON.stringify({ category: 'OTHER', text: 'Show a distinguishing feature' }) })).status, 403)
  const requestResponse = await api(`/api/conversations/claims/${claimId}/proof-requests`, { token: finder.token, method: 'POST', body: JSON.stringify({ category: 'DISTINGUISHING_MARK', text: 'Please show the small scratch on the left side.' }) })
  assert.equal(requestResponse.status, 201)
  const request = (await requestResponse.json()).proofRequest
  assert.equal((await api(`/api/conversations/proof-requests/${request.proof_request_id}`, { token: stranger.token, method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) })).status, 403)
  const invalid = await api(`/api/conversations/proof-requests/${request.proof_request_id}/attachments`, { token: claimant.token, method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('not image') })
  assert.equal(invalid.status, 400)
  const bytes = Buffer.from('%PDF-1.4\nproof fixture\n%%EOF')
  const uploads = await Promise.all([1, 2].map(() => api(`/api/conversations/proof-requests/${request.proof_request_id}/attachments`, { token: claimant.token, method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes })))
  assert.deepEqual(uploads.map((r) => r.status).sort(), [201, 409])
  const attachment = (await uploads.find((r) => r.status === 201).json()).attachment
  const retrieved = await api(`/api/conversations/proof-attachments/${attachment.attachmentId}/content`, { token: finder.token })
  assert.equal(retrieved.status, 200); assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), bytes)
  assert.equal((await api(`/api/conversations/proof-attachments/${attachment.attachmentId}/content`, { token: stranger.token })).status, 403)
  const state = await api(`/api/conversations/proof-requests/${request.proof_request_id}`, { token: finder.token, method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) })
  assert.equal(state.status, 200)
  assert.equal((await api(`/api/conversations/proof-requests/${request.proof_request_id}`, { token: finder.token, method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) })).status, 409)
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM audit_logs WHERE entity_type='PROOF_REQUEST' AND entity_id=$1",[request.proof_request_id])).rows[0].n,3)
  const listing = await api('/api/conversations/inbox', { token: claimant.token })
  assert.equal(listing.status,200); assert.equal((await listing.json()).conversations.length,1)
  const claimantNotifications = await (await api('/api/notifications', { token: claimant.token })).json()
  assert.ok(claimantNotifications.notifications.some((n) => n.notification_type === 'PROOF_REQUESTED' && n.navigation_target === '#my-claims'))
  assert.equal(JSON.stringify(claimantNotifications).includes('storage_key'), false)
  assert.equal(JSON.stringify(claimantNotifications).includes('Please show the small scratch'), false)
  const central = await pool.query("SELECT authority_id FROM authority_destinations WHERE destination_type='CENTRAL' AND verification_status='VERIFIED' AND destination_status='ACTIVE' LIMIT 1")
  if (central.rowCount) {
    await pool.query("UPDATE reports SET recovery_mode='AUTHORITY',authority_id=$2 WHERE report_id=$1", [foundId, central.rows[0].authority_id])
    assert.equal((await api(`/api/conversations/claims/${claimId}`, { token: finder.token })).status, 403)
    assert.equal((await api(`/api/conversations/claims/${claimId}`, { token: claimant.token })).status, 200)
    await pool.query("UPDATE reports SET recovery_mode='DIRECT',authority_id=NULL WHERE report_id=$1", [foundId])
  }
})
