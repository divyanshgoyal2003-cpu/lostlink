export function startNotificationPolling(refresh, {
  intervalMs = 60000,
  isAuthenticated = () => true,
  isVisible = () => true,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  let active = true
  let inFlight = false
  const poll = async () => {
    if (!active || inFlight || !isAuthenticated() || !isVisible()) return
    inFlight = true
    try { await refresh() } catch { /* Next visible tick retries without affecting the rest of the UI. */ }
    finally { inFlight = false }
  }
  const timer = setIntervalFn(() => { void poll() }, intervalMs)
  return {
    poll,
    stop() {
      if (!active) return
      active = false
      clearIntervalFn(timer)
    },
  }
}
