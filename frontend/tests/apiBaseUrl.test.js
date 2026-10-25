import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveApiBaseUrl } from '../src/apiBaseUrl.js'

test('local frontend retains the localhost API default', () => {
  assert.equal(resolveApiBaseUrl(undefined, false), 'http://localhost:5000/api')
  assert.equal(resolveApiBaseUrl('http://127.0.0.1:5000/api/', false), 'http://127.0.0.1:5000/api')
})

test('production frontend requires an HTTPS API base ending in /api', () => {
  assert.equal(resolveApiBaseUrl('https://lostlink-api.example/api', true), 'https://lostlink-api.example/api')
  assert.throws(() => resolveApiBaseUrl('', true), /required/)
  assert.throws(() => resolveApiBaseUrl('http://lostlink-api.example/api', true), /HTTPS/)
  assert.throws(() => resolveApiBaseUrl('https://lostlink-api.example', true), /end in \/api/)
  assert.throws(() => resolveApiBaseUrl('https://lostlink-api.example/api?token=bad', true), /end in \/api/)
  assert.throws(() => resolveApiBaseUrl('https://user:secret@lostlink-api.example/api', true), /HTTPS|credentials/i)
  assert.throws(() => resolveApiBaseUrl('https://user@lostlink-api.example/api', true), /HTTPS|credentials/i)
  assert.throws(() => resolveApiBaseUrl('not a URL', true), /valid HTTPS/)
})
