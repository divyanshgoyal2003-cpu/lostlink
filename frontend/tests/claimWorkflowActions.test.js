import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('finder and assigned authority can start chat from their respective claim views', async () => {
  const workflow = await readSource('../src/components/ClaimWorkflow.jsx')
  const photoAccess = await readSource('../src/components/ClaimPhotoAccess.jsx')
  assert.match(workflow, /relationship === 'FOUND_REPORT_OWNER' && claim\.found_recovery_mode === 'DIRECT'/)
  assert.match(workflow, /claim\.found_recovery_mode === 'AUTHORITY'[\s\S]*claim\.authority_custody_received && hasAuthorityMembership/)
  assert.match(workflow, /Start chat with claimant/)
  assert.match(photoAccess, /Start chat with claimant/)
})

test('approved authority claims remain in the review queue for chat and review', async () => {
  const claimsRoute = await readSource('../../backend/src/routes/claims.js')
  assert.match(claimsRoute, /c\.claim_status = 'APPROVED'[\s\S]*found\.recovery_mode = 'AUTHORITY'[\s\S]*conv\.conversation_status IS DISTINCT FROM 'CLOSED'/)
})

test('photo permissions refresh for the matching claim after chat opens', async () => {
  const api = await readSource('../src/api.js')
  const photoAccess = await readSource('../src/components/ClaimPhotoAccess.jsx')
  assert.match(api, /await authenticatedRequest\(`\/claims\/\$\{encodeURIComponent\(claimId\)\}\/conversation\/open`[\s\S]*lostlink:claim-conversation-opened/)
  assert.match(photoAccess, /addEventListener\('lostlink:claim-conversation-opened'/)
  assert.match(photoAccess, /String\(event\.detail\?\.claimId\) === String\(claimId\)/)
})

test('direct recovery puts the founder chat action beside the photo-sharing prerequisite', async () => {
  const workflow = await readSource('../src/components/ClaimWorkflow.jsx')
  const photoAccess = await readSource('../src/components/ClaimPhotoAccess.jsx')
  assert.match(workflow, /onStartChat=\{relationship === 'FOUND_REPORT_OWNER' && claim\.found_recovery_mode === 'DIRECT'/)
  assert.match(workflow, /chatStarting=\{pendingAction === `enable-chat-\$\{id\}`\}/)
  assert.match(photoAccess, /Start a chat with the claimant first\. Photos stay private until you share them separately below\./)
  assert.match(photoAccess, /access\?\.canManage && access\?\.sharingStatus !== 'SHARED' && !access\?\.conversationOpen && onStartChat/)
  assert.match(photoAccess, /await grantClaimPhotoAccess\(token, claimId\)/)
})

test('failed finder handover keeps the entered code for correction and retry', async () => {
  const workflow = await readSource('../src/components/ClaimWorkflow.jsx')
  assert.match(workflow, /const confirmed = await runAction\(key, async \(\) => \{[\s\S]*confirmHandover\(token, id, code\)[\s\S]*if \(confirmed\) updateById\(setCodeInputs, id, ''\)/)
})

test('hiding a newly issued handover code preserves it for an in-session Show action', async () => {
  const workflow = await readSource('../src/components/ClaimWorkflow.jsx')
  assert.match(workflow, /const \[hiddenIssuedCodes, setHiddenIssuedCodes\] = useState\(\{\}\)/)
  assert.match(workflow, /onClick=\{\(\) => updateById\(setHiddenIssuedCodes, id, true\)\}>Hide code/)
  assert.match(workflow, /onClick=\{\(\) => updateById\(setHiddenIssuedCodes, id, false\)\}>Show code/)
  assert.doesNotMatch(workflow, /onClick=\{\(\) => updateById\(setIssuedCodes, id, ''\)\}>Hide code/)
  assert.match(workflow, /const serverCodeActive = claim\.handover_status === 'CODE_ISSUED'[\s\S]*handoverCodeExpiresAt > handoverClockNow/)
  assert.match(workflow, /setTimeout\(\(\) => \{[\s\S]*expiredClaimIds[\s\S]*setIssuedCodes/)
})

test('authority handover failures are shown beside the code form', async () => {
  const portal = await readSource('../src/components/AuthorityPortal.jsx')
  assert.match(portal, /setHandoverErrors\(\(previous\) => \(\{ \.\.\.previous, \[claimId\]: confirmError\.message/)
  assert.match(portal, /handoverErrors\[claim\.claim_id\].*role="alert"/)
})
