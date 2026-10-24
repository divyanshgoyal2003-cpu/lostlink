import { useEffect, useState } from 'react'
import { getClaimConversation, sendClaimConversationMessage } from '../api'
import './ConversationPanel.css'

function ConversationPanel({ token, claimId, title = 'Conversation' }) {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    if (!token || !claimId) return
    setLoading(true)
    setError('')
    try {
      const result = await getClaimConversation(token, claimId)
      setMessages(result.messages || [])
    } catch (loadError) {
      setError(loadError.message || 'Conversation is not available.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [token, claimId])

  async function send(event) {
    event.preventDefault()
    if (!draft.trim() || sending) return
    setSending(true)
    setError('')
    try {
      await sendClaimConversationMessage(token, claimId, draft)
      setDraft('')
      const result = await getClaimConversation(token, claimId)
      setMessages(result.messages || [])
    } catch (sendError) {
      setError(sendError.message || 'Could not send this message.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="claim-conversation" aria-label={title}>
      <div className="claim-conversation-heading">
        <h4>{title}</h4>
        <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh messages'}
        </button>
      </div>
      {loading ? <p role="status">Loading conversation…</p> : (
        <div className="claim-conversation-messages" aria-live="polite">
          {messages.length ? messages.map((message) => (
            <article className={`conversation-message${message.isYou ? ' is-you' : ''}`} key={message.messageId}>
              <div><strong>{message.isYou ? 'You' : message.senderName}</strong><time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString()}</time></div>
              <p>{message.body}</p>
            </article>
          )) : <p>No messages yet. Send a message to start the conversation.</p>}
        </div>
      )}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <form onSubmit={send} className="claim-conversation-form">
        <label htmlFor={`conversation-message-${claimId}`}>Message</label>
        <textarea id={`conversation-message-${claimId}`} maxLength={2000} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} required />
        <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()}>
          {sending ? 'Sending…' : 'Send message'}
        </button>
      </form>
    </section>
  )
}

export default ConversationPanel
