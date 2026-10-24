const REVIEW_ROLES = new Set(["STAFF", "ADMIN"]);

async function currentUser(client, userId) {
  const result = await client.query(
    `SELECT user_id, role, account_status FROM users WHERE user_id = $1 FOR SHARE`,
    [userId]
  );
  return result.rows[0] || null;
}

async function isCurrentAdmin(client, userId) {
  const user = await currentUser(client, userId);
  return Boolean(user && user.account_status === "ACTIVE" && user.role === "ADMIN");
}

async function isCurrentReviewer(client, userId) {
  const user = await currentUser(client, userId);
  return Boolean(user && user.account_status === "ACTIVE" && REVIEW_ROLES.has(user.role));
}

async function hasActiveAuthorityMembership(client, userId, authorityId, { requireCustody = false, reportId = null } = {}) {
  const result = await client.query(
    `SELECT 1
     FROM users u
     JOIN authority_memberships am ON am.user_id = u.user_id
     JOIN authority_destinations ad ON ad.authority_id = am.authority_id
     WHERE u.user_id = $1 AND u.account_status = 'ACTIVE'
       AND am.authority_id = $2 AND am.membership_status = 'ACTIVE'
       AND ad.verification_status = 'VERIFIED' AND ad.destination_status = 'ACTIVE'
       AND ($3::boolean = FALSE OR EXISTS (
         SELECT 1 FROM reports r
         JOIN custody_transfer_requests ctr ON ctr.report_id = r.report_id
         WHERE r.report_id = $4 AND r.authority_id = ad.authority_id
           AND ctr.custody_status = 'RECEIVED'
       ))
     LIMIT 1`,
    [userId, authorityId, requireCustody, reportId]
  );
  return result.rowCount > 0;
}

async function canReviewClaim(client, userId, claimId) {
  const actor = await currentUser(client, userId);
  if (!actor || actor.account_status !== "ACTIVE") return false;
  const claim = await client.query(
    `SELECT f.report_id, f.authority_id, f.user_id AS found_owner_id, f.recovery_mode
     FROM claim_requests c JOIN match_records m ON m.match_id=c.match_id
     JOIN reports f ON f.report_id=m.found_report_id WHERE c.claim_id=$1`,
    [claimId]
  );
  if (!claim.rowCount) return false;
  if (claim.rows[0].recovery_mode === "DIRECT" && Number(claim.rows[0].found_owner_id) === userId) return true;
  if (actor.role === "ADMIN" || (actor.role === "STAFF" && claim.rows[0].authority_id == null)) return true;
  const access = await client.query(
    `SELECT am.membership_id
     FROM authority_memberships am
     JOIN authority_destinations ad ON ad.authority_id=am.authority_id
     JOIN users u ON u.user_id=am.user_id
     WHERE am.user_id=$1 AND am.authority_id=$2 AND am.membership_status='ACTIVE'
       AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
       AND u.account_status='ACTIVE'
       AND EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                   WHERE ctr.report_id=$3 AND ctr.custody_status='RECEIVED')
     FOR SHARE OF am, ad, u`,
    [userId, claim.rows[0].authority_id, claim.rows[0].report_id]
  );
  return access.rowCount > 0;
}

module.exports = {
  currentUser,
  isCurrentAdmin,
  isCurrentReviewer,
  hasActiveAuthorityMembership,
  canReviewClaim,
};
