import { useEffect, useState } from 'react'
import { getConversationInbox } from '../api'
import ConversationPanel from './ConversationPanel'
import './ConversationInbox.css'

export default function ConversationInbox({ token }) {
  const [conversations, setConversations] = useState([])
  const [selectedClaim, setSelectedClaim] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const load = () => getConversationInbox(token).then((result) => { if (active) setConversations(result.conversations || []) }).catch((e) => { if (active) setError(e.message || 'Unable to load inbox') })
    void load()
    const timer = window.setInterval(load, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [token])
  if (!token) return null
  return <section className="conversation-inbox">
    <h3>Messages</h3>
    {error && <p role="alert">{error}</p>}
    {!conversations.length ? <p>No open conversations yet.</p> : <div className="conversation-inbox-list">
      {conversations.map((conversation) => <button type="button" className="conversation-inbox-item" key={conversation.claimId} onClick={() => setSelectedClaim(String(conversation.claimId))}>
        <strong>{conversation.itemTitle}</strong><span>{conversation.counterpartName || 'Recovery participant'} · {conversation.participantType === 'CLAIMANT' ? 'Claimant' : conversation.participantType === 'AUTHORITY' ? 'Authority case' : 'Finder'}</span>
        <small>{conversation.latestMessage || 'No messages yet'} · {new Date(conversation.latestMessageAt).toLocaleString()}</small>
        {conversation.unreadCount > 0 && <b aria-label={`${conversation.unreadCount} unread messages`}>{conversation.unreadCount} unread</b>}
      </button>)}
    </div>}
    {selectedClaim && <ConversationPanel token={token} claimId={selectedClaim} title="Conversation" />}
  </section>
}
