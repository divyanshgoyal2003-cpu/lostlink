import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNotifications,
  getUnreadNotificationCount,
  clearAllNotifications,
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
  CLAIM_IN_REVIEW: 'Your claim is now under review.',
  CLAIM_APPROVED: 'Your claim was approved.',
  CLAIM_REJECTED: 'Your claim was rejected.',
  HANDOVER_COMPLETED: 'The item handover is complete.',
}

function NotificationCenter({ token }) {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)
  const refreshInFlight = useRef(new Set())
  const currentToken = useRef(token)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { currentToken.current = token }, [token])

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
    try {
      await markNotificationRead(token, notification.notification_id)
      if (notification.navigation_target) setOpen(false)
    } catch (markError) {
      setError(markError.message || 'Could not update notification.')
    }
  }

  async function markAllRead() {
    try {
      await markAllNotificationsRead(token)
      setNotifications((previous) => previous.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() })))
    } catch (markError) {
      setError(markError.message || 'Could not update notifications.')
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

  return (
    <div className="notification-center">
      <button type="button" className="btn btn-ghost notification-toggle" aria-expanded={open} aria-controls="notification-panel" onClick={togglePanel}>
        Notifications
        {unreadCount > 0 && <span className="notification-badge" aria-label={`${unreadCount} unread`}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <section className="notification-panel" id="notification-panel" aria-label="Notifications">
          <div className="notification-panel-heading">
            <h2>Notifications</h2>
            <div className="notification-actions">
              <button type="button" className="btn btn-ghost" onClick={markAllRead} disabled={unreadCount === 0}>Mark all read</button>
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
                <li className={notification.read_at ? 'notification-item read' : 'notification-item unread'} key={notification.notification_id}>
                  <span>{DESCRIPTIONS[notification.notification_type] || 'There is an update on one of your LostLink items.'}</span>
                  <time dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString()}</time>
                  {notification.navigation_target && (
                    <a className="notification-open" href={notification.navigation_target} onClick={() => markRead(notification)}>View related activity</a>
                  )}
                  {!notification.read_at && <button type="button" className="notification-open" onClick={() => markRead(notification)}>Mark as read</button>}
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
