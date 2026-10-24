
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const error = new Error(
      data.error || data.message || `Request failed (${response.status})`,
    )
    error.status = response.status
    throw error
  }

  return data
}

export async function registerUser({ name, email, phone, password }) {
  return apiRequest('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, phone, password }),
  })
}

export async function loginUser({ email, password }) {
  return apiRequest('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}


export async function authenticatedRequest(path, token, options = {}) {
  return apiRequest(path, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  })
}


export async function createReport(token, report) {
  return authenticatedRequest('/reports', token, {
    method: 'POST',
    body: JSON.stringify(report),
  })
}

export async function getMyReports(token) {
  return authenticatedRequest('/reports/mine', token)
}

export async function getMyReturnHistory(token) {
  return authenticatedRequest('/reports/mine/history', token)
}

export async function updateReport(token, reportId, report) {
  return authenticatedRequest(`/reports/${reportId}`, token, {
    method: 'PATCH',
    body: JSON.stringify(report),
  })
}

export async function closeReport(token, reportId) {
  return authenticatedRequest(`/reports/${reportId}/close`, token, {
    method: 'PATCH',
  })
}

export async function getAuthorityDestinations(token) {
  return authenticatedRequest('/authorities/destinations', token)
}

export async function getAuthorityCapabilities(token) {
  return authenticatedRequest('/authorities/capabilities', token)
}

export async function submitAuthorityRequest(token, request) {
  return authenticatedRequest('/authorities/requests', token, {
    method: 'POST', body: JSON.stringify(request),
  })
}

export async function provisionAuthorityAccount(token, details) {
  return authenticatedRequest('/authorities/admin/accounts', token, {
    method: 'POST', body: JSON.stringify(details),
  })
}

export async function getClaimConversation(token, claimId, { beforeMessageId, limit } = {}) {
  const query = new URLSearchParams()
  if (beforeMessageId) query.set('beforeMessageId', beforeMessageId)
  if (limit) query.set('limit', String(limit))
  return authenticatedRequest(`/conversations/claims/${encodeURIComponent(claimId)}${query.size ? `?${query}` : ''}`, token)
}

export async function getConversationInbox(token) { return authenticatedRequest('/conversations/inbox', token) }
export async function markConversationRead(token, claimId, lastReadMessageId) {
  return authenticatedRequest(`/conversations/claims/${encodeURIComponent(claimId)}/read`, token, { method: 'PATCH', body: JSON.stringify({ lastReadMessageId }) })
}
export async function createProofRequest(token, claimId, request) {
  return authenticatedRequest(`/conversations/claims/${encodeURIComponent(claimId)}/proof-requests`, token, { method: 'POST', body: JSON.stringify(request) })
}
export async function reviewProofRequest(token, requestId, status) {
  return authenticatedRequest(`/conversations/proof-requests/${encodeURIComponent(requestId)}`, token, { method: 'PATCH', body: JSON.stringify({ status }) })
}
export async function uploadConversationProof(token, requestId, file, note = '') {
  return authenticatedRequest(`/conversations/proof-requests/${encodeURIComponent(requestId)}/attachments`, token, { method: 'PUT', headers: { 'Content-Type': file.type, 'X-Proof-Note': note }, body: file })
}
export async function downloadConversationProof(token, attachmentId) {
  const response = await fetch(`${API_BASE_URL}/conversations/proof-attachments/${encodeURIComponent(attachmentId)}/content`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error('Evidence is not available to this account.')
  return response.blob()
}

export async function sendClaimConversationMessage(token, claimId, message, clientMessageId = crypto.randomUUID()) {
  return authenticatedRequest(`/conversations/claims/${encodeURIComponent(claimId)}`, token, {
    method: 'POST', body: JSON.stringify({ message, clientMessageId }),
  })
}
export async function getAuthorityMemberships(token) {
  return authenticatedRequest('/authorities/me', token)
}

export async function getAuthorityAdminQueue(token) {
  return authenticatedRequest('/authorities/admin/queue', token)
}

export async function reviewAuthorityDestination(token, authorityId, action) {
  return authenticatedRequest(`/authorities/admin/destinations/${encodeURIComponent(authorityId)}`, token, {
    method: 'PATCH', body: JSON.stringify({ action }),
  })
}

export async function reviewAuthorityMembership(token, membershipId, action, membershipRole) {
  return authenticatedRequest(`/authorities/admin/memberships/${encodeURIComponent(membershipId)}`, token, {
    method: 'PATCH', body: JSON.stringify({ action, membershipRole }),
  })
}

export async function getAuthorityCases(token, { history = false } = {}) {
  const query = history ? '?history=true' : ''
  return authenticatedRequest(`/authorities/cases${query}`, token)
}

export async function assignReportAuthority(token, reportId, recoveryMode, authorityId = null) {
  return authenticatedRequest(`/authorities/reports/${encodeURIComponent(reportId)}/assignment`, token, {
    method: 'PATCH', body: JSON.stringify({ recoveryMode, authorityId }),
  })
}

export async function initiateCustodyTransfer(token, reportId) {
  return authenticatedRequest(`/authorities/reports/${encodeURIComponent(reportId)}/custody-transfers`, token, { method: 'POST' })
}

export async function confirmCustodyTransfer(token, transferId, code) {
  const result = await authenticatedRequest(`/authorities/custody-transfers/${encodeURIComponent(transferId)}/confirm`, token, {
    method: 'POST', body: JSON.stringify({ code }),
  })
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('lostlink:return-history-refresh'))
  return result
}

export async function cancelCustodyTransfer(token, transferId) {
  return authenticatedRequest(`/authorities/custody-transfers/${encodeURIComponent(transferId)}/cancel`, token, { method: 'POST' })
}


export async function getMyMatches(token, lostReportId = '') {
  const query = lostReportId
    ? `?lostReportId=${encodeURIComponent(lostReportId)}`
    : ''
  return authenticatedRequest(`/matches${query}`, token)
}

export async function refreshMatchCandidates(token) {
  const result = await authenticatedRequest('/matches/refresh', token, {
    method: 'POST',
  })
  notifyNotificationsChanged()
  return result
}

export async function getMyClaims(token) {
  return authenticatedRequest('/claims', token)
}

export async function submitClaim(token, matchId) {
  const result = await authenticatedRequest('/claims', token, {
    method: 'POST',
    body: JSON.stringify({ matchId }),
  })
  notifyNotificationsChanged()
  return result
}

function notifyNotificationsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('lostlink:notifications-refresh'))
}

export async function getNotifications(token, { limit = 20, offset = 0 } = {}) {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  return authenticatedRequest(`/notifications?${query}`, token)
}

export async function getUnreadNotificationCount(token) {
  return authenticatedRequest('/notifications/unread-count', token)
}

export async function markNotificationRead(token, notificationId) {
  const result = await authenticatedRequest(`/notifications/${encodeURIComponent(notificationId)}/read`, token, { method: 'PATCH' })
  notifyNotificationsChanged()
  return result
}

export async function markAllNotificationsRead(token) {
  const result = await authenticatedRequest('/notifications/read-all', token, { method: 'POST' })
  notifyNotificationsChanged()
  return result
}

export async function clearAllNotifications(token) {
  const result = await authenticatedRequest('/notifications', token, { method: 'DELETE' })
  notifyNotificationsChanged()
  return result
}

export async function getClaimReviewQueue(token) {
  return authenticatedRequest('/claims/review-queue', token)
}

export async function enableClaimConversation(token, claimId) {
  return authenticatedRequest(`/claims/${encodeURIComponent(claimId)}/conversation/open`, token, { method: 'POST' })
}

export async function getClaimVerifications(token, claimId) {
  return authenticatedRequest(`/claims/${claimId}/verifications`, token)
}

export async function submitClaimVerification(token, claimId, verification) {
  const result = await authenticatedRequest(`/claims/${claimId}/verifications`, token, {
    method: 'POST',
    body: JSON.stringify(verification),
  })
  notifyNotificationsChanged()
  return result
}

export async function reviewClaim(token, claimId, decision, privateNote) {
  const result = await authenticatedRequest(`/claims/${claimId}/review`, token, {
    method: 'PATCH',
    body: JSON.stringify({ decision, privateNote }),
  })
  notifyNotificationsChanged()
  return result
}

export async function issueHandoverCode(token, claimId) {
  return authenticatedRequest(`/claims/${claimId}/handover/code`, token, {
    method: 'POST',
  })
}

export async function confirmHandover(token, claimId, code) {
  const result = await authenticatedRequest(`/claims/${claimId}/handover/confirm`, token, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  notifyNotificationsChanged()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('lostlink:return-history-refresh'))
  return result
}

export async function uploadFoundReportPhoto(token, reportId, photoType, file) {
  return authenticatedRequest(`/reports/${reportId}/photos`, token, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, 'X-Photo-Type': photoType },
    body: file,
  })
}

export async function getFoundReportPhotos(token, reportId) {
  return authenticatedRequest(`/reports/${reportId}/photos`, token)
}

export async function getClaimPhotoAccess(token, claimId) {
  return authenticatedRequest(`/claims/${claimId}/photos`, token)
}

export async function grantClaimPhotoAccess(token, claimId) {
  return authenticatedRequest(`/claims/${claimId}/photo-sharing`, token, { method: 'POST' })
}

export async function revokeClaimPhotoAccess(token, claimId) {
  return authenticatedRequest(`/claims/${claimId}/photo-sharing`, token, { method: 'DELETE' })
}

export async function getPrivatePhoto(token, photoId, claimId = null, reportId = null) {
  const params = new URLSearchParams()
  if (claimId) params.set('claimId', claimId)
  if (reportId) params.set('reportId', reportId)
  const query = params.size ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/reports/photos/${encodeURIComponent(photoId)}${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = new Error(body.error || body.message || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return response.blob()
}
