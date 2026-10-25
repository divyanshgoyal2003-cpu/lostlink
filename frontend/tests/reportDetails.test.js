import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  activateReportDetails,
  getReportDetailSections,
  handleReportDetailsKeyDown,
  reportDetailsReducer,
} from '../src/reportDetails.js'

const sampleReport = {
  report_id: 42,
  report_type: 'FOUND',
  status: 'OPEN',
  title: 'Blue backpack',
  category: 'BAGS',
  description: 'Small stitched patch on the front pocket',
  color: 'Blue',
  company: 'Generic',
  item_attributes: { model: 'Trail 20L', pattern: 'mountain patch', company: 'Generic' },
  location_description: 'Near the library entrance',
  latitude: 12.97,
  longitude: 79.16,
  uncertainty_radius_m: 80,
  location_accuracy_m: null,
  location_source: 'MAP_PIN',
  report_time: '2026-10-25T11:30:00.000Z',
  created_at: '2026-10-25T12:00:00.000Z',
  recovery_mode: 'DIRECT',
}

test('report details viewer opens and closes through the reducer', () => {
  const opened = reportDetailsReducer(null, { type: 'open', report: sampleReport })
  assert.equal(opened, sampleReport)
  assert.equal(reportDetailsReducer(opened, { type: 'close' }), null)
})

test('My Reports eye button opens details and stops card-action propagation', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const viewerSource = await readFile(new URL('../src/components/ReportDetailsViewer.jsx', import.meta.url), 'utf8')
  const myReportsStart = source.indexOf('id="my-reports"')
  const myMatchesStart = source.indexOf('id="my-matches"')
  const buttonUse = source.indexOf('<ReportDetailsButton')
  assert.ok(myReportsStart >= 0 && myMatchesStart > myReportsStart)
  assert.ok(buttonUse > myReportsStart && buttonUse < myMatchesStart)
  assert.equal(source.indexOf('<ReportDetailsButton', myMatchesStart), -1)
  assert.match(viewerSource, /aria-label="View report details"/)
  assert.match(viewerSource, /<svg viewBox="0 0 24 24"/)
  assert.match(viewerSource, /aria-label="Close report details"/)
  assert.match(viewerSource, /onClick={onClose}/)

  let opened = null
  let stopped = false
  let trigger = null
  const event = {
    currentTarget: { id: 'my-report-details' },
    stopPropagation() { stopped = true },
  }
  activateReportDetails(event, sampleReport, (report, element) => {
    opened = reportDetailsReducer(opened, { type: 'open', report })
    trigger = element
  })
  assert.equal(stopped, true)
  assert.equal(opened, sampleReport)
  assert.equal(trigger, event.currentTarget)
})

test('details sections render available report, item, and location fields', () => {
  const sections = getReportDetailSections(sampleReport)
  assert.deepEqual(sections.map((section) => section.title), [
    'Item Details',
    'Location Details',
    'Report Information',
  ])
  const fields = Object.fromEntries(sections.flatMap((section) => section.fields.map(({ label, value }) => [label, value])))
  assert.equal(fields.Title, 'Blue backpack')
  assert.equal(fields.Category, 'BAGS')
  assert.equal(fields.Description, 'Small stitched patch on the front pocket')
  assert.equal(fields.Colour, 'Blue')
  assert.equal(fields.Brand, 'Generic')
  assert.equal(fields.Model, 'Trail 20L')
  assert.equal(fields.pattern, 'mountain patch')
  assert.equal(fields.Latitude, '12.97')
  assert.equal(fields.Longitude, '79.16')
  assert.equal(fields['Uncertainty radius'], '80 m')
  assert.equal(fields['Location accuracy'], 'Not provided')
  assert.equal(fields['Report type'], 'FOUND')
  assert.equal(fields.Status, 'OPEN')
  assert.notEqual(fields['Submitted date and time'], 'Not recorded')
})

test('missing coordinates and private-looking custom attributes are handled safely', () => {
  const [items, location] = getReportDetailSections({
    report_id: 43,
    item_attributes: {
      serial_number_private: 'do-not-render',
      reviewer_note: 'also-private',
      api_token: 'also-secret',
      proof_attachment: 'private-proof',
      custom_mark: 'red thread',
    },
  })
  const itemFields = Object.fromEntries(items.fields.map(({ label, value }) => [label, value]))
  const locationFields = Object.fromEntries(location.fields.map(({ label, value }) => [label, value]))
  assert.equal(itemFields['custom mark'], 'red thread')
  assert.equal('serial number private' in itemFields, false)
  assert.equal('reviewer note' in itemFields, false)
  assert.equal('api token' in itemFields, false)
  assert.equal('proof attachment' in itemFields, false)
  assert.equal(locationFields.Latitude, 'Not provided')
  assert.equal(locationFields.Longitude, 'Not provided')
})

test('Escape closes the details viewer and other keys do not', () => {
  let closeCount = 0
  let prevented = false
  handleReportDetailsKeyDown({ key: 'Enter', preventDefault() { prevented = true } }, () => { closeCount += 1 })
  assert.equal(closeCount, 0)
  assert.equal(prevented, false)
  handleReportDetailsKeyDown({ key: 'Escape', preventDefault() { prevented = true } }, () => { closeCount += 1 })
  assert.equal(closeCount, 1)
  assert.equal(prevented, true)
})
