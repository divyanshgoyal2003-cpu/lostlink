import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('chat offers reporting only on another person’s messages and keeps report details private', async () => {
  const panel = await read('../src/components/ConversationPanel.jsx')
  const api = await read('../src/api.js')
  const route = await read('../../backend/src/routes/conversations.js')
  assert.match(panel, /!entry\.isYou/)
  assert.match(panel, /Report rude or abusive message/)
  assert.match(panel, /ABUSIVE_LANGUAGE/)
  assert.match(panel, /RUDE_OR_HARASSING/)
  assert.match(panel, /reportChatUser\(token, claimId/)
  assert.match(api, /\/conversations\/claims\/\$\{encodeURIComponent\(claimId\)\}\/user-reports/)
  assert.match(route, /reportedByYou: message\.reported_by_you/)
  assert.doesNotMatch(route.slice(route.indexOf('messages: messages.rows.map'), route.indexOf('router.post("/claims/:claimId/user-reports"')), /report_details/)
})

test('admin dashboard exposes a protected report queue, report dismissal, and account reinstatement', async () => {
  const portal = await read('../src/components/AuthorityPortal.jsx')
  const route = await read('../../backend/src/routes/conversations.js')
  assert.match(portal, /isAdmin && <section className="authority-panel chat-moderation-panel"/)
  assert.match(portal, /Dismiss this report/)
  assert.match(portal, /Reinstate account/)
  assert.match(route, /router\.get\("\/moderation\/reports"/)
  assert.match(route, /router\.post\("\/moderation\/users\/:userId\/reinstate"/)
  assert.match(route, /router\.patch\("\/moderation\/reports\/:reportId\/dismiss"/)
  assert.match(route, /isCurrentAdmin\(client, req\.user\.userId\)/)
})
