export function startConversationPolling(load, {
  intervalMs = 5000,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  let active = true
  let inFlight = false
  let timer

  const poll = async () => {
    if (!active || inFlight) return
    inFlight = true
    try {
      if (await load() === false) stop()
    } catch {
      // Keep retrying on the next tick after transient network failures.
    } finally {
      inFlight = false
    }
  }

  const stop = () => {
    if (!active) return
    active = false
    if (timer !== undefined) clearIntervalFn(timer)
  }

  timer = setIntervalFn(() => poll(), intervalMs)
  return { poll, stop }
}
