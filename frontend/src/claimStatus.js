export const CLAIM_STATUS_LABELS = {
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  COMPLETED: 'Completed',
}

export function describeClaimStatus(status, relationship, recoveryMode) {
  if (status === 'SUBMITTED') {
    if (relationship === 'FOUND_REPORT_OWNER' && recoveryMode === 'DIRECT') {
      return 'Review this ownership claim and record verification below.'
    }
    if (relationship === 'CLAIMANT' && recoveryMode === 'AUTHORITY') {
      return 'Waiting for the assigned authority to begin claim review.'
    }
    if (relationship === 'CLAIMANT') {
      return 'Waiting for the found-item owner or an authorized reviewer to begin review.'
    }
    return 'A reviewer has not started this claim yet.'
  }
  if (status === 'IN_REVIEW') {
    if (relationship === 'FOUND_REPORT_OWNER' && recoveryMode === 'DIRECT') {
      return 'Review the latest ownership verification and make a decision when eligible.'
    }
    if (relationship === 'AUTHORITY_CLAIMANT') {
      return 'The assigned authority is reviewing your claim. Respond to any evidence requests in the claim conversation.'
    }
    if (relationship === 'CLAIMANT') {
      return 'A reviewer is checking your claim. Respond to any evidence requests in the claim conversation.'
    }
    return 'A reviewer is checking this claim.'
  }
  if (status === 'APPROVED' && relationship === 'FOUND_REPORT_OWNER') {
    return 'The claimant gets a one-time code and shows it to you; confirm the safe return after receiving the item.'
  }
  if (status === 'APPROVED' && relationship === 'AUTHORITY_CLAIMANT') {
    return 'Get your one-time return code here and show it to the assigned authority.'
  }
  if (status === 'APPROVED') return 'Get your one-time return code here and show it to the finder.'
  if (status === 'REJECTED') return 'This claim was rejected. Contact support if you need help.'
  if (status === 'COMPLETED') return 'Handover confirmed.'
  if (status === 'WITHDRAWN') return 'This claim was withdrawn.'
  return 'Check back here for updates.'
}
