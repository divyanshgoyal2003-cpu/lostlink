
require("dotenv").config();
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Force this test process to use the isolated database.
process.env.DB_NAME = "lostlink_test";
process.env.PRIVATE_PHOTO_DIR = path.join(os.tmpdir(), `lostlink-private-photos-${process.pid}`);

const assert = require("node:assert/strict");
const { before, after, afterEach, test } = require("node:test");
const jwt = require("jsonwebtoken");

const pool = require("../src/config/db");
const app = require("../src/server");

let server;
let baseUrl;
let token;
let userId;
let userEmail;
let staffId;
let staffEmail;
let staffToken;

let foundOwnerId;
let foundOwnerEmail;
let foundOwnerToken;

const reportIds = [];
const itemIds = [];
const matchIds = [];
const claimIds = [];
const extraRoleUsers = [];

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.token
      ? { Authorization: `Bearer ${options.token}` }
      : {}),
    ...options.headers,
  };

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
}

async function registerTestUser(name, email) {
  const response = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      password: "Claims-Integration-Test-123",
    }),
  });

  const responseText = await response.text();

  assert.equal(
    response.status,
    201,
    `Test account registration failed: ${responseText}`
  );

  return JSON.parse(responseText);
}

async function createReport(ownerId, reportType, title) {
  const itemResult = await pool.query(
    `INSERT INTO items (
       category,
       title,
       description,
       color,
       attributes_json
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING item_id`,
    [
      "ELECTRONICS",
      title,
      "Claims integration test item",
      "Black",
      JSON.stringify({ brand: "Sony", model: "WH-1000XM5" }),
    ]
  );

  const itemId = itemResult.rows[0].item_id;
  itemIds.push(itemId);

  const reportResult = await pool.query(
    `INSERT INTO reports (
       user_id,
       item_id,
       report_type,
       report_time,
       location_point,
       uncertainty_radius_m,
       location_source,
       location_description
     )
     VALUES (
       $1,
       $2,
       $3,
       NOW(),
       ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
       100,
       'MAP_PIN',
       'Claims integration test location'
     )
     RETURNING report_id`,
    [ownerId, itemId, reportType, 79.16, 12.97]
  );

  const reportId = reportResult.rows[0].report_id;
  reportIds.push(reportId);

  return reportId;
}

async function createMatch(lostReportId, foundReportId, status = "CANDIDATE", totalScore = 90) {
  const result = await pool.query(
    `INSERT INTO match_records (
       lost_report_id,
       found_report_id,
       location_score,
       item_score,
       time_score,
       description_score,
       total_score,
       score_breakdown,
       match_status
     )
     VALUES ($1, $2, 90, 100, 90, 80, $4, '{}'::jsonb, $3)
     RETURNING match_id`,
    [lostReportId, foundReportId, status, totalScore]
  );

  const matchId = result.rows[0].match_id;
  matchIds.push(matchId);

  return matchId;
}

async function createClaimableMatch() {
  const lostReportId = await createReport(
    userId,
    "LOST",
    "Lost Sony headphones"
  );

  const foundReportId = await createReport(
    foundOwnerId,
    "FOUND",
    "Found Sony headphones"
  );

  return createMatch(lostReportId, foundReportId);
}

async function submitClaim(matchId) {
  const response = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  claimIds.push(body.claim.claim_id);
  return body.claim;
}

async function recordVerification(claimId, status = "PASSED", privateNote = null) {
  const response = await api(`/api/claims/${claimId}/verifications`, {
    method: "POST",
    token: staffToken,
    body: JSON.stringify({
      verificationType: "OWNERSHIP_REVIEW",
      status,
      privateNote,
    }),
  });
  return { response, body: await response.json() };
}

async function approveClaim(claimId) {
  const verification = await recordVerification(claimId);
  assert.equal(verification.response.status, 201);
  return api(`/api/claims/${claimId}/review`, {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({ decision: "APPROVED" }),
  });
}

afterEach(async () => {
  // Delete claims before matches because claims reference match_records.
  if (matchIds.length > 0) {
    await pool.query(
      `DELETE FROM notifications
       WHERE reference_type = 'CLAIM'
         AND (reference_id = ANY($2::bigint[]) OR reference_id IN (
           SELECT claim_id FROM claim_requests WHERE match_id = ANY($1::bigint[])
         ))`,
      [matchIds, claimIds]
    );
    await pool.query(
      `DELETE FROM handover_records
       WHERE claim_id IN (
         SELECT claim_id FROM claim_requests WHERE match_id = ANY($1::bigint[])
       )`,
      [matchIds]
    );

    await pool.query(
      `DELETE FROM audit_logs
       WHERE entity_type = 'CLAIM'
         AND entity_id IN (
           SELECT claim_id FROM claim_requests WHERE match_id = ANY($1::bigint[])
         )`,
      [matchIds]
    );

    await pool.query(
      `DELETE FROM claim_requests
       WHERE match_id = ANY($1::bigint[])`,
      [matchIds]
    );

    await pool.query(
      `DELETE FROM match_records
       WHERE match_id = ANY($1::bigint[])`,
      [matchIds]
    );
  }

  if (claimIds.length > 0) {
    await pool.query(
      `DELETE FROM claim_requests
       WHERE claim_id = ANY($1::bigint[])`,
      [claimIds]
    );
  }

  if (reportIds.length > 0) {
    await pool.query(
      `DELETE FROM reports
       WHERE report_id = ANY($1::bigint[])`,
      [reportIds]
    );
  }

  if (itemIds.length > 0) {
    await pool.query(
      `DELETE FROM items
       WHERE item_id = ANY($1::bigint[])`,
      [itemIds]
    );
  }

  reportIds.length = 0;
  itemIds.length = 0;
  matchIds.length = 0;
  claimIds.length = 0;
  const storedFiles = await fs.readdir(process.env.PRIVATE_PHOTO_DIR).catch(() => []);
  await Promise.all(storedFiles.map((file) => fs.unlink(path.join(process.env.PRIVATE_PHOTO_DIR, file))));
});

before(async () => {
  const result = await pool.query(
    "SELECT current_database() AS database_name"
  );

  assert.equal(
    result.rows[0].database_name,
    "lostlink_test",
    "Safety check failed: tests must use lostlink_test"
  );

  assert.ok(
    process.env.JWT_SECRET,
    "JWT_SECRET must be configured in backend/.env"
  );

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const suffix = `${process.pid}-${Date.now()}`;

  userEmail = `claims-test-${suffix}@example.test`;
  foundOwnerEmail = `claims-found-owner-${suffix}@example.test`;

  const claimant = await registerTestUser(
    "Claims Integration Test",
    userEmail
  );

  token = claimant.token;
  userId = claimant.user.user_id;

  const foundOwner = await registerTestUser(
    "Claims Found Owner Test",
    foundOwnerEmail
  );

  foundOwnerId = foundOwner.user.user_id;
  foundOwnerToken = foundOwner.token;

  staffEmail = `claims-staff-${suffix}@example.test`;
  const staff = await registerTestUser("Claims Staff Test", staffEmail);
  staffId = staff.user.user_id;
  await pool.query("UPDATE users SET role = 'STAFF' WHERE user_id = $1", [staffId]);
  staffToken = jwt.sign({ userId: staffId, role: "STAFF" }, process.env.JWT_SECRET);

  assert.ok(token, "Registration should return a JWT");
  await fs.mkdir(process.env.PRIVATE_PHOTO_DIR, { recursive: true });
});

after(async () => {
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (userId !== undefined || foundOwnerId !== undefined || staffId !== undefined || extraRoleUsers.length > 0) {
      await pool.query(
        `DELETE FROM users
         WHERE user_id = ANY($1::bigint[])
           AND email = ANY($2::text[])`,
        [
          [userId, foundOwnerId, staffId, ...extraRoleUsers.map((entry) => entry.id)].filter((id) => id !== undefined),
          [userEmail, foundOwnerEmail, staffEmail, ...extraRoleUsers.map((entry) => entry.email)].filter(Boolean),
        ]
      );
    }
    await fs.rm(process.env.PRIVATE_PHOTO_DIR, { recursive: true, force: true });
  } finally {
    await pool.end();
  }
});

test("GET /api/claims rejects requests without authentication", async () => {
  const response = await api("/api/claims");
  assert.equal(response.status, 401);

  const body = await response.json();
  assert.equal(body.message, "Authentication required.");
});

test("GET /api/claims returns an empty list for a user without claims", async () => {
  const response = await api("/api/claims", { token });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.count, 0);
  assert.deepEqual(body.claims, []);
});

test("GET /api/claims rejects an invalid token", async () => {
  const invalidToken = jwt.sign(
    { userId, role: "USER" },
    "incorrect-test-secret"
  );

  const response = await api("/api/claims", { token: invalidToken });
  assert.equal(response.status, 401);
});

test("POST /api/claims rejects requests without authentication", async () => {
  const response = await api("/api/claims", {
    method: "POST",
    body: JSON.stringify({ matchId: 1 }),
  });

  assert.equal(response.status, 401);
});

test("POST /api/claims rejects an invalid matchId", async () => {
  const response = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId: "invalid" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "A valid matchId is required",
  });
});

test("POST /api/claims returns 404 for a nonexistent match", async () => {
  const response = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId: 999999999 }),
  });

  assert.equal(response.status, 404);
});

test("POST /api/claims rejects a claimant who does not own the lost report", async () => {
  const lostReportId = await createReport(
    foundOwnerId,
    "LOST",
    "Lost Sony headphones"
  );

  const foundReportId = await createReport(
    userId,
    "FOUND",
    "Found Sony headphones"
  );

  const matchId = await createMatch(lostReportId, foundReportId);

  const response = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId }),
  });

  assert.equal(response.status, 403);
});

test("POST /api/claims creates a claim for an eligible match", async () => {
  const matchId = await createClaimableMatch();

  const response = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId }),
  });

  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.claim.match_id, matchId);
  assert.equal(Number(body.claim.claimant_user_id), Number(userId));
  assert.equal(body.claim.claim_status, "SUBMITTED");

  claimIds.push(body.claim.claim_id);
  const conversation = await pool.query("SELECT conversation_status FROM conversations WHERE claim_id=$1", [body.claim.claim_id]);
  assert.equal(conversation.rowCount, 0, "Chat must remain disabled until the finder or assigned authority enables it");
  const events = await pool.query(
    `SELECT user_id, notification_type FROM notifications
     WHERE reference_type = 'CLAIM' AND reference_id = $1
     ORDER BY notification_type`,
    [body.claim.claim_id]
  );
  assert.deepEqual(events.rows.map((row) => `${row.user_id}:${row.notification_type}`).sort(), [
    `${userId}:CLAIM_SUBMITTED`,
    `${foundOwnerId}:NEW_CLAIM`,
  ].sort());
});

test("POST /api/claims rejects a duplicate active claim", async () => {
  const matchId = await createClaimableMatch();

  const firstResponse = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId }),
  });

  assert.equal(firstResponse.status, 201);

  const firstBody = await firstResponse.json();
  claimIds.push(firstBody.claim.claim_id);

  const secondResponse = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId }),
  });

  assert.equal(secondResponse.status, 409);
});

test("POST /api/claims prevents duplicate claims from concurrent requests", async () => {
  const matchId = await createClaimableMatch();

  const submitClaim = () =>
    api("/api/claims", {
      method: "POST",
      token,
      body: JSON.stringify({ matchId }),
    });

  const responses = await Promise.all([
    submitClaim(),
    submitClaim(),
  ]);

  const statuses = responses.map((response) => response.status);

  assert.equal(
    statuses.filter((status) => status === 201).length,
    1,
    `Expected exactly one successful claim, received: ${statuses.join(", ")}`
  );

  assert.equal(
    statuses.filter((status) => status === 409).length,
    1,
    `Expected exactly one conflict, received: ${statuses.join(", ")}`
  );

  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM claim_requests
     WHERE match_id = $1
       AND claimant_user_id = $2
       AND claim_status IN ('SUBMITTED', 'IN_REVIEW', 'APPROVED')`,
    [matchId, userId]
  );

  assert.equal(result.rows[0].count, 1);
});

function validPngFixture() {
  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const name = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const compressedPixels = require("node:zlib").deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", compressedPixels), chunk("IEND", Buffer.alloc(0))]);
}

async function uploadPhoto(reportId, photoType, authToken = foundOwnerToken, bytes = validPngFixture()) {
  return api(`/api/reports/${reportId}/photos`, {
    method: "PUT",
    token: authToken,
    headers: { "Content-Type": "image/png", "X-Photo-Type": photoType },
    body: bytes,
  });
}

test("found photos are private by default and sharing is claim-scoped, revocable, and audited", async () => {
  const matchId = await createClaimableMatch();
  const foundReport = await pool.query("SELECT found_report_id FROM match_records WHERE match_id = $1", [matchId]);
  const foundReportId = foundReport.rows[0].found_report_id;
  const claim = await submitClaim(matchId);

  const unauthorizedUpload = await uploadPhoto(foundReportId, "FRONT", token);
  assert.equal(unauthorizedUpload.status, 404);
  const unauthenticatedUpload = await uploadPhoto(foundReportId, "FRONT", null);
  assert.equal(unauthenticatedUpload.status, 401);
  const wrongReportUpload = await uploadPhoto(
    (await pool.query("SELECT lost_report_id FROM match_records WHERE match_id = $1", [matchId])).rows[0].lost_report_id,
    "FRONT",
  );
  assert.equal(wrongReportUpload.status, 404);

  const uploadResponses = [];
  for (const photoType of ["FRONT", "BACK", "SIDE"]) {
    const response = await uploadPhoto(foundReportId, photoType);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.photo.photoType, photoType);
    assert.equal("storage_key" in body.photo, false);
    assert.equal(JSON.stringify(body).includes("http"), false);
    uploadResponses.push(body);
  }
  const photoId = uploadResponses[0].photo.photoId;
  const matchResponse = await api("/api/matches", { token });
  assert.equal(matchResponse.status, 200);
  const matchPayload = JSON.stringify(await matchResponse.json());
  assert.equal(matchPayload.includes("storage_key"), false);
  assert.equal(matchPayload.includes("photoId"), false);
  const claimsResponse = await api("/api/claims", { token });
  const claimsPayload = JSON.stringify(await claimsResponse.json());
  assert.equal(claimsPayload.includes("storage_key"), false);
  assert.equal(claimsPayload.includes("photoId"), false);
  const metadata = await api(`/api/reports/${foundReportId}/photos`, { token: foundOwnerToken });
  assert.equal(metadata.status, 200);
  assert.equal(JSON.stringify(await metadata.json()).includes("storage_key"), false);
  const claimantMetadata = await api(`/api/claims/${claim.claim_id}/photos`, { token });
  assert.equal(claimantMetadata.status, 200);
  const privateState = await claimantMetadata.json();
  assert.equal(privateState.sharingStatus, "PRIVATE");
  assert.deepEqual(privateState.photos, []);

  const noAuthRetrieval = await api(`/api/reports/photos/${photoId}?claimId=${claim.claim_id}`);
  assert.equal(noAuthRetrieval.status, 401);
  const preGrantRetrieval = await api(`/api/reports/photos/${photoId}?claimId=${claim.claim_id}`, { token });
  assert.equal(preGrantRetrieval.status, 403);

  await pool.query("UPDATE conversations SET conversation_status='CLOSED' WHERE claim_id=$1", [claim.claim_id]);
  const grantBeforeConversation = await api(`/api/claims/${claim.claim_id}/photo-sharing`, {
    method: "POST", token: foundOwnerToken,
  });
  assert.equal(grantBeforeConversation.status, 409);
  await pool.query("UPDATE conversations SET conversation_status='OPEN' WHERE claim_id=$1", [claim.claim_id]);
  await pool.query("INSERT INTO conversations (claim_id, conversation_status) VALUES ($1, 'OPEN') ON CONFLICT (claim_id) DO NOTHING", [claim.claim_id]);

  const claimantCannotGrant = await api(`/api/claims/${claim.claim_id}/photo-sharing`, {
    method: "POST", token,
  });
  assert.equal(claimantCannotGrant.status, 403);
  const grant = await api(`/api/claims/${claim.claim_id}/photo-sharing`, {
    method: "POST", token: foundOwnerToken,
  });
  assert.equal(grant.status, 201);

  const unrelated = await registerTestUser("Unrelated Photo Test", `photo-unrelated-${process.pid}-${Date.now()}@example.test`);
  extraRoleUsers.push({ id: unrelated.user.user_id, email: unrelated.user.email });
  const unrelatedList = await api(`/api/claims/${claim.claim_id}/photos`, { token: unrelated.token });
  assert.equal(unrelatedList.status, 403);
  const unrelatedRetrieval = await api(`/api/reports/photos/${photoId}?claimId=${claim.claim_id}`, { token: unrelated.token });
  assert.equal(unrelatedRetrieval.status, 403);

  const claimantAfterGrant = await api(`/api/claims/${claim.claim_id}/photos`, { token });
  const sharedState = await claimantAfterGrant.json();
  assert.equal(sharedState.sharingStatus, "SHARED");
  assert.equal(sharedState.photos.length, 3);
  assert.equal(JSON.stringify(sharedState).includes("storage_key"), false);
  const image = await api(`/api/reports/photos/${photoId}?claimId=${claim.claim_id}`, { token });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), validPngFixture());

  const finderImage = await api(`/api/reports/photos/${photoId}?reportId=${foundReportId}`, { token: foundOwnerToken });
  assert.equal(finderImage.status, 200);
  const wrongFinderImage = await api(`/api/reports/photos/${photoId}?reportId=${foundReportId}`, { token });
  assert.equal(wrongFinderImage.status, 403);

  const secondClaimant = await registerTestUser("Second Claimant", `claims-second-${process.pid}-${Date.now()}@example.test`);
  extraRoleUsers.push({ id: secondClaimant.user.user_id, email: secondClaimant.user.email });
  const otherLostReport = await createReport(secondClaimant.user.user_id, "LOST", "Second claimant lost item");
  const sameFoundMatch = await createMatch(otherLostReport, foundReportId);
  const secondClaimResponse = await api("/api/claims", {
    method: "POST", token: secondClaimant.token, body: JSON.stringify({ matchId: sameFoundMatch }),
  });
  assert.equal(secondClaimResponse.status, 201);
  const secondClaim = (await secondClaimResponse.json()).claim;
  claimIds.push(secondClaim.claim_id);
  const secondClaimDenied = await api(`/api/reports/photos/${photoId}?claimId=${secondClaim.claim_id}`, { token: secondClaimant.token });
  assert.equal(secondClaimDenied.status, 403);

  const revoke = await api(`/api/claims/${claim.claim_id}/photo-sharing`, {
    method: "DELETE", token: foundOwnerToken,
  });
  assert.equal(revoke.status, 200);
  const afterRevoke = await api(`/api/reports/photos/${photoId}?claimId=${claim.claim_id}`, { token });
  assert.equal(afterRevoke.status, 403);
  const audit = await pool.query(
    `SELECT action_type FROM audit_logs WHERE entity_type = 'CLAIM' AND entity_id = $1
     AND action_type IN ('CLAIM_PHOTOS_SHARED', 'CLAIM_PHOTOS_REVOKED') ORDER BY action_type`,
    [claim.claim_id],
  );
  assert.deepEqual(audit.rows.map((row) => row.action_type), ["CLAIM_PHOTOS_REVOKED", "CLAIM_PHOTOS_SHARED"]);
});

test("photo formats and guided replacement are validated; STAFF/ADMIN boundaries are enforced", async () => {
  const matchId = await createClaimableMatch();
  const foundReportId = (await pool.query("SELECT found_report_id FROM match_records WHERE match_id = $1", [matchId])).rows[0].found_report_id;
  const claim = await submitClaim(matchId);
  const invalid = await uploadPhoto(foundReportId, "FRONT", foundOwnerToken, Buffer.from("not an image"));
  assert.equal(invalid.status, 415);
  const mimeMismatch = await api(`/api/reports/${foundReportId}/photos`, {
    method: "PUT", token: foundOwnerToken,
    headers: { "Content-Type": "image/jpeg", "X-Photo-Type": "FRONT" },
    body: validPngFixture(),
  });
  assert.equal(mimeMismatch.status, 415);
  const invalidType = await uploadPhoto(foundReportId, "SERIAL_NUMBER", foundOwnerToken);
  assert.equal(invalidType.status, 400);
  const oversized = await uploadPhoto(foundReportId, "FRONT", foundOwnerToken, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 413);

  const first = await uploadPhoto(foundReportId, "FRONT");
  const firstPhoto = (await first.json()).photo;
  const replacement = await uploadPhoto(foundReportId, "FRONT", foundOwnerToken, validPngFixture());
  assert.equal(replacement.status, 200);
  assert.equal((await replacement.json()).photo.photoId, firstPhoto.photoId);

  await pool.query("INSERT INTO conversations (claim_id, conversation_status) VALUES ($1, 'OPEN') ON CONFLICT (claim_id) DO NOTHING", [claim.claim_id]);
  const incompleteCapture = await api(`/api/claims/${claim.claim_id}/photo-sharing`, { method: "POST", token: foundOwnerToken });
  assert.equal(incompleteCapture.status, 409);
  for (const photoType of ["BACK", "SIDE"]) assert.equal((await uploadPhoto(foundReportId, photoType)).status, 201);
  const claimantCanShare = await api(`/api/claims/${claim.claim_id}/photo-sharing`, { method: "POST", token });
  assert.equal(claimantCanShare.status, 403);
  const shareByStaff = await api(`/api/claims/${claim.claim_id}/photo-sharing`, { method: "POST", token: staffToken });
  assert.equal(shareByStaff.status, 201);
  const staffPhotoList = await api(`/api/claims/${claim.claim_id}/photos`, { token: staffToken });
  assert.equal((await staffPhotoList.json()).photos.length, 3);
  const staffPhoto = await api(`/api/reports/photos/${firstPhoto.photoId}?claimId=${claim.claim_id}`, { token: staffToken });
  assert.equal(staffPhoto.status, 200);
  await pool.query("UPDATE conversations SET conversation_status = 'CLOSED' WHERE claim_id = $1", [claim.claim_id]);
  const staffAfterClose = await api(`/api/reports/photos/${firstPhoto.photoId}?claimId=${claim.claim_id}`, { token: staffToken });
  assert.equal(staffAfterClose.status, 403);
  await pool.query("UPDATE conversations SET conversation_status = 'OPEN' WHERE claim_id = $1", [claim.claim_id]);
  const revokeByFinder = await api(`/api/claims/${claim.claim_id}/photo-sharing`, { method: "DELETE", token: foundOwnerToken });
  assert.equal(revokeByFinder.status, 200);

  const adminEmail = `claims-admin-${process.pid}-${Date.now()}@example.test`;
  const admin = await registerTestUser("Claims Admin Test", adminEmail);
  extraRoleUsers.push({ id: admin.user.user_id, email: admin.user.email });
  await pool.query("UPDATE users SET role = 'ADMIN' WHERE user_id = $1", [admin.user.user_id]);
  const adminToken = jwt.sign({ userId: admin.user.user_id, role: "ADMIN" }, process.env.JWT_SECRET);
  const shareByAdmin = await api(`/api/claims/${claim.claim_id}/photo-sharing`, { method: "POST", token: adminToken });
  assert.equal(shareByAdmin.status, 201);
  const revokeByAdmin = await api(`/api/claims/${claim.claim_id}/photo-sharing`, { method: "DELETE", token: adminToken });
  assert.equal(revokeByAdmin.status, 200);
});

test("GET /api/matches includes the persisted match ID and lost-owner eligibility", async () => {
  const matchId = await createClaimableMatch();

  const claimantResponse = await api("/api/matches", { token });
  assert.equal(claimantResponse.status, 200);
  const claimantMatches = await claimantResponse.json();
  const claimantMatch = claimantMatches.matches.find(
    (match) => match.lostTitle === "Lost Sony headphones"
  );
  assert.ok(claimantMatch);
  assert.equal(claimantMatch.matchId, String(matchId));
  assert.equal(claimantMatch.canClaim, true);
  assert.equal(claimantMatch.matchStrength, "STRONG");
  assert.equal(Object.hasOwn(claimantMatch, "foundTitle"), false);
  assert.equal(claimantMatch.lostReportTime != null, true);
  assert.equal(claimantMatch.foundReportTime != null, true);
  assert.equal(claimantMatches.scoreThreshold, 70);
  assert.equal(claimantMatches.strongMatchThreshold, 85);

  const foundOwnerResponse = await api("/api/matches", { token: foundOwnerToken });
  assert.equal(foundOwnerResponse.status, 200);
  const foundOwnerMatches = await foundOwnerResponse.json();
  const foundOwnerMatch = foundOwnerMatches.matches.find(
    (match) => match.lostTitle === "Lost Sony headphones"
  );
  assert.equal(foundOwnerMatch, undefined);
});

test("found-report owners cannot refresh another user's lost-report matches", async () => {
  const matchId = await createClaimableMatch();

  const response = await api("/api/matches/refresh", {
    method: "POST",
    token: foundOwnerToken,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidatesFound, 0);

  const saved = await pool.query(
    "SELECT match_status FROM match_records WHERE match_id = $1",
    [matchId]
  );
  assert.equal(saved.rows[0].match_status, "CANDIDATE");
});

test("My Matches marks stale records non-claimable and omits closed report pairs", async () => {
  const staleLost = await createReport(userId, "LOST", "Stale lost Sony headphones");
  const staleFound = await createReport(foundOwnerId, "FOUND", "Stale found Sony headphones");
  const staleMatchId = await createMatch(staleLost, staleFound, "STALE", 95);

  const closedMatchId = await createClaimableMatch();
  const closedPair = await pool.query(
    "SELECT found_report_id FROM match_records WHERE match_id = $1",
    [closedMatchId]
  );
  await pool.query("UPDATE reports SET status = 'CLOSED' WHERE report_id = $1", [closedPair.rows[0].found_report_id]);

  const response = await api("/api/matches", { token });
  assert.equal(response.status, 200);
  const body = await response.json();
  const staleMatch = body.matches.find((match) => match.matchId === String(staleMatchId));
  assert.ok(staleMatch);
  assert.equal(staleMatch.status, "STALE");
  assert.equal(staleMatch.canClaim, false);
  assert.equal(body.matches.some((match) => match.matchId === String(closedMatchId)), false);
});

test("My Matches excludes persisted scores below 70 and preserves the 70 boundary", async () => {
  const matchId = await createClaimableMatch();
  await pool.query("UPDATE match_records SET total_score = 69.99 WHERE match_id = $1", [matchId]);

  const belowResponse = await api("/api/matches", { token });
  assert.equal(belowResponse.status, 200);
  const belowBody = await belowResponse.json();
  assert.equal(belowBody.matches.some((match) => match.matchId === String(matchId)), false);

  await pool.query("UPDATE match_records SET total_score = 70 WHERE match_id = $1", [matchId]);
  const boundaryResponse = await api("/api/matches", { token });
  assert.equal(boundaryResponse.status, 200);
  const boundaryBody = await boundaryResponse.json();
  const boundaryMatch = boundaryBody.matches.find((match) => match.matchId === String(matchId));
  assert.ok(boundaryMatch);
  assert.equal(boundaryMatch.matchScore >= 70, true);
});

test("POST /api/claims rejects below-threshold persisted scores but accepts 70", async () => {
  const belowMatchId = await createClaimableMatch();
  await pool.query("UPDATE match_records SET total_score = 69.99 WHERE match_id = $1", [belowMatchId]);
  const belowResponse = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId: belowMatchId }),
  });
  assert.equal(belowResponse.status, 409);

  const boundaryMatchId = await createClaimableMatch();
  await pool.query("UPDATE match_records SET total_score = 70 WHERE match_id = $1", [boundaryMatchId]);
  const boundaryResponse = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId: boundaryMatchId }),
  });
  assert.equal(boundaryResponse.status, 201);
  const body = await boundaryResponse.json();
  claimIds.push(body.claim.claim_id);
});

test("stale matches cannot be claimed even when their stored score qualifies", async () => {
  const lostReportId = await createReport(userId, "LOST", "Lost Sony headphones");
  const foundReportId = await createReport(foundOwnerId, "FOUND", "Found Sony headphones");
  const matchId = await createMatch(lostReportId, foundReportId, "STALE", 95);

  const response = await api("/api/claims", {
    method: "POST",
    token,
    body: JSON.stringify({ matchId }),
  });
  assert.equal(response.status, 409);
});

test("review queue and verification endpoints require authentication and reviewer role", async () => {
  const claimId = (await submitClaim(await createClaimableMatch())).claim_id;
  const noAuth = await api("/api/claims/review-queue");
  assert.equal(noAuth.status, 401);

  const userQueue = await api("/api/claims/review-queue", { token });
  assert.equal(userQueue.status, 403);

  const staffQueue = await api("/api/claims/review-queue", { token: staffToken });
  assert.equal(staffQueue.status, 200);

  const noAuthVerification = await api(`/api/claims/${claimId}/verifications`, {
    method: "POST",
    body: JSON.stringify({ verificationType: "OWNERSHIP_REVIEW", status: "PASSED" }),
  });
  assert.equal(noAuthVerification.status, 401);

  const userVerification = await api(`/api/claims/${claimId}/verifications`, {
    method: "POST",
    token,
    body: JSON.stringify({ verificationType: "OWNERSHIP_REVIEW", status: "PASSED" }),
  });
  assert.equal(userVerification.status, 403);
});

test("only the finder can activate direct-recovery chat for an active claim", async () => {
  const claim = await submitClaim(await createClaimableMatch());
  await pool.query("DELETE FROM conversations WHERE claim_id=$1", [claim.claim_id]);

  const claimantAttempt = await api(`/api/claims/${claim.claim_id}/conversation/open`, {
    method: "POST",
    token,
  });
  assert.equal(claimantAttempt.status, 403);

  const staffAttempt = await api(`/api/claims/${claim.claim_id}/conversation/open`, {
    method: "POST",
    token: staffToken,
  });
  assert.equal(staffAttempt.status, 403);

  const opened = await api(`/api/claims/${claim.claim_id}/conversation/open`, {
    method: "POST",
    token: foundOwnerToken,
  });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).conversationStatus, "OPEN");

  const repeatedOpen = await api(`/api/claims/${claim.claim_id}/conversation/open`, {
    method: "POST",
    token: foundOwnerToken,
  });
  assert.equal(repeatedOpen.status, 200);
  const state = await pool.query(
    `SELECT conv.conversation_status,
            (SELECT COUNT(*)::int FROM audit_logs WHERE entity_type='CLAIM' AND entity_id=$1 AND action_type='CLAIM_CHAT_ENABLED') AS audit_count
     FROM conversations conv WHERE conv.claim_id=$1`,
    [claim.claim_id]
  );
  assert.equal(state.rows[0].conversation_status, "OPEN");
  assert.equal(state.rows[0].audit_count, 1);

  await pool.query("UPDATE claim_requests SET claim_status='REJECTED' WHERE claim_id=$1", [claim.claim_id]);
  await pool.query("DELETE FROM conversations WHERE claim_id=$1", [claim.claim_id]);
  const rejectedAttempt = await api(`/api/claims/${claim.claim_id}/conversation/open`, {
    method: "POST",
    token: foundOwnerToken,
  });
  assert.equal(rejectedAttempt.status, 409);
});

test("verification starts review and private notes stay out of participant responses", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);
  const privateNote = "REVIEWER_ONLY_SENTINEL_92741";

  const { response, body } = await recordVerification(claim.claim_id, "PASSED", privateNote);
  assert.equal(response.status, 201);
  assert.equal(body.verification.verification_status, "PASSED");
  assert.equal(JSON.stringify(body).includes(privateNote), false);
  assert.equal(JSON.stringify(body).includes("evidence_reference"), false);

  const claimState = await pool.query(
    `SELECT c.claim_status, m.match_status, lost.status AS lost_status,
            found.status AS found_status
     FROM claim_requests c
     JOIN match_records m ON m.match_id = c.match_id
     JOIN reports lost ON lost.report_id = m.lost_report_id
     JOIN reports found ON found.report_id = m.found_report_id
     WHERE c.claim_id = $1`,
    [claim.claim_id]
  );
  assert.deepEqual(claimState.rows[0], {
    claim_status: "IN_REVIEW",
    match_status: "CLAIM_PENDING",
    lost_status: "CLAIM_PENDING",
    found_status: "CLAIM_PENDING",
  });
  const reviewNotification = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE user_id = $1 AND notification_type = 'CLAIM_IN_REVIEW'
       AND reference_type = 'CLAIM' AND reference_id = $2`,
    [userId, claim.claim_id]
  );
  assert.equal(reviewNotification.rows[0].count, 1);

  const participantClaims = await api("/api/claims", { token });
  const participantBody = await participantClaims.json();
  assert.equal(JSON.stringify(participantBody).includes(privateNote), false);
  assert.equal(JSON.stringify(participantBody).includes("evidence_reference"), false);

  const deniedPrivateNotes = await api(`/api/claims/${claim.claim_id}/verifications`, { token });
  assert.equal(deniedPrivateNotes.status, 403);

  const reviewerNotes = await api(`/api/claims/${claim.claim_id}/verifications`, { token: staffToken });
  assert.equal(reviewerNotes.status, 200);
  const reviewerBody = await reviewerNotes.json();
  assert.equal(reviewerBody.verifications[0].review_notes_private, privateNote);
  assert.equal("evidence_reference" in reviewerBody.verifications[0], false);
});

test("approval requires a passed verification and rejected claims reopen reports", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);

  const directApproval = await api(`/api/claims/${claim.claim_id}/review`, {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({ decision: "APPROVED" }),
  });
  assert.equal(directApproval.status, 409);

  const { response: failedVerification } = await recordVerification(
    claim.claim_id,
    "FAILED"
  );
  assert.equal(failedVerification.status, 201);

  const invalidApproval = await api(`/api/claims/${claim.claim_id}/review`, {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({ decision: "APPROVED" }),
  });
  assert.equal(invalidApproval.status, 409);

  const rejection = await api(`/api/claims/${claim.claim_id}/review`, {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({ decision: "REJECTED", privateNote: "Not enough evidence" }),
  });
  assert.equal(rejection.status, 200);

  const statuses = await pool.query(
    `SELECT c.claim_status, m.match_status, lost.status AS lost_status,
            found.status AS found_status
     FROM claim_requests c
     JOIN match_records m ON m.match_id = c.match_id
     JOIN reports lost ON lost.report_id = m.lost_report_id
     JOIN reports found ON found.report_id = m.found_report_id
     WHERE c.claim_id = $1`,
    [claim.claim_id]
  );
  assert.deepEqual(statuses.rows[0], {
    claim_status: "REJECTED",
    match_status: "REJECTED",
    lost_status: "OPEN",
    found_status: "OPEN",
  });
  assert.equal(JSON.stringify(await rejection.json()).includes("Not enough evidence"), false);

  const duplicateRejection = await api(`/api/claims/${claim.claim_id}/review`, {
    method: "PATCH",
    token: staffToken,
    body: JSON.stringify({ decision: "REJECTED" }),
  });
  assert.equal(duplicateRejection.status, 409);
  const rejectionNotification = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE user_id = $1 AND notification_type = 'CLAIM_REJECTED'
       AND reference_type = 'CLAIM' AND reference_id = $2`,
    [userId, claim.claim_id]
  );
  assert.equal(rejectionNotification.rows[0].count, 1);
});

test("unknown reviewers are rejected before verification changes claim state", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);
  const missingUserToken = jwt.sign(
    { userId: Number.MAX_SAFE_INTEGER, role: "STAFF" },
    process.env.JWT_SECRET
  );

  const response = await api(`/api/claims/${claim.claim_id}/verifications`, {
    method: "POST",
    token: missingUserToken,
    body: JSON.stringify({
      verificationType: "OWNERSHIP_REVIEW",
      status: "PASSED",
      privateNote: "Must rollback with the failed transaction",
    }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "You are not authorized to review this claim" });

  const state = await pool.query(
    `SELECT c.claim_status, m.match_status, lost.status AS lost_status,
            found.status AS found_status,
            (SELECT COUNT(*)::int FROM claim_verifications v WHERE v.claim_id = c.claim_id) AS verification_count
     FROM claim_requests c
     JOIN match_records m ON m.match_id = c.match_id
     JOIN reports lost ON lost.report_id = m.lost_report_id
     JOIN reports found ON found.report_id = m.found_report_id
     WHERE c.claim_id = $1`,
    [claim.claim_id]
  );
  assert.deepEqual(state.rows[0], {
    claim_status: "SUBMITTED",
    match_status: "CANDIDATE",
    lost_status: "OPEN",
    found_status: "OPEN",
    verification_count: 0,
  });
});

test("only the claimant receives a hashed handover code; found owner confirms it once", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);
  const approval = await approveClaim(claim.claim_id);
  assert.equal(approval.status, 200, await approval.clone().text());
  const approvalNotification = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE user_id = $1 AND notification_type = 'CLAIM_APPROVED'
       AND reference_type = 'CLAIM' AND reference_id = $2`,
    [userId, claim.claim_id]
  );
  assert.equal(approvalNotification.rows[0].count, 1);

  const ownerCannotIssue = await api(`/api/claims/${claim.claim_id}/handover/code`, {
    method: "POST",
    token: foundOwnerToken,
  });
  assert.equal(ownerCannotIssue.status, 403);

  const issued = await api(`/api/claims/${claim.claim_id}/handover/code`, {
    method: "POST",
    token,
  });
  assert.equal(issued.status, 201);
  const issuedBody = await issued.json();
  assert.match(issuedBody.code, /^\d{8}$/);
  assert.equal(issuedBody.expiresInMinutes, 15);

  const stored = await pool.query(
    `SELECT handover_status, code_hash, code_expires_at
     FROM handover_records WHERE claim_id = $1`,
    [claim.claim_id]
  );
  assert.equal(stored.rows[0].handover_status, "CODE_ISSUED");
  assert.notEqual(stored.rows[0].code_hash, issuedBody.code);
  assert.match(stored.rows[0].code_hash, /^[a-f0-9]{64}$/);
  assert.ok(new Date(stored.rows[0].code_expires_at).getTime() > Date.now());

  const claimantCannotConfirm = await api(`/api/claims/${claim.claim_id}/handover/confirm`, {
    method: "POST",
    token,
    body: JSON.stringify({ code: issuedBody.code }),
  });
  assert.equal(claimantCannotConfirm.status, 403);

  const confirmed = await api(`/api/claims/${claim.claim_id}/handover/confirm`, {
    method: "POST",
    token: foundOwnerToken,
    body: JSON.stringify({ code: issuedBody.code }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).claimStatus, "COMPLETED");

  const replay = await api(`/api/claims/${claim.claim_id}/handover/confirm`, {
    method: "POST",
    token: foundOwnerToken,
    body: JSON.stringify({ code: issuedBody.code }),
  });
  assert.equal(replay.status, 409);

  const completed = await pool.query(
    `SELECT c.claim_status, m.match_status, lost.status AS lost_status,
            found.status AS found_status, h.handover_status,
            h.code_used_at, h.verified_by_user_id
     FROM claim_requests c
     JOIN match_records m ON m.match_id = c.match_id
     JOIN reports lost ON lost.report_id = m.lost_report_id
     JOIN reports found ON found.report_id = m.found_report_id
     JOIN handover_records h ON h.claim_id = c.claim_id
     WHERE c.claim_id = $1`,
    [claim.claim_id]
  );
  assert.deepEqual(completed.rows[0], {
    claim_status: "COMPLETED",
    match_status: "RETURNED",
    lost_status: "RETURNED",
    found_status: "RETURNED",
    handover_status: "COMPLETED",
    code_used_at: completed.rows[0].code_used_at,
    verified_by_user_id: foundOwnerId,
  });
  assert.ok(completed.rows[0].code_used_at);
  const claimantClaims = await api("/api/claims", { token });
  assert.ok((await claimantClaims.json()).claims.some((entry) => Number(entry.claim_id) === Number(claim.claim_id) && entry.claim_status === "COMPLETED"));
  const handoverEvents = await pool.query(
    `SELECT user_id, COUNT(*)::int AS count FROM notifications
     WHERE notification_type = 'HANDOVER_COMPLETED'
       AND reference_type = 'CLAIM' AND reference_id = $1
     GROUP BY user_id ORDER BY user_id`,
    [claim.claim_id]
  );
  assert.deepEqual(handoverEvents.rows.map((row) => `${row.user_id}:${row.count}`).sort(), [
    `${userId}:1`,
    `${foundOwnerId}:1`,
  ].sort());
});

test("found owner can verify and approve a direct-recovery claim", async () => {
  const directMatch = await createClaimableMatch();
  const directClaim = await submitClaim(directMatch);
  const verification = await api(`/api/claims/${directClaim.claim_id}/verifications`, {
    method: "POST",
    token: foundOwnerToken,
    body: JSON.stringify({ verificationType: "OWNERSHIP_VERIFICATION", status: "PASSED" }),
  });
  assert.equal(verification.status, 201, await verification.clone().text());
  const approved = await api(`/api/claims/${directClaim.claim_id}/review`, {
    method: "PATCH",
    token: foundOwnerToken,
    body: JSON.stringify({ decision: "APPROVED" }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
});

test("expired handover codes cannot complete and may be replaced", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);
  const approval = await approveClaim(claim.claim_id);
  assert.equal(approval.status, 200, await approval.clone().text());

  const issueCode = () => api(`/api/claims/${claim.claim_id}/handover/code`, {
    method: "POST",
    token,
  });
  const firstIssue = await issueCode();
  assert.equal(firstIssue.status, 201);
  const firstCode = (await firstIssue.json()).code;
  await pool.query(
    `UPDATE handover_records SET code_expires_at = NOW() - INTERVAL '1 second'
     WHERE claim_id = $1`,
    [claim.claim_id]
  );

  const expired = await api(`/api/claims/${claim.claim_id}/handover/confirm`, {
    method: "POST",
    token: foundOwnerToken,
    body: JSON.stringify({ code: firstCode }),
  });
  assert.equal(expired.status, 410);

  const expiredState = await pool.query(
    `SELECT handover_status, code_used_at
     FROM handover_records WHERE claim_id = $1`,
    [claim.claim_id]
  );
  assert.equal(expiredState.rows[0].handover_status, "EXPIRED");
  assert.equal(expiredState.rows[0].code_used_at, null);

  const secondIssue = await issueCode();
  assert.equal(secondIssue.status, 200);
  const secondCode = (await secondIssue.json()).code;
  assert.notEqual(secondCode, firstCode);
});

test("invalid handover codes are audited and rate limited", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);
  const approval = await approveClaim(claim.claim_id);
  assert.equal(approval.status, 200, await approval.clone().text());

  const issued = await api(`/api/claims/${claim.claim_id}/handover/code`, {
    method: "POST",
    token,
  });
  assert.equal(issued.status, 201);
  const code = (await issued.json()).code;
  const wrongCode = String((Number(code) + 1) % 100000000).padStart(8, "0");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await api(`/api/claims/${claim.claim_id}/handover/confirm`, {
      method: "POST",
      token: foundOwnerToken,
      body: JSON.stringify({ code: wrongCode }),
    });
    assert.equal(response.status, 400);
  }

  const rateLimited = await api(`/api/claims/${claim.claim_id}/handover/confirm`, {
    method: "POST",
    token: foundOwnerToken,
    body: JSON.stringify({ code }),
  });
  assert.equal(rateLimited.status, 429);

  const attempts = await pool.query(
    `SELECT COUNT(*)::int AS count FROM audit_logs
     WHERE actor_user_id = $1 AND entity_type = 'CLAIM' AND entity_id = $2
       AND action_type = 'HANDOVER_CODE_REJECTED'`,
    [foundOwnerId, claim.claim_id]
  );
  assert.equal(attempts.rows[0].count, 5);
});

test("concurrent handover confirmations complete exactly once", async () => {
  const matchId = await createClaimableMatch();
  const claim = await submitClaim(matchId);
  const approval = await approveClaim(claim.claim_id);
  assert.equal(approval.status, 200, await approval.clone().text());

  const issued = await api(`/api/claims/${claim.claim_id}/handover/code`, {
    method: "POST",
    token,
  });
  assert.equal(issued.status, 201);
  const code = (await issued.json()).code;

  const confirm = () => api(`/api/claims/${claim.claim_id}/handover/confirm`, {
    method: "POST",
    token: foundOwnerToken,
    body: JSON.stringify({ code }),
  });
  const responses = await Promise.all([confirm(), confirm()]);
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 409]);

  const audit = await pool.query(
    `SELECT action_type FROM audit_logs
     WHERE entity_type = 'CLAIM' AND entity_id = $1
       AND action_type = 'HANDOVER_COMPLETED'`,
    [claim.claim_id]
  );
  assert.equal(audit.rowCount, 1);
});
