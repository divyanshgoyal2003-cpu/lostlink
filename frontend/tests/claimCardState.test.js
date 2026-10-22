import assert from 'node:assert/strict'
import test from 'node:test'
import { getMatchClaimState } from '../src/claimCardState.js'

const match = { matchId: '17', canClaim: true }

test('claim action waits until claims are loaded and only appears for eligible persisted matches', () => {
  assert.deepEqual(getMatchClaimState(match, [], false), { type: 'loading' })
  assert.deepEqual(getMatchClaimState({ ...match, canClaim: false }, [], true), { type: 'ineligible' })
  assert.deepEqual(getMatchClaimState({ ...match, matchId: null }, [], true), { type: 'unsaved' })
  assert.deepEqual(getMatchClaimState(match, [], true), { type: 'submit' })
})

test('every existing claim state replaces the submit action and uses readable status labels', () => {
  const statuses = [
    ['SUBMITTED', 'Awaiting review'],
    ['IN_REVIEW', 'Under review'],
    ['APPROVED', 'Approved'],
    ['REJECTED', 'Rejected'],
    ['COMPLETED', 'Completed'],
    ['WITHDRAWN', 'Withdrawn'],
  ]

  for (const [claim_status, label] of statuses) {
    const state = getMatchClaimState(match, [{ match_id: 17, claim_id: 5, claim_status }], true)
    assert.equal(state.type, 'existing')
    assert.equal(state.label, label)
  }
})

test('an existing rejected or completed claim also prevents another card submission', () => {
  for (const claim_status of ['REJECTED', 'COMPLETED']) {
    assert.equal(
      getMatchClaimState(match, [{ match_id: 17, claim_status }], true).type,
      'existing',
    )
  }
})
