import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNotifications,
  getUnreadNotificationCount,
  clearAllNotifications,
  deleteNotification,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api'
import './NotificationCenter.css'
import { startNotificationPolling } from '../notificationPolling'

const configuredPollMs = Number(import.meta.env.VITE_NOTIFICATION_POLL_INTERVAL_MS)
const NOTIFICATION_POLL_MS = Number.isInteger(configuredPollMs) && configuredPollMs >= 30000 && configuredPollMs <= 300000
  ? configuredPollMs
  : 60000

const DESCRIPTIONS = {
  MATCH_FOUND: 'A new possible match is available for one of your lost reports.',
  CLAIM_SUBMITTED: 'Your claim was submitted.',
  NEW_CLAIM: 'A new claim was submitted for a found item you reported.',
  NEW_AUTHORITY_CLAIM: 'A new claim is waiting for your authority team to review.',
  CLAIM_IN_REVIEW: 'Your claim is now under review.',
  CLAIM_VERIFICATION_PASSED: 'Ownership verification passed; a reviewer must still make the claim decision.',
  CLAIM_VERIFICATION_FAILED: 'A reviewer marked ownership verification as failed. Check My Claims for the current claim status.',
  CLAIM_VERIFICATION_UPDATED: 'A reviewer updated ownership verification. Check My Claims for the latest claim status.',
  CLAIM_APPROVED: 'Your claim was approved.',
  CLAIM_REJECTED: 'Your claim was rejected.',
  CLAIM_CHAT_ENABLED: 'Chat is enabled for your claim. Open My Claims to continue.',
  NEW_CLAIM_MESSAGE: 'You received a new message in a claim conversation.',
  PROOF_REQUESTED: 'A reviewer requested ownership evidence in your claim conversation.',
  PROOF_ACCEPTED: 'The proof you submitted was accepted. Check the claim conversation for the next step.',
  PROOF_MORE_INFORMATION: 'More information was requested for your proof. Open the claim conversation for instructions.',
  PROOF_REQUEST_CANCELLED: 'A proof request in your claim conversation was cancelled.',
  PROOF_SUBMITTED: 'A claimant submitted requested proof in the claim conversation.',
  AUTHORITY_MEMBERSHIP_APPROVED: 'Your authority membership was approved.',
  AUTHORITY_MEMBERSHIP_REJECTED: 'Your authority membership request was not approved.',
  AUTHORITY_CASE_ASSIGNED: 'A found-item case was assigned to your authority.',
  CUSTODY_TRANSFER_INITIATED: 'A found item is awaiting your authority’s physical receipt confirmation.',
  CUSTODY_TRANSFER_RECEIVED: 'The authority confirmed physical receipt of a found item.',
  HANDOVER_CODE_READY: 'A claimant generated a return code. Coordinate the in-person handover; the code is not included here.',
  HANDOVER_COMPLETED: 'The item handover is complete.',
}

function NotificationCenter({ token }) {
  const centerRef = useRef(null)
  const touchStartX = useRef(null)
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)
  const [readingIds, setReadingIds] = useState(() => new Set())
  const [swipedId, setSwipedId] = useState('')
  const refreshInFlight = useRef(new Set())
  const currentToken = useRef(token)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { currentToken.current = token }, [token])

  useEffect(() => {
    if (!open) return undefined
    function dismissOutside(event) {
      if (!centerRef.current?.contains(event.target)) {
        setOpen(false)
        setSwipedId('')
      }
    }
    function dismissOnEscape(event) {
      if (event.key === 'Escape') {
        setOpen(false)
        setSwipedId('')
      }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  const refresh = useCallback(async (includeList = open) => {
    if (!token || refreshInFlight.current.has(token)) return
    refreshInFlight.current.add(token)
    try {
      const countResult = await getUnreadNotificationCount(token)
      if (!mounted.current || currentToken.current !== token) return
      setUnreadCount(countResult.unreadCount)
      if (includeList) {
        setLoading(true)
        const listResult = await getNotifications(token)
        if (!mounted.current || currentToken.current !== token) return
        setNotifications(listResult.notifications || [])
      }
      setError('')
    } catch (loadError) {
      if (mounted.current && currentToken.current === token) setError(loadError.message || 'Could not load notifications.')
    } finally {
      if (mounted.current && currentToken.current === token) setLoading(false)
      refreshInFlight.current.delete(token)
    }
  }, [token, open])

  useEffect(() => {
    const poller = startNotificationPolling(() => refresh(open), {
      intervalMs: NOTIFICATION_POLL_MS,
      isAuthenticated: () => Boolean(token),
      isVisible: () => document.visibilityState === 'visible',
    })
    void poller.poll()
    const handleRefresh = () => refresh(open)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') handleRefresh()
    }
    window.addEventListener('lostlink:notifications-refresh', handleRefresh)
    window.addEventListener('focus', handleRefresh)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('lostlink:notifications-refresh', handleRefresh)
      window.removeEventListener('focus', handleRefresh)
      document.removeEventListener('visibilitychange', handleVisibility)
      poller.stop()
    }
  }, [open, refresh, token])

  async function togglePanel() {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) await refresh(true)
  }

  async function markRead(notification) {
    const id = String(notification.notification_id)
    if (notification.read_at || readingIds.has(id)) return
    setReadingIds((previous) => new Set(previous).add(id))
    try {
      const result = await markNotificationRead(token, notification.notification_id)
      const readAt = result.notification.read_at
      setNotifications((previous) => previous.map((item) => String(item.notification_id) === id ? { ...item, read_at: item.read_at || readAt } : item))
      setUnreadCount((previous) => Math.max(0, previous - 1))
      if (notification.navigation_target) setOpen(false)
    } catch (markError) {
      setError(markError.message || 'Could not update notification.')
    } finally {
      setReadingIds((previous) => { const next = new Set(previous); next.delete(id); return next })
    }
  }

  async function markAllRead() {
    if (markingAll || unreadCount === 0) return
    setMarkingAll(true)
    try {
      await markAllNotificationsRead(token)
      const readAt = new Date().toISOString()
      setNotifications((previous) => previous.map((item) => ({ ...item, read_at: item.read_at || readAt })))
      setUnreadCount(0)
    } catch (markError) {
      setError(markError.message || 'Could not update notifications.')
    } finally {
      setMarkingAll(false)
    }
  }

  async function clearAll() {
    if (notifications.length === 0 || clearing) return
    if (!window.confirm('Clear all notifications? This removes them from your notification history.')) return
    setClearing(true)
    setError('')
    try {
      await clearAllNotifications(token)
      setNotifications([])
      setUnreadCount(0)
    } catch (clearError) {
      setError(clearError.message || 'Could not clear notifications.')
    } finally {
      setClearing(false)
    }
  }

  async function clearOne(notification) {
    const id = String(notification.notification_id)
    if (clearing) return
    setClearing(true)
    setError('')
    try {
      await deleteNotification(token, notification.notification_id)
      setNotifications((previous) => previous.filter((item) => String(item.notification_id) !== id))
      if (!notification.read_at) setUnreadCount((previous) => Math.max(0, previous - 1))
      setSwipedId('')
    } catch (clearError) {
      setError(clearError.message || 'Could not clear notification.')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="notification-center" ref={centerRef}>
      <button type="button" className="btn btn-ghost notification-toggle" aria-expanded={open} aria-controls="notification-panel" onClick={togglePanel}>
        Notifications
        {unreadCount > 0 && <span className="notification-badge" aria-label={`${unreadCount} unread`}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <section className="notification-panel" id="notification-panel" aria-label="Notifications">
          <div className="notification-panel-heading">
            <h2>Notifications</h2>
            <div className="notification-actions">
              <button type="button" className="btn btn-ghost" onClick={markAllRead} disabled={unreadCount === 0 || markingAll}>{markingAll ? 'Marking…' : 'Mark all read'}</button>
              <button type="button" className="btn btn-ghost" onClick={clearAll} disabled={notifications.length === 0 || clearing}>
                {clearing ? 'Clearing…' : 'Clear all'}
              </button>
            </div>
          </div>
          {error && <p className="notification-error" role="alert">{error}</p>}
          {loading ? <p role="status">Loading notifications…</p> : notifications.length === 0 ? (
            <p className="notification-empty">You’re all caught up.</p>
          ) : (
            <ul className="notification-list">
              {notifications.map((notification) => (
                <li className="notification-row" key={notification.notification_id}>
                  <button
                    type="button"
                    className="notification-swipe-clear"
                    aria-label={`Clear notification: ${DESCRIPTIONS[notification.notification_type] || 'LostLink update'}`}
                    tabIndex={swipedId === String(notification.notification_id) ? 0 : -1}
                    onClick={() => clearOne(notification)}
                    disabled={clearing}
                  >Clear</button>
                  <article
                    className={`notification-item ${notification.read_at ? 'read' : 'unread'}${swipedId === String(notification.notification_id) ? ' swiped' : ''}`}
                    tabIndex={0}
                    aria-label="Notification. Use the left arrow key to reveal the clear action."
                    onTouchStart={(event) => { touchStartX.current = event.changedTouches[0].clientX }}
                    onTouchEnd={(event) => {
                      if (touchStartX.current === null) return
                      const delta = event.changedTouches[0].clientX - touchStartX.current
                      if (delta < -45) setSwipedId(String(notification.notification_id))
                      else if (delta > 45) setSwipedId('')
                      touchStartX.current = null
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft') setSwipedId(String(notification.notification_id))
                      if (event.key === 'ArrowRight') setSwipedId('')
                    }}
                  >
                    <span>{DESCRIPTIONS[notification.notification_type] || 'There is an update on one of your LostLink items.'}</span>
                    <time dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString()}</time>
                    {notification.navigation_target && (
                      <a className="notification-open" href={notification.navigation_target} onClick={() => markRead(notification)}>View related activity</a>
                    )}
                    {!notification.read_at && <button type="button" className="notification-open" disabled={readingIds.has(String(notification.notification_id))} onClick={() => markRead(notification)}>{readingIds.has(String(notification.notification_id)) ? 'Marking…' : 'Mark as read'}</button>}
                  </article>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

export default NotificationCenter
