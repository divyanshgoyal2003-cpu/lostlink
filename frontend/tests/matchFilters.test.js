import assert from 'node:assert/strict'
import test from 'node:test'
import { filterAndSortMatches } from '../src/matchFilters.js'

const matches = [
  { matchId: 'a', lostTitle: 'Sony headphones', category: 'ELECTRONICS', matchStrength: 'STRONG', status: 'CANDIDATE', matchScore: 91, foundReportTime: '2026-01-11T00:00:00Z', matchedAt: '2026-01-12T00:00:00Z' },
  { matchId: 'b', lostTitle: 'Sony wallet', category: 'ACCESSORIES', matchStrength: 'POTENTIAL', status: 'CHAT_ENABLED', matchScore: 79, foundReportTime: '2026-01-13T00:00:00Z', matchedAt: '2026-01-20T00:00:00Z' },
  { matchId: 'c', lostTitle: 'Dell laptop', category: 'ELECTRONICS', matchStrength: 'POTENTIAL', status: 'CANDIDATE', matchScore: 80, foundReportTime: '2026-02-02T00:00:00Z', matchedAt: '2026-01-18T00:00:00Z' },
]

const defaults = {
  keyword: '', category: '', strength: 'ALL', lostReportId: '',
  foundDateFrom: '', foundDateTo: '', sort: 'score',
}

test('combines keyword, category, minimum score band, and found date filters', () => {
  const filtered = filterAndSortMatches(matches, {
    ...defaults,
    keyword: 'sony',
    category: 'ELECTRONICS',
    strength: 'STRONG',
    foundDateFrom: '2026-01-11',
    foundDateTo: '2026-01-11',
  })
  assert.deepEqual(filtered.map((match) => match.matchId), ['a'])
})

test('sorts qualifying matches by score and newest match with stable tie breakers', () => {
  assert.deepEqual(filterAndSortMatches(matches, defaults).map((match) => match.matchId), ['a', 'c', 'b'])
  assert.deepEqual(filterAndSortMatches(matches, { ...defaults, sort: 'newest' }).map((match) => match.matchId), ['b', 'c', 'a'])
})

test('applies found-date boundaries together with other visible filters', () => {
  const filtered = filterAndSortMatches(matches, {
    ...defaults,
    keyword: 'dell',
    category: 'ELECTRONICS',
    strength: 'POTENTIAL',
    foundDateFrom: '2026-02-02',
    foundDateTo: '2026-02-02',
  })
  assert.deepEqual(filtered.map((match) => match.matchId), ['c'])
})
