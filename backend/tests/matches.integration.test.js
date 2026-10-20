
require("dotenv").config();

// Force this test process to use the isolated database.
// This does not modify backend/.env.
process.env.DB_NAME = "lostlink_test";

const assert = require("node:assert/strict");
const { before, after, afterEach, test } = require("node:test");

const pool = require("../src/config/db");
const app = require("../src/server");

let server;
let baseUrl;
let token;
let userId;

const reportIds = [];
const itemIds = [];

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.authenticated && token
      ? { Authorization: `Bearer ${token}` }
      : {}),
    ...options.headers,
  };

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
}

before(async () => {
  // Fail closed before creating any test data if the DB is wrong.
  const result = await pool.query(
    "SELECT current_database() AS database_name"
  );

  assert.equal(
    result.rows[0].database_name,
    "lostlink_test",
    "Safety check failed: integration tests must use lostlink_test"
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

  const registration = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "LostLink Integration Test",
      email: `lostlink-test-${process.pid}-${Date.now()}@example.test`,
      password: "Integration-Test-Password-123",
    }),
  });

  const registrationText = await registration.text();

  assert.equal(
    registration.status,
    201,
    `Test account registration failed: ${registrationText}`
  );

  const registrationBody = JSON.parse(registrationText);
  token = registrationBody.token;
  userId = registrationBody.user.user_id;

  assert.ok(token, "Registration should return a JWT");
});

async function createReport({
  reportType,
  title,
  brand,
  model,
  color = "Black",
}) {
  const attributes = {};

  if (brand !== undefined && brand !== null && brand !== "") {
    attributes.brand = brand;
  }

  if (model !== undefined && model !== null && model !== "") {
    attributes.model = model;
  }

  const itemResult = await pool.query(
    `INSERT INTO items
       (category, title, description, color, attributes_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING item_id`,
    [
      "ELECTRONICS",
      title,
      "Integration test item",
      color,
      JSON.stringify(attributes),
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
       $1, $2, $3, NOW(),
       ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
       100, 'MAP_PIN', 'Integration test location'
     )
     RETURNING report_id`,
    [userId, itemId, reportType, 79.16, 12.97]
  );

  const reportId = reportResult.rows[0].report_id;
  reportIds.push(reportId);

  return reportId;
}

async function createReportViaApi(overrides = {}) {
  const payload = {
    category: "ELECTRONICS",
    title: "Sony wireless headphones",
    description: "Integration test report",
    color: "Black",
    company: "Sony",
    attributes: {
      model: "WH-1000XM5",
    },
    reportType: "LOST",
    reportTime: new Date().toISOString(),
    latitude: 12.97,
    longitude: 79.16,
    locationSource: "MAP_PIN",
    ...overrides,
  };

  return api("/api/reports", {
    method: "POST",
    authenticated: true,
    body: JSON.stringify(payload),
  });
}

afterEach(async () => {
  if (reportIds.length > 0) {
    await pool.query(
      `DELETE FROM match_records
       WHERE lost_report_id = ANY($1::bigint[])
          OR found_report_id = ANY($1::bigint[])`,
      [reportIds]
    );

    await pool.query(
      "DELETE FROM reports WHERE report_id = ANY($1::bigint[])",
      [reportIds]
    );
  }

  if (itemIds.length > 0) {
    await pool.query(
      "DELETE FROM items WHERE item_id = ANY($1::bigint[])",
      [itemIds]
    );
  }

  reportIds.length = 0;
  itemIds.length = 0;
});

after(async () => {
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (userId !== undefined) {
      await pool.query("DELETE FROM users WHERE user_id = $1", [userId]);
    }
  } finally {
    await pool.end();
  }
});

test("GET /api/matches rejects requests without authentication", async () => {
  const response = await api("/api/matches");

  assert.equal(response.status, 401);
});

test("production SQL rejects mismatched brands and scores identical models", async () => {
  await createReport({
    reportType: "LOST",
    title: "Sony Bluetooth headphones",
    brand: "Sony",
    model: "WH-1000XM5",
  });

  await createReport({
    reportType: "FOUND",
    title: "Sony Bluetooth headphones",
    brand: "Sony",
    model: "WH-1000XM5",
  });

  // This found item must be rejected because both brands are known
  // and incompatible, even though the model happens to be the same.
  await createReport({
    reportType: "FOUND",
    title: "JBL Bluetooth headphones",
    brand: "JBL",
    model: "WH-1000XM5",
  });

  const response = await api("/api/matches", {
    authenticated: true,
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.count, 1);
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].modelScore, 100);
});

test("different known models remain candidates with a model score of zero", async () => {
  await createReport({
    reportType: "LOST",
    title: "Sony Bluetooth headphones",
    brand: "Sony",
    model: "WH-1000XM5",
  });

  await createReport({
    reportType: "FOUND",
    title: "Sony Bluetooth headphones",
    brand: "Sony",
    model: "WH-1000XM4",
  });

  const response = await api("/api/matches", {
    authenticated: true,
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.count, 1);
  assert.equal(body.matches[0].modelScore, 0);
});

test("unknown brands and models remain eligible with a neutral model score", async () => {
  await createReport({
    reportType: "LOST",
    title: "Bluetooth headphones",
    brand: "Sony",
  });

  await createReport({
    reportType: "FOUND",
    title: "Bluetooth headphones",
  });

  const response = await api("/api/matches", {
    authenticated: true,
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.count, 1);
  assert.equal(body.matches[0].modelScore, 50);
});

test("POST /api/matches/refresh persists the production model score", async () => {
  const lostReportId = await createReport({
    reportType: "LOST",
    title: "Sony Bluetooth headphones",
    brand: "Sony",
    model: "WH-1000XM5",
  });

  const foundReportId = await createReport({
    reportType: "FOUND",
    title: "Sony Bluetooth headphones",
    brand: "Sony",
    model: "WH-1000XM5",
  });

  const response = await api("/api/matches/refresh", {
    method: "POST",
    authenticated: true,
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.candidatesFound, 1);
  assert.equal(body.insertedOrUpdated, 1);

  const persisted = await pool.query(
    `SELECT match_status, score_breakdown->>'model_score' AS model_score
     FROM match_records
     WHERE lost_report_id = $1 AND found_report_id = $2`,
    [lostReportId, foundReportId]
  );

  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].match_status, "CANDIDATE");
  assert.equal(persisted.rows[0].model_score, "100");
});
test("electronics reports reject a missing model", async () => {
  const response = await createReportViaApi({
    attributes: {},
  });

  assert.equal(response.status, 400);

  const body = await response.json();
  assert.match(body.error, /model is required/i);
});

test("electronics reports reject a blank model", async () => {
  const response = await createReportViaApi({
    attributes: {
      model: "   ",
    },
  });

  assert.equal(response.status, 400);
});

test("electronics model is stored in attributes_json", async () => {
  const response = await createReportViaApi();

  const body = await response.json();

  assert.equal(response.status, 201);

  itemIds.push(body.item.item_id);
  reportIds.push(body.report.report_id);

  const result = await pool.query(
    `SELECT attributes_json->>'model' AS model
     FROM items
     WHERE item_id = $1`,
    [body.item.item_id]
  );

  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].model, "WH-1000XM5");
});

test("non-electronics reports do not require a model", async () => {
  const response = await createReportViaApi({
    category: "BAGS",
    title: "Black backpack",
    attributes: {},
  });

  const body = await response.json();

  assert.equal(response.status, 201);

  itemIds.push(body.item.item_id);
  reportIds.push(body.report.report_id);
});