import { useCallback, useEffect, useRef, useState } from 'react'
import { createProofRequest, downloadConversationProof, getClaimConversation, markConversationRead, reportChatUser, reviewProofRequest, sendClaimConversationMessage, uploadConversationProof } from '../api'
import { startConversationPolling } from '../conversationPolling'
import './ConversationPanel.css'
import './ChatModeration.css'

function ConversationPanel({ token, claimId, title = 'Conversation' }) {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [proofRequests, setProofRequests] = useState([])
  const [canRequestProof, setCanRequestProof] = useState(false)
  const [proofCategory, setProofCategory] = useState('PURCHASE_RECEIPT')
  const [proofText, setProofText] = useState('')
  const [uploading, setUploading] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [pendingMessageId, setPendingMessageId] = useState('')
  const [reportingMessageId, setReportingMessageId] = useState('')
  const [reportCategory, setReportCategory] = useState('ABUSIVE_LANGUAGE')
  const [reportDetails, setReportDetails] = useState('')
  const [reporting, setReporting] = useState(false)
  const [reportMessage, setReportMessage] = useState('')
  const [reportError, setReportError] = useState('')
  const lastReadMessageId = useRef('')

  const load = useCallback(async () => {
    if (!token || !claimId) return
    try {
      const result = await getClaimConversation(token, claimId)
      setMessages(result.messages || [])
      setHasMore(Boolean(result.hasMore))
      setProofRequests(result.proofRequests || [])
      setCanRequestProof(Boolean(result.canRequestProof))
      const last = result.messages?.at(-1)
      const readKey = last ? `${claimId}:${last.messageId}` : ''
      if (last && readKey !== lastReadMessageId.current) {
        lastReadMessageId.current = readKey
        await markConversationRead(token, claimId, last.messageId).catch(() => {})
      }
      return true
    } catch (loadError) {
      setError(loadError.message || 'Conversation is not available.')
      return loadError.status !== 401 && loadError.status !== 403
    } finally {
      setLoading(false)
    }
  }, [token, claimId])

  useEffect(() => {
    if (!token || !claimId) return undefined
    const poller = startConversationPolling(load, { intervalMs: 5000 })
    void poller.poll()
    return () => poller.stop()
  }, [load, token, claimId])

  async function send(event) {
    event.preventDefault()
    if (!draft.trim() || sending) return
    setSending(true)
    setError('')
    const clientMessageId = pendingMessageId || crypto.randomUUID()
    setPendingMessageId(clientMessageId)
    try {
      await sendClaimConversationMessage(token, claimId, draft, clientMessageId)
      setPendingMessageId('')
      setDraft('')
      const result = await getClaimConversation(token, claimId)
      setMessages(result.messages || [])
    } catch (sendError) {
      setError(sendError.message || 'Could not send this message.')
    } finally {
      setSending(false)
    }
  }

  async function loadOlder() {
    const first = messages[0]
    if (!first || !hasMore) return
    setLoading(true)
    try {
      const result = await getClaimConversation(token, claimId, { beforeMessageId: first.messageId, limit: 50 })
      setMessages((current) => [...(result.messages || []), ...current])
      setHasMore(Boolean(result.hasMore))
    } catch (loadError) { setError(loadError.message || 'Could not load earlier messages.') }
    finally { setLoading(false) }
  }

  async function requestProof(event) {
    event.preventDefault()
    if (!proofText.trim()) return
    setSending(true); setError('')
    try { await createProofRequest(token, claimId, { category: proofCategory, text: proofText }); setProofText(''); await load() }
    catch (requestError) { setError(requestError.message || 'Could not request proof.') }
    finally { setSending(false) }
  }

  async function submitProof(requestId, file) {
    if (!file) return
    setUploading(String(requestId)); setError('')
    try { await uploadConversationProof(token, requestId, file, '', claimId); await load() }
    catch (uploadError) { setError(uploadError.message || 'Could not upload proof.') }
    finally { setUploading('') }
  }

  async function openAttachment(attachmentId) {
    try { const blob = await downloadConversationProof(token, attachmentId); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'ownership-proof'; a.click(); URL.revokeObjectURL(url) }
    catch (downloadError) { setError(downloadError.message) }
  }

  async function setProofStatus(requestId, status) {
    try { await reviewProofRequest(token, requestId, status); await load() }
    catch (statusError) { setError(statusError.message || 'Could not update proof request.') }
  }

  async function submitUserReport(event, message) {
    event.preventDefault()
    if (reporting) return
    setReporting(true)
    setReportError('')
    setReportMessage('')
    try {
      await reportChatUser(token, claimId, {
        messageId: message.messageId,
        category: reportCategory,
        details: reportDetails.trim(),
      })
      setMessages((current) => current.map((item) => String(item.messageId) === String(message.messageId)
        ? { ...item, reportedByYou: true }
        : item))
      setReportingMessageId('')
      setReportDetails('')
      setReportMessage('Report submitted privately for review.')
    } catch (submitError) {
      setReportError(submitError.message || 'Could not submit this report.')
    } finally {
      setReporting(false)
    }
  }

  const timeline = [
    ...messages.map((message) => ({ ...message, type: 'MESSAGE', eventAt: message.sentAt })),
    ...proofRequests.map((request) => ({ ...request, type: 'PROOF_REQUEST', eventAt: request.createdAt })),
  ].sort((a, b) => new Date(a.eventAt) - new Date(b.eventAt) || Number(a.messageId || a.requestId) - Number(b.messageId || b.requestId))

  return (
    <section className="claim-conversation" aria-label={title}>
      <div className="claim-conversation-heading">
        <h4>{title}</h4>
        <button type="button" className="btn btn-secondary" onClick={() => { setLoading(true); void load() }} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh messages'}
        </button>
      </div>
      {loading ? <p role="status">Loading conversation…</p> : (
        <div className="claim-conversation-messages" aria-live="polite">
          {hasMore && <button type="button" className="btn btn-secondary" onClick={() => void loadOlder()} disabled={loading}>Load earlier messages</button>}
          {timeline.length ? timeline.map((entry) => entry.type === 'MESSAGE' ? (
            <article className={`conversation-message${entry.isYou ? ' is-you' : ''}`} key={`message-${entry.messageId}`}>
              <div><strong>{entry.isYou ? 'You' : entry.senderName}</strong><span><time dateTime={entry.sentAt}>{new Date(entry.sentAt).toLocaleString()}</time>{entry.isYou && <small>{entry.readByOther ? ' · Read' : ' · Sent'}</small>}</span></div>
              <p>{entry.body}</p>
              {!entry.isYou && (
                entry.reportedByYou
                  ? <small className="chat-report-submitted">You reported this message.</small>
                  : <div className="chat-report-control">
                    <button
                      type="button"
                      className="chat-report-toggle"
                      aria-expanded={reportingMessageId === String(entry.messageId)}
                      onClick={() => {
                        setReportingMessageId((current) => current === String(entry.messageId) ? '' : String(entry.messageId))
                        setReportError('')
                        setReportMessage('')
                      }}
                    >Report rude or abusive message</button>
                    {reportingMessageId === String(entry.messageId) && (
                      <form className="chat-report-form" onSubmit={(event) => void submitUserReport(event, entry)}>
                        <p>Use this for cuss words, rude or harassing speech. Reports are private and reviewed by LostLink administrators.</p>
                        <label htmlFor={`chat-report-reason-${entry.messageId}`}>Reason</label>
                        <select id={`chat-report-reason-${entry.messageId}`} value={reportCategory} onChange={(event) => setReportCategory(event.target.value)}>
                          <option value="ABUSIVE_LANGUAGE">Cuss words or abusive language</option>
                          <option value="RUDE_OR_HARASSING">Rude or harassing behavior</option>
                        </select>
                        <label htmlFor={`chat-report-details-${entry.messageId}`}>Additional context (optional)</label>
                        <textarea id={`chat-report-details-${entry.messageId}`} rows={2} maxLength={500} value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} />
                        <button className="btn btn-secondary" type="submit" disabled={reporting}>
                          {reporting ? 'Submitting report…' : 'Submit report'}
                        </button>
                        {reportError && <p className="auth-error" role="alert">{reportError}</p>}
                      </form>
                    )}
                  </div>
              )}
            </article>
          ) : (
            <article className="conversation-message" key={`proof-${entry.requestId}`}>
              <strong>Proof request · {entry.category.replaceAll('_', ' ')}</strong>
              <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
              <p>{entry.text}</p><small>Status: {entry.status.replaceAll('_', ' ')}</small>
              {entry.canUpload && <label>Upload requested proof<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={uploading === String(entry.requestId)} onChange={(event) => void submitProof(entry.requestId, event.target.files?.[0])} /></label>}
              {entry.attachments?.map((attachment) => <p key={attachment.attachmentId}>Evidence submitted · {Math.ceil(attachment.byteSize / 1024)} KB <button type="button" onClick={() => void openAttachment(attachment.attachmentId)}>Download securely</button></p>)}
              {entry.isRequester && entry.status === 'SUBMITTED' && <div><button type="button" onClick={() => void setProofStatus(entry.requestId, 'ACCEPTED')}>Accept evidence for review</button><button type="button" onClick={() => void setProofStatus(entry.requestId, 'NEEDS_MORE_INFORMATION')}>Request more information</button></div>}
            </article>
          )) : <p>No messages yet. Send a message to start the conversation.</p>}
        </div>
      )}
      {canRequestProof && <form className="claim-conversation-form" onSubmit={requestProof}>
        <label>Request proof<select value={proofCategory} onChange={(event) => setProofCategory(event.target.value)}><option value="PURCHASE_RECEIPT">Purchase receipt or invoice</option><option value="PRE_LOSS_PHOTO">Photo from before the item was lost</option><option value="DISTINGUISHING_MARK">Photo of a distinguishing mark</option><option value="PACKAGING_LABEL_SERIAL">Packaging, label, or model identification</option><option value="OTHER">Other ownership evidence</option></select></label>
        <textarea value={proofText} maxLength={500} onChange={(event) => setProofText(event.target.value)} placeholder="Describe the specific evidence needed" required />
        <button className="btn btn-secondary" type="submit" disabled={sending || !proofText.trim()}>Request proof</button>
      </form>}
      {uploading && <p role="status">Uploading requested proof…</p>}
      {reportMessage && <p className="claim-feedback" role="status">{reportMessage}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <form onSubmit={send} className="claim-conversation-form">
        <label htmlFor={`conversation-message-${claimId}`}>Message</label>
        <textarea id={`conversation-message-${claimId}`} maxLength={2000} rows={3} value={draft} onChange={(event) => { if (event.target.value !== draft) setPendingMessageId(''); setDraft(event.target.value) }} required />
        <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()}>
          {sending ? 'Sending…' : 'Send message'}
        </button>
      </form>
    </section>
  )
}

export default ConversationPanel
