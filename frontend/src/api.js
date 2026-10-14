
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
    throw new Error(
      data.error || data.message || `Request failed (${response.status})`,
    )
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


export async function getMyMatches(token) {
  return authenticatedRequest('/matches', token)
}