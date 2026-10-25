import { useEffect, useRef, useState } from 'react'
import { getFoundReportPhotos, getPrivatePhoto } from '../api'
import {
  activateReportDetails,
  getReportDetailSections,
  handleReportDetailsKeyDown,
} from '../reportDetails'
import './ReportDetailsViewer.css'

export function ReportDetailsButton({ report, onOpen }) {
  return (
    <button
      type="button"
      className="report-details-button"
      aria-label="View report details"
      title="View report details"
      onClick={(event) => activateReportDetails(event, report, onOpen)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2.2 12s3.4-6 9.8-6 9.8 6 9.8 6-3.4 6-9.8 6-9.8-6-9.8-6Z" />
        <circle cx="12" cy="12" r="2.7" />
      </svg>
    </button>
  )
}

function ReportPhotos({ token, report }) {
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(report.report_type === 'FOUND')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const urls = []
    async function load() {
      try {
        const listing = await getFoundReportPhotos(token, report.report_id)
        const loaded = await Promise.all((listing.photos || []).map(async (photo) => {
          const blob = await getPrivatePhoto(token, photo.photoId, null, report.report_id)
          const url = URL.createObjectURL(blob)
          urls.push(url)
          return { ...photo, url }
        }))
        if (cancelled) urls.forEach((url) => URL.revokeObjectURL(url))
        else setPhotos(loaded)
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Could not load this report’s private photos.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (report.report_type === 'FOUND') void load()
    return () => {
      cancelled = true
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [token, report.report_id, report.report_type])

  if (report.report_type !== 'FOUND') return null
  return (
    <section className="report-details-photos" aria-labelledby="report-details-photos-title">
      <h3 id="report-details-photos-title">Authorized photos</h3>
      {loading && <p role="status">Loading your private photos…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && photos.length === 0 && <p>No photos were uploaded for this report.</p>}
      <div className="report-details-photo-grid">
        {photos.map((photo) => (
          <figure key={photo.photoId}>
            <img src={photo.url} alt={`${String(photo.photoType || 'Item').replaceAll('_', ' ').toLowerCase()} view of your reported item`} />
            <figcaption>{String(photo.photoType || 'Item photo').replaceAll('_', ' ')}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

export default function ReportDetailsViewer({ report, token, onClose }) {
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)
  const sections = getReportDetailSections(report)

  useEffect(() => {
    closeButtonRef.current?.focus()
    function onKeyDown(event) {
      handleReportDetailsKeyDown(event, onClose)
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="modal-backdrop report-details-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="report-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-details-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <button ref={closeButtonRef} type="button" className="modal-close" onClick={onClose} aria-label="Close report details">×</button>
        <span className="section-kicker">MY REPORT</span>
        <h2 id="report-details-title">Report details</h2>
        <div className="report-details-sections">
          {sections.map((section) => (
            <section className="report-details-section" key={section.title} aria-labelledby={`report-details-${section.title.replaceAll(' ', '-').toLowerCase()}`}>
              <h3 id={`report-details-${section.title.replaceAll(' ', '-').toLowerCase()}`}>{section.title}</h3>
              <dl>
                {section.fields.map((field) => (
                  <div key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <ReportPhotos token={token} report={report} />
      </section>
    </div>
  )
}
