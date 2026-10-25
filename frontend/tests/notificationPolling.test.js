import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startNotificationPolling } from '../src/notificationPolling.js'

test('notification polling respects authentication and visibility and cleans up', async () => {
  let tick
  let cleared = false
  let authenticated = false
  let visible = true
  let calls = 0
  const poller = startNotificationPolling(async () => { calls += 1 }, {
    intervalMs: 60000,
    isAuthenticated: () => authenticated,
    isVisible: () => visible,
    setIntervalFn(callback, ms) { assert.equal(ms, 60000); tick = callback; return 12 },
    clearIntervalFn(id) { assert.equal(id, 12); cleared = true },
  })
  await poller.poll()
  assert.equal(calls, 0)
  authenticated = true; visible = false
  await poller.poll()
  assert.equal(calls, 0)
  visible = true
  await poller.poll()
  assert.equal(calls, 1)
  poller.stop()
  assert.equal(cleared, true)
  await tick()
  assert.equal(calls, 1)
})

test('notification polling does not overlap and retries after a failed request', async () => {
  let tick
  let finish
  let calls = 0
  const pending = new Promise((resolve) => { finish = resolve })
  const poller = startNotificationPolling(async () => { calls += 1; if (calls === 1) await pending; else throw new Error('offline') }, {
    setIntervalFn(callback) { tick = callback; return 2 },
    clearIntervalFn() {},
  })
  const first = poller.poll()
  await poller.poll()
  assert.equal(calls, 1)
  finish()
  await first
  await tick()
  assert.equal(calls, 2)
  poller.stop()
})
