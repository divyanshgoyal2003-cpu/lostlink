import { useEffect, useState } from 'react'
import {
  confirmHandover,
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

const REVIEW_ROLES = ['STAFF', 'ADMIN']

const STATUS_LABELS = {
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  COMPLETED: 'Completed',
}

function readableError(error) {
  if (error.status === 400) return 'The code or details were not accepted. Check them and try again.'
  if (error.status === 401) return 'Your session expired. Log in again to continue.'
  if (error.status === 403) return 'Your account is not authorized for this action.'
  if (error.status === 404) return 'This claim is no longer available.'
  if (error.status === 409) return error.message || 'The claim changed. Refresh and try again.'
  if (error.status === 410) return 'This handover code expired. Ask the found-item owner for a new code.'
  if (error.status === 429) return 'Too many incorrect codes were entered. Try again after the limit resets.'
  return error.message || 'Something went wrong. Please try again.'
}

function statusDescription(status, relationship) {
  if (status === 'SUBMITTED') return 'Waiting for the assigned review team.'
  if (status === 'IN_REVIEW') return 'A reviewer is checking the claim.'
  if (status === 'APPROVED' && relationship === 'FOUND_REPORT_OWNER') {
    return 'The assigned authority manages claimant release after receiving the item.'
  }
  if (status === 'APPROVED' && relationship === 'AUTHORITY_CLAIMANT') {
    return 'Enter the one-time release code provided by the assigned authority.'
  }
  if (status === 'APPROVED') return 'Enter the code provided by the found-item owner to confirm handover.'
  if (status === 'REJECTED') return 'This claim was rejected. Contact support if you need help.'
  if (status === 'COMPLETED') return 'Handover confirmed.'
  if (status === 'WITHDRAWN') return 'This claim was withdrawn.'
  return 'Check back here for updates.'
}

function updateById(setter, id, value) {
  setter((previous) => ({ ...previous, [id]: value }))
}

function ClaimWorkflow({ token, user, claims = [], onClaimsChange, onRefresh, hidePersonalClaims = false }) {
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
    } catch (error) {
      setActionErrors((previous) => ({ ...previous, [key]: readableError(error) }))
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
      await Promise.all([loadReviewQueue(), loadClaims()])
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
      // Keep the one-time code in component memory only while it is being displayed.
      updateById(setIssuedCodes, id, result.code)
      await loadClaims()
    }, 'Code issued. Share it directly with the claimant; it expires in 15 minutes.')
  }

  async function handleConfirmHandover(claim) {
    const id = claim.claim_id
    const key = `confirm-${id}`
    const code = codeInputs[id] || ''
    await runAction(key, async () => {
      await confirmHandover(token, id, code)
      updateById(setIssuedCodes, id, '')
      await Promise.all([refreshWorkflow(), onRefresh?.()])
    }, 'Handover confirmed. The claim and related report statuses are updated.')
    updateById(setCodeInputs, id, '')
  }

  return (
    <>
      <section className="my-reports-section claim-workflow" id="my-claims" aria-labelledby="my-claims-title" hidden={hidePersonalClaims}>
        <div className="section-heading">
          <span className="section-kicker">YOUR ACTIVITY</span>
          <h2 id="my-claims-title">My claims</h2>
          <p>Track review progress and confirm a safe handover when a claim is approved.</p>
        </div>

        {!user ? (
          <div className="my-reports-empty"><p>Log in to submit and track claims.</p></div>
        ) : claimsLoading ? (
          <div className="my-reports-empty" role="status">Loading your claims…</div>
        ) : claimsError ? (
          <div className="my-reports-empty">
            <p className="auth-error" role="alert">{claimsError}</p>
            <button className="btn btn-secondary" onClick={loadClaims}>Try again</button>
          </div>
        ) : claims.length === 0 ? (
          <div className="my-reports-empty">
            <div className="placeholder-icon" aria-hidden="true">✓</div>
            <h3>No claims yet</h3>
            <p>When you claim a possible match, its progress will appear here.</p>
            <a className="btn btn-primary" href="#my-matches">View matches</a>
          </div>
        ) : (
          <div className="my-reports-list">
            {claims.map((claim) => {
              const id = claim.claim_id
              const relationship = claim.current_user_relationship
              const actionKey = `claim-${id}`
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
                    : statusDescription(claim.claim_status, relationship === 'CLAIMANT' && claim.authority_custody_received ? 'AUTHORITY_CLAIMANT' : relationship)}</p>
                  <ClaimPhotoAccess token={token} claimId={id} onRefresh={onRefresh} />
                  {claim.conversation_status === 'OPEN' && <ConversationPanel token={token} claimId={id} title={claim.found_recovery_mode === 'AUTHORITY' ? 'Chat with the assigned authority' : 'Chat with the found-item owner'} />}

                  {claim.claim_status === 'APPROVED' && relationship === 'FOUND_REPORT_OWNER' && !claim.authority_custody_received && (
                    <div className="claim-handover-box">
                      <p>Request a fresh code only when you are ready to hand over the item. The code is single-use and expires in 15 minutes.</p>
                      {issuedCodes[id] ? (
                        <div className="handover-code-display" role="status" aria-live="polite">
                          <span>Share this code with the claimant:</span>
                          <strong aria-label={`Handover code ${issuedCodes[id]}`}>{issuedCodes[id]}</strong>
                          <button type="button" className="btn btn-secondary" onClick={() => updateById(setIssuedCodes, id, '')}>Hide code</button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={pendingAction === `issue-code-${id}`}
                          onClick={() => handleIssueCode(claim)}
                        >
                          {pendingAction === `issue-code-${id}` ? 'Requesting code…' : 'Request handover code'}
                        </button>
                      )}
                      {feedback[`issue-code-${id}`] && <p className="claim-feedback" role="status">{feedback[`issue-code-${id}`]}</p>}
                      {actionErrors[`issue-code-${id}`] && <p className="auth-error" role="alert">{actionErrors[`issue-code-${id}`]}</p>}
                    </div>
                  )}

                  {claim.claim_status === 'APPROVED' && relationship === 'CLAIMANT' && (
                    <form
                      className="claim-handover-box claim-code-form"
                      onSubmit={(event) => { event.preventDefault(); handleConfirmHandover(claim) }}
                    >
                      <p>Enter the 8-digit code from the found-item owner. It can be used once and expires 15 minutes after issue.</p>
                      <label htmlFor={`handover-code-${id}`}>Handover code</label>
                      <input
                        id={`handover-code-${id}`}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{8}"
                        maxLength={8}
                        value={codeInputs[id] || ''}
                        onChange={(event) => updateById(setCodeInputs, id, event.target.value.replace(/\D/g, '').slice(0, 8))}
                        aria-describedby={`handover-help-${id}`}
                        required
                      />
                      <small id={`handover-help-${id}`}>The code is checked securely and is never saved in your session.</small>
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={pendingAction === `confirm-${id}` || (codeInputs[id] || '').length !== 8}
                      >
                        {pendingAction === `confirm-${id}` ? 'Confirming…' : 'Confirm handover'}
                      </button>
                      {actionErrors[`confirm-${id}`] && <p className="auth-error" role="alert">{actionErrors[`confirm-${id}`]}</p>}
                    </form>
                  )}

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
                      className="btn btn-primary claim-enable-chat"
                      aria-expanded={Boolean(reviewOptions[id])}
                      aria-controls={`claim-review-options-${id}`}
                      onClick={() => updateById(setReviewOptions, id, !reviewOptions[id])}
                    >
                      {reviewOptions[id] ? 'Hide chat and review options' : 'Enable chat'}
                    </button>
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
