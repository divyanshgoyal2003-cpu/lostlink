import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('My Reports found-photo sections start collapsed and load private images only when opened', async () => {
  const component = await read('../src/components/FoundPhotoCapture.jsx')
  const app = await read('../src/App.jsx')

  assert.match(component, /const \[photosVisible, setPhotosVisible\] = useState\(false\)/)
  assert.match(component, /aria-expanded=\{photosVisible\}/)
  assert.match(component, /\{photosVisible \? 'Hide photos' : 'Show photos'\}/)
  assert.match(component, /if \(!photosVisible \|\| photosLoaded\) return undefined/)
  assert.match(component, /URL\.createObjectURL\(await getPrivatePhoto/)

  const usages = [...app.matchAll(/<FoundPhotoCapture\b/g)]
  assert.equal(usages.length, 1)
  assert.match(app.slice(usages[0].index - 150, usages[0].index + 120), /report\.report_type === 'FOUND'/)
})
