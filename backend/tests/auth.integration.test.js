require("dotenv").config();
process.env.DB_NAME = "lostlink_test";

const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const app = require("../src/server");

let server;
let baseUrl;
let account;

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  };
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

before(async () => {
  const database = await pool.query("SELECT current_database() AS name");
  assert.equal(database.rows[0].name, "lostlink_test", "Authentication tests must use lostlink_test");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `auth-${suffix}@example.test`;
  const response = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Authentication integration user",
      email,
      password: "Auth-Integration-Password-123",
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(Object.hasOwn(body.user, "password_hash"), false);
  account = { id: Number(body.user.user_id), token: body.token, email };
  assert.ok(Number.isSafeInteger(account.id));
});

after(async () => {
  if (account?.id) {
    await pool.query("DELETE FROM notifications WHERE user_id=$1", [account.id]);
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [account.id]);
    await pool.query("DELETE FROM users WHERE user_id=$1", [account.id]);
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
});

test("protected routes reject missing, malformed, and expired bearer credentials", async () => {
  assert.equal((await api("/api/auth/me")).status, 401);
  assert.equal((await api("/api/auth/me", { headers: { Authorization: "Bearer malformed" } })).status, 401);
  assert.equal((await api("/api/auth/me", { headers: { Authorization: "Bearer " } })).status, 401);
  const expired = jwt.sign({ userId: account.id, role: "USER" }, process.env.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await api("/api/auth/me", { token: expired })).status, 401);
});

test("suspended accounts lose access before their JWT expires", async () => {
  await pool.query("UPDATE users SET account_status='SUSPENDED' WHERE user_id=$1", [account.id]);
  try {
    assert.equal((await api("/api/reports/mine", { token: account.token })).status, 401);
    assert.equal((await api("/api/notifications", { token: account.token })).status, 401);
  } finally {
    await pool.query("UPDATE users SET account_status='ACTIVE' WHERE user_id=$1", [account.id]);
  }
});

test("authorization uses the current database role, not a stale JWT role", async () => {
  await pool.query("UPDATE users SET role='USER' WHERE user_id=$1", [account.id]);
  const staleAdminToken = jwt.sign({ userId: account.id, role: "ADMIN" }, process.env.JWT_SECRET, { expiresIn: "2h" });
  const identity = await api("/api/auth/me", { token: staleAdminToken });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).user.role, "USER");
  assert.equal((await api("/api/authorities/admin/queue", { token: staleAdminToken })).status, 403);
});

test("registration and login responses do not expose password hashes", async () => {
  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: account.email, password: "Auth-Integration-Password-123" }),
  });
  const body = await login.json();
  assert.equal(login.status, 200);
  assert.equal(Object.hasOwn(body.user, "password_hash"), false);
  assert.equal(JSON.stringify(body).includes("Auth-Integration-Password-123"), false);
});

test("oversized conversation and authority identifiers are rejected as client errors", async () => {
  const tooLarge = "9007199254740992";
  assert.equal((await api(`/api/conversations/claims/${tooLarge}`, { token: account.token })).status, 400);
  assert.equal((await api(`/api/authorities/cases/${tooLarge}`, { token: account.token })).status, 400);
});
