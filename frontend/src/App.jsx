import { useEffect, useRef, useState } from 'react'
import {
  loginUser,
  registerUser,
  createReport,
  getMyReports,
  updateReport,
  closeReport,
  getMyMatches,
  refreshMatchCandidates,
  getMyClaims,
  submitClaim,
  getAuthorityDestinations,
  getAuthorityMemberships,
} from './api'
import './App.css'
import LocationPicker from './components/LocationPicker'
import ClaimWorkflow from './components/ClaimWorkflow'
import FoundPhotoCapture from './components/FoundPhotoCapture'
import NotificationCenter from './components/NotificationCenter'
import AuthorityPortal from './components/AuthorityPortal'
import ReturnHistory from './components/ReturnHistory'
import { filterAndSortMatches } from './matchFilters'
import { getMatchClaimState } from './claimCardState'

const DEFAULT_MATCH_FILTERS = {
  keyword: '',
  category: '',
  strength: 'ALL',
  lostReportId: '',
  foundDateFrom: '',
  foundDateTo: '',
  sort: 'score',
}

function App() {
  const [editingReportId, setEditingReportId] = useState(null)
  const [editReportForm, setEditReportForm] = useState({
      title: '',
      description: '',
      color: '',
  })
const [reportActionMessage, setReportActionMessage] = useState('')
const [reportActionError, setReportActionError] = useState('')
const [reportActionLoading, setReportActionLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('lost')
  const [authMode, setAuthMode] = useState(null)
  const [authForm, setAuthForm] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
  })
  const [authMessage, setAuthMessage] = useState('')
  const [authError, setAuthError] = useState('')
const [authLoading, setAuthLoading] = useState(false)

const [reportForm, setReportForm] = useState({
  category: 'ELECTRONICS',
  title: '',
  description: '',
  color: '',
  company: '',
  model: '',
  reportType: 'LOST',
  reportTime: '',
  latitude: '',
  longitude: '',
  locationDescription: '',
  recoveryMode: 'DIRECT',
  authorityId: '',
})
const [uncertaintyRadiusM, setUncertaintyRadiusM] = useState(75)
const [reportLoading, setReportLoading] = useState(false)
const [reportMessage, setReportMessage] = useState('')
const [reportError, setReportError] = useState('')

const [myReports, setMyReports] = useState([])
const [reportsLoading, setReportsLoading] = useState(false)
const [reportsError, setReportsError] = useState('')
const [authorityDestinations, setAuthorityDestinations] = useState([])
const [authorityDestinationsError, setAuthorityDestinationsError] = useState('')
const [hasAuthorityAccess, setHasAuthorityAccess] = useState(false)
const [myMatches, setMyMatches] = useState([])
const [matchesLoading, setMatchesLoading] = useState(false)
const [matchesError, setMatchesError] = useState('')
const [matchesMessage, setMatchesMessage] = useState('')
const [matchScoreThreshold, setMatchScoreThreshold] = useState(null)
const [strongMatchThreshold, setStrongMatchThreshold] = useState(null)
const [matchFilters, setMatchFilters] = useState({ ...DEFAULT_MATCH_FILTERS })
const [appliedMatchFilters, setAppliedMatchFilters] = useState({ ...DEFAULT_MATCH_FILTERS })
const [claimsForMatches, setClaimsForMatches] = useState([])
const [claimsLoaded, setClaimsLoaded] = useState(false)
const [claimSubmittingMatchId, setClaimSubmittingMatchId] = useState('')
const [claimCardMessages, setClaimCardMessages] = useState({})
const claimSubmissionLocks = useRef(new Set())

const [currentUser, setCurrentUser] = useState(() => {
  try {
    const savedSession = sessionStorage.getItem('lostlink_session')
    return savedSession ? JSON.parse(savedSession).user : null
  } catch {
    return null
  }
})

const [authToken, setAuthToken] = useState(() => {
  try {
    const savedSession = sessionStorage.getItem('lostlink_session')
    return savedSession ? JSON.parse(savedSession).token : null
  } catch {
    return null
  }
})
const hasFoundReports = myReports.some((report) => report.report_type === 'FOUND')
const hasAuthorityDashboard = ["STAFF", "ADMIN"].includes(currentUser?.role) || hasAuthorityAccess
const [authorityAccessLoading, setAuthorityAccessLoading] = useState(Boolean(authToken && currentUser?.role === 'USER'))
const isOperationsUser = currentUser?.role === 'ADMIN' || hasAuthorityAccess || (currentUser?.role === 'USER' && authorityAccessLoading)

  function openAuth(mode) {
    setAuthMode(mode)
    setAuthMessage('')
    setAuthError('')
    setAuthForm({ name: '', email: '', phone: '', password: '' })
  }

  function closeAuth() {
    if (authLoading) return
    setAuthMode(null)
    setAuthMessage('')
    setAuthError('')
  }

  function updateAuthField(event) {
    const { name, value } = event.target
    setAuthForm((previous) => ({ ...previous, [name]: value }))
  }

  async function handleAuthSubmit(event) {
    event.preventDefault()
    setAuthLoading(true)
    setAuthMessage('')
    setAuthError('')

    try {
      const result =
        authMode === 'signup'
          ? await registerUser(authForm)
          : await loginUser({
              email: authForm.email,
              password: authForm.password,
            })

      sessionStorage.setItem(
        'lostlink_session',
        JSON.stringify({ user: result.user, token: result.token }),
      )
      setAuthorityAccessLoading(result.user?.role === 'USER')
      setCurrentUser(result.user)
      setAuthToken(result.token)
      setAuthMessage(
        authMode === 'signup'
          ? 'Account created successfully!'
          : 'You are now logged in!',
      )
      setAuthMode(null)
      setAuthForm({ name: '', email: '', phone: '', password: '' })
    } catch (error) {
      setAuthError(error.message || 'Authentication failed. Please try again.')
    } finally {
      setAuthLoading(false)
    }
  }
async function handleReportSubmit(event) {
  event.preventDefault()
  setReportLoading(true)
  setReportMessage('')
  setReportError('')

  try {
    if (!authToken) {
      throw new Error('Please log in again before submitting a report.')
    }

    const latitude = Number(reportForm.latitude)
    const longitude = Number(reportForm.longitude)

    if (
      reportForm.latitude.trim() === '' ||
      reportForm.longitude.trim() === '' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error('Enter a valid latitude and longitude.')
    }

    if (!reportForm.reportTime) {
      throw new Error('Please select when the item was lost or found.')
    }

    const result = await createReport(authToken, {
      category: reportForm.category,
title: reportForm.title.trim(),
description: reportForm.description.trim() || null,
color: reportForm.color.trim(),
company: reportForm.company.trim(),
attributes:
  reportForm.category === 'ELECTRONICS'
    ? { model: reportForm.model.trim() }
    : {},
      reportType: reportForm.reportType,
      reportTime: new Date(reportForm.reportTime).toISOString(),
      latitude,
      longitude,
      uncertaintyRadiusM,
      locationAccuracyM: null,
      locationSource: 'MAP_PIN',
      locationDescription: reportForm.locationDescription.trim() || null,
      recoveryMode: reportForm.reportType === 'FOUND' ? reportForm.recoveryMode : 'DIRECT',
      authorityId: reportForm.reportType === 'FOUND' && reportForm.recoveryMode === 'AUTHORITY' ? reportForm.authorityId : null,
    })

    setReportMessage(result.message || 'Report submitted successfully!')
    setReportForm({
      category: 'ELECTRONICS',
      title: '',
      description: '',
     color: '',
      company: '',
      model: '',
      reportType: reportForm.reportType,
     reportTime: '',
     latitude: '',
      longitude: '',
      locationDescription: '',
      recoveryMode: 'DIRECT',
      authorityId: '',
    })
  } catch (error) {
    setReportError(error.message || 'Could not submit the report.')
  } finally {
    setReportLoading(false)
  }
}async function loadMyReports()

 {
  if (!authToken) {
    setMyReports([])
    return
  }

  setReportsLoading(true)
  setReportsError('')

  try {
    const result = await getMyReports(authToken)
    setMyReports(result.reports || [])
  } catch (error) {
    setReportsError(error.message || 'Could not load your reports.')
  } finally {
    setReportsLoading(false)
  }
}

async function loadMyMatches({ refresh = false, lostReportId = appliedMatchFilters.lostReportId } = {}) {
  if (!authToken) {
    setMyMatches([])
      setMatchScoreThreshold(null)
      setStrongMatchThreshold(null)
    setMatchesError('Please log in to view your matches.')
    return false
  }

  setMatchesLoading(true)
  setMatchesError('')
  setMatchesMessage('')

  try {
    if (refresh) {
      await refreshMatchCandidates(authToken)
    }
    const result = await getMyMatches(authToken, lostReportId)
    setMyMatches(result.matches || [])
    setMatchScoreThreshold(result.scoreThreshold ?? null)
    setStrongMatchThreshold(result.strongMatchThreshold ?? null)

    if (!result.matches?.length) {
      setMatchesMessage(
        'No potential matches are available for your reports yet.'
      )
    }
    return true
  } catch (error) {
    setMatchesError(error.message || 'Could not load your matches.')
    return false
  } finally {
    setMatchesLoading(false)
  }
}

async function refreshClaimRelatedData() {
  await Promise.all([loadMyReports(), loadMyMatches()])
}

async function refreshClaimsForMatches() {
  if (!authToken) {
    setClaimsForMatches([])
    setClaimsLoaded(false)
    return false
  }
  try {
    const result = await getMyClaims(authToken)
    setClaimsForMatches(result.claims || [])
    setClaimsLoaded(true)
    return true
  } catch {
    return false
  }
}

function handleClaimsChange(claims, loaded) {
  setClaimsForMatches(claims)
  setClaimsLoaded(loaded)
}

async function handleCardClaim(match) {
  const matchId = String(match.matchId)
  const state = getMatchClaimState(match, claimsForMatches, claimsLoaded)
  if (!authToken || state.type !== 'submit' || claimSubmissionLocks.current.has(matchId)) return

  claimSubmissionLocks.current.add(matchId)
  setClaimSubmittingMatchId(matchId)
  setClaimCardMessages((previous) => ({ ...previous, [matchId]: '' }))
  try {
    const confirmed = window.confirm(
      `Submit a claim for “${match.lostTitle || 'this lost item'}”? A staff member will review it. If approved, you will confirm the handover with a one-time code.`,
    )
    if (!confirmed) return

    const result = await submitClaim(authToken, match.matchId)
    setClaimsForMatches((previous) => [
      result.claim,
      ...previous.filter((claim) => String(claim.claim_id) !== String(result.claim.claim_id)),
    ])
    setClaimsLoaded(true)
    setClaimCardMessages((previous) => ({ ...previous, [matchId]: 'Claim submitted. Track its status under My Claims.' }))
    await Promise.all([refreshClaimsForMatches(), refreshClaimRelatedData()])
  } catch (error) {
    setClaimCardMessages((previous) => ({ ...previous, [matchId]: error.message || 'Could not submit the claim. Please try again.' }))
  } finally {
    claimSubmissionLocks.current.delete(matchId)
    setClaimSubmittingMatchId('')
  }
}

async function handleSaveReport() {
  if (!authToken || !editingReportId) return

  setReportActionLoading(true)
  setReportActionMessage('')
  setReportActionError('')

  try {
    const result = await updateReport(
      authToken,
      editingReportId,
      {
        title: editReportForm.title.trim(),
        description: editReportForm.description.trim(),
        color: editReportForm.color.trim(),
      }
    )

    setReportActionMessage(
      result.message || 'Report updated successfully.'
    )
    setEditingReportId(null)
    await loadMyReports()
  } catch (error) {
    setReportActionError(
      error.message || 'Could not update the report.'
    )
  } finally {
    setReportActionLoading(false)
  }
}

async function handleCloseReport(reportId) {
  if (!authToken) return

  const confirmed = window.confirm(
    'Are you sure you want to close this report?'
  )

  if (!confirmed) return

  setReportActionLoading(true)
  setReportActionMessage('')
  setReportActionError('')

  try {
    const result = await closeReport(authToken, reportId)

    setReportActionMessage(
      result.message || 'Report closed successfully.'
    )
    await loadMyReports()
  } catch (error) {
    setReportActionError(
      error.message || 'Could not close the report.'
    )
  } finally {
    setReportActionLoading(false)
  }
}

useEffect(() => {
  if (authToken) {
    if (currentUser?.role === 'USER') setAuthorityAccessLoading(true)
    getAuthorityMemberships(authToken).then((result) => {
      setHasAuthorityAccess((result.memberships || []).some((membership) => membership.membership_status === 'ACTIVE' && membership.verification_status === 'VERIFIED' && membership.destination_status === 'ACTIVE'))
    }).catch(() => setHasAuthorityAccess(false)).finally(() => setAuthorityAccessLoading(false))
    loadMyReports()
    getAuthorityDestinations(authToken)
      .then((result) => {
        setAuthorityDestinations(result.destinations || [])
        setAuthorityDestinationsError('')
      })
      .catch((error) => setAuthorityDestinationsError(error.message || 'Could not load authority destinations.'))
  } else {
    setHasAuthorityAccess(false)
    setAuthorityAccessLoading(false)
    setMyReports([])
    setAuthorityDestinations([])
  }
}, [authToken])

useEffect(() => {
  if (!authToken) return undefined
  const refreshReports = () => {
    getMyReports(authToken)
      .then((result) => setMyReports(result.reports || []))
      .catch((error) => setReportsError(error.message || 'Could not refresh your reports.'))
  }
  window.addEventListener('lostlink:return-history-refresh', refreshReports)
  return () => window.removeEventListener('lostlink:return-history-refresh', refreshReports)
}, [authToken])

const filteredMatches = filterAndSortMatches(myMatches, appliedMatchFilters)
const eligibleLostReports = myReports.filter((report) =>
  report.report_type === 'LOST' && report.status === 'OPEN'
)
const selectedLostReport = myReports.find((report) =>
  String(report.report_id) === String(appliedMatchFilters.lostReportId)
)

function updateMatchFilter(event) {
  const { name, value } = event.target
  setMatchFilters((previous) => ({ ...previous, [name]: value }))
}

  return (
      <div className={`app${isOperationsUser ? ' operations-user-app' : ''}`}>
      <header className="navbar">
        <a className="brand" href="#">
          <span className="brand-icon">L</span>
          <span>Lost<span className="brand-accent">Link</span></span>
        </a>

        <nav className="nav-links">
          {isOperationsUser ? (
            <>
              <a href="#authority-portal">{currentUser?.role === 'ADMIN' ? 'Admin dashboard' : 'Authority dashboard'}</a>
              <a href="#claim-review">Review claims</a>
              <a href="#return-history">Return history</a>
            </>
          ) : <>
          <a href="#how-it-works">How it works</a>
          <a href="#my-matches">My Matches</a>
          {currentUser && <a href="#return-history">Return history</a>}
          {currentUser && (hasAuthorityDashboard || hasFoundReports) && <a href="#authority-portal">{currentUser.role === 'ADMIN' ? 'Admin dashboard' : hasAuthorityDashboard ? 'Authority dashboard' : 'My return plan'}</a>}
          <a href="#safety">Safety</a>
          </>}
        </nav>

        <div className="nav-actions">
          {currentUser ? (
            <>
<NotificationCenter token={authToken} />
<span className="welcome-user">
  Hi, {currentUser.name}
</span>
{!isOperationsUser && <button
  className="btn btn-ghost"
  onClick={async () => {
    await loadMyMatches({ refresh: true })
    document.getElementById('my-matches')?.scrollIntoView({
      behavior: 'smooth',
    })
  }}
>
  My matches
</button>}
{!isOperationsUser && <a className="btn btn-ghost" href="#my-claims">My claims</a>}
{(["STAFF", "ADMIN"].includes(currentUser.role) || hasAuthorityAccess) && <a className="btn btn-ghost" href="#claim-review">Review claims</a>}
<button
  className="btn btn-ghost"
  onClick={() => {
    sessionStorage.removeItem('lostlink_session')
    setAuthToken(null)
    setCurrentUser(null)
    setHasAuthorityAccess(false)
    setMyReports([])
    setMyMatches([])
    setMatchScoreThreshold(null)
    setStrongMatchThreshold(null)
    setMatchFilters({ ...DEFAULT_MATCH_FILTERS })
    setAppliedMatchFilters({ ...DEFAULT_MATCH_FILTERS })
    setClaimsForMatches([])
    setClaimsLoaded(false)
    setClaimCardMessages({})
    setAuthMessage('You have been logged out.')
  }}
>
  Log out
</button>

            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => openAuth('login')}>
                Log in
              </button>
              <button className="btn btn-primary" onClick={() => openAuth('signup')}>
                Sign up
              </button>
            </>
          )}
        </div>
      </header>

      {authMessage && (
        <div className="global-message" role="status">
          {authMessage}
          <button onClick={() => setAuthMessage('')} aria-label="Dismiss message">×</button>
        </div>
      )}

      <main className={isOperationsUser ? 'operations-mode' : undefined}>
        <section className="hero-section">
          <div className="hero-content">
            <div className="eyebrow">
              <span className="status-dot"></span>
              A smarter way to reunite people with their belongings
            </div>

            <h1>
              Lost something?
              <br />
              <span>Let's bring it back.</span>
            </h1>

            <p className="hero-description">
              LostLink helps people report missing belongings and find
              possible matches through a privacy-conscious lost-and-found
              platform.
            </p>

            <div className="hero-actions">
              <button
                className="btn btn-primary btn-large"
                onClick={() => {
                  setActiveTab('lost')
                  setReportForm((previous) => ({ ...previous, reportType: 'LOST' }))
                  document.getElementById('report')?.scrollIntoView({ behavior: 'smooth' })
                  if (!currentUser) openAuth('login')
                }}
              >
                I lost something <span>→</span>
              </button>
            <button
                className="btn btn-secondary btn-large"
                onClick={() => {
                  setActiveTab('found')
                  setReportForm((previous) => ({ ...previous, reportType: 'FOUND' }))
                  document.getElementById('report')?.scrollIntoView({ behavior: 'smooth' })
                  if (!currentUser) openAuth('login')
                }}
              >
                I found something
              </button>
            </div>
            <div className="trust-note">
              <span>✓</span> Your private details stay protected
            </div>
          </div>

          <div className="hero-visual" aria-label="LostLink item recovery illustration">
            <div className="orbit orbit-one"></div>
            <div className="orbit orbit-two"></div>
            <div className="floating-card card-top">
              <span className="item-emoji">🎧</span>
              <div>
                <strong>Wireless earbuds</strong>
                <small>Possible match nearby</small>
              </div>
              <span className="match-indicator">↗</span>
            </div>

            <div className="illustration-circle">
              <div className="illustration-inner">
                <span className="illustration-icon">⌕</span>
                <div className="illustration-text">A little search.</div>
                <div className="illustration-subtext">A meaningful reunion.</div>
              </div>
            </div>

            <div className="floating-card card-bottom">
              <span className="item-emoji">🎒</span>
              <div>
                <strong>One less thing to worry about</strong>
                <small>Every item has a story</small>
              </div>
            </div>
          </div>
        </section>

        <section className="report-section" id="report">
          <div className="section-heading">
            <span className="section-kicker">GET STARTED</span>
            <h2>Let's find what you're looking for.</h2>
            <p>Start with a few details. You can review everything before submitting.</p>
          </div>

          <div className="report-panel">
            <div className="report-tabs">
              <button
                className={activeTab === 'lost' ? 'report-tab active' : 'report-tab'}
                onClick={() => {
                  setActiveTab('lost')
                  setReportForm((previous) => ({
                       ...previous,
                       reportType: 'LOST',
                  }))
                }}
              >
                <span>⌕</span> I lost an item
              </button>
              <button
                className={activeTab === 'found' ? 'report-tab active' : 'report-tab'}
                onClick={() => {
                        setActiveTab('found')
                        setReportForm((previous) => ({
                          ...previous,
                          reportType: 'FOUND',
                        }))
                }}
              >
                <span>✓</span> I found an item
              </button>
            </div>
<form className="report-form" onSubmit={handleReportSubmit}>
  <div className="report-form-heading">
    <h3>
      {activeTab === 'lost'
        ? 'Tell us what you lost'
        : 'Tell us what you found'}
    </h3>
    <p>
      {activeTab === 'lost'
        ? 'Describe your missing item to help identify possible matches.'
        : 'Share details to help reunite this item with its owner.'}
    </p>
  </div>
  <label htmlFor="report-category">Item category</label>
  <select
    id="report-category"
    value={reportForm.category}
    onChange={(e) =>
      setReportForm({ ...reportForm, category: e.target.value })
    }
    required
  >
    <option value="ELECTRONICS">Electronics</option>
    <option value="DOC_CARDS">Documents and cards</option>
    <option value="ACCESSORIES">Accessories</option>
    <option value="CLOTHING">Clothing</option>
    <option value="BAGS">Bags</option>
    <option value="OTHER">Other</option>
  </select>

  <label htmlFor="report-title">Item name</label>
  <input
    id="report-title"
    value={reportForm.title}
    onChange={(e) =>
      setReportForm({ ...reportForm, title: e.target.value })
    }
    maxLength={160}
    required
    placeholder="e.g. Blue wireless headphones"
  />

  <label htmlFor="report-description">Description</label>
  <textarea
    id="report-description"
    value={reportForm.description}
    onChange={(e) =>
      setReportForm({ ...reportForm, description: e.target.value })
    }
    rows={3}
    placeholder="Model number, serial number, and other identifying details..."
  />


<label htmlFor="report-color">Color</label>
<input
  id="report-color"
  value={reportForm.color}
  onChange={(e) =>
    setReportForm((previous) => ({
      ...previous,
      color: e.target.value,
    }))
  }
  maxLength={100}
  required
  placeholder="e.g. Navy blue"
/>
{reportForm.category === 'ELECTRONICS' && (
  <>
    <label htmlFor="report-model">
      Model <span aria-hidden="true">*</span>
    </label>
    <input
      id="report-model"
      value={reportForm.model}
      onChange={(e) =>
        setReportForm((previous) => ({
          ...previous,
          model: e.target.value,
        }))
      }
      maxLength={100}
      required
      placeholder="e.g. WH-1000XM5"
    />
  </>
)}
<label htmlFor="report-company">Company / Brand</label>
<input
  id="report-company"
  value={reportForm.company}
  onChange={(e) =>
    setReportForm((previous) => ({
      ...previous,
      company: e.target.value,
    }))
  }
  maxLength={120}
  required
  placeholder="e.g. Apple, Samsung, Nike, or Generic"
/>


  <label htmlFor="report-time">
    When was it {activeTab === 'lost' ? 'lost' : 'found'}?
  </label>
  <input
    id="report-time"
    type="datetime-local"
    value={reportForm.reportTime}
    onChange={(e) =>
      setReportForm({ ...reportForm, reportTime: e.target.value })
    }
    required
  />


<h4>Approximate location</h4>
<p>
  Select the approximate place where the item was lost or found.
  The circle represents your location uncertainty.
</p>

<LocationPicker
  latitude={reportForm.latitude}
  longitude={reportForm.longitude}
  uncertaintyRadiusM={uncertaintyRadiusM}
  onLocationChange={({ latitude, longitude }) => {
    setReportForm((previous) => ({
      ...previous,
      latitude: String(latitude),
      longitude: String(longitude),
    }))
  }}
  onRadiusChange={setUncertaintyRadiusM}
/>


  <label htmlFor="report-location-description">
    Location description (optional)
  </label>
  <input
    id="report-location-description"
    value={reportForm.locationDescription}
    onChange={(e) =>
      setReportForm({
        ...reportForm,
        locationDescription: e.target.value,
      })
    }
    placeholder="e.g. Near the library entrance"
  />

  {activeTab === 'found' && (
    <div className="recovery-choice">
      <h4>How would you like to return this item?</h4>
      <p>You can arrange the return directly, or hand the item to a verified authority. If you choose an authority, you are finished once its staff confirm physical receipt with your one-time code.</p>
      <label htmlFor="recovery-mode">Choose how you want to proceed</label>
      <select id="recovery-mode" value={reportForm.recoveryMode} onChange={(event) => setReportForm((previous) => ({ ...previous, recoveryMode: event.target.value, authorityId: '' }))}>
        <option value="DIRECT">I will coordinate the return myself</option>
        <option value="AUTHORITY">I will hand it to an authority</option>
      </select>
      {reportForm.recoveryMode === 'AUTHORITY' && <>
        <label htmlFor="recovery-authority">Verified authority destination</label>
        <select id="recovery-authority" required value={reportForm.authorityId} onChange={(event) => setReportForm((previous) => ({ ...previous, authorityId: event.target.value }))}>
          <option value="">Choose a destination</option>
          {authorityDestinations.map((destination) => <option value={destination.authority_id} key={destination.authority_id}>{destination.name}{destination.destination_type === 'CENTRAL' ? ' · LostLink central team' : destination.location_description ? ` · ${destination.location_description}` : ''}</option>)}
        </select>
        {authorityDestinationsError && <p className="auth-error" role="alert">{authorityDestinationsError}</p>}
        {!authorityDestinations.length && !authorityDestinationsError && <p>No verified, active destinations are available yet. You can submit a direct-recovery report.</p>}
      </>}
    </div>
  )}

  {reportError && (
    <p className="auth-error" role="alert">{reportError}</p>
  )}

  {reportMessage && (
    <p className="report-success" role="status">{reportMessage}</p>
  )}

  <button
    type="submit"
    className="btn btn-primary report-submit"
    disabled={reportLoading || !currentUser || !authToken}
  >
    {reportLoading
      ? 'Submitting...'
      : `Submit ${activeTab === 'lost' ? 'lost' : 'found'} report`}
  </button>

  {!currentUser && (
    <p className="report-login-note">
      Please log in before submitting a report.
    </p>
  )}
</form>

          </div>
        </section>

        <section className="steps-section" id="how-it-works">
          <div className="section-heading">
            <span className="section-kicker">HOW IT WORKS</span>
            <h2>Small details. Better connections.</h2>
            <p>A straightforward process designed around privacy and responsible recovery.</p>
          </div>

          <div className="steps-grid">
            <article className="step-card">
              <span className="step-number">01</span>
              <div className="step-icon">✎</div>
              <h3>Describe the item</h3>
              <p>Provide details about the item, when it went missing, and its approximate location.</p>
            </article>
            <article className="step-card">
              <span className="step-number">02</span>
              <div className="step-icon">⌕</div>
              <h3>Explore possible matches</h3>
              <p>LostLink compares relevant details to help identify promising matches.</p>
            </article>
            <article className="step-card">
              <span className="step-number">03</span>
              <div className="step-icon">♡</div>
              <h3>Verify and reconnect</h3>
              <p>Ownership verification helps people arrange a safe return without exposing private details.</p>
            </article>
          </div>
        </section>

<section className="my-reports-section" id="my-reports">
  {reportActionMessage && (
  <p className="report-success" role="status">
    {reportActionMessage}
  </p>
)}

{reportActionError && (
  <p className="auth-error" role="alert">
    {reportActionError}
  </p>
)}
  <div className="section-heading">
    <span className="section-kicker">YOUR ACTIVITY</span>
    <h2>My reports</h2>
    <p>Keep track of the items you've reported lost or found.</p>
  </div>

  {!currentUser ? (
    <div className="my-reports-empty">
      <p>Please log in to view your reports.</p>
      <button
        className="btn btn-primary"
        onClick={() => openAuth('login')}
      >
        Log in
      </button>
    </div>
  ) : reportsLoading ? (
    <div className="my-reports-empty">Loading your reports...</div>
  ) : reportsError ? (
    <div className="my-reports-empty">
      <p className="auth-error">{reportsError}</p>
      <button
        className="btn btn-secondary"
        onClick={loadMyReports}
      >
        Try again
      </button>
    </div>
  ) : myReports.length === 0 ? (
    <div className="my-reports-empty">
      <div className="placeholder-icon">⌕</div>
      <h3>No reports yet</h3>
      <p>Your submitted lost and found reports will appear here.</p>
      <button
        className="btn btn-primary"
        onClick={() =>
          document.getElementById('report')?.scrollIntoView({
            behavior: 'smooth',
          })
        }
      >
        Create a report
      </button>
    </div>
  ) : (
    <div className="my-reports-list">
      {myReports.map((report) => (
        <article
          className="my-report-card"
          key={report.report_id}
        >
          <div className="my-report-card-top">
            <span
              className={
                report.report_type === 'LOST'
                  ? 'report-type-badge lost-badge'
                  : 'report-type-badge found-badge'
              }
            >
              {report.report_type}
            </span>
            <span className="my-report-status">
              {(report.status || 'OPEN').replaceAll('_', ' ')}
            </span>
          </div>
          <h3>{report.title || report.item_title || 'Reported item'}</h3>
          {report.category && (
            <p className="my-report-category">
              {report.category.replaceAll('_', ' ')}
            </p>
          )}
          {report.company && (
            <p className="my-report-company">
               <strong>Company / Brand:</strong> {report.company}
            </p>
          )}
          {report.report_time && (
            <p className="my-report-date">
              Reported time: {new Date(report.report_time).toLocaleString()}
            </p>
          )}

          <p className="my-report-id">
            Report ID: {report.report_id}
          </p>
          {editingReportId === report.report_id ? (
  <div className="edit-report-form">
    <label>
      Item title
      <input
        value={editReportForm.title}
        maxLength={160}
        onChange={(event) =>
          setEditReportForm((prev) => ({
            ...prev,
            title: event.target.value,
          }))
        }
      />
    </label>

    <label>
      Description
      <textarea
        rows={3}
        maxLength={5000}
        value={editReportForm.description}
        onChange={(event) =>
          setEditReportForm((prev) => ({
            ...prev,
            description: event.target.value,
          }))
        }
      />
    </label>

    <label>
      Colour
      <input
        maxLength={100}
        value={editReportForm.color}
        onChange={(event) =>
          setEditReportForm((prev) => ({
            ...prev,
            color: event.target.value,
          }))
        }
      />
    </label>

    <div className="report-action-buttons">
      <button
        type="button"
        className="btn btn-primary"
        disabled={reportActionLoading}
        onClick={handleSaveReport}
      >
        {reportActionLoading ? 'Saving...' : 'Save changes'}
      </button>

      <button
        type="button"
        className="btn btn-secondary"
        disabled={reportActionLoading}
        onClick={() => setEditingReportId(null)}
      >
        Cancel
      </button>
    </div>
  </div>
) : (
  <div className="report-action-buttons">
    <button
      type="button"
      className="btn btn-secondary"
      disabled={reportActionLoading}
      onClick={() => {
        setEditReportForm({
          title: report.title || '',
          description: report.description || '',
          color: report.color || '',
        })
        setEditingReportId(report.report_id)
        setReportActionMessage('')
        setReportActionError('')
      }}
    >
      Edit
    </button>

    {report.status === 'OPEN' && (
      <button
        type="button"
        className="btn btn-secondary"
        disabled={reportActionLoading}
        onClick={() => handleCloseReport(report.report_id)}
      >
        Close report
      </button>
    )}
  </div>
)}
          {report.report_type === 'FOUND' && currentUser && (
            <FoundPhotoCapture token={authToken} report={report} />
          )}
        </article>
      ))}
    </div>
  )}
</section>
{currentUser && (hasAuthorityDashboard || hasFoundReports) && <AuthorityPortal token={authToken} user={currentUser} onLogin={() => openAuth('login')} />}
{currentUser && <ReturnHistory token={authToken} />}
<section className="my-reports-section" id="my-matches">
  <div className="section-heading">
    <span className="section-kicker">MATCHING</span>
    <h2>My matches</h2>
    <p>
      Potential matches based on item details and approximate location.
    </p>
  </div>

  {!currentUser ? (
    <div className="my-reports-empty">
      <p>Please log in to view your matches.</p>
    </div>
  ) : matchesLoading ? (
    <div className="my-reports-empty">
      Loading your matches...
    </div>
  ) : matchesError ? (
    <div className="my-reports-empty">
      <p className="auth-error">{matchesError}</p>
      <button
        className="btn btn-secondary"
        onClick={() => loadMyMatches({ refresh: true })}
      >
        Try again
      </button>
    </div>
  ) : (
    <>
      <form
        className="match-filters"
        onSubmit={async (event) => {
          event.preventDefault()
          const loaded = await loadMyMatches({ lostReportId: matchFilters.lostReportId })
          if (loaded) setAppliedMatchFilters({ ...matchFilters })
        }}
        aria-label="Filter My Matches"
      >
        <div>
          <label htmlFor="match-keyword">Keyword</label>
          <input id="match-keyword" name="keyword" value={matchFilters.keyword} onChange={updateMatchFilter} placeholder="Your lost-item title or category" />
        </div>
        <div>
          <label htmlFor="match-category">Category</label>
          <select id="match-category" name="category" value={matchFilters.category} onChange={updateMatchFilter}>
            <option value="">All categories</option>
            {['ELECTRONICS', 'DOC_CARDS', 'ACCESSORIES', 'CLOTHING', 'BAGS', 'OTHER'].map((category) => (
              <option value={category} key={category}>{category.replaceAll('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="match-strength">Match strength</label>
          <select id="match-strength" name="strength" value={matchFilters.strength} onChange={updateMatchFilter}>
            <option value="ALL">All qualifying matches</option>
            <option value="POTENTIAL">
              {matchScoreThreshold != null && strongMatchThreshold != null
                ? `Potential (${matchScoreThreshold}–${(strongMatchThreshold - 0.01).toFixed(2)})`
                : 'Potential'}
            </option>
            <option value="STRONG">
              {strongMatchThreshold != null ? `Strong (${strongMatchThreshold}+)` : 'Strong'}
            </option>
          </select>
        </div>
        <div>
          <label htmlFor="match-sort">Sort by</label>
          <select id="match-sort" name="sort" value={matchFilters.sort} onChange={updateMatchFilter}>
            <option value="score">Highest score</option>
            <option value="newest">Newest match</option>
          </select>
        </div>
        <div className="match-lost-report-filter">
          <label htmlFor="match-lost-report">Lost report</label>
          <select
            id="match-lost-report"
            name="lostReportId"
            value={matchFilters.lostReportId}
            onChange={updateMatchFilter}
          >
            <option value="">All eligible lost reports</option>
            {eligibleLostReports.map((report) => (
              <option value={report.report_id} key={report.report_id}>
                {(report.title || 'Untitled lost report')} · {new Date(report.report_time).toLocaleDateString()}
              </option>
            ))}
          </select>
          {eligibleLostReports.length === 0 && (
            <small className="match-filter-hint">Only your open lost reports can be selected.</small>
          )}
        </div>
        <fieldset>
          <legend>Found report date</legend>
          <label htmlFor="found-date-from">From</label>
          <input id="found-date-from" name="foundDateFrom" type="date" value={matchFilters.foundDateFrom} onChange={updateMatchFilter} />
          <label htmlFor="found-date-to">Through</label>
          <input id="found-date-to" name="foundDateTo" type="date" value={matchFilters.foundDateTo} onChange={updateMatchFilter} />
        </fieldset>
        <div className="match-filter-actions">
          <button className="btn btn-primary" type="submit">Apply filters</button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              const clearedFilters = { ...DEFAULT_MATCH_FILTERS }
              setMatchFilters(clearedFilters)
              loadMyMatches({ lostReportId: '' }).then((loaded) => {
                if (loaded) setAppliedMatchFilters(clearedFilters)
              })
            }}
          >
            Clear filters
          </button>
        </div>
      </form>

      <p className="match-filter-count" role="status">
        {selectedLostReport && (
          <strong className="selected-lost-report">
            Matches for {selectedLostReport.title || 'Untitled lost report'} · {new Date(selectedLostReport.report_time).toLocaleDateString()}.{' '}
          </strong>
        )}
        Showing {filteredMatches.length} of {myMatches.length} qualifying matches (up to 100 are loaded).
      </p>

      {filteredMatches.length === 0 ? (
        <div className="my-reports-empty">
          <div className="placeholder-icon">⌕</div>
          <h3>No qualifying matches for these filters</h3>
          <p>
            {matchScoreThreshold == null
              ? 'No candidates currently meet the matching threshold. Try another lost report or check again after new reports are added.'
              : `No candidates currently score ${matchScoreThreshold}/100 or higher for these filters. Try another lost report or clear filters.`}
          </p>
          <button className="btn btn-primary" onClick={() => loadMyMatches({ refresh: true })}>
            Check matches
          </button>
        </div>
      ) : (
        <div className="my-reports-list">
          {filteredMatches.map((match, index) => (
            <article className="my-report-card match-result-card" key={match.matchId || `${match.category}-${index}`}>
              <div className="my-report-card-top">
                <span className="report-type-badge">{match.matchStrength === 'STRONG' ? 'STRONG MATCH' : 'POTENTIAL MATCH'}</span>
                <span className="my-report-status">Score: {Number(match.matchScore).toFixed(2)}/100</span>
              </div>
              <h3>{match.category?.replaceAll('_', ' ') || 'Possible item match'}</h3>
              <p><strong>Lost item:</strong> {match.lostTitle || 'Title unavailable'}</p>
              <p><strong>Found item details:</strong> Hidden to protect ownership-verification details.</p>
              <p><strong>Lost report date:</strong> {new Date(match.lostReportTime).toLocaleDateString()}</p>
              <p><strong>Found report date:</strong> {new Date(match.foundReportTime).toLocaleDateString()}</p>
              <p>Approximate distance: {match.approximateDistanceM} m · {match.daysApart} days apart</p>
              <p>Score measures similarity, not probability of ownership. It never approves a claim automatically.</p>
              {(() => {
                if (!currentUser || !authToken) {
                  return <p className="claim-muted">Log in to submit a claim.</p>
                }
                const claimState = getMatchClaimState(match, claimsForMatches, claimsLoaded)
                const matchId = String(match.matchId ?? '')
                if (claimState.type === 'loading') {
                  return <p className="claim-muted" role="status">Checking claim status…</p>
                }
                if (claimState.type === 'existing') {
                  return (
                    <div className="match-claim-action">
                      <p className="claim-status" role="status">{claimState.label}</p>
                      <a className="btn btn-secondary" href="#my-claims" aria-label={`View claim ${claimState.claim.claim_id} status`}>
                        View claim status
                      </a>
                    </div>
                  )
                }
                if (claimState.type === 'submit') {
                  return (
                    <div className="match-claim-action">
                      <button
                        type="button"
                        className="btn btn-primary"
                        aria-label={`Claim this item: ${match.lostTitle || match.category || 'matched item'}`}
                        disabled={claimSubmittingMatchId === matchId}
                        onClick={() => handleCardClaim(match)}
                      >
                        {claimSubmittingMatchId === matchId ? 'Submitting…' : 'Claim this item'}
                      </button>
                    </div>
                  )
                }
                if (claimState.type === 'unsaved') {
                  return <p className="match-ineligible-note">Refresh matches before submitting a claim.</p>
                }
                return <p className="match-ineligible-note">This match is not currently eligible for a claim.</p>
              })()}
              {claimCardMessages[String(match.matchId)] && (
                <p className={claimCardMessages[String(match.matchId)].startsWith('Claim submitted') ? 'claim-feedback' : 'auth-error'} role={claimCardMessages[String(match.matchId)].startsWith('Claim submitted') ? 'status' : 'alert'}>
                  {claimCardMessages[String(match.matchId)]}
                </p>
              )}
              {!match.canClaim && <p className="match-ineligible-note">This candidate is not currently claimable. Refresh matches to check its current state.</p>}
            </article>
          ))}
        </div>
      )}
    </>
  )}
</section>
<ClaimWorkflow
  token={authToken}
  user={currentUser}
  hidePersonalClaims={isOperationsUser}
  claims={claimsForMatches}
  onClaimsChange={handleClaimsChange}
  onRefresh={refreshClaimRelatedData}
/>
        <section className="safety-banner" id="safety">
          <div className="safety-icon">⌑</div>
          <div>
            <h2>Your belongings matter. Your privacy does too.</h2>
            <p>Potential matches are not proof of ownership. Verification and careful information sharing remain important.</p>
          </div>
        </section>
      </main>

      {!isOperationsUser && <footer className="footer">
        <a className="brand" href="#">
          <span className="brand-icon">L</span>
          <span>Lost<span className="brand-accent">Link</span></span>
        </a>
        <span>Helping lost things find their way home.</span>
        <span>© {new Date().getFullYear()} LostLink</span>
      </footer>}

      {authMode && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAuth()
          }}
        >
          <section
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
            <button
              className="modal-close"
              onClick={closeAuth}
              disabled={authLoading}
              aria-label="Close authentication form"
            >
              ×
            </button>

            <span className="section-kicker">WELCOME TO LOSTLINK</span>
            <h2 id="auth-title">
              {authMode === 'signup' ? 'Create your account' : 'Welcome back'}
            </h2>
            <p className="auth-description">
              {authMode === 'signup'
                ? 'Join LostLink and help belongings find their way home.'
                : 'Log in to manage your reports and continue your search.'}
            </p>

            <form className="auth-form" onSubmit={handleAuthSubmit}>
              {authMode === 'signup' && (
                <>
                  <label htmlFor="auth-name">Full name</label>
                  <input
                    id="auth-name"
                    name="name"
                    autoComplete="name"
                    value={authForm.name}
                    onChange={updateAuthField}
                    maxLength={120}
                    required
                    placeholder="Your name"
                  />

                  <label htmlFor="auth-phone">Phone (optional)</label>
                  <input
                    id="auth-phone"
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    value={authForm.phone}
                    onChange={updateAuthField}
                    placeholder="Your phone number"
                  />
                </>
              )}

              <label htmlFor="auth-email">Email address</label>
              <input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                value={authForm.email}
                onChange={updateAuthField}
                maxLength={254}
                required
                placeholder="you@example.com"
              />

              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                value={authForm.password}
                onChange={updateAuthField}
                minLength={authMode === 'signup' ? 8 : undefined}
                required
                placeholder={authMode === 'signup' ? 'At least 8 characters' : 'Your password'}
              />

              {authError && (
                <p className="auth-error" role="alert">{authError}</p>
              )}

              <button
                className="btn btn-primary auth-submit"
                type="submit"
                disabled={authLoading}
              >
                {authLoading
                  ? 'Please wait...'
                  : authMode === 'signup'
                    ? 'Create account'
                    : 'Log in'}
              </button>
            </form>

            <p className="auth-switch">
              {authMode === 'signup' ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                onClick={() => openAuth(authMode === 'signup' ? 'login' : 'signup')}
                disabled={authLoading}
              >
                {authMode === 'signup' ? 'Log in' : 'Sign up'}
              </button>
            </p>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
