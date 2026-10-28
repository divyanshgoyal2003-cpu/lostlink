import { useCallback, useEffect, useState } from 'react'
import {
  confirmCustodyTransfer,
  confirmHandover,
  getAuthorityAdminQueue,
  getAuthorityCapabilities,
  getAuthorityCases,
  getAuthorityDestinations,
  getAuthorityMemberships,
  getMyReports,
  assignReportAuthority,
  initiateCustodyTransfer,
  cancelCustodyTransfer,
  reviewAuthorityDestination,
  reviewAuthorityMembership,
  provisionAuthorityAccount,
  getPrivatePhoto,
  getChatModerationReports,
  dismissChatUserReport,
  reinstateChatUser,
} from '../api'
import './AuthorityPortal.css'
import './ChatModeration.css'
import ClaimPhotoAccess from './ClaimPhotoAccess'
import ConversationInbox from './ConversationInbox'

function AuthorityReportPhotos({ token, reportId, photos = [] }) {
  const [images, setImages] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const urls = []
    async function load() {
      setLoading(true)
      setError('')
      try {
        const loaded = await Promise.all(photos.map(async (photo) => {
          const blob = await getPrivatePhoto(token, photo.photoId, null, reportId)
          const url = URL.createObjectURL(blob)
          urls.push(url)
          return { ...photo, url }
        }))
        if (!cancelled) setImages(loaded)
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Could not load the report photos.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (photos.length) void load()
    return () => { cancelled = true; urls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [token, reportId, photos])
  if (!photos.length) return <p>No photos were uploaded for this report.</p>
  const visibleImages = images.filter((image) =>
    photos.some((photo) => String(photo.photoId) === String(image.photoId))
  )
  return <div className="authority-report-photos" aria-label="Found item photos">
    {loading && <p role="status">Loading private report photos…</p>}
    {error && <p className="authority-photo-error" role="alert">{error}</p>}
    {visibleImages.map((photo) => <figure key={photo.photoId}><img src={photo.url} alt={`${String(photo.photoType || 'Item').replaceAll('_', ' ').toLowerCase()} view of the found item`} /><figcaption>{String(photo.photoType || 'Item photo').replaceAll('_', ' ')}</figcaption></figure>)}
  </div>
}

function AuthorityPortal({ token, user, onLogin }) {
  const [destinations, setDestinations] = useState([])
  const [memberships, setMemberships] = useState([])
  const [cases, setCases] = useState([])
  const [reports, setReports] = useState([])
  const [assignments, setAssignments] = useState({})
  const [adminQueue, setAdminQueue] = useState({ destinations: [], memberships: [] })
  const [moderationUsers, setModerationUsers] = useState([])
  const [capabilities, setCapabilities] = useState({ custodyTransfersEnabled: false })
  const [form, setForm] = useState({ authorityId: '', authorityName: '', institutionType: '', officialEmail: '', contactInformation: '', locationDescription: '', name: '', email: '', password: '' })
  const [codes, setCodes] = useState({})
  const [handoverCodes, setHandoverCodes] = useState({})
  const [handoverErrors, setHandoverErrors] = useState({})
  const [issued, setIssued] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [provisionedCredentials, setProvisionedCredentials] = useState(null)
  const hasGlobalAuthorityRole = ['STAFF', 'ADMIN'].includes(user?.role)
  const isAdmin = user?.role === 'ADMIN'
  const hasAuthorityMembership = memberships.some((item) => item.membership_status === 'ACTIVE' && item.verification_status === 'VERIFIED' && item.destination_status === 'ACTIVE')
  const showAuthorityCases = hasGlobalAuthorityRole || hasAuthorityMembership
  const showFinderReports = !isAdmin && !hasAuthorityMembership && reports.some((report) => report.report_type === 'FOUND')

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const [eligible, mine, caseResult, feature, ownReports] = await Promise.all([
        getAuthorityDestinations(token),
        getAuthorityMemberships(token),
        getAuthorityCases(token),
        getAuthorityCapabilities(token),
        getMyReports(token),
      ])
      setDestinations(eligible.destinations || [])
      setMemberships(mine.memberships || [])
      setCases(caseResult.cases || [])
      setCapabilities(feature)
      setReports(ownReports.reports || [])
      if (user?.role === 'ADMIN') {
        const [queue, moderation] = await Promise.all([getAuthorityAdminQueue(token), getChatModerationReports(token)])
        setAdminQueue(queue)
        setModerationUsers(moderation.users || [])
      } else {
        setAdminQueue({ destinations: [], memberships: [] })
        setModerationUsers([])
      }
    } catch (loadError) {
      setError(loadError.message || 'Could not load authority information.')
    } finally {
      setLoading(false)
    }
  }, [token, user])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  async function submitProvision(event) {
    event.preventDefault()
    setSaving('request')
    setError('')
    setMessage('')
    try {
      const result = await provisionAuthorityAccount(token, {
        authorityId: form.authorityId || null,
        authorityName: form.authorityName,
        institutionType: form.institutionType,
        officialEmail: form.officialEmail,
        contactInformation: form.contactInformation,
        locationDescription: form.locationDescription,
        name: form.name,
        email: form.email,
        password: form.password,
      })
      setProvisionedCredentials({ email: result.account.email, password: form.password })
      setMessage('Authority login created. Share the credentials below with the authority through a secure channel.')
      setForm({ authorityId: '', authorityName: '', institutionType: '', officialEmail: '', contactInformation: '', locationDescription: '', name: '', email: '', password: '' })
      await load()
    } catch (requestError) {
      setError(requestError.message || 'Could not submit authority request.')
    } finally {
      setSaving('')
    }
  }

  async function adminAction(kind, id, action, membershipRole) {
    const key = `${kind}:${id}`
    setSaving(key)
    setError('')
    setMessage('')
    try {
      if (kind === 'destination') await reviewAuthorityDestination(token, id, action)
      else await reviewAuthorityMembership(token, id, action, membershipRole)
      setMessage('Authority record updated.')
      await load()
    } catch (actionError) {
      setError(actionError.message || 'Could not update authority record.')
    } finally {
      setSaving('')
    }
  }

  async function moderationAction(action, id) {
    const key = `moderation:${action}:${id}`
    setSaving(key)
    setError('')
    setMessage('')
    try {
      if (action === 'dismiss') await dismissChatUserReport(token, id)
      else await reinstateChatUser(token, id)
      setMessage(action === 'dismiss' ? 'Report dismissed.' : 'Account reinstated.')
      await load()
    } catch (actionError) {
      setError(actionError.message || 'Could not update the moderation report.')
    } finally {
      setSaving('')
    }
  }

  async function confirm(transferId) {
    setSaving(`transfer:${transferId}`)
    setError('')
    setMessage('')
    try {
      await confirmCustodyTransfer(token, transferId, codes[transferId] || '')
      setCodes((previous) => ({ ...previous, [transferId]: '' }))
      setMessage('Physical receipt confirmed.')
      await load()
    } catch (confirmError) {
      setError(confirmError.message || 'Could not confirm receipt.')
    } finally {
      setSaving('')
    }
  }

  async function confirmClaimReturn(claimId) {
    setSaving(`claim-return:${claimId}`)
    setHandoverErrors((previous) => ({ ...previous, [claimId]: '' }))
    setError('')
    setMessage('')
    try {
      await confirmHandover(token, claimId, handoverCodes[claimId] || '')
      setHandoverCodes((previous) => ({ ...previous, [claimId]: '' }))
      setMessage('Safe return confirmed. The claim and related reports are now marked returned.')
      await load()
    } catch (confirmError) {
      setHandoverErrors((previous) => ({ ...previous, [claimId]: confirmError.message || 'Could not confirm safe return.' }))
    } finally {
      setSaving('')
    }
  }

  async function updateAssignment(reportId) {
    const choice = assignments[reportId] || {}
    setSaving(`assignment:${reportId}`)
    setError('')
    setMessage('')
    try {
      await assignReportAuthority(token, reportId, choice.recoveryMode || 'DIRECT', choice.authorityId || null)
      setAssignments((previous) => {
        const next = { ...previous }
        delete next[reportId]
        return next
      })
      setMessage('Recovery assignment updated.')
      await load()
    } catch (assignmentError) {
      setError(assignmentError.message || 'Could not update recovery assignment.')
    } finally {
      setSaving('')
    }
  }

  async function initiate(reportId) {
    setSaving(`initiate:${reportId}`)
    setError('')
    setMessage('')
    setIssued(null)
    try {
      const result = await initiateCustodyTransfer(token, reportId)
      setIssued({ reportId, code: result.code, expiresAt: result.custodyTransfer.code_expires_at })
      setMessage('Give this one-time code directly to the receiving authority. It will not be shown again.')
      await load()
    } catch (initiateError) {
      setError(initiateError.message || 'Could not initiate physical custody transfer.')
    } finally {
      setSaving('')
    }
  }

  async function cancel(reportId, transferId) {
    setSaving(`cancel:${transferId}`)
    setError('')
    setMessage('')
    try {
      await cancelCustodyTransfer(token, transferId)
      setMessage('Pending transfer cancelled.')
      await load()
    } catch (cancelError) {
      setError(cancelError.message || 'Could not cancel transfer.')
    } finally {
      setSaving('')
    }
  }

  if (!token) {
    return (
      <section className="authority-section" id="authority-portal">
        <div className="section-heading"><span className="section-kicker">AUTHORITY PORTAL</span><h2>Manage authority requests and assigned cases</h2></div>
        <div className="authority-panel"><p>Sign in with your existing LostLink account. Authority access is enabled only after administrator approval.</p><button className="btn btn-primary" onClick={onLogin}>Log in</button></div>
      </section>
    )
  }

  return (
    <section className="authority-section" id="authority-portal">
      <div className="section-heading"><span className="section-kicker">{isAdmin ? 'ADMINISTRATION' : showAuthorityCases ? 'AUTHORITY PORTAL' : 'RETURN PLAN'}</span><h2>{isAdmin ? 'LostLink admin dashboard' : showAuthorityCases ? 'Authority case dashboard' : 'My return plan'}</h2><p>{isAdmin ? 'Manage authority access, review new institutions, and open the claim review workspace.' : showAuthorityCases ? 'Assigned cases and safe-return handovers for your authority.' : 'Choose whether to coordinate a return directly or hand a found item to a verified authority.'}</p></div>
      {error && <p className="authority-alert error" role="alert">{error}</p>}
      {showAuthorityCases && <ConversationInbox token={token} />}
      {message && <p className="authority-alert success" role="status">{message}</p>}
      {provisionedCredentials && <div className="authority-credentials" role="status"><div><h3>New authority login credentials</h3><p>Shown only in this session. Send these details through your secure channel, then hide them.</p><dl><dt>Login email</dt><dd>{provisionedCredentials.email}</dd><dt>Initial password</dt><dd><code>{provisionedCredentials.password}</code></dd></dl></div><button type="button" className="btn btn-secondary" onClick={() => setProvisionedCredentials(null)}>Hide credentials</button></div>}
      {loading ? <div className="authority-panel" role="status">Loading authority data…</div> : (
      <>
      {isAdmin && <div className="admin-dashboard-overview" aria-label="Administration overview">
        <article className="admin-dashboard-stat"><span>Active verified destinations</span><strong>{destinations.length}</strong></article>
        <article className="admin-dashboard-stat"><span>Institution reviews</span><strong>{adminQueue.destinations?.length || 0}</strong></article>
        <article className="admin-dashboard-stat"><span>Membership requests</span><strong>{adminQueue.memberships?.length || 0}</strong></article>
        <nav className="admin-dashboard-actions" aria-label="Admin dashboard shortcuts">
          <a className="btn btn-primary" href="#claim-review">Review claims</a>
          <a className="btn btn-secondary" href="#admin-authority-accounts">Create authority login</a>
          <a className="btn btn-secondary" href="#admin-authority-review">Review authority requests</a>
          <a className="btn btn-secondary" href="#admin-chat-moderation">Chat reports</a>
        </nav>
      </div>}
      {isAdmin && <section className="authority-panel chat-moderation-panel" id="admin-chat-moderation" aria-labelledby="chat-moderation-title">
        <h3 id="chat-moderation-title">Chat safety reports</h3>
        <p>Five distinct people reporting a user suspends the account. Review reports below; dismissed reports no longer count toward that threshold.</p>
        {moderationUsers.length === 0 ? <p>No open chat reports.</p> : <div className="chat-moderation-list">
          {moderationUsers.map((reported) => <article className="chat-moderation-user" key={reported.reported_user_id}>
            <div className="authority-case-top"><span>{reported.reported_name} · {reported.reported_email}</span><span>{reported.account_status}</span></div>
            <p><strong>{reported.distinct_reporters} distinct reports</strong> · account {reported.account_status.toLowerCase()}</p>
            {(reported.reports || []).map((item) => <div className="chat-moderation-report" key={item.reportId}>
              <strong>{item.category === 'ABUSIVE_LANGUAGE' ? 'Cuss words or abusive language' : 'Rude or harassing behavior'}</strong>
              <p>“{item.message}”</p>
              {item.details && <p>Reporter context: {item.details}</p>}
              <small>Reported by {item.reporterName} · {new Date(item.createdAt).toLocaleString()} · Claim #{item.claimId}</small>
              <button type="button" className="btn btn-secondary" disabled={Boolean(saving)} onClick={() => moderationAction('dismiss', item.reportId)}>
                {saving === `moderation:dismiss:${item.reportId}` ? 'Dismissing…' : 'Dismiss this report'}
              </button>
            </div>)}
            {reported.account_status === 'SUSPENDED' && <button type="button" className="btn btn-primary" disabled={Boolean(saving)} onClick={() => moderationAction('reinstate', reported.reported_user_id)}>
              {saving === `moderation:reinstate:${reported.reported_user_id}` ? 'Reinstating…' : 'Reinstate account'}
            </button>}
          </article>)}
        </div>}
      </section>}
      <div className={`authority-layout${isAdmin ? ' admin-dashboard-layout' : showAuthorityCases ? '' : ' finder-return-layout'}`}>
          {showAuthorityCases && <div className="authority-panel" id={isAdmin ? 'admin-authority-accounts' : undefined}>
            {user?.role === 'ADMIN' ? <div className="authority-panel">
              <h3>Provision an authority login</h3>
              <p>Only LostLink administrators create authority accounts. Share the password with the institution through a secure channel.</p>
              <form className="authority-form" onSubmit={submitProvision}>
                <label htmlFor="provision-destination">Existing authority</label>
                <select id="provision-destination" value={form.authorityId} onChange={(event) => setForm((previous) => ({ ...previous, authorityId: event.target.value }))}>
                  <option value="">Create a new verified authority</option>
                  {destinations.map((item) => <option key={item.authority_id} value={item.authority_id}>{item.name}</option>)}
                </select>
                {!form.authorityId && <>
                  <label htmlFor="provision-authority-name">Authority name</label><input id="provision-authority-name" required maxLength={200} value={form.authorityName} onChange={(event) => setForm((previous) => ({ ...previous, authorityName: event.target.value }))} placeholder="Campus security, library, etc." />
                  <label htmlFor="provision-authority-type">Authority type</label><input id="provision-authority-type" maxLength={80} value={form.institutionType} onChange={(event) => setForm((previous) => ({ ...previous, institutionType: event.target.value }))} />
                  <label htmlFor="provision-authority-location">Location</label><input id="provision-authority-location" maxLength={300} value={form.locationDescription} onChange={(event) => setForm((previous) => ({ ...previous, locationDescription: event.target.value }))} />
                  <label htmlFor="provision-authority-official-email">Official contact email</label><input id="provision-authority-official-email" type="email" maxLength={254} value={form.officialEmail} onChange={(event) => setForm((previous) => ({ ...previous, officialEmail: event.target.value }))} />
                </>}
                <label htmlFor="provision-user-name">Authority staff name</label><input id="provision-user-name" required maxLength={120} value={form.name} onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))} />
                <label htmlFor="provision-user-email">Login email</label><input id="provision-user-email" type="email" required maxLength={254} value={form.email} onChange={(event) => setForm((previous) => ({ ...previous, email: event.target.value }))} />
                <label htmlFor="provision-user-password">Initial password</label><input id="provision-user-password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required value={form.password} onChange={(event) => setForm((previous) => ({ ...previous, password: event.target.value }))} />
                <button className="btn btn-primary" type="submit" disabled={Boolean(saving)}>{saving === 'request' ? 'Creating authority login…' : 'Create authority login'}</button>
              </form>
              {!isAdmin && <><h3 className="authority-subheading">Your authority memberships</h3>
              {memberships.length ? <ul className="authority-membership-list">{memberships.map((item) => <li key={item.membership_id}><strong>{item.authority_name}</strong><span>{item.membership_status.replaceAll('_', ' ')} · {item.membership_role}</span></li>)}</ul> : <p>No authority memberships are linked to this administrator account.</p>}</>}
            </div> : <div className="authority-panel">
              <h3>Authority access</h3>
              {memberships.length ? <ul className="authority-membership-list">{memberships.map((item) => <li key={item.membership_id}><strong>{item.authority_name}</strong><span>{item.membership_status.replaceAll('_', ' ')} · {item.membership_role}</span></li>)}</ul> : <p>Authority logins are created by LostLink administrators. Use the credentials supplied by your institution administrator.</p>}
            </div>}
          </div>}
          {showFinderReports && !isAdmin && <div className="authority-panel">
            <h3>Your found reports</h3>
            {reports.filter((report) => report.report_type === 'FOUND').length === 0 ? <p>You have no found reports to assign.</p> : <div className="authority-case-list">{reports.filter((report) => report.report_type === 'FOUND').map((report) => {
              const choice = assignments[report.report_id] || { recoveryMode: report.recovery_mode || 'DIRECT', authorityId: report.authority_id ? String(report.authority_id) : '' }
              return <article className="authority-case" key={report.report_id}>
                <h4>{report.title || 'Found item'}</h4>
                <p>Recovery: {report.recovery_mode === 'AUTHORITY' ? `Authority assisted · ${report.authority_name || 'assigned authority'}` : 'Direct'}</p>
                {report.custody_status && <p>Transfer state: {report.custody_status.replaceAll('_', ' ')}</p>}
                {report.recovery_mode === 'AUTHORITY' && !capabilities.custodyTransfersEnabled && <p className="authority-note" role="status">One-time handover codes are unavailable because the server is missing its custody-code configuration. Ask the LostLink administrator to configure CUSTODY_CODE_HMAC_KEY (at least 32 bytes) and restart the backend.</p>}
                {report.custody_status === 'PENDING_RECEIPT' && report.custody_transfer_id && <button className="btn btn-secondary" disabled={Boolean(saving)} onClick={() => cancel(report.report_id, report.custody_transfer_id)}>Cancel pending transfer</button>}
                {report.report_type === 'FOUND' && !report.custody_received_at && ['OPEN', 'MATCHED'].includes(report.status) && <>
                  <label htmlFor={`recovery-mode-${report.report_id}`}>Recovery mode</label>
                  <select id={`recovery-mode-${report.report_id}`} value={choice.recoveryMode} onChange={(event) => setAssignments((previous) => ({ ...previous, [report.report_id]: { ...choice, recoveryMode: event.target.value, authorityId: '' } }))}>
                    <option value="DIRECT">Direct recovery</option><option value="AUTHORITY">Authority assisted</option>
                  </select>
                  {choice.recoveryMode === 'AUTHORITY' && <>
                    <label htmlFor={`authority-destination-${report.report_id}`}>Verified destination</label>
                    <select id={`authority-destination-${report.report_id}`} required value={choice.authorityId} onChange={(event) => setAssignments((previous) => ({ ...previous, [report.report_id]: { ...choice, authorityId: event.target.value } }))}>
                      <option value="">Choose an authority</option>
                      {destinations.map((destination) => <option key={destination.authority_id} value={destination.authority_id}>{destination.name}{destination.destination_type === 'CENTRAL' ? ' · LostLink central team' : ''}</option>)}
                    </select>
                  </>}
                  <button className="btn btn-secondary" disabled={Boolean(saving) || (choice.recoveryMode === 'AUTHORITY' && !choice.authorityId)} onClick={() => updateAssignment(report.report_id)}>{saving === `assignment:${report.report_id}` ? 'Saving…' : 'Save recovery choice'}</button>
                  {report.recovery_mode === 'AUTHORITY' && report.custody_status !== 'RECEIVED' && capabilities.custodyTransfersEnabled && <button className="btn btn-primary" disabled={Boolean(saving) || report.custody_status === 'PENDING_RECEIPT'} onClick={() => initiate(report.report_id)}>{saving === `initiate:${report.report_id}` ? 'Preparing code…' : 'Start physical handover'}</button>}
                </>}
                {issued?.reportId === report.report_id && <p className="custody-code-presentation" role="status"><strong>One-time code: {issued.code}</strong><span>Expires {new Date(issued.expiresAt).toLocaleString()}. Show it only to the assigned authority member.</span><button type="button" className="btn btn-secondary" onClick={() => setIssued(null)}>Hide code</button></p>}
              </article>
            })}</div>}
          </div>}
          {showAuthorityCases && !isAdmin && <div className="authority-panel">
            <h3>Assigned cases</h3>
            {cases.length === 0 ? <p>No cases are assigned to an active membership.</p> : <div className="authority-case-list">{cases.map((item) => (
              <article className="authority-case" key={item.report_id}>
                <div className="authority-case-top"><span>{item.destination_type} · {item.authority_name}</span><span>{(item.custody_status || 'AWAITING ASSIGNMENT').replaceAll('_', ' ')}</span></div>
                <h4>{item.custody_status === 'RECEIVED' ? item.title : 'Awaiting finder handoff'}</h4>{item.custody_status === 'RECEIVED' && <><p>{item.category?.replaceAll('_', ' ')} · {item.report_time ? new Date(item.report_time).toLocaleDateString() : 'Date unavailable'}</p>{item.company && <p>Brand: {item.company}</p>}{item.model && <p>Model: {item.model}</p>}{item.color && <p>Color: {item.color}</p>}{item.location_description && <p>Finder’s location details: {item.location_description}</p>}{item.item_attributes && Object.entries(item.item_attributes).filter(([key]) => !['company', 'model'].includes(key)).map(([key, value]) => <p key={key}><strong>{key.replaceAll('_', ' ')}:</strong> {typeof value === 'string' ? value : JSON.stringify(value)}</p>)}<h5>Found-item photos</h5><AuthorityReportPhotos token={token} reportId={item.report_id} photos={item.photos || []} /></>}
                {item.description && <p>{item.description}</p>}
                <p>{item.pending_claim_count} pending claim{item.pending_claim_count === 1 ? '' : 's'}</p>
                {item.custody_status === 'RECEIVED' && item.pending_claim_count > 0 && <a className="btn btn-secondary" href="#claim-review">Review assigned claims</a>}
                {item.custody_status === 'PENDING_RECEIPT' && <form className="custody-confirm-form" onSubmit={(event) => { event.preventDefault(); confirm(item.custody_transfer_id) }}>
                  <label htmlFor={`custody-code-${item.custody_transfer_id}`}>Finder’s custody code</label>
                  <input id={`custody-code-${item.custody_transfer_id}`} inputMode="numeric" autoComplete="one-time-code" maxLength={8} pattern="[0-9]{8}" value={codes[item.custody_transfer_id] || ''} onChange={(event) => setCodes((previous) => ({ ...previous, [item.custody_transfer_id]: event.target.value.replace(/\D/g, '').slice(0, 8) }))} required />
                  <button className="btn btn-primary" disabled={Boolean(saving)}>{saving === `transfer:${item.custody_transfer_id}` ? 'Confirming…' : 'Confirm physical receipt'}</button>
                </form>}
                {item.custody_status === 'RECEIVED' && <p className="authority-received">In custody since {new Date(item.received_at).toLocaleString()}</p>}
                {item.claims?.map((claim) => <div className="authority-claim-thread" key={claim.claim_id}>
                  <ClaimPhotoAccess token={token} claimId={claim.claim_id} />
                  {claim.claim_status === 'APPROVED' && claim.handover_status !== 'COMPLETED' && <form className="custody-confirm-form" onSubmit={(event) => { event.preventDefault(); confirmClaimReturn(claim.claim_id) }}>
                    <label htmlFor={`claim-return-code-${claim.claim_id}`}>Claimant’s safe-return code</label>
                    <input id={`claim-return-code-${claim.claim_id}`} inputMode="numeric" autoComplete="one-time-code" maxLength={8} pattern="[0-9]{8}" value={handoverCodes[claim.claim_id] || ''} onChange={(event) => setHandoverCodes((previous) => ({ ...previous, [claim.claim_id]: event.target.value.replace(/\D/g, '').slice(0, 8) }))} required />
                    <button className="btn btn-primary" disabled={Boolean(saving) || (handoverCodes[claim.claim_id] || '').length !== 8}>{saving === `claim-return:${claim.claim_id}` ? 'Confirming…' : 'Confirm safe return'}</button>
                    {handoverErrors[claim.claim_id] && <p className="authority-alert error" role="alert">{handoverErrors[claim.claim_id]}</p>}
                  </form>}
                  {claim.handover_status === 'COMPLETED' && <p className="authority-received">Safe return confirmed.</p>}
                </div>)}
              </article>
            ))}</div>}
            {!capabilities.custodyTransfersEnabled && <p className="authority-note">Custody transfers are disabled until the server is configured with a secret HMAC key of at least 32 bytes.</p>}
          </div>
          }
        </div>
      </>)}

      {isAdmin && <div className="authority-panel admin-authority-panel" id="admin-authority-review">
        <h3>Authority account administration</h3>
        <h4>Institution registrations</h4>
        {adminQueue.destinations?.length ? adminQueue.destinations.map((item) => <div className="authority-admin-row" key={item.authority_id}><div><strong>{item.name}</strong><span>{item.institution_type || 'Institution'} · {item.official_email || 'No official email provided'}</span></div><button className="btn btn-primary" disabled={Boolean(saving)} onClick={() => adminAction('destination', item.authority_id, 'VERIFY')}>Approve</button><button className="btn btn-secondary" disabled={Boolean(saving)} onClick={() => adminAction('destination', item.authority_id, 'REJECT')}>Reject</button></div>) : <p>No institution registrations need review.</p>}
        <h4>Existing membership requests</h4>
        <p>These requests cannot grant dashboard access. Provision authority accounts above.</p>
        {adminQueue.memberships?.length ? adminQueue.memberships.map((item) => <div className="authority-admin-row" key={item.membership_id}><div><strong>{item.applicant_name} · {item.authority_name}</strong><span>{item.applicant_email} · {item.membership_status}</span></div><button className="btn btn-secondary" disabled={Boolean(saving)} onClick={() => adminAction('membership', item.membership_id, 'REJECT')}>Reject request</button></div>) : <p>No existing membership requests need review.</p>}
      </div>}
    </section>
  )
}

export default AuthorityPortal
