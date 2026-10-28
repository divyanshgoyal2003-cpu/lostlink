import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/components/LocationPicker.jsx', import.meta.url),
  'utf8',
)

test('location picker uses the OpenStreetMap tile endpoint and attribution only', () => {
  assert.match(source, /url="https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png"/)
  assert.match(source, /www\.openstreetmap\.org\/copyright/)
  assert.doesNotMatch(source, /cartocdn|CARTO/)
})

test('tile errors offer a retry that remounts the same map layer', () => {
  assert.match(source, /setTileError\(\s*'Map tiles are temporarily unavailable/)
  assert.match(source, /key=\{tileRetry\}/)
  assert.match(source, /setTileRetry\(\(previous\) => previous \+ 1\)/)
  assert.match(source, /Retry map tiles/)
})
