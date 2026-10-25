import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLAIM_STATUS_LABELS, describeClaimStatus } from '../src/claimStatus.js'

test('claim status labels cover every existing lifecycle state', () => {
  assert.deepEqual(Object.keys(CLAIM_STATUS_LABELS), ['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'COMPLETED'])
})

test('submitted next action distinguishes finder, direct claimant, and authority claimant', () => {
  assert.match(describeClaimStatus('SUBMITTED', 'FOUND_REPORT_OWNER', 'DIRECT'), /record verification/i)
  assert.match(describeClaimStatus('SUBMITTED', 'CLAIMANT', 'DIRECT'), /found-item owner/i)
  assert.match(describeClaimStatus('SUBMITTED', 'CLAIMANT', 'AUTHORITY'), /assigned authority/i)
})

test('in-review guidance tells claimants how evidence requests are handled', () => {
  assert.match(describeClaimStatus('IN_REVIEW', 'CLAIMANT', 'DIRECT'), /evidence requests in the claim conversation/i)
  assert.match(describeClaimStatus('IN_REVIEW', 'AUTHORITY_CLAIMANT', 'AUTHORITY'), /assigned authority/i)
})

test('approved guidance preserves the correct handover actor', () => {
  assert.match(describeClaimStatus('APPROVED', 'FOUND_REPORT_OWNER', 'DIRECT'), /shows it to you/i)
  assert.match(describeClaimStatus('APPROVED', 'CLAIMANT', 'DIRECT'), /show it to the finder/i)
  assert.match(describeClaimStatus('APPROVED', 'AUTHORITY_CLAIMANT', 'AUTHORITY'), /assigned authority/i)
})
