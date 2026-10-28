import { useEffect, useState } from 'react'
import { getClaimPhotoAccess, getPrivatePhoto, grantClaimPhotoAccess, revokeClaimPhotoAccess } from '../api'
import './ClaimPhotoAccess.css'

function ClaimPhotoAccess({ token, claimId, onRefresh, onStartChat, chatStarting = false, chatError = '', chatFeedback = '' }) {
  const [access, setAccess] = useState(null)
  const [photoUrls, setPhotoUrls] = useState([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function loadAccess() {
    setLoading(true)
    setError('')
    setPhotoUrls([])
    try {
      const result = await getClaimPhotoAccess(token, claimId)
      setAccess(result)
      const urls = await Promise.all((result.photos || []).map(async (photo) => ({
        ...photo,
        url: URL.createObjectURL(await getPrivatePhoto(token, photo.photoId, claimId)),
      })))
      setPhotoUrls(urls)
    } catch (loadError) {
      setError(loadError.message || 'Could not load private photo access.')
      setPhotoUrls([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAccess()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, claimId])

  useEffect(() => {
    function refreshAfterChatOpens(event) {
      if (String(event.detail?.claimId) === String(claimId)) void loadAccess()
    }
    window.addEventListener('lostlink:claim-conversation-opened', refreshAfterChatOpens)
    return () => window.removeEventListener('lostlink:claim-conversation-opened', refreshAfterChatOpens)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, claimId])

  useEffect(() => () => photoUrls.forEach((photo) => URL.revokeObjectURL(photo.url)), [photoUrls])

  async function handleGrant() {
    const accepted = window.confirm(
      'Share the found-item photos with the claimant for this claim? Only this claimant will get access. You can revoke access later.',
    )
    if (!accepted) return
    setPending(true)
    setError('')
    try {
      await grantClaimPhotoAccess(token, claimId)
      await loadAccess()
      await onRefresh?.()
    } catch (grantError) {
      setError(grantError.message || 'Could not share photos.')
    } finally {
      setPending(false)
    }
  }

  async function handleRevoke() {
    const accepted = window.confirm('Revoke this claimant’s photo access now? Future photo requests will be denied.')
    if (!accepted) return
    setPending(true)
    setError('')
    try {
      await revokeClaimPhotoAccess(token, claimId)
      await loadAccess()
      await onRefresh?.()
    } catch (revokeError) {
      setError(revokeError.message || 'Could not revoke photo access.')
    } finally {
      setPending(false)
    }
  }

  if (loading) return <p className="claim-photo-state" role="status">Checking photo-sharing permission…</p>
  return (
    <section className="claim-photo-access" aria-label={`Photo sharing for claim ${claimId}`}>
      <div className="claim-photo-access-heading">
        <strong>Found-item photos: {access?.sharingStatus === 'SHARED' ? 'Shared for this claim' : 'Private'}</strong>
        {access?.sharingStatus === 'SHARED' && <small>The claimant on this claim can view these photos securely.</small>}
        {access?.canManage && access?.sharingStatus !== 'SHARED' && !access?.conversationOpen && <small>Start a chat with the claimant first. Photos stay private until you share them separately below.</small>}
        {access?.canManage && access?.sharingStatus !== 'SHARED' && access?.conversationOpen && !access?.requiredViewsComplete && <small>Complete the Front, Back, and Side capture before sharing.</small>}
        {!access?.canManage && access?.sharingStatus !== 'SHARED' && <small>The finder or assigned authority must explicitly share photos for this claim.</small>}
      </div>
      <button type="button" className="btn btn-secondary" disabled={loading || pending} onClick={loadAccess}>
        {loading ? 'Refreshing…' : 'Refresh photo access'}
      </button>
      {access?.canManage && access?.sharingStatus !== 'SHARED' && !access?.conversationOpen && onStartChat && (
        <div className="claim-photo-chat-action">
          <button type="button" className="btn btn-primary" disabled={chatStarting} onClick={onStartChat}>
            {chatStarting ? 'Starting chat…' : 'Start chat with claimant'}
          </button>
          {chatError && <p className="auth-error" role="alert">{chatError}</p>}
          {chatFeedback && <p className="claim-feedback" role="status">{chatFeedback}</p>}
        </div>
      )}
      {access?.photos?.length > 0 && photoUrls.length > 0 && (
        <div className="claim-photo-gallery">
          {photoUrls.map((photo) => (
            <figure key={photo.photoId}>
              <img src={photo.url} alt={`${photo.photoType.replaceAll('_', ' ').toLowerCase()} view of found item`} />
              <figcaption>{photo.photoType.replaceAll('_', ' ').toLowerCase()}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {access?.canManage && access?.sharingStatus !== 'SHARED' && (
        <button type="button" className="btn btn-primary" disabled={pending || !access?.canGrant} onClick={handleGrant}>
          {pending ? 'Updating…' : 'Share photos with claimant'}
        </button>
      )}
      {access?.canRevoke && (
        <button type="button" className="btn btn-secondary" disabled={pending} onClick={handleRevoke}>
          {pending ? 'Updating…' : 'Revoke photo access'}
        </button>
      )}
      {access?.sharingStatus === 'SHARED' && !access.canRevoke && <small>These photos are shared only with the claimant on this claim.</small>}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </section>
  )
}

export default ClaimPhotoAccess
