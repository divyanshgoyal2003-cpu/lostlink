import { useEffect, useState } from 'react'
import {
  confirmHandover,
  enableClaimConversation,
  getClaimReviewQueue,
  getClaimVerifications,
  getMyClaims,
  issueHandoverCode,
  reviewClaim,
  submitClaimVerification,
  getAuthorityMemberships,
} from '../api'
import './ClaimWorkflow.css'
import ClaimPhotoAccess from './ClaimPhotoAccess'
import ConversationPanel from './ConversationPanel'
import ConversationInbox from './ConversationInbox'
import { CLAIM_STATUS_LABELS as STATUS_LABELS, describeClaimStatus } from '../claimStatus'

const REVIEW_ROLES = ['STAFF', 'ADMIN']

function readableError(error) {
  if (error.status === 400) return 'The code or details were not accepted. Check them and try again.'
  if (error.status === 401) return 'Your session expired. Log in again to continue.'
  if (error.status === 403) return 'Your account is not authorized for this action.'
  if (error.status === 404) return 'This claim is no longer available.'
  if (error.status === 409) return error.message || 'The claim changed. Refresh and try again.'
  if (error.status === 410) return 'This handover code expired. Request a fresh code from My Claims.'
  if (error.status === 429) return 'Too many incorrect codes were entered. Try again after the limit resets.'
  return error.message || 'Something went wrong. Please try again.'
}

function updateById(setter, id, value) {
  setter((previous) => ({ ...previous, [id]: value }))
}

function ClaimWorkflow({ token, user, claims = [], onClaimsChange, onRefresh, hidePersonalClaims = false }) {
  const activeClaims = claims.filter((claim) => claim.claim_status !== 'COMPLETED')
  const [hasAuthorityMembership, setHasAuthorityMembership] = useState(false)
  const isReviewer = REVIEW_ROLES.includes(user?.role) || hasAuthorityMembership
  const [claimsLoading, setClaimsLoading] = useState(false)
  const [claimsError, setClaimsError] = useState('')
  const [reviewQueue, setReviewQueue] = useState([])
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState('')
  const [pendingAction, setPendingAction] = useState('')
  const [actionErrors, setActionErrors] = useState({})
  const [feedback, setFeedback] = useState({})
  const [verificationDrafts, setVerificationDrafts] = useState({})
  const [decisionNotes, setDecisionNotes] = useState({})
  const [history, setHistory] = useState({})
  const [historyLoading, setHistoryLoading] = useState('')
  const [issuedCodes, setIssuedCodes] = useState({})
  const [hiddenIssuedCodes, setHiddenIssuedCodes] = useState({})
  const [handoverClockNow, setHandoverClockNow] = useState(Date.now())
  const [codeInputs, setCodeInputs] = useState({})
  const [reviewOptions, setReviewOptions] = useState({})

  useEffect(() => {
    let active = true
    if (!token) {
      setHasAuthorityMembership(false)
      return () => { active = false }
    }
    getAuthorityMemberships(token)
      .then((result) => {
        if (!active) return
        setHasAuthorityMembership((result.memberships || []).some((membership) =>
          membership.membership_status === 'ACTIVE' &&
          membership.verification_status === 'VERIFIED' &&
          membership.destination_status === 'ACTIVE',
        ))
      })
      .catch(() => { if (active) setHasAuthorityMembership(false) })
    return () => { active = false }
  }, [token])

  useEffect(() => {
    const expiries = claims
      .filter((claim) => claim.handover_status === 'CODE_ISSUED')
      .map((claim) => Date.parse(claim.handover_code_expires_at))
      .filter((expiry) => Number.isFinite(expiry) && expiry > handoverClockNow)
    if (!expiries.length) return undefined

    const nextExpiry = Math.min(...expiries)
    const timer = window.setTimeout(() => {
      const now = Date.now()
      const expiredClaimIds = new Set(claims
        .filter((claim) => {
          const expiry = Date.parse(claim.handover_code_expires_at)
          return Number.isFinite(expiry) && expiry <= now
        })
        .map((claim) => String(claim.claim_id)))
      setHandoverClockNow(now)
      if (expiredClaimIds.size) {
        setIssuedCodes((previous) => Object.fromEntries(
          Object.entries(previous).filter(([claimId]) => !expiredClaimIds.has(claimId)),
        ))
        setHiddenIssuedCodes((previous) => Object.fromEntries(
          Object.entries(previous).filter(([claimId]) => !expiredClaimIds.has(claimId)),
        ))
      }
    }, Math.min(Math.max(nextExpiry - handoverClockNow + 50, 50), 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [claims, handoverClockNow])

  async function loadClaims() {
    if (!token) {
      onClaimsChange?.([], false)
      return
    }
    setClaimsLoading(true)
    setClaimsError('')
    try {
      const result = await getMyClaims(token)
      onClaimsChange?.(result.claims || [], true)
    } catch (error) {
      setClaimsError(readableError(error))
    } finally {
      setClaimsLoading(false)
    }
  }

  async function loadReviewQueue() {
    if (!token || !isReviewer) {
      setReviewQueue([])
      return
    }
    setQueueLoading(true)
    setQueueError('')
    try {
      const result = await getClaimReviewQueue(token)
      setReviewQueue(result.claims || [])
    } catch (error) {
      setQueueError(readableError(error))
    } finally {
      setQueueLoading(false)
    }
  }

  async function refreshWorkflow() {
    await Promise.all([loadClaims(), isReviewer ? loadReviewQueue() : Promise.resolve()])
  }

  useEffect(() => {
    onClaimsChange?.([], false)
    setReviewQueue([])
    setIssuedCodes({})
    setHiddenIssuedCodes({})
    setCodeInputs({})
    setActionErrors({})
    setFeedback({})
    setHistory({})
    setVerificationDrafts({})
    setDecisionNotes({})
    if (token) {
      loadClaims()
      if (isReviewer) loadReviewQueue()
    }
    // Load only when the signed-in identity, role, or active authority access changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.role, isReviewer])

  async function runAction(key, action, successMessage) {
    setPendingAction(key)
    setActionErrors((previous) => ({ ...previous, [key]: '' }))
    setFeedback((previous) => ({ ...previous, [key]: '' }))
    try {
      await action()
      if (successMessage) {
        setFeedback((previous) => ({ ...previous, [key]: successMessage }))
      }
      return true
    } catch (error) {
      setActionErrors((previous) => ({ ...previous, [key]: readableError(error) }))
      return false
    } finally {
      setPendingAction('')
    }
  }

  async function handleVerification(claim) {
    const id = claim.claim_id
    const draft = verificationDrafts[id] || {
      verificationType: 'OWNERSHIP_VERIFICATION',
      status: 'NEEDS_REVIEW',
      privateNote: '',
    }
    const key = `verify-${id}`
    await runAction(key, async () => {
      await submitClaimVerification(token, id, draft)
      await Promise.all([isReviewer ? loadReviewQueue() : Promise.resolve(), loadClaims()])
    }, 'Verification recorded. Review the updated status before deciding.')
  }

  async function handleDecision(claim, decision) {
    const id = claim.claim_id
    const key = `decision-${id}`
    await runAction(key, async () => {
      await reviewClaim(token, id, decision, decisionNotes[id] || '')
      await Promise.all([refreshWorkflow(), onRefresh?.()])
    }, `Claim ${decision.toLowerCase()}.`)
  }

  async function handleEnableChat(claim) {
    const id = claim.claim_id
    const key = `enable-chat-${id}`
    await runAction(key, async () => {
      await enableClaimConversation(token, id)
      updateById(setReviewOptions, id, true)
      await Promise.all([loadReviewQueue(), loadClaims()])
    }, 'Chat is enabled for this claim.')
  }

  async function handleHistory(claimId) {
    setHistoryLoading(claimId)
    setActionErrors((previous) => ({ ...previous, [`history-${claimId}`]: '' }))
    try {
      const result = await getClaimVerifications(token, claimId)
      updateById(setHistory, claimId, result.verifications || [])
    } catch (error) {
      setActionErrors((previous) => ({ ...previous, [`history-${claimId}`]: readableError(error) }))
    } finally {
      setHistoryLoading('')
    }
  }

  async function handleIssueCode(claim) {
    const id = claim.claim_id
    const key = `issue-code-${id}`
    await runAction(key, async () => {
      const result = await issueHandoverCode(token, id)
      // Keep the code only in this session's component memory; never persist it.
      updateById(setIssuedCodes, id, result.code)
      updateById(setHiddenIssuedCodes, id, false)
      await loadClaims()
    }, 'Your one-time code is ready. Show it only to the person handing the item to you; it expires in 15 minutes.')
  }

  async function handleConfirmHandover(claim) {
    const id = claim.claim_id
    const key = `confirm-${id}`
    const code = codeInputs[id] || ''
    const confirmed = await runAction(key, async () => {
      await confirmHandover(token, id, code)
      updateById(setIssuedCodes, id, '')
      updateById(setHiddenIssuedCodes, id, false)
      await Promise.all([refreshWorkflow(), onRefresh?.()])
    }, 'Handover confirmed. The claim and related report statuses are updated.')
    if (confirmed) updateById(setCodeInputs, id, '')
  }

  return (
    <>
      <section className="my-reports-section claim-workflow" id="my-claims" aria-labelledby="my-claims-title" hidden={hidePersonalClaims}>
        <div className="section-heading">
          <span className="section-kicker">YOUR ACTIVITY</span>
          <h2 id="my-claims-title">My claims</h2>
          <p>Track review progress and confirm a safe handover when a claim is approved.</p>
        </div>
        <ConversationInbox token={token} />

        {!user ? (
          <div className="my-reports-empty"><p>Log in to submit and track claims.</p></div>
        ) : claimsLoading ? (
          <div className="my-reports-empty" role="status">Loading your claims…</div>
        ) : claimsError ? (
          <div className="my-reports-empty">
            <p className="auth-error" role="alert">{claimsError}</p>
            <button className="btn btn-secondary" onClick={loadClaims}>Try again</button>
          </div>
        ) : activeClaims.length === 0 ? (
          <div className="my-reports-empty">
            <div className="placeholder-icon" aria-hidden="true">✓</div>
            <h3>{claims.length ? 'No active claims' : 'No claims yet'}</h3>
            <p>{claims.length ? 'Completed returns are available in Return history.' : 'When you claim a possible match, its progress will appear here.'}</p>
            {claims.length ? <a className="btn btn-secondary" href="#return-history">View return history</a> : <a className="btn btn-primary" href="#my-matches">View matches</a>}
          </div>
        ) : (
          <div className="my-reports-list">
            {activeClaims.map((claim) => {
              const id = claim.claim_id
              const relationship = claim.current_user_relationship
              const actionKey = `claim-${id}`
              const handoverCodeExpiresAt = Date.parse(claim.handover_code_expires_at)
              const serverCodeActive = claim.handover_status === 'CODE_ISSUED' &&
                Number.isFinite(handoverCodeExpiresAt) && handoverCodeExpiresAt > handoverClockNow
              const localCodeActive = Boolean(issuedCodes[id]) &&
                (!Number.isFinite(handoverCodeExpiresAt) || handoverCodeExpiresAt > handoverClockNow)
              return (
                <article className="my-report-card claim-card" key={id}>
                  <div className="my-report-card-top">
                    <span className="report-type-badge">CLAIM #{id}</span>
                    <span className={`claim-status claim-status-${claim.claim_status?.toLowerCase()}`}>
                      {STATUS_LABELS[claim.claim_status] || claim.claim_status}
                    </span>
                  </div>
                  <p><strong>Match:</strong> #{claim.match_id} · score {Math.round(Number(claim.total_score))}/100</p>
                  <p><strong>Your role:</strong> {relationship === 'CLAIMANT' ? 'Claimant' : 'Found-item owner'}</p>
                  <p><strong>Submitted:</strong> {new Date(claim.submitted_at).toLocaleString()}</p>
                  <p className="claim-next-step">{claim.authority_custody_received && relationship === 'FOUND_REPORT_OWNER'
                    ? 'The assigned authority has physical custody and manages claimant release.'
                    : describeClaimStatus(claim.claim_status, relationship === 'CLAIMANT' && claim.authority_custody_received ? 'AUTHORITY_CLAIMANT' : relationship, claim.found_recovery_mode)}</p>
                  <ClaimPhotoAccess
                    token={token}
                    claimId={id}
                    onRefresh={onRefresh}
                    onStartChat={relationship === 'FOUND_REPORT_OWNER' && claim.found_recovery_mode === 'DIRECT' &&
                      ['SUBMITTED', 'IN_REVIEW', 'APPROVED'].includes(claim.claim_status) &&
                      claim.conversation_status !== 'CLOSED' ? () => handleEnableChat(claim) : undefined}
                    chatStarting={pendingAction === `enable-chat-${id}`}
                    chatError={actionErrors[`enable-chat-${id}`]}
                    chatFeedback={feedback[`enable-chat-${id}`]}
                  />
                  {relationship === 'CLAIMANT' && claim.conversation_status !== 'OPEN' &&
                    ['SUBMITTED', 'IN_REVIEW', 'APPROVED'].includes(claim.claim_status) && (
                      <p className="claim-chat-note" role="status">
                        {claim.found_recovery_mode === 'AUTHORITY'
                          ? 'Chat will be available after the assigned authority enables it.'
                          : 'Chat will be available after the found-item owner enables it.'}
                      </p>
                    )}
                  {claim.conversation_status === 'OPEN' && <ConversationPanel token={token} claimId={id} title={claim.found_recovery_mode === 'AUTHORITY' ? 'Chat with the assigned authority' : 'Chat with the found-item owner'} />}

                  {claim.claim_status === 'APPROVED' && relationship === 'FOUND_REPORT_OWNER' && claim.found_recovery_mode === 'DIRECT' && (
                    <div className="claim-handover-box">
                      <form className="claim-code-form" onSubmit={(event) => { event.preventDefault(); handleConfirmHandover(claim) }}>
                        <p>The claimant will show you their one-time code. Confirm only after the item is safely returned.</p>
                        <label htmlFor={`handover-code-${id}`}>Claimant’s handover code</label>
                        <input id={`handover-code-${id}`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} value={codeInputs[id] || ''} onChange={(event) => updateById(setCodeInputs, id, event.target.value.replace(/\D/g, '').slice(0, 8))} required />
                        <button className="btn btn-primary" type="submit" disabled={pendingAction === `confirm-${id}` || (codeInputs[id] || '').length !== 8}>
                          {pendingAction === `confirm-${id}` ? 'Confirming…' : 'Confirm safe handover'}
                        </button>
                        {actionErrors[`confirm-${id}`] && <p className="auth-error" role="alert">{actionErrors[`confirm-${id}`]}</p>}
                      </form>
                    </div>
                  )}

                  {claim.claim_status === 'APPROVED' && relationship === 'CLAIMANT' && (
                    <div className="claim-handover-box claim-code-form">
                      <p>Get your private one-time code after approval and show it to the finder{claim.found_recovery_mode === 'AUTHORITY' ? ' or assigned authority' : ''} when you receive the item. It expires in 15 minutes and can be used once.</p>
                      {localCodeActive ? hiddenIssuedCodes[id]
                        ? <div className="handover-code-display" role="status" aria-live="polite">
                          <span>Your active handover code is hidden on this page.</span>
                          <button type="button" className="btn btn-secondary" onClick={() => updateById(setHiddenIssuedCodes, id, false)}>Show code</button>
                        </div>
                        : <div className="handover-code-display" role="status" aria-live="polite">
                          <span>Show this code to the person handing over the item:</span>
                          <strong aria-label={`Handover code ${issuedCodes[id]}`}>{issuedCodes[id]}</strong>
                          <button type="button" className="btn btn-secondary" onClick={() => updateById(setHiddenIssuedCodes, id, true)}>Hide code</button>
                        </div> : serverCodeActive
                        ? <p role="status">A code was already generated for this claim. It expires {new Date(claim.handover_code_expires_at).toLocaleString()}. For security, its value can only be shown in the session that generated it; if you leave that session, request a replacement after this code expires.</p>
                        : <button type="button" className="btn btn-primary" disabled={pendingAction === `issue-code-${id}`} onClick={() => handleIssueCode(claim)}>
                        {pendingAction === `issue-code-${id}` ? 'Preparing code…' : 'Get one-time handover code'}
                      </button>}
                      {feedback[`issue-code-${id}`] && <p className="claim-feedback" role="status">{feedback[`issue-code-${id}`]}</p>}
                      {actionErrors[`issue-code-${id}`] && <p className="auth-error" role="alert">{actionErrors[`issue-code-${id}`]}</p>}
                    </div>
                  )}

                  {relationship === 'FOUND_REPORT_OWNER' && claim.found_recovery_mode === 'DIRECT' && ['SUBMITTED', 'IN_REVIEW'].includes(claim.claim_status) && (() => {
                    const draft = verificationDrafts[id] || { verificationType: 'OWNERSHIP_VERIFICATION', status: 'NEEDS_REVIEW', privateNote: '' }
                    const canApprove = claim.claim_status === 'IN_REVIEW' && claim.latest_verification_status === 'PASSED'
                    return <div className="claim-review-form founder-claim-review">
                      <h3>Review this ownership claim</h3>
                      <label htmlFor={`founder-verification-result-${id}`}>Ownership verification</label>
                      <select id={`founder-verification-result-${id}`} value={draft.status} onChange={(event) => updateById(setVerificationDrafts, id, { ...draft, status: event.target.value })}>
                        <option value="NEEDS_REVIEW">Needs more review</option><option value="PASSED">Passed</option><option value="FAILED">Failed</option>
                      </select>
                      <label htmlFor={`founder-verification-note-${id}`}>Private verification note</label>
                      <textarea id={`founder-verification-note-${id}`} rows={2} maxLength={2000} value={draft.privateNote} onChange={(event) => updateById(setVerificationDrafts, id, { ...draft, privateNote: event.target.value })} />
                      <button type="button" className="btn btn-secondary" disabled={pendingAction === `verify-${id}`} onClick={() => handleVerification(claim)}>{pendingAction === `verify-${id}` ? 'Saving…' : 'Record verification'}</button>
                      {claim.claim_status === 'IN_REVIEW' && <div className="claim-review-actions">
                        <button type="button" className="btn btn-primary" disabled={!canApprove || pendingAction === `decision-${id}`} onClick={() => handleDecision(claim, 'APPROVED')}>Approve claim</button>
                        <button type="button" className="btn btn-secondary" disabled={pendingAction === `decision-${id}`} onClick={() => handleDecision(claim, 'REJECTED')}>Reject claim</button>
                      </div>}
                      {!canApprove && <small>Approval requires a passed ownership verification.</small>}
                      {actionErrors[`verify-${id}`] && <p className="auth-error" role="alert">{actionErrors[`verify-${id}`]}</p>}
                      {actionErrors[`decision-${id}`] && <p className="auth-error" role="alert">{actionErrors[`decision-${id}`]}</p>}
                    </div>
                  })()}

                  {feedback[actionKey] && <p className="claim-feedback" role="status">{feedback[actionKey]}</p>}
                  {actionErrors[actionKey] && <p className="auth-error" role="alert">{actionErrors[actionKey]}</p>}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {isReviewer && (
        <section className="my-reports-section claim-workflow" id="claim-review" aria-labelledby="claim-review-title">
          <div className="section-heading">
            <span className="section-kicker">STAFF WORKSPACE</span>
            <h2 id="claim-review-title">Claim review queue</h2>
            <p>Record a verification before approving. Private notes are visible only to authorized reviewers.</p>
          </div>

          {queueLoading ? (
            <div className="my-reports-empty" role="status">Loading review queue…</div>
          ) : queueError ? (
            <div className="my-reports-empty">
              <p className="auth-error" role="alert">{queueError}</p>
              <button className="btn btn-secondary" onClick={loadReviewQueue}>Try again</button>
            </div>
          ) : reviewQueue.length === 0 ? (
            <div className="my-reports-empty"><h3>Queue is clear</h3><p>New submitted claims will appear here.</p></div>
          ) : (
            <div className="my-reports-list">
              {reviewQueue.map((claim) => {
                const id = claim.claim_id
                const verification = verificationDrafts[id] || {
                  verificationType: 'OWNERSHIP_VERIFICATION',
                  status: 'NEEDS_REVIEW',
                  privateNote: '',
                }
                const canApprove = claim.claim_status === 'IN_REVIEW' && claim.latest_verification_status === 'PASSED'
                const canEnableAuthorityChat = claim.found_recovery_mode === 'AUTHORITY' &&
                  claim.authority_custody_received && hasAuthorityMembership &&
                  ['SUBMITTED', 'IN_REVIEW', 'APPROVED'].includes(claim.claim_status)
                const actionKey = `verify-${id}`
                return (
                  <article className="my-report-card claim-review-card" key={id}>
                    <div className="my-report-card-top">
                      <span className="report-type-badge">CLAIM #{id}</span>
                      <span className={`claim-status claim-status-${claim.claim_status?.toLowerCase()}`}>
                        {STATUS_LABELS[claim.claim_status] || claim.claim_status}
                      </span>
                    </div>
                    <div className="claim-review-summary">
                      <div><strong>Claimant</strong><span>{claim.claimant_name || `User #${claim.claimant_user_id}`} · user #{claim.claimant_user_id}</span></div>
                      <div><strong>Match</strong><span>#{claim.match_id} · {Math.round(Number(claim.total_score))}/100</span></div>
                      <div><strong>Latest verification</strong><span>{claim.latest_verification_status || 'None recorded'}</span></div>
                      {claim.found_authority_name && <div><strong>Assigned authority</strong><span>{claim.found_authority_name}</span></div>}
                    </div>
                    <div className="claim-review-reports">
                      <section className="claim-review-report-details">
                        <h3>Lost report</h3>
                        <h4>{claim.lost_item_title || `Report #${claim.lost_report_id}`}</h4>
                        <p>{claim.lost_item_category?.replaceAll('_', ' ')}{claim.lost_report_time ? ` · ${new Date(claim.lost_report_time).toLocaleDateString()}` : ''}</p>
                        {claim.lost_item_color && <p>Color: {claim.lost_item_color}</p>}
                        {claim.lost_item_company && <p>Brand: {claim.lost_item_company}</p>}
                        {claim.lost_item_model && <p>Model: {claim.lost_item_model}</p>}
                        {claim.lost_item_description && <p>{claim.lost_item_description}</p>}
                        {claim.lost_location_description && <p>Location details: {claim.lost_location_description}</p>}
                      </section>
                      <section className="claim-review-report-details">
                        <h3>Found report</h3>
                        <h4>{claim.found_item_title || `Report #${claim.found_report_id}`}</h4>
                        <p>{claim.found_item_category?.replaceAll('_', ' ')}{claim.found_report_time ? ` · ${new Date(claim.found_report_time).toLocaleDateString()}` : ''}</p>
                        {claim.found_item_color && <p>Color: {claim.found_item_color}</p>}
                        {claim.found_item_company && <p>Brand: {claim.found_item_company}</p>}
                        {claim.found_item_model && <p>Model: {claim.found_item_model}</p>}
                        {claim.found_item_description && <p>{claim.found_item_description}</p>}
                        {claim.found_location_description && <p>Location details: {claim.found_location_description}</p>}
                      </section>
                    </div>

                    <button
                      type="button"
                      className="btn btn-secondary claim-enable-chat"
                      aria-expanded={Boolean(reviewOptions[id])}
                      aria-controls={`claim-review-options-${id}`}
                      onClick={() => updateById(setReviewOptions, id, !reviewOptions[id])}
                    >
                      {reviewOptions[id] ? 'Hide chat and review options' : 'Open chat and review options'}
                    </button>
                    {canEnableAuthorityChat && claim.conversation_status !== 'OPEN' && claim.conversation_status !== 'CLOSED' && (
                      <div className="claim-chat-action">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={pendingAction === `enable-chat-${id}`}
                          onClick={() => handleEnableChat(claim)}
                        >
                          {pendingAction === `enable-chat-${id}` ? 'Starting chat…' : 'Start chat with claimant'}
                        </button>
                        {actionErrors[`enable-chat-${id}`] && <p className="auth-error" role="alert">{actionErrors[`enable-chat-${id}`]}</p>}
                        {feedback[`enable-chat-${id}`] && <p className="claim-feedback" role="status">{feedback[`enable-chat-${id}`]}</p>}
                      </div>
                    )}
                    <div id={`claim-review-options-${id}`} hidden={!reviewOptions[id]}>
                    {reviewOptions[id] && <>
                      {claim.conversation_status === 'OPEN'
                        ? <ConversationPanel token={token} claimId={id} title={claim.found_recovery_mode === 'AUTHORITY' ? 'Chat with the assigned authority' : 'Chat with the found-item owner'} />
                        : <p className="claim-chat-note">Chat is not active for this claim yet. You can continue with verification and review below.</p>}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={historyLoading === id}
                        onClick={() => handleHistory(id)}
                      >
                        {historyLoading === id ? 'Loading history…' : history[id] ? 'Refresh private review history' : 'Load private review history'}
                      </button>
                      {history[id] && (
                        <div className="claim-history">
                          {history[id].length === 0 ? <p>No verification records yet.</p> : history[id].map((entry) => (
                            <div className="claim-history-entry" key={entry.verification_id}>
                              <strong>{entry.verification_type}: {entry.verification_status}</strong>
                              {entry.review_notes_private && <p>{entry.review_notes_private}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                      {actionErrors[`history-${id}`] && <p className="auth-error" role="alert">{actionErrors[`history-${id}`]}</p>}

                      <div className="claim-review-form">
                        <label htmlFor={`verification-type-${id}`}>Verification type</label>
                        <input id={`verification-type-${id}`} value="OWNERSHIP_VERIFICATION" readOnly aria-readonly="true" />
                        <label htmlFor={`verification-status-${id}`}>Verification result</label>
                        <select
                          id={`verification-status-${id}`}
                          value={verification.status}
                          onChange={(event) => updateById(setVerificationDrafts, id, { ...verification, status: event.target.value })}
                        >
                          <option value="NEEDS_REVIEW">Needs more review</option>
                          <option value="PASSED">Passed</option>
                          <option value="FAILED">Failed</option>
                        </select>
                        <label htmlFor={`verification-note-${id}`}>Private reviewer note</label>
                        <textarea
                          id={`verification-note-${id}`}
                          maxLength={2000}
                          rows={3}
                          value={verification.privateNote}
                          onChange={(event) => updateById(setVerificationDrafts, id, { ...verification, privateNote: event.target.value })}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={pendingAction === actionKey}
                          onClick={() => handleVerification(claim)}
                        >
                          {pendingAction === actionKey ? 'Saving verification…' : 'Record verification'}
                        </button>
                        {feedback[actionKey] && <p className="claim-feedback" role="status">{feedback[actionKey]}</p>}
                        {actionErrors[actionKey] && <p className="auth-error" role="alert">{actionErrors[actionKey]}</p>}

                        <label htmlFor={`decision-note-${id}`}>Private decision note (optional)</label>
                        <textarea
                          id={`decision-note-${id}`}
                          maxLength={2000}
                          rows={2}
                          value={decisionNotes[id] || ''}
                          onChange={(event) => updateById(setDecisionNotes, id, { ...decisionNotes, [id]: event.target.value })}
                        />
                        <div className="claim-review-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!canApprove || pendingAction === `decision-${id}`}
                            onClick={() => handleDecision(claim, 'APPROVED')}
                          >
                            Approve claim
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={claim.claim_status !== 'IN_REVIEW' || pendingAction === `decision-${id}`}
                            onClick={() => handleDecision(claim, 'REJECTED')}
                          >
                            Reject claim
                          </button>
                        </div>
                        {!canApprove && <small>Approval is available after the latest verification is marked Passed.</small>}
                        {feedback[`decision-${id}`] && <p className="claim-feedback" role="status">{feedback[`decision-${id}`]}</p>}
                        {actionErrors[`decision-${id}`] && <p className="auth-error" role="alert">{actionErrors[`decision-${id}`]}</p>}
                      </div>
                    </>}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      )}

    </>
  )
}

export default ClaimWorkflow
