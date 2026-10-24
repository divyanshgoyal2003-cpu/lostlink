const express = require("express");
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const { createNotification } = require("../notifications");
const { currentUser, isCurrentAdmin } = require("../authorityAccess");

const router = express.Router();
router.use(authenticateToken);

function idParam(value) {
  return /^[1-9]\d*$/.test(String(value || "")) ? String(value) : null;
}

function custodySecret() {
  const value = process.env.CUSTODY_CODE_HMAC_KEY;
  if (typeof value !== "string" || Buffer.byteLength(value) < 32 ||
      /^replace-with-at-least-32-random-secret-bytes$/i.test(value.trim())) return null;
  return value;
}

function digestCode(code) {
  const secret = custodySecret();
  if (!secret) throw new Error("Custody HMAC key is unavailable");
  return crypto.createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

function safeDigestEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || "") || !/^[a-f0-9]{64}$/.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function audit(client, actorId, action, entityType, entityId, metadata = {}) {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, entityType, entityId, JSON.stringify(metadata)]
  );
}

async function rollback(client) {
  if (!client) return;
  try { await client.query("ROLLBACK"); } catch { /* preserve the original result */ }
}

async function requireAdmin(client, userId) {
  return isCurrentAdmin(client, userId);
}

async function loadActiveMembership(client, userId, authorityId) {
  const result = await client.query(
    `SELECT am.membership_id, am.authority_id, am.membership_role
     FROM authority_memberships am
     JOIN authority_destinations ad ON ad.authority_id = am.authority_id
     JOIN users u ON u.user_id = am.user_id
     WHERE am.user_id = $1 AND am.authority_id = $2
       AND am.membership_status = 'ACTIVE'
       AND ad.verification_status = 'VERIFIED' AND ad.destination_status = 'ACTIVE'
       AND u.account_status = 'ACTIVE'
     LIMIT 1`,
    [userId, authorityId]
  );
  return result.rows[0] || null;
}

router.get("/capabilities", (_req, res) => {
  return res.json({ custodyTransfersEnabled: Boolean(custodySecret()) });
});

router.get("/destinations", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT authority_id, destination_type, name, institution_type,
              official_email, contact_information, location_description
       FROM authority_destinations
       WHERE verification_status = 'VERIFIED' AND destination_status = 'ACTIVE'
       ORDER BY CASE destination_type WHEN 'CENTRAL' THEN 0 ELSE 1 END, name`
    );
    return res.json({ destinations: result.rows });
  } catch (error) {
    console.error("List authority destinations failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve authority destinations" });
  }
});

// An account can request a new institution or request membership in an
// existing verified institution. Neither path grants authority access.
router.post("/requests", (_req, res) => {
  return res.status(410).json({ error: "Authority access is provisioned by LostLink administrators" });
});

router.post("/admin/accounts", async (req, res) => {
  const { authorityId, authorityName, institutionType, officialEmail, contactInformation, locationDescription, name, email, password } = req.body || {};
  const existingAuthorityId = authorityId == null || authorityId === "" ? null : idParam(authorityId);
  const valid = typeof name === "string" && name.trim().length > 0 && name.trim().length <= 120 &&
    typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().length <= 254 &&
    typeof password === "string" && password.length >= 12 && password.length <= 72 &&
    (authorityId == null || authorityId === "" || existingAuthorityId) &&
    (existingAuthorityId || (typeof authorityName === "string" && authorityName.trim().length > 0 && authorityName.trim().length <= 200));
  if (!valid) return res.status(400).json({ error: "Provide an authority, account name, valid email, and password of 12–72 characters" });
  if ((institutionType != null && (typeof institutionType !== "string" || institutionType.length > 80)) ||
      (officialEmail != null && (typeof officialEmail !== "string" || officialEmail.length > 254)) ||
      (contactInformation != null && (typeof contactInformation !== "string" || contactInformation.length > 500)) ||
      (locationDescription != null && (typeof locationDescription !== "string" || locationDescription.length > 300))) {
    return res.status(400).json({ error: "Authority contact fields exceed their allowed lengths" });
  }
  let client;
  try {
  if (!(await requireAdmin(pool, req.user.userId))) return res.status(403).json({ error: "Administrator access required" });
    const passwordHash = await bcrypt.hash(password, 12);
    client = await pool.connect();
    await client.query("BEGIN");
    if (!(await requireAdmin(client, req.user.userId))) {
      await rollback(client);
      return res.status(403).json({ error: "Administrator access required" });
    }
    let destination;
    if (existingAuthorityId) {
      destination = await client.query(
        `SELECT authority_id, name FROM authority_destinations
         WHERE authority_id=$1 AND verification_status='VERIFIED' AND destination_status='ACTIVE'
         FOR UPDATE`, [existingAuthorityId]
      );
      if (!destination.rowCount) {
        await rollback(client);
        return res.status(404).json({ error: "Active authority destination not found" });
      }
    } else {
      destination = await client.query(
        `INSERT INTO authority_destinations
           (destination_type, name, institution_type, official_email, contact_information,
            location_description, verification_status, destination_status)
         VALUES ('INSTITUTION',$1,$2,$3,$4,$5,'VERIFIED','ACTIVE')
         RETURNING authority_id, name`,
        [authorityName.trim(), institutionType || null, officialEmail || null, contactInformation || null, locationDescription || null]
      );
    }
    const createdUser = await client.query(
      `INSERT INTO users (name,email,password_hash,role,account_status)
       VALUES ($1,$2,$3,'USER','ACTIVE') RETURNING user_id,name,email,role`,
      [name.trim(), email.trim().toLowerCase(), passwordHash]
    );
    const membership = await client.query(
      `INSERT INTO authority_memberships
         (authority_id,user_id,membership_role,membership_status,requested_by_user_id,reviewed_by_user_id,reviewed_at)
       VALUES ($1,$2,'MANAGER','ACTIVE',$3,$3,NOW())
       RETURNING membership_id,authority_id,user_id,membership_role,membership_status`,
      [destination.rows[0].authority_id, createdUser.rows[0].user_id, req.user.userId]
    );
    await audit(client, req.user.userId, "AUTHORITY_ACCOUNT_PROVISIONED", "AUTHORITY_MEMBERSHIP", membership.rows[0].membership_id, { authorityId: Number(destination.rows[0].authority_id), userId: Number(createdUser.rows[0].user_id) });
    await client.query("COMMIT");
    return res.status(201).json({ authority: destination.rows[0], account: createdUser.rows[0], membership: membership.rows[0] });
  } catch (error) {
    await rollback(client);
    if (error.code === "23505") return res.status(409).json({ error: "An account or authority with those details already exists" });
    console.error("Provision authority account failed:", error.message);
    return res.status(500).json({ error: "Unable to provision authority account" });
  } finally {
    if (client) client.release();
  }
});
router.get("/me", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT am.membership_id, am.authority_id, am.membership_role, am.membership_status,
              am.requested_at, am.reviewed_at, ad.name AS authority_name,
              ad.destination_type, ad.verification_status, ad.destination_status
       FROM authority_memberships am
       JOIN authority_destinations ad ON ad.authority_id = am.authority_id
       WHERE am.user_id = $1 ORDER BY am.requested_at DESC, am.membership_id DESC`,
      [req.user.userId]
    );
    return res.json({ memberships: result.rows });
  } catch (error) {
    console.error("Get authority memberships failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve authority memberships" });
  }
});

router.get("/admin/queue", async (req, res) => {
  try {
    if (!(await requireAdmin(pool, req.user.userId))) return res.status(403).json({ error: "Administrator access required" });
    const [destinations, memberships] = await Promise.all([
      pool.query(
        `SELECT authority_id, destination_type, name, institution_type, official_email,
                contact_information, location_description, verification_status, destination_status, created_at
         FROM authority_destinations WHERE verification_status = 'PENDING'
         ORDER BY created_at, authority_id LIMIT 100`
      ),
      pool.query(
        `SELECT am.membership_id, am.authority_id, am.user_id, am.membership_role,
                am.membership_status, am.requested_at, u.name AS applicant_name,
                u.email AS applicant_email, ad.name AS authority_name,
                ad.verification_status, ad.destination_status
         FROM authority_memberships am
         JOIN users u ON u.user_id = am.user_id
         JOIN authority_destinations ad ON ad.authority_id = am.authority_id
         WHERE am.membership_status = 'PENDING'
         ORDER BY am.requested_at, am.membership_id LIMIT 100`
      ),
    ]);
    return res.json({ destinations: destinations.rows, memberships: memberships.rows });
  } catch (error) {
    console.error("Get authority admin queue failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve authority approval queue" });
  }
});

router.patch("/admin/destinations/:authorityId", async (req, res) => {
  const authorityId = idParam(req.params.authorityId);
  const { action } = req.body || {};
  if (!authorityId || !["VERIFY", "REJECT", "SUSPEND", "REACTIVATE"].includes(action)) {
    return res.status(400).json({ error: "Invalid destination action" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (!(await requireAdmin(client, req.user.userId))) {
      await rollback(client);
      return res.status(403).json({ error: "Administrator access required" });
    }
    const before = await client.query("SELECT authority_id, verification_status, destination_status FROM authority_destinations WHERE authority_id = $1 FOR UPDATE", [authorityId]);
    if (!before.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Authority destination not found" });
    }
    const next = {
      VERIFY: { verification: "VERIFIED", status: null },
      REJECT: { verification: "REJECTED", status: null },
      SUSPEND: { verification: null, status: "SUSPENDED" },
      REACTIVATE: { verification: null, status: "ACTIVE" },
    }[action];
    const currentDestination = before.rows[0];
    const destinationTransitions = {
      VERIFY: currentDestination.verification_status === "PENDING",
      REJECT: currentDestination.verification_status === "PENDING",
      SUSPEND: currentDestination.destination_status === "ACTIVE",
      REACTIVATE: currentDestination.destination_status === "SUSPENDED" && currentDestination.verification_status === "VERIFIED",
    };
    if (!destinationTransitions[action]) {
      await rollback(client);
      return res.status(409).json({ error: "Invalid authority destination state transition" });
    }
    const updated = await client.query(
      `UPDATE authority_destinations SET verification_status = COALESCE($2, verification_status),
         destination_status = COALESCE($3, destination_status), updated_at = NOW()
       WHERE authority_id = $1
       RETURNING authority_id, destination_type, name, verification_status, destination_status`,
      [authorityId, next.verification, next.status]
    );
    await audit(client, req.user.userId, `AUTHORITY_${action}`, "AUTHORITY", authorityId, { previousVerificationStatus: before.rows[0].verification_status, previousDestinationStatus: before.rows[0].destination_status });
    await client.query("COMMIT");
    return res.json({ destination: updated.rows[0] });
  } catch (error) {
    await rollback(client);
    console.error("Update authority destination failed:", error.message);
    return res.status(500).json({ error: "Unable to update authority destination" });
  } finally {
    if (client) client.release();
  }
});

router.patch("/admin/memberships/:membershipId", async (req, res) => {
  const membershipId = idParam(req.params.membershipId);
  const { action, membershipRole } = req.body || {};

  if (!membershipId || !["APPROVE", "REJECT", "REVOKE", "SUSPEND", "REACTIVATE"].includes(action) ||
      membershipRole != null && !["MEMBER", "REVIEWER", "MANAGER"].includes(membershipRole)) {
    return res.status(400).json({ error: "Invalid membership action" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (!(await requireAdmin(client, req.user.userId))) {
      await rollback(client);
      return res.status(403).json({ error: "Administrator access required" });
    }
    if (action === "APPROVE") {
      await rollback(client);
      return res.status(409).json({ error: "Authority access is granted only through administrator provisioning" });
    }
    const membershipLink = await client.query("SELECT authority_id FROM authority_memberships WHERE membership_id=$1", [membershipId]);
    if (!membershipLink.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Membership request not found" });
    }
    await client.query("SELECT authority_id FROM authority_destinations WHERE authority_id=$1 FOR UPDATE", [membershipLink.rows[0].authority_id]);
    const before = await client.query(
      `SELECT am.membership_id, am.user_id, am.authority_id, am.membership_status,
              ad.verification_status, ad.destination_status
       FROM authority_memberships am
       JOIN authority_destinations ad ON ad.authority_id = am.authority_id
       WHERE am.membership_id = $1 FOR UPDATE OF am`,
      [membershipId]
    );
    if (!before.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Membership request not found" });
    }
    const row = before.rows[0];
    const membershipTransitions = {
      APPROVE: row.membership_status === "PENDING",
      REJECT: row.membership_status === "PENDING",
      REVOKE: ["ACTIVE", "SUSPENDED"].includes(row.membership_status),
      SUSPEND: row.membership_status === "ACTIVE",
      REACTIVATE: row.membership_status === "SUSPENDED",
    };
    if (!membershipTransitions[action]) {
      await rollback(client);
      return res.status(409).json({ error: "Invalid authority membership state transition" });
    }
    if (["APPROVE", "REACTIVATE"].includes(action) &&
        (Number(row.user_id) === req.user.userId || row.verification_status !== "VERIFIED" || row.destination_status !== "ACTIVE")) {
      await rollback(client);
      return res.status(409).json({ error: "Membership cannot be activated by this request" });
    }
    const status = { APPROVE: "ACTIVE", REJECT: "REJECTED", REVOKE: "REVOKED", SUSPEND: "SUSPENDED", REACTIVATE: "ACTIVE" }[action];
    const updated = await client.query(
      `UPDATE authority_memberships SET membership_status = $2,
         membership_role = COALESCE($3, membership_role), reviewed_by_user_id = $4,
         reviewed_at = NOW(), updated_at = NOW()
       WHERE membership_id = $1
       RETURNING membership_id, authority_id, user_id, membership_role, membership_status, reviewed_by_user_id, reviewed_at`,
      [membershipId, status, membershipRole || null, req.user.userId]
    );
    await audit(client, req.user.userId, `AUTHORITY_MEMBERSHIP_${action}`, "AUTHORITY_MEMBERSHIP", membershipId, { authorityId: Number(row.authority_id), userId: Number(row.user_id), previousStatus: row.membership_status, status });
    if (["APPROVE", "REJECT"].includes(action)) {
      await createNotification(client, row.user_id, action === "APPROVE" ? "AUTHORITY_MEMBERSHIP_APPROVED" : "AUTHORITY_MEMBERSHIP_REJECTED", "AUTHORITY_MEMBERSHIP", membershipId);
    }
    await client.query("COMMIT");
    return res.json({ membership: updated.rows[0] });
  } catch (error) {
    await rollback(client);
    console.error("Update authority membership failed:", error.message);
    return res.status(500).json({ error: "Unable to update authority membership" });
  } finally {
    if (client) client.release();
  }
});

router.patch("/reports/:reportId/assignment", async (req, res) => {
  const reportId = idParam(req.params.reportId);
  const recoveryMode = req.body?.recoveryMode;
  const authorityId = req.body?.authorityId == null || req.body.authorityId === ""
    ? null
    : idParam(req.body.authorityId);
  if (!reportId || !["DIRECT", "AUTHORITY"].includes(recoveryMode) ||
      recoveryMode === "AUTHORITY" && !authorityId || recoveryMode === "DIRECT" && req.body?.authorityId != null && req.body.authorityId !== "") {
    return res.status(400).json({ error: "Choose DIRECT recovery or an eligible authority destination" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const report = await client.query(
      `SELECT r.report_id, r.user_id, r.report_type, r.status, r.recovery_mode, r.authority_id,
              EXISTS (SELECT 1 FROM custody_transfer_requests x WHERE x.report_id=r.report_id AND x.custody_status='RECEIVED') AS custody_received
       FROM reports r WHERE r.report_id=$1 FOR UPDATE`,
      [reportId]
    );
    if (!report.rowCount || Number(report.rows[0].user_id) !== req.user.userId) {
      await rollback(client);
      return res.status(404).json({ error: "Found report not found" });
    }
    const assignmentActor = await currentUser(client, req.user.userId);
    if (!assignmentActor || assignmentActor.account_status !== "ACTIVE") {
      await rollback(client);
      return res.status(403).json({ error: "An active account is required" });
    }
    const current = report.rows[0];
    if (current.report_type !== "FOUND" || !["OPEN", "MATCHED"].includes(current.status)) {
      await rollback(client);
      return res.status(409).json({ error: "Only an available found report can change recovery assignment" });
    }
    if (current.custody_received) {
      await rollback(client);
      return res.status(409).json({ error: "A report already received by an authority cannot be reassigned through this workflow" });
    }
    if (recoveryMode === "AUTHORITY") {
      const destination = await client.query(
        `SELECT authority_id FROM authority_destinations
         WHERE authority_id=$1 AND verification_status='VERIFIED' AND destination_status='ACTIVE' FOR SHARE`,
        [authorityId]
      );
      if (!destination.rowCount) {
        await rollback(client);
        return res.status(400).json({ error: "Select a verified, active authority destination" });
      }
    }
    const changed = current.recovery_mode !== recoveryMode || String(current.authority_id || "") !== String(authorityId || "");
    if (!changed) {
      await client.query("COMMIT");
      return res.json({ reportId: Number(reportId), recoveryMode, authorityId: authorityId ? Number(authorityId) : null });
    }
    const pending = await client.query(
      `UPDATE custody_transfer_requests SET custody_status='CANCELLED', cancelled_at=NOW(), updated_at=NOW()
       WHERE report_id=$1 AND custody_status='PENDING_RECEIPT'
       RETURNING custody_transfer_id, authority_id`,
      [reportId]
    );
    for (const transfer of pending.rows) {
      await audit(client, req.user.userId, "CUSTODY_TRANSFER_CANCELLED", "CUSTODY_TRANSFER", transfer.custody_transfer_id, { reportId: Number(reportId), authorityId: Number(transfer.authority_id), reason: "REPORT_ASSIGNMENT_CHANGED" });
    }
    const updated = await client.query(
      `UPDATE reports SET recovery_mode=$2, authority_id=$3, updated_at=NOW()
       WHERE report_id=$1 RETURNING report_id, recovery_mode, authority_id`,
      [reportId, recoveryMode, authorityId]
    );
    await audit(client, req.user.userId, recoveryMode === "AUTHORITY" ? "AUTHORITY_REPORT_ASSIGNED" : "AUTHORITY_REPORT_UNASSIGNED", "REPORT", reportId, { previousRecoveryMode: current.recovery_mode, previousAuthorityId: current.authority_id == null ? null : Number(current.authority_id), recoveryMode, authorityId: authorityId ? Number(authorityId) : null });
    if (authorityId) {
      const members = await client.query(
        `SELECT user_id FROM authority_memberships WHERE authority_id=$1 AND membership_status='ACTIVE'`,
        [authorityId]
      );
      for (const member of members.rows) {
        await createNotification(client, member.user_id, "AUTHORITY_CASE_ASSIGNED", "REPORT", reportId);
      }
    }
    await client.query("COMMIT");
    return res.json({ report: updated.rows[0] });
  } catch (error) {
    await rollback(client);
    console.error("Update report recovery assignment failed:", error.message);
    return res.status(error.code === "23514" ? 400 : 500).json({ error: error.code === "23514" ? "Authority destination is no longer eligible" : "Unable to update report assignment" });
  } finally {
    if (client) client.release();
  }
});

router.post("/reports/:reportId/custody-transfers", async (req, res) => {
  if (!custodySecret()) return res.status(503).json({ error: "Custody transfer is not configured" });
  const reportId = idParam(req.params.reportId);
  if (!reportId) return res.status(400).json({ error: "Invalid report ID" });
  const configuredTtl = Number(process.env.CUSTODY_CODE_TTL_MINUTES || 30);
  const ttlMinutes = Number.isInteger(configuredTtl) && configuredTtl >= 1 && configuredTtl <= 120 ? configuredTtl : 30;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const report = await client.query(
      `SELECT r.report_id, r.user_id, r.report_type, r.status, r.recovery_mode, r.authority_id,
              EXISTS (SELECT 1 FROM custody_transfer_requests x WHERE x.report_id=r.report_id AND x.custody_status='RECEIVED') AS custody_received
       FROM reports r WHERE r.report_id=$1 FOR UPDATE`,
      [reportId]
    );
    if (!report.rowCount || Number(report.rows[0].user_id) !== req.user.userId) {
      await rollback(client);
      return res.status(404).json({ error: "Found report not found" });
    }
    const row = report.rows[0];
    const user = await currentUser(client, req.user.userId);
    if (!user || user.account_status !== "ACTIVE") {
      await rollback(client);
      return res.status(403).json({ error: "An active account is required" });
    }
    if (row.report_type !== "FOUND" || row.recovery_mode !== "AUTHORITY" || !row.authority_id || !["OPEN", "MATCHED"].includes(row.status) || row.custody_received) {
      await rollback(client);
      return res.status(409).json({ error: "Assign this available found report to an authority before initiating custody" });
    }
    const destination = await client.query(
      `SELECT authority_id FROM authority_destinations WHERE authority_id=$1
       AND verification_status='VERIFIED' AND destination_status='ACTIVE' FOR SHARE`,
      [row.authority_id]
    );
    if (!destination.rowCount) {
      await rollback(client);
      return res.status(409).json({ error: "The assigned authority is not currently eligible to receive custody" });
    }
    const expiredPending = await client.query(
      `SELECT custody_transfer_id, authority_id FROM custody_transfer_requests
       WHERE report_id=$1 AND custody_status='PENDING_RECEIPT' AND code_expires_at <= NOW()
       FOR UPDATE`,
      [reportId]
    );
    await client.query("SELECT lostlink_expire_pending_custody($1)", [reportId]);
    for (const old of expiredPending.rows) {
      await audit(client, req.user.userId, "CUSTODY_TRANSFER_EXPIRED", "CUSTODY_TRANSFER", old.custody_transfer_id, { reportId: Number(reportId), authorityId: Number(old.authority_id), reason: "REPLACED_AFTER_EXPIRY" });
    }
    const active = await client.query(
      `SELECT custody_transfer_id FROM custody_transfer_requests
       WHERE report_id=$1 AND custody_status='PENDING_RECEIPT' FOR UPDATE`,
      [reportId]
    );
    if (active.rowCount) {
      await rollback(client);
      return res.status(409).json({ error: "A custody transfer is already awaiting receipt" });
    }
    const code = crypto.randomInt(0, 100000000).toString().padStart(8, "0");
    const inserted = await client.query(
      `INSERT INTO custody_transfer_requests
         (report_id, authority_id, initiated_by_user_id, custody_status, code_hash, code_expires_at)
       VALUES ($1,$2,$3,'PENDING_RECEIPT',$4,NOW() + ($5::int * INTERVAL '1 minute'))
       RETURNING custody_transfer_id, report_id, authority_id, custody_status, code_expires_at, initiated_at`,
      [reportId, row.authority_id, req.user.userId, digestCode(code), ttlMinutes]
    );
    const transfer = inserted.rows[0];
    await audit(client, req.user.userId, "CUSTODY_TRANSFER_INITIATED", "CUSTODY_TRANSFER", transfer.custody_transfer_id, { reportId: Number(reportId), authorityId: Number(row.authority_id), expiresAt: transfer.code_expires_at });
    const members = await client.query(
      `SELECT user_id FROM authority_memberships WHERE authority_id=$1 AND membership_status='ACTIVE'`,
      [row.authority_id]
    );
    for (const member of members.rows) {
      await createNotification(client, member.user_id, "CUSTODY_TRANSFER_INITIATED", "REPORT", reportId);
    }
    await client.query("COMMIT");
    return res.status(201).json({ custodyTransfer: transfer, code });
  } catch (error) {
    await rollback(client);
    console.error("Initiate authority custody transfer failed:", error.message);
    return res.status(error.code === "23505" ? 409 : error.code === "23514" ? 409 : 500).json({ error: ["23505", "23514"].includes(error.code) ? "Custody transfer is no longer eligible" : "Unable to initiate custody transfer" });
  } finally {
    if (client) client.release();
  }
});

router.get("/cases", async (req, res) => {
  const historyView = req.query.history === "true";
  try {
    const result = await pool.query(
      `SELECT r.report_id, r.status AS report_status, r.report_time, r.updated_at, r.recovery_mode,
              ad.authority_id, ad.name AS authority_name, ad.destination_type,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.title END AS title,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN i.description END AS description,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.category END AS category,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN i.color END AS color,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN r.location_description END AS location_description,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN i.attributes_json->>'company' END AS company,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN i.attributes_json->>'model' END AS model,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN i.attributes_json END AS item_attributes,
              CASE WHEN ctr.custody_status='RECEIVED' AND $2::boolean = FALSE THEN COALESCE((
                SELECT json_agg(json_build_object(
                  'photoId', p.photo_id, 'photoType', p.photo_type, 'uploadedAt', p.uploaded_at
                ) ORDER BY p.photo_type, p.photo_id)
                FROM item_photos p WHERE p.item_id = i.item_id
              ), '[]'::json) ELSE '[]'::json END AS photos,
              ctr.custody_transfer_id, ctr.custody_status, ctr.initiated_at,
              ctr.received_at, ctr.code_expires_at,
              CASE WHEN ctr.custody_status='RECEIVED' THEN COALESCE((
                SELECT json_agg(json_build_object(
                  'claim_id', c.claim_id, 'claim_status', c.claim_status,
                  'claimant_name', CASE WHEN $2::boolean = FALSE THEN claimant.name END,
                  'conversation_status', CASE WHEN $2::boolean = FALSE THEN conv.conversation_status END,
                  'handover_status', hr.handover_status,
                  'completed_at', hr.completed_at
                ) ORDER BY c.submitted_at DESC)
                FROM claim_requests c
                JOIN match_records m ON m.match_id=c.match_id
                JOIN users claimant ON claimant.user_id=c.claimant_user_id
                LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
                LEFT JOIN handover_records hr ON hr.claim_id=c.claim_id
                WHERE m.found_report_id=r.report_id AND (
                  ($2::boolean = FALSE AND c.claim_status IN ('SUBMITTED','IN_REVIEW','APPROVED')) OR
                  ($2::boolean = TRUE AND c.claim_status = 'COMPLETED')
                )
              ), '[]'::json) ELSE '[]'::json END AS claims,
              CASE WHEN EXISTS (SELECT 1 FROM custody_transfer_requests confirmed
                                WHERE confirmed.report_id=r.report_id AND confirmed.custody_status='RECEIVED')
                   THEN (SELECT COUNT(*)::int FROM claim_requests c JOIN match_records m ON m.match_id=c.match_id
                         WHERE m.found_report_id=r.report_id AND c.claim_status IN ('SUBMITTED','IN_REVIEW'))
                   ELSE 0 END AS pending_claim_count
       FROM reports r JOIN authority_destinations ad ON ad.authority_id = r.authority_id
       JOIN authority_memberships am ON am.authority_id = ad.authority_id
       JOIN users u ON u.user_id = am.user_id
       JOIN items i ON i.item_id = r.item_id
       LEFT JOIN LATERAL (SELECT * FROM custody_transfer_requests x WHERE x.report_id=r.report_id
                          ORDER BY x.initiated_at DESC, x.custody_transfer_id DESC LIMIT 1) ctr ON TRUE
       WHERE am.user_id = $1 AND am.membership_status = 'ACTIVE'
         AND ad.verification_status = 'VERIFIED' AND ad.destination_status = 'ACTIVE'
         AND u.account_status = 'ACTIVE' AND r.report_type = 'FOUND' AND r.recovery_mode = 'AUTHORITY'
         AND (($2::boolean = TRUE AND r.status = 'RETURNED' AND ctr.custody_status = 'RECEIVED')
           OR ($2::boolean = FALSE AND r.status <> 'RETURNED'))
       ORDER BY r.updated_at DESC, r.report_id DESC LIMIT 200`,
      [req.user.userId, historyView]
    );
    return res.json({ cases: result.rows });
  } catch (error) {
    console.error("List authority cases failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve authority cases" });
  }
});

router.get("/cases/:reportId", async (req, res) => {
  const reportId = idParam(req.params.reportId);
  if (!reportId) return res.status(400).json({ error: "Invalid report ID" });
  try {
    const result = await pool.query(
      `SELECT r.report_id, r.status AS report_status, r.report_time, r.recovery_mode,
              CASE WHEN ctr.custody_status='RECEIVED' THEN r.location_description END AS location_description, ad.authority_id, ad.name AS authority_name,
              ad.destination_type, CASE WHEN ctr.custody_status='RECEIVED' THEN i.title END AS title,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.description END AS description,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.category END AS category,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.color END AS color,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.attributes_json->>'company' END AS company,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.attributes_json->>'model' END AS model,
              CASE WHEN ctr.custody_status='RECEIVED' THEN i.attributes_json END AS item_attributes,
              CASE WHEN ctr.custody_status='RECEIVED' THEN COALESCE((
                SELECT json_agg(json_build_object(
                  'photoId', p.photo_id, 'photoType', p.photo_type, 'uploadedAt', p.uploaded_at
                ) ORDER BY p.photo_type, p.photo_id)
                FROM item_photos p WHERE p.item_id = i.item_id
              ), '[]'::json) ELSE '[]'::json END AS photos,
              ctr.custody_transfer_id, ctr.custody_status, ctr.initiated_at, ctr.received_at
       FROM reports r JOIN authority_destinations ad ON ad.authority_id = r.authority_id
       JOIN authority_memberships am ON am.authority_id = ad.authority_id
       JOIN users u ON u.user_id = am.user_id JOIN items i ON i.item_id = r.item_id
       LEFT JOIN LATERAL (SELECT * FROM custody_transfer_requests x WHERE x.report_id=r.report_id
                          ORDER BY x.initiated_at DESC, x.custody_transfer_id DESC LIMIT 1) ctr ON TRUE
       WHERE r.report_id = $1 AND am.user_id = $2 AND am.membership_status = 'ACTIVE'
         AND ad.verification_status = 'VERIFIED' AND ad.destination_status = 'ACTIVE'
         AND u.account_status = 'ACTIVE' AND r.report_type = 'FOUND' AND r.recovery_mode = 'AUTHORITY'
       LIMIT 1`,
      [reportId, req.user.userId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Authority case not found" });
    const claims = result.rows[0].custody_status === "RECEIVED"
      ? await pool.query(
        `SELECT c.claim_id, c.claim_status, c.submitted_at, c.updated_at, m.total_score
         FROM claim_requests c JOIN match_records m ON m.match_id = c.match_id
         WHERE m.found_report_id = $1 ORDER BY c.submitted_at DESC`,
        [reportId]
      )
      : { rows: [] };
    return res.json({ case: result.rows[0], claims: claims.rows });
  } catch (error) {
    console.error("Get authority case failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve authority case" });
  }
});

router.post("/custody-transfers/:transferId/confirm", async (req, res) => {
  if (!custodySecret()) return res.status(503).json({ error: "Custody transfer is not configured" });
  const transferId = idParam(req.params.transferId);
  const code = req.body?.code;
  if (!transferId || typeof code !== "string" || !/^\d{8}$/.test(code)) {
    return res.status(400).json({ error: "A valid custody code is required" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const preliminary = await client.query("SELECT report_id FROM custody_transfer_requests WHERE custody_transfer_id = $1", [transferId]);
    if (!preliminary.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Custody transfer not found" });
    }
    const report = await client.query("SELECT report_id, authority_id FROM reports WHERE report_id = $1 FOR UPDATE", [preliminary.rows[0].report_id]);
    if (!report.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Custody transfer not found" });
    }
    const user = await currentUser(client, req.user.userId);
    const membership = user?.account_status === "ACTIVE"
      ? await loadActiveMembership(client, req.user.userId, report.rows[0].authority_id)
      : null;
    if (!membership) {
      await rollback(client);
      return res.status(403).json({ error: "Active membership in the assigned authority is required" });
    }
    const locked = await client.query(
      `SELECT custody_transfer_id, report_id, authority_id, custody_status, code_hash,
              code_expires_at, failed_attempt_count
       FROM custody_transfer_requests WHERE custody_transfer_id = $1 FOR UPDATE`,
      [transferId]
    );
    if (!locked.rowCount || Number(locked.rows[0].report_id) !== Number(report.rows[0].report_id)) {
      await rollback(client);
      return res.status(404).json({ error: "Custody transfer not found" });
    }
    const transfer = locked.rows[0];
    if (transfer.custody_status !== "PENDING_RECEIPT") {
      await rollback(client);
      return res.status(409).json({ error: "Custody transfer is no longer pending" });
    }
    if (transfer.failed_attempt_count >= 5) {
      await rollback(client);
      return res.status(429).json({ error: "Too many invalid custody code attempts" });
    }
    if (new Date(transfer.code_expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE custody_transfer_requests SET custody_status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
         WHERE custody_transfer_id = $1 AND custody_status = 'PENDING_RECEIPT'`,
        [transferId]
      );
      await audit(client, req.user.userId, "CUSTODY_TRANSFER_EXPIRED", "CUSTODY_TRANSFER", transferId, { reportId: Number(transfer.report_id), authorityId: Number(transfer.authority_id) });
      await client.query("COMMIT");
      return res.status(410).json({ error: "Custody code has expired" });
    }
    const attemptedHash = digestCode(code);
    if (!safeDigestEqual(attemptedHash, transfer.code_hash)) {
      await client.query(
        `UPDATE custody_transfer_requests SET failed_attempt_count = failed_attempt_count + 1, updated_at = NOW()
         WHERE custody_transfer_id = $1 AND custody_status = 'PENDING_RECEIPT' AND failed_attempt_count < 5`,
        [transferId]
      );
      await audit(client, req.user.userId, "CUSTODY_TRANSFER_CODE_REJECTED", "CUSTODY_TRANSFER", transferId, { reportId: Number(transfer.report_id), authorityId: Number(transfer.authority_id) });
      await client.query("COMMIT");
      return res.status(400).json({ error: "Invalid custody code" });
    }
    const received = await client.query(
      `UPDATE custody_transfer_requests
       SET custody_status = 'RECEIVED', received_at = NOW(), received_by_membership_id = $2, updated_at = NOW()
       WHERE custody_transfer_id = $1 AND custody_status = 'PENDING_RECEIPT'
         AND code_expires_at > NOW() AND failed_attempt_count < 5
       RETURNING custody_transfer_id, report_id, authority_id, custody_status, received_at`,
      [transferId, membership.membership_id]
    );
    if (!received.rowCount) {
      await rollback(client);
      return res.status(409).json({ error: "Custody transfer is no longer eligible for confirmation" });
    }
    const reportOwner = await client.query("SELECT user_id FROM reports WHERE report_id = $1", [transfer.report_id]);
    await audit(client, req.user.userId, "CUSTODY_TRANSFER_CONFIRMED", "CUSTODY_TRANSFER", transferId, { reportId: Number(transfer.report_id), authorityId: Number(transfer.authority_id), membershipId: Number(membership.membership_id) });
    await createNotification(client, reportOwner.rows[0].user_id, "CUSTODY_TRANSFER_RECEIVED", "REPORT", transfer.report_id);
    await client.query("COMMIT");
    return res.json({ custodyTransfer: received.rows[0] });
  } catch (error) {
    await rollback(client);
    console.error("Confirm authority custody failed:", error.message);
    return res.status(error.code === "23514" ? 409 : 500).json({ error: error.code === "23514" ? "Custody confirmation is no longer allowed" : "Unable to confirm custody" });
  } finally {
    if (client) client.release();
  }
});

router.post("/custody-transfers/:transferId/cancel", async (req, res) => {
  const transferId = idParam(req.params.transferId);
  if (!transferId) return res.status(400).json({ error: "Invalid custody transfer ID" });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const actor = await currentUser(client, req.user.userId);
    if (!actor || actor.account_status !== "ACTIVE") {
      await rollback(client);
      return res.status(403).json({ error: "An active account is required" });
    }
    const preliminary = await client.query("SELECT report_id FROM custody_transfer_requests WHERE custody_transfer_id=$1", [transferId]);
    if (!preliminary.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Custody transfer not found" });
    }
    const report = await client.query("SELECT report_id FROM reports WHERE report_id=$1 AND user_id=$2 FOR UPDATE", [preliminary.rows[0].report_id, req.user.userId]);
    if (!report.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Custody transfer not found" });
    }
    const row = await client.query(
      `SELECT custody_transfer_id, report_id, authority_id, custody_status
       FROM custody_transfer_requests WHERE custody_transfer_id=$1 FOR UPDATE`,
      [transferId]
    );
    if (!row.rowCount) {
      await rollback(client);
      return res.status(404).json({ error: "Custody transfer not found" });
    }
    if (row.rows[0].custody_status !== "PENDING_RECEIPT") {
      await rollback(client);
      return res.status(409).json({ error: "Only pending custody transfers can be cancelled" });
    }
    await client.query("UPDATE custody_transfer_requests SET custody_status='CANCELLED', cancelled_at=NOW(), updated_at=NOW() WHERE custody_transfer_id=$1", [transferId]);
    await audit(client, req.user.userId, "CUSTODY_TRANSFER_CANCELLED", "CUSTODY_TRANSFER", transferId, { reportId: Number(row.rows[0].report_id), authorityId: Number(row.rows[0].authority_id) });
    await client.query("COMMIT");
    return res.json({ custodyTransferId: Number(transferId), custodyStatus: "CANCELLED" });
  } catch (error) {
    await rollback(client);
    console.error("Cancel custody transfer failed:", error.message);
    return res.status(500).json({ error: "Unable to cancel custody transfer" });
  } finally {
    if (client) client.release();
  }
});

module.exports = { router, custodySecret, digestCode, safeDigestEqual };
