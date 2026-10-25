export function resolveApiBaseUrl(configured, isProduction) {
  const value = configured?.trim()
  if (isProduction) {
    if (!value) throw new Error('VITE_API_URL is required for the production frontend.')
    let parsed
    try { parsed = new URL(value) } catch { throw new Error('VITE_API_URL must be a valid HTTPS API URL ending in /api.') }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname.replace(/\/$/, '') !== '/api' || parsed.search || parsed.hash) {
      throw new Error('VITE_API_URL must use HTTPS and end in /api.')
    }
    return value.replace(/\/$/, '')
  }
  return (value || 'http://localhost:5000/api').replace(/\/$/, '')
}
