
require("dotenv").config();

// Force this test process to use the isolated database.
process.env.DB_NAME = "lostlink_test";

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

let foundOwnerId;
let foundOwnerEmail;

const reportIds = [];
const itemIds = [];
const matchIds = [];
const claimIds = [];

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.token
      ? { Authorization: `Bearer ${options.token}` }
      : {}),
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

async function createMatch(lostReportId, foundReportId, status = "CANDIDATE") {
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
     VALUES ($1, $2, 90, 100, 90, 80, 90, '{}'::jsonb, $3)
     RETURNING match_id`,
    [lostReportId, foundReportId, status]
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

afterEach(async () => {
  // Delete claims before matches because claims reference match_records.
  if (matchIds.length > 0) {
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

  assert.ok(token, "Registration should return a JWT");
});

after(async () => {
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (userId !== undefined || foundOwnerId !== undefined) {
      await pool.query(
        `DELETE FROM users
         WHERE user_id = ANY($1::bigint[])
           AND email = ANY($2::text[])`,
        [
          [userId, foundOwnerId].filter((id) => id !== undefined),
          [userEmail, foundOwnerEmail].filter(Boolean),
        ]
      );
    }
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
