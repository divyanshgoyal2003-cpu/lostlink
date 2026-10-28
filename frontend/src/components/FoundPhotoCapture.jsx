import { useEffect, useRef, useState } from 'react'
import { getFoundReportPhotos, getPrivatePhoto, uploadFoundReportPhoto } from '../api'
import './FoundPhotoCapture.css'

const CAPTURE_STEPS = [
  { type: 'FRONT', label: 'Front', required: true },
  { type: 'BACK', label: 'Back', required: true },
  { type: 'SIDE', label: 'Side', required: true },
  { type: 'DISTINGUISHING_DETAIL', label: 'Distinguishing detail', required: false },
]
const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function FoundPhotoCapture({ token, report }) {
  const editable = report.status === 'OPEN'
  const [photos, setPhotos] = useState([])
  const [previews, setPreviews] = useState({})
  const [loading, setLoading] = useState(true)
  const [photosLoaded, setPhotosLoaded] = useState(false)
  const [photosVisible, setPhotosVisible] = useState(false)
  const [uploading, setUploading] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [cameraStep, setCameraStep] = useState(null)
  const [cameraError, setCameraError] = useState('')
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  async function loadPhotos() {
    setLoading(true)
    setError('')
    try {
      const result = await getFoundReportPhotos(token, report.report_id)
      setPhotos(result.photos || [])
      const previewUrls = await Promise.all((result.photos || []).map(async (photo) => ({
        type: photo.photoType,
        url: URL.createObjectURL(await getPrivatePhoto(token, photo.photoId, null, report.report_id)),
      })))
      setPreviews(Object.fromEntries(previewUrls.map(({ type, url }) => [type, url])))
      setPhotosLoaded(true)
    } catch (loadError) {
      setError(loadError.message || 'Could not load your private photos.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!photosVisible || photosLoaded) return undefined
    loadPhotos()
    // Load only after the owner opens the panel; file changes use the event handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, report.report_id, photosLoaded, photosVisible])

  useEffect(() => () => Object.values(previews).forEach((url) => URL.revokeObjectURL(url)), [previews])

  useEffect(() => {
    if (!cameraStep) return undefined
    let cancelled = false
    setCameraError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access is unavailable. Use Upload photo, or open this page in a browser that supports camera access over HTTPS or localhost.')
      return undefined
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => setCameraError('Could not start the camera preview. Check browser camera permissions.'))
        }
      })
      .catch(() => setCameraError('Could not access the camera. Allow camera permission in your browser, then try again.'))
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [cameraStep])

  function capturePhoto() {
    const video = videoRef.current
    if (!video?.videoWidth || !video?.videoHeight || !cameraStep) {
      setCameraError('Wait for the camera preview, then take the photo.')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) {
        setCameraError('Could not capture the photo. Please try again.')
        return
      }
      const file = new File([blob], `${cameraStep.type.toLowerCase()}-capture.jpg`, { type: 'image/jpeg' })
      const step = cameraStep
      setCameraStep(null)
      handleFile(step, file)
    }, 'image/jpeg', 0.92)
  }

  async function handleFile(step, file) {
    if (!file) return
    setError('')
    setMessage('')
    if (!ALLOWED_TYPES.has(file.type) || file.size > MAX_BYTES || file.size === 0) {
      setError('Choose a non-empty JPEG, PNG, or WebP image no larger than 8 MB.')
      return
    }
    setUploading(step.type)
    try {
      const result = await uploadFoundReportPhoto(token, report.report_id, step.type, file)
      setPhotos((previous) => [
        ...(previous.filter((photo) => photo.photoType !== step.type)),
        result.photo,
      ])
      setPreviews((previous) => {
        if (previous[step.type]) URL.revokeObjectURL(previous[step.type])
        return { ...previous, [step.type]: URL.createObjectURL(file) }
      })
      setMessage(`${step.label} photo saved privately. You can replace it at any time.`)
    } catch (uploadError) {
      setError(uploadError.message || `Could not save the ${step.label.toLowerCase()} photo.`)
    } finally {
      setUploading('')
    }
  }

  const completedRequired = CAPTURE_STEPS.filter((step) => step.required && photos.some((photo) => photo.photoType === step.type)).length
  return (
    <section className="found-photo-capture" aria-label="Private found-item photos">
      <div className="photo-capture-heading">
        <div className="photo-capture-heading-row">
          <h4>Private item photos</h4>
          <button
            type="button"
            className="btn btn-secondary photo-capture-toggle"
            aria-expanded={photosVisible}
            aria-controls={`found-photo-capture-content-${report.report_id}`}
            onClick={() => {
              if (photosVisible) setCameraStep(null)
              setPhotosVisible((visible) => !visible)
            }}
          >
            {photosVisible ? 'Hide photos' : 'Show photos'}
          </button>
        </div>
        <p>Only you can view these photos until you explicitly share them for a specific claim.</p>
        <p className="photo-capture-progress" role="status">
          {photosLoaded ? `Required views: ${completedRequired}/3` : 'Photos stay hidden until you choose to show them.'}
        </p>
      </div>
      <div id={`found-photo-capture-content-${report.report_id}`} hidden={!photosVisible}>
      {photosVisible && loading ? <p role="status">Loading private photos…</p> : photosVisible && (
        <div className="photo-capture-steps">
          {CAPTURE_STEPS.map((step) => {
            const existing = photos.find((photo) => photo.photoType === step.type)
            const preview = previews[step.type]
            return (
              <div className="photo-capture-step" key={step.type}>
                <strong>{step.label}{step.required ? ' · Required' : ' · Optional'}</strong>
                {existing && preview && <img src={preview} alt={`${step.label} view of your found item`} />}
                {editable ? (
                  <div className="photo-capture-actions">
                    <button type="button" className="btn btn-primary" disabled={Boolean(uploading)} onClick={() => setCameraStep(step)}>
                      {uploading === step.type ? 'Saving…' : existing ? `Retake ${step.label.toLowerCase()}` : `Take ${step.label.toLowerCase()} photo`}
                    </button>
                    <label className="btn btn-secondary photo-upload-button">
                      Upload photo
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      aria-label={`${existing ? 'Replace' : 'Add'} ${step.label} photo`}
                      disabled={Boolean(uploading)}
                      onChange={(event) => {
                        handleFile(step, event.target.files?.[0])
                        event.target.value = ''
                      }}
                    />
                    </label>
                  </div>
                ) : <small>Read only while this report is not open.</small>}
                {existing && <span className="photo-step-saved">Saved privately</span>}
              </div>
            )
          })}
        </div>
      )}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {cameraStep && (
        <div className="photo-camera-backdrop" role="presentation">
          <section className="photo-camera-dialog" role="dialog" aria-modal="true" aria-labelledby="photo-camera-title">
            <h4 id="photo-camera-title">Take {cameraStep.label.toLowerCase()} photo</h4>
            <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" />
            {cameraError && <p className="auth-error" role="alert">{cameraError}</p>}
            <div className="photo-camera-actions">
              <button type="button" className="btn btn-primary" onClick={capturePhoto}>Capture photo</button>
              <button type="button" className="btn btn-secondary" onClick={() => setCameraStep(null)}>Cancel</button>
            </div>
            <small>Camera access is used only to capture this photo for private upload.</small>
          </section>
        </div>
      )}
      {message && <p className="claim-feedback" role="status">{message}</p>}
      {completedRequired === 3 && <p className="photo-capture-complete" role="status">Guided capture complete. Photos remain private by default.</p>}
      {completedRequired < 3 && <small>Complete Front, Back, and Side before guided capture is complete. Photos are never shared by uploading, matching, claiming, or opening a conversation.</small>}
      </div>
    </section>
  )
}

export default FoundPhotoCapture
