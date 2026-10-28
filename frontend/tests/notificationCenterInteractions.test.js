import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/components/NotificationCenter.jsx', import.meta.url),
  'utf8',
)

test('notification panel closes on outside click and Escape while its toggle remains a toggle', () => {
  assert.match(source, /document\.addEventListener\('pointerdown', dismissOutside\)/)
  assert.match(source, /centerRef\.current\?\.contains\(event\.target\)/)
  assert.match(source, /document\.addEventListener\('keydown', dismissOnEscape\)/)
  assert.match(source, /onClick=\{togglePanel\}/)
})

test('notifications reveal an owner-scoped clear action after a left swipe', () => {
  assert.match(source, /delta < -45/)
  assert.match(source, /setSwipedId\(String\(notification\.notification_id\)\)/)
  assert.match(source, /onClick=\{\(\) => clearOne\(notification\)\}/)
  assert.match(source, /tabIndex=\{swipedId === String\(notification\.notification_id\) \? 0 : -1\}/)
  assert.match(source, /deleteNotification\(token, notification\.notification_id\)/)
})
