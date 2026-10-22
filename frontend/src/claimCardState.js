const CLAIM_STATUS_LABELS = {
  SUBMITTED: 'Awaiting review',
  IN_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  COMPLETED: 'Completed',
}

export function getMatchClaimState(match, claims, claimsLoaded) {
  if (!claimsLoaded) return { type: 'loading' }

  const existingClaim = claims.find((claim) =>
    String(claim.match_id) === String(match.matchId)
  )
  if (existingClaim) {
    return {
      type: 'existing',
      claim: existingClaim,
      label: CLAIM_STATUS_LABELS[existingClaim.claim_status] || existingClaim.claim_status,
    }
  }

  if (match.canClaim && match.matchId != null) return { type: 'submit' }
  if (match.canClaim) return { type: 'unsaved' }
  return { type: 'ineligible' }
}
