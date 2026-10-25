import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startConversationPolling } from '../src/conversationPolling.js'

test('conversation polling serializes requests and stops after authorization is revoked', async () => {
  let tick
  let stopped = false
  let calls = 0
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const poller = startConversationPolling(async () => { calls += 1; await pending; return false }, {
    intervalMs: 5000,
    setIntervalFn(callback, ms) { assert.equal(ms, 5000); tick = callback; return 7 },
    clearIntervalFn(id) { assert.equal(id, 7); stopped = true },
  })
  const first = poller.poll()
  await poller.poll()
  assert.equal(calls, 1)
  finish()
  await first
  assert.equal(stopped, true)
  await tick()
  assert.equal(calls, 1)
});

test('conversation polling retries after a transient network failure', async () => {
  let tick
  let calls = 0
  const poller = startConversationPolling(async () => { calls += 1; if (calls === 1) throw new Error('offline'); return true }, {
    setIntervalFn(callback) { tick = callback; return 9 },
    clearIntervalFn() {},
  })
  await tick()
  await tick()
  assert.equal(calls, 2)
  poller.stop()
});
