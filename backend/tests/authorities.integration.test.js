require("dotenv").config();
process.env.DB_NAME = "lostlink_test";
process.env.CUSTODY_CODE_HMAC_KEY = "integration-test-only-secret-key-32-bytes-minimum";

const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const app = require("../src/server");

let server;
let baseUrl;
let admin;
let owner;
let unrelated;
const users = [];
const authorityIds = [];
const membershipIds = [];
const reportIds = [];
const itemIds = [];
const matchIds = [];
const claimIds = [];

async function api(route, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  };
  return fetch(`${baseUrl}${route}`, { ...options, headers });
}

async function register(name) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email: `s11-${suffix}@example.test`, password: "Sprint11-Integration-Test-123" }),
  });
  const data = await result.json();
  assert.equal(result.status, 201, JSON.stringify(data));
  const user = { id: Number(data.user.user_id), token: data.token };
  users.push(user.id);
  return user;
}

async function createApprovedAuthority() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `authority-${suffix}@example.test`;
  const password = "Authority-Integration-Password-4321";
  const response = await api("/api/authorities/admin/accounts", {
    method: "POST", token: admin.token,
    body: JSON.stringify({
      authorityName: `Integration Authority ${suffix}`,
      institutionType: "Test campus security",
      officialEmail: "office@example.test",
      locationDescription: "Test campus",
      name: `Integration authority officer ${suffix}`,
      email,
      password,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const authorityId = Number(body.authority.authority_id);
  const membershipId = Number(body.membership.membership_id);
  const memberId = Number(body.account.user_id);
  authorityIds.push(authorityId);
  membershipIds.push(membershipId);
  users.push(memberId);
  assert.equal(body.account.role, "USER", "Authority login must not inherit global STAFF permissions");
  const login = await api("/api/auth/login", {
    method: "POST", body: JSON.stringify({ email, password }),
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  return { authorityId, membershipId, member: { id: memberId, token: loginBody.token } };
}
async function createFoundReport(userId, title, authorityId = null) {
  const item = await pool.query(
    `INSERT INTO items (category,title,description,color,attributes_json)
     VALUES ('OTHER',$1,'Sprint 11 authority integration test','Blue','{"company":"Test Brand","model":"Test Model"}'::jsonb) RETURNING item_id`,
    [title]
  );
  const itemId = Number(item.rows[0].item_id);
  itemIds.push(itemId);
  const report = await pool.query(
    `INSERT INTO reports (user_id,item_id,report_type,report_time,location_point,
       uncertainty_radius_m,location_source,location_description)
     VALUES ($1,$2,'FOUND',NOW(),ST_SetSRID(ST_MakePoint(79.16,12.97),4326)::geography,
       100,'MAP_PIN','Authority test location') RETURNING report_id`,
    [userId, itemId]
  );
  const reportId = Number(report.rows[0].report_id);
  reportIds.push(reportId);
  if (authorityId) {
    const assigned = await api(`/api/authorities/reports/${reportId}/assignment`, {
      method: "PATCH", token: owner.token,
      body: JSON.stringify({ recoveryMode: "AUTHORITY", authorityId }),
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());
  }
  return reportId;
}

async function initiate(reportId) {
  return api(`/api/authorities/reports/${reportId}/custody-transfers`, { method: "POST", token: owner.token });
}

async function confirm(transferId, user, code) {
  return api(`/api/authorities/custody-transfers/${transferId}/confirm`, {
    method: "POST", token: user.token, body: JSON.stringify({ code }),
  });
}

before(async () => {
  const db = await pool.query("SELECT current_database() AS name");
  assert.equal(db.rows[0].name, "lostlink_test", "Authority integration tests must use lostlink_test");
  assert.ok(process.env.JWT_SECRET, "JWT_SECRET must be configured");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  admin = await register("Sprint 11 Test Administrator");
  owner = await register("Sprint 11 Test Finder");
  unrelated = await register("Sprint 11 Unrelated Authority Member");
  const adminRole = await pool.query("UPDATE users SET role='ADMIN' WHERE user_id=$1 RETURNING user_id", [admin.id]);
  assert.equal(adminRole.rowCount, 1);
  admin.token = jwt.sign({ userId: admin.id, role: "ADMIN" }, process.env.JWT_SECRET, { expiresIn: "2h" });
});

after(async () => {
  const client = await pool.connect();
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await client.query("BEGIN");
    if (claimIds.length) {
      await client.query("DELETE FROM claim_photo_shares WHERE claim_id=ANY($1::bigint[])", [claimIds]);
      await client.query("DELETE FROM claim_verifications WHERE claim_id=ANY($1::bigint[])", [claimIds]);
      await client.query("DELETE FROM handover_records WHERE claim_id=ANY($1::bigint[])", [claimIds]);
      await client.query("DELETE FROM conversations WHERE claim_id=ANY($1::bigint[])", [claimIds]);
      await client.query("DELETE FROM claim_requests WHERE claim_id=ANY($1::bigint[])", [claimIds]);
    }
    if (matchIds.length) await client.query("DELETE FROM match_records WHERE match_id=ANY($1::bigint[])", [matchIds]);
    if (reportIds.length) {
      await client.query("DELETE FROM notifications WHERE reference_type='REPORT' AND reference_id=ANY($1::bigint[])", [reportIds]);
      await client.query("DELETE FROM custody_transfer_requests WHERE report_id=ANY($1::bigint[])", [reportIds]);
      await client.query("UPDATE reports SET recovery_mode='DIRECT', authority_id=NULL WHERE report_id=ANY($1::bigint[])", [reportIds]);
      await client.query("DELETE FROM reports WHERE report_id=ANY($1::bigint[])", [reportIds]);
    }
    if (itemIds.length) await client.query("DELETE FROM items WHERE item_id=ANY($1::bigint[])", [itemIds]);
    await client.query("DELETE FROM notifications WHERE user_id=ANY($1::bigint[]) OR reference_type='AUTHORITY_MEMBERSHIP' AND reference_id=ANY($2::bigint[])", [users, membershipIds]);
    await client.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::bigint[]) OR entity_id=ANY($2::bigint[])", [users, [...authorityIds, ...membershipIds]]);
    if (membershipIds.length) await client.query("DELETE FROM authority_memberships WHERE membership_id=ANY($1::bigint[])", [membershipIds]);
    if (authorityIds.length) await client.query("DELETE FROM authority_destinations WHERE authority_id=ANY($1::bigint[])", [authorityIds]);
    if (users.length) await client.query("DELETE FROM users WHERE user_id=ANY($1::bigint[])", [users]);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* cleanup is best-effort after a test failure */ }
    console.error("Authority test cleanup failed:", error.message);
  } finally {
    client.release();
    await pool.end();
  }
});

test("authority access is provisioned only by administrators", async () => {
  const publicRequest = await api("/api/authorities/requests", {
    method: "POST", token: owner.token,
    body: JSON.stringify({ name: `Self service authority ${Date.now()}` }),
  });
  assert.equal(publicRequest.status, 410);
  const userProvision = await api("/api/authorities/admin/accounts", {
    method: "POST", token: owner.token,
    body: JSON.stringify({ authorityName: "Forged authority", name: "Forged officer", email: `forged-${Date.now()}@example.test`, password: "Authority-Integration-Password-4321" }),
  });
  assert.equal(userProvision.status, 403);
  const account = await createApprovedAuthority();
  const membership = await pool.query("SELECT membership_status FROM authority_memberships WHERE membership_id=$1", [account.membershipId]);
  assert.equal(membership.rows[0].membership_status, "ACTIVE");
  const audit = await pool.query("SELECT action_type FROM audit_logs WHERE entity_type='AUTHORITY_MEMBERSHIP' AND entity_id=$1", [account.membershipId]);
  assert.ok(audit.rows.some((entry) => entry.action_type === "AUTHORITY_ACCOUNT_PROVISIONED"));
});
test("finder assignment validates destination ownership and reports direct recovery by default", async () => {
  const reportId = await createFoundReport(owner.id, "Assignment test found report");
  const mode = await pool.query("SELECT recovery_mode,authority_id FROM reports WHERE report_id=$1", [reportId]);
  assert.equal(mode.rows[0].recovery_mode, "DIRECT");
  assert.equal(mode.rows[0].authority_id, null);
  const pendingDestination = await pool.query(
    `INSERT INTO authority_destinations (destination_type,name,verification_status,destination_status)
     VALUES ('INSTITUTION',$1,'PENDING','ACTIVE') RETURNING authority_id`,
    [`Unverified Destination ${Date.now()}`]
  );
  const pendingAuthorityId = Number(pendingDestination.rows[0].authority_id);
  authorityIds.push(pendingAuthorityId);
  const rejectUnverified = await api(`/api/authorities/reports/${reportId}/assignment`, {
    method: "PATCH", token: owner.token,
    body: JSON.stringify({ recoveryMode: "AUTHORITY", authorityId: pendingAuthorityId }),
  });
  assert.equal(rejectUnverified.status, 400);
  const foreign = await api(`/api/authorities/reports/${reportId}/assignment`, {
    method: "PATCH", token: unrelated.token,
    body: JSON.stringify({ recoveryMode: "DIRECT" }),
  });
  assert.equal(foreign.status, 404);
  const adminCannotChooseForFinder = await api(`/api/authorities/reports/${reportId}/assignment`, {
    method: "PATCH", token: admin.token,
    body: JSON.stringify({ recoveryMode: "AUTHORITY", authorityId: (await createApprovedAuthority()).authorityId }),
  });
  assert.equal(adminCannotChooseForFinder.status, 404);
});

test("authority custody is separate, HMAC protected, private, and confirms once under concurrency", async () => {
  const assigned = await createApprovedAuthority();
  const reportId = await createFoundReport(owner.id, "Custody integration item", assigned.authorityId);
  const initiated = await initiate(reportId);
  assert.equal(initiated.status, 201, await initiated.clone().text());
  const initiatedBody = await initiated.json();
  const transferId = Number(initiatedBody.custodyTransfer.custody_transfer_id);
  const code = initiatedBody.code;
  assert.match(code, /^\d{8}$/);
  const stored = await pool.query("SELECT code_hash,custody_status FROM custody_transfer_requests WHERE custody_transfer_id=$1", [transferId]);
  assert.notEqual(stored.rows[0].code_hash, code);
  assert.equal(stored.rows[0].custody_status, "PENDING_RECEIPT");
  const pendingCases = await api("/api/authorities/cases", { token: assigned.member.token });
  const pendingCase = (await pendingCases.json()).cases.find((entry) => Number(entry.report_id) === reportId);
  assert.equal(pendingCase.title, null);
  assert.equal(pendingCase.company, null);
  assert.equal(pendingCase.model, null);
  const ownerReports = await api("/api/reports/mine", { token: owner.token });
  const reportData = await ownerReports.json();
  assert.equal(JSON.stringify(reportData).includes(code), false);
  assert.equal(JSON.stringify(reportData).includes(stored.rows[0].code_hash), false);
  const audit = await pool.query("SELECT metadata::text FROM audit_logs WHERE entity_type='CUSTODY_TRANSFER' AND entity_id=$1", [transferId]);
  assert.equal(audit.rows.some((row) => row.metadata.includes(code) || row.metadata.includes(stored.rows[0].code_hash)), false);

  const otherAuthority = await createApprovedAuthority();
  const unauthorized = await confirm(transferId, unrelated, code);
  assert.equal(unauthorized.status, 403);
  assert.equal(otherAuthority.authorityId === assigned.authorityId, false);

  const wrongAuthority = await confirm(transferId, otherAuthority.member, code);
  assert.equal(wrongAuthority.status, 403);
  const confirmResponses = await Promise.all([confirm(transferId, assigned.member, code), confirm(transferId, assigned.member, code)]);
  assert.deepEqual(confirmResponses.map((response) => response.status).sort(), [200, 409]);
  const finalState = await pool.query("SELECT custody_status,received_by_membership_id FROM custody_transfer_requests WHERE custody_transfer_id=$1", [transferId]);
  assert.equal(finalState.rows[0].custody_status, "RECEIVED");
  assert.equal(Number(finalState.rows[0].received_by_membership_id), assigned.membershipId);
  const receivedCases = await api("/api/authorities/cases", { token: assigned.member.token });
  const receivedCase = (await receivedCases.json()).cases.find((entry) => Number(entry.report_id) === reportId);
  assert.equal(receivedCase.title, "Custody integration item");
  assert.equal(receivedCase.company, "Test Brand");
  assert.equal(receivedCase.model, "Test Model");
  const confirmationEvents = await pool.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE action_type='CUSTODY_TRANSFER_CONFIRMED' AND entity_id=$1", [transferId]);
  assert.equal(confirmationEvents.rows[0].count, 1);
});

test("invalid custody attempts lock the code and expired requests can be replaced", async () => {
  const assigned = await createApprovedAuthority();
  const reportId = await createFoundReport(owner.id, "Invalid custody code item", assigned.authorityId);
  const initiation = await initiate(reportId);
  assert.equal(initiation.status, 201);
  const first = await initiation.json();
  const wrongCode = first.code === "00000000" ? "00000001" : "00000000";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await confirm(first.custodyTransfer.custody_transfer_id, assigned.member, wrongCode);
    assert.equal(response.status, 400);
  }
  const locked = await confirm(first.custodyTransfer.custody_transfer_id, assigned.member, first.code);
  assert.equal(locked.status, 429);
  const status = await pool.query("SELECT custody_status,failed_attempt_count FROM custody_transfer_requests WHERE custody_transfer_id=$1", [first.custodyTransfer.custody_transfer_id]);
  assert.equal(status.rows[0].custody_status, "PENDING_RECEIPT");
  assert.equal(status.rows[0].failed_attempt_count, 5);

  const oldTtl = process.env.CUSTODY_CODE_TTL_MINUTES;
  process.env.CUSTODY_CODE_TTL_MINUTES = "1";
  const replacementReport = await createFoundReport(owner.id, "Expired custody replacement item", assigned.authorityId);
  const firstIssue = await initiate(replacementReport);
  assert.equal(firstIssue.status, 201);
  const firstTransfer = await firstIssue.json();
  const waitMs = Math.max(0, new Date(firstTransfer.custodyTransfer.code_expires_at).getTime() - Date.now() + 100);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const replacementResponse = await initiate(replacementReport);
  if (oldTtl === undefined) delete process.env.CUSTODY_CODE_TTL_MINUTES;
  else process.env.CUSTODY_CODE_TTL_MINUTES = oldTtl;
  assert.equal(replacementResponse.status, 201, await replacementResponse.clone().text());
  const replacement = await replacementResponse.json();
  assert.notEqual(replacement.code, firstTransfer.code);
  const oldState = await pool.query("SELECT custody_status,expired_at FROM custody_transfer_requests WHERE custody_transfer_id=$1", [firstTransfer.custodyTransfer.custody_transfer_id]);
  assert.equal(oldState.rows[0].custody_status, "EXPIRED");
  assert.ok(oldState.rows[0].expired_at);
  const oldCode = await confirm(firstTransfer.custodyTransfer.custody_transfer_id, assigned.member, firstTransfer.code);
  assert.equal(oldCode.status, 409);
});

test("revoked authority membership immediately loses case and confirmation access", async () => {
  const assigned = await createApprovedAuthority();
  const reportId = await createFoundReport(owner.id, "Revoked member custody item", assigned.authorityId);
  const initiation = await initiate(reportId);
  assert.equal(initiation.status, 201);
  const transfer = await initiation.json();
  const revoke = await api(`/api/authorities/admin/memberships/${assigned.membershipId}`, {
    method: "PATCH", token: admin.token, body: JSON.stringify({ action: "REVOKE" }),
  });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  const cases = await api("/api/authorities/cases", { token: assigned.member.token });
  const visibleCases = (await cases.json()).cases;
  assert.equal(visibleCases.some((entry) => Number(entry.report_id) === reportId), false);
  const denied = await confirm(transfer.custodyTransfer.custody_transfer_id, assigned.member, transfer.code);
  assert.equal(denied.status, 403);
  const events = await pool.query("SELECT action_type FROM audit_logs WHERE entity_type='AUTHORITY_MEMBERSHIP' AND entity_id=$1", [assigned.membershipId]);
  assert.ok(events.rows.some((row) => row.action_type === "AUTHORITY_MEMBERSHIP_REVOKE"));
});

test("authority members review claims only after custody and final release uses claimant handover", async () => {
  const assigned = await createApprovedAuthority();
  const foundReportId = await createFoundReport(owner.id, "Authority claim review item", assigned.authorityId);
  const custody = await initiate(foundReportId);
  assert.equal(custody.status, 201);
  const issued = await custody.json();
  const receipt = await confirm(issued.custodyTransfer.custody_transfer_id, assigned.member, issued.code);
  assert.equal(receipt.status, 200, await receipt.clone().text());

  const lostUser = await register("Sprint 11 Claimant");
  const lostItem = await pool.query(`INSERT INTO items (category,title,color,attributes_json) VALUES ('OTHER','Lost test item','Blue','{}') RETURNING item_id`);
  const lostItemId = Number(lostItem.rows[0].item_id);
  itemIds.push(lostItemId);
  const lost = await pool.query(
    `INSERT INTO reports (user_id,item_id,report_type,report_time,location_point,uncertainty_radius_m,location_source)
     VALUES ($1,$2,'LOST',NOW(),ST_SetSRID(ST_MakePoint(79.16,12.97),4326)::geography,100,'MAP_PIN') RETURNING report_id`,
    [lostUser.id, lostItemId]
  );
  const lostReportId = Number(lost.rows[0].report_id);
  reportIds.push(lostReportId);
  const match = await pool.query(
    `INSERT INTO match_records (lost_report_id,found_report_id,location_score,item_score,time_score,description_score,total_score,score_breakdown)
     VALUES ($1,$2,90,95,90,90,92,'{}'::jsonb) RETURNING match_id`,
    [lostReportId, foundReportId]
  );
  const matchId = Number(match.rows[0].match_id);
  matchIds.push(matchId);
  const submitted = await api("/api/claims", { method: "POST", token: lostUser.token, body: JSON.stringify({ matchId }) });
  const submittedBody = await submitted.json();
  assert.equal(submitted.status, 201, JSON.stringify(submittedBody));
  const claimId = Number(submittedBody.claim.claim_id);
  claimIds.push(claimId);
  const queue = await api("/api/claims/review-queue", { token: assigned.member.token });
  assert.ok((await queue.json()).claims.some((item) => Number(item.claim_id) === claimId));
  const verification = await api(`/api/claims/${claimId}/verifications`, {
    method: "POST", token: assigned.member.token,
    body: JSON.stringify({ verificationType: "AUTHORITY_REVIEW", status: "PASSED", privateNote: "authority test note" }),
  });
  assert.equal(verification.status, 201, await verification.clone().text());
  const review = await api(`/api/claims/${claimId}/review`, { method: "PATCH", token: assigned.member.token, body: JSON.stringify({ decision: "APPROVED" }) });
  assert.equal(review.status, 200, await review.clone().text());
  const codeResponse = await api(`/api/claims/${claimId}/handover/code`, { method: "POST", token: assigned.member.token });
  assert.equal(codeResponse.status, 201, await codeResponse.clone().text());
  const releaseCode = (await codeResponse.json()).code;
  const release = await api(`/api/claims/${claimId}/handover/confirm`, { method: "POST", token: lostUser.token, body: JSON.stringify({ code: releaseCode }) });
  assert.equal(release.status, 200, await release.clone().text());
  assert.equal((await pool.query("SELECT claim_status FROM claim_requests WHERE claim_id=$1", [claimId])).rows[0].claim_status, "COMPLETED");
});

test("assigned authority can read claim photo state after custody while photos remain private by default", async () => {
  const assigned = await createApprovedAuthority();
  const foundReportId = await createFoundReport(owner.id, "Authority private photo state", assigned.authorityId);
  const custody = await initiate(foundReportId);
  assert.equal(custody.status, 201);
  const issued = await custody.json();
  const receipt = await confirm(issued.custodyTransfer.custody_transfer_id, assigned.member, issued.code);
  assert.equal(receipt.status, 200, await receipt.clone().text());

  const lostUser = await register("Authority Photo Claimant");
  const lostItem = await pool.query(
    `INSERT INTO items (category,title,color,attributes_json)
     VALUES ('OTHER','Photo state test item','Blue','{}') RETURNING item_id`
  );
  const lostItemId = Number(lostItem.rows[0].item_id);
  itemIds.push(lostItemId);
  const lost = await pool.query(
    `INSERT INTO reports (user_id,item_id,report_type,report_time,location_point,uncertainty_radius_m,location_source)
     VALUES ($1,$2,'LOST',NOW(),ST_SetSRID(ST_MakePoint(79.16,12.97),4326)::geography,100,'MAP_PIN') RETURNING report_id`,
    [lostUser.id, lostItemId]
  );
  const lostReportId = Number(lost.rows[0].report_id);
  reportIds.push(lostReportId);
  const match = await pool.query(
    `INSERT INTO match_records (lost_report_id,found_report_id,location_score,item_score,time_score,description_score,total_score,score_breakdown)
     VALUES ($1,$2,90,95,90,90,92,'{}'::jsonb) RETURNING match_id`,
    [lostReportId, foundReportId]
  );
  const matchId = Number(match.rows[0].match_id);
  matchIds.push(matchId);
  const submitted = await api("/api/claims", { method: "POST", token: lostUser.token, body: JSON.stringify({ matchId }) });
  const submittedBody = await submitted.json();
  assert.equal(submitted.status, 201, JSON.stringify(submittedBody));
  const claimId = Number(submittedBody.claim.claim_id);
  claimIds.push(claimId);

  const access = await api(`/api/claims/${claimId}/photos`, { token: assigned.member.token });
  const body = await access.json();
  assert.equal(access.status, 200, JSON.stringify(body));
  assert.equal(body.sharingStatus, "PRIVATE");
  assert.deepEqual(body.photos, []);
});

test("authority actions use current database role, and custody fails closed without configured key", async () => {
  const priorKey = process.env.CUSTODY_CODE_HMAC_KEY;
  delete process.env.CUSTODY_CODE_HMAC_KEY;
  try {
    const capability = await api("/api/authorities/capabilities", { token: owner.token });
    assert.equal((await capability.json()).custodyTransfersEnabled, false);
    process.env.CUSTODY_CODE_HMAC_KEY = "replace-with-at-least-32-random-secret-bytes";
    const placeholderCapability = await api("/api/authorities/capabilities", { token: owner.token });
    assert.equal((await placeholderCapability.json()).custodyTransfersEnabled, false);
    const reportId = await createFoundReport(owner.id, "Key disabled test");
    const assigned = await createApprovedAuthority();
    const assignment = await api(`/api/authorities/reports/${reportId}/assignment`, { method: "PATCH", token: owner.token, body: JSON.stringify({ recoveryMode: "AUTHORITY", authorityId: assigned.authorityId }) });
    assert.equal(assignment.status, 200);
    const disabled = await initiate(reportId);
    assert.equal(disabled.status, 503);
    await pool.query("UPDATE users SET role='USER' WHERE user_id=$1", [admin.id]);
    const demoted = await api("/api/authorities/admin/queue", { token: admin.token });
    assert.equal(demoted.status, 403);
  } finally {
    process.env.CUSTODY_CODE_HMAC_KEY = priorKey;
    await pool.query("UPDATE users SET role='ADMIN' WHERE user_id=$1", [admin.id]);
  }
});
