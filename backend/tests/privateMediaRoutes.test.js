'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const clientUpload = require('../src/storage/clientUpload');

const ORIGINAL_ENV = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
const TEST_SECRET = 'isolated-private-media-test-jwt-secret-001';

function fixtureState() {
  return {
    photoShared: false,
    foundAuthorityId: null,
    roles: {},
    ownerAuthorized: true,
    callbackOwnerAuthorized: true,
    photoDuplicate: false,
    callbackDbFailure: false,
    proofCallbackDbFailure: false,
    proofRecipient: 20,
    proofContextClaimant: 20,
    proofDuplicate: false,
    invalidProof: false,
    proofContextCalls: 0,
    proofContextChangeAfter: null,
    dbFailure: false,
    storageFailure: false,
    callbackCount: 0,
    deleted: 0,
  };
}

function fakePool(state) {
  const response = (rows) => ({ rows, rowCount: rows.length });
  async function query(sql) {
    if (state.dbFailure) throw new Error('mock database failure');
    if (sql.includes('SELECT p.photo_id, p.storage_key')) return response([{ photo_id: 3, storage_key: 'a3db4567-1111-4111-8111-abcdef123456.jpg', found_report_id: 51, finder_id: 10, authority_id: state.foundAuthorityId }]);
    if (sql.includes('SELECT p.photo_id, p.photo_type')) return response([{ photo_id: 3, photo_type: 'FRONT', uploaded_at: '2026-01-01T00:00:00.000Z' }]);
    if (sql.includes('SELECT c.claimant_user_id, conv.conversation_status')) return response([{ claimant_user_id: 20, conversation_status: 'OPEN', authority_id: state.foundAuthorityId, shared: state.photoShared }]);
    if (sql.includes('SELECT a.storage_key,a.content_type')) return response([{ storage_key: 'a3db4567-1111-4111-8111-abcdef123456', content_type: 'application/pdf', byte_size: 15, claim_id: 9, requester_user_id: 10, recipient_user_id: state.proofRecipient }]);
    if (sql.includes('SELECT c.claim_id, c.claim_status')) return response([{ claim_id: 9, claim_status: 'APPROVED', claimant_user_id: state.proofContextClaimant, conversation_id: 7, conversation_status: 'OPEN', finder_id: 10, recovery_mode: 'DIRECT', authority_id: null, item_title: 'Private test item', custody_received: false }]);
    if (sql.includes('SELECT user_id, role, account_status')) return response([{ user_id: 20, role: 'USER', account_status: 'ACTIVE' }]);
    if (sql.includes('WHERE r.report_id=$1 AND r.user_id=$2')) return response(state.ownerAuthorized ? [{ ok: 1 }] : []);
    return response([]);
  }
  return {
    query,
    async connect() {
      return {
        async query(sql) {
          state.callbackCount += 1;
          if (state.dbFailure) throw new Error('mock database failure');
          if (state.proofCallbackDbFailure && sql === 'BEGIN') throw new Error('mock proof callback database failure');
          if (state.callbackDbFailure && sql.includes('SELECT r.item_id FROM reports')) throw new Error('mock callback database failure');
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return response([]);
          if (sql.includes('SELECT r.item_id FROM reports')) return response(state.callbackOwnerAuthorized ? [{ item_id: 77 }] : []);
          if (sql.includes('SELECT photo_id, storage_key FROM item_photos')) return response(state.photoDuplicate ? [{ photo_id: 3, storage_key: 'a3db4567-1111-4111-8111-abcdef123456.jpg' }] : []);
          if (sql.includes('SELECT r.request_status,r.recipient_user_id,v.claim_id')) return response([{ request_status: 'OPEN', recipient_user_id: state.proofRecipient, claim_id: 9 }]);
          if (sql.includes('SELECT c.claim_id, c.claim_status')) {
            state.proofContextCalls += 1;
            const claimantId = state.proofContextChangeAfter !== null && state.proofContextCalls > state.proofContextChangeAfter ? 22 : state.proofContextClaimant;
            return response([{ claim_id: 9, claim_status: 'APPROVED', claimant_user_id: claimantId, conversation_id: 7, conversation_status: 'OPEN', finder_id: 10, recovery_mode: 'DIRECT', authority_id: null, item_title: 'Private test item', custody_received: false }]);
          }
          if (sql.includes('SELECT user_id, role, account_status')) return response([{ user_id: 20, role: 'USER', account_status: 'ACTIVE' }]);
          if (sql.includes('FROM conversation_proof_requests r JOIN conversations v')) return response([{ proof_request_id: 12, request_status: 'OPEN', recipient_user_id: state.proofRecipient, requester_user_id: 10, claim_id: 9, conversation_id: 7 }]);
          if (sql.includes('SELECT 1 FROM conversation_proof_attachments WHERE storage_key')) return response(state.proofDuplicate ? [{ ok: 1 }] : []);
          if (sql.includes('COUNT(*)::int n FROM conversation_proof_attachments')) return { rows: [{ n: 0 }], rowCount: 1 };
          if (sql.includes('SELECT storage_key FROM conversation_proof_attachments WHERE proof_request_id')) return response([]);
          return response([]);
        },
        release() {},
      };
    },
  };
}

async function fakeHandleUpload(req, res, options) {
  const parsed = clientUpload.clientIntent(req);
  if (!parsed) return res.status(401).json({ error: 'Private upload could not be authorized or completed.' });
  try {
    const key = options.getObjectName(parsed.intent);
    const trusted = await options.authorize(parsed.userId, parsed.intent, key);
    if (!trusted) return res.status(403).json({ error: 'Private upload could not be authorized or completed.' });
    await options.onCompleted({ pathname: `lostlink/${options.namespace}/${key}`, contentType: parsed.intent.contentType }, { ...trusted, userId: parsed.userId, objectName: key });
    return res.status(200).json({ accepted: true });
  } catch {
    return res.status(500).json({ error: 'Private upload could not be authorized or completed.' });
  }
}

function loadRoutes(state) {
  const pool = fakePool(state);
  const storage = {
    async getPrivateObject(namespace) {
      if (state.storageFailure) throw new Error('mock storage failure');
      if (namespace === 'item-photos') return { bytes: Buffer.from('ffd8ffc00008080001000101ffda0002010203ffd9', 'hex'), contentType: 'image/jpeg' };
      if (state.invalidProof) return { bytes: Buffer.from('not a document'), contentType: 'application/pdf' };
      return { bytes: Buffer.from('%PDF-1.4\n%%EOF'), contentType: 'application/pdf' };
    },
    async getPrivateObjectStream(namespace) {
      if (state.storageFailure) throw new Error('mock storage failure');
      return { stream: Readable.from([Buffer.from(namespace)]), contentLength: namespace.length };
    },
    async deletePrivateObject() { state.deleted += 1; },
    async putPrivateObject() {},
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '../config/db') return pool;
    if (request === '../storage/privateObjectStore') return storage;
    if (request === '../storage/clientUpload') return { handlePrivateClientUpload: fakeHandleUpload, clientIntent: clientUpload.clientIntent };
    if (request === '../middleware/auth') return (req, res, next) => {
      const value = req.headers.authorization?.replace(/^Bearer\s+/, '');
      if (!/^\d+$/.test(value || '')) return res.status(401).json({ error: 'Authentication required.' });
      req.user = { userId: Number(value), role: 'USER' };
      return next();
    };
    if (request === '../notifications') return { createNotification: async () => null };
    if (request === '../authorityAccess') return {
      currentUser: async (_client, userId) => ({ user_id: userId, role: state.roles[userId] || 'USER', account_status: 'ACTIVE' }),
      hasActiveAuthorityMembership: async () => false,
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  let reportRouter;
  let conversationRouter;
  try {
    for (const filename of [require.resolve('../src/routes/reports'), require.resolve('../src/routes/conversations')]) delete require.cache[filename];
    reportRouter = require('../src/routes/reports');
    conversationRouter = require('../src/routes/conversations');
  } finally { Module._load = originalLoad; }
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportRouter);
  app.use('/api/conversations', conversationRouter);
  return app;
}

async function withApp(state, run) {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = TEST_SECRET;
  const server = http.createServer(loadRoutes(state));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
    if (ORIGINAL_ENV.JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = ORIGINAL_ENV.JWT_SECRET;
  }
}

function clientToken(payload, ttl = '5m') {
  return jwt.sign({ userId: payload.userId || 20, role: 'USER' }, TEST_SECRET, { expiresIn: ttl });
}

test('item photo retrieval requires authentication, the specific claim, and an active photo share', async () => {
  const state = fixtureState();
  await withApp(state, async (base) => {
    assert.equal((await fetch(`${base}/api/reports/photos/3?claimId=9`)).status, 401);
    assert.equal((await fetch(`${base}/api/reports/photos/3?claimId=8`, { headers: { authorization: 'Bearer 20' } })).status, 403);
    assert.equal((await fetch(`${base}/api/reports/photos/3?claimId=9`, { headers: { authorization: 'Bearer 21' } })).status, 403);
    const finder = await fetch(`${base}/api/reports/photos/3?reportId=51`, { headers: { authorization: 'Bearer 10' } });
    assert.equal(finder.status, 200);
    assert.equal((await fetch(`${base}/api/reports/photos/3?reportId=51`, { headers: { authorization: 'Bearer 11' } })).status, 403);
    const listing = await fetch(`${base}/api/reports/51/photos`, { headers: { authorization: 'Bearer 10' } });
    assert.equal(listing.status, 200);
    const listedBody = await listing.json();
    assert.equal(JSON.stringify(listedBody).includes('storage_key'), false);
    assert.equal(JSON.stringify(listedBody).includes('vercel-storage.com'), false);
    state.roles[30] = 'STAFF';
    assert.equal((await fetch(`${base}/api/reports/photos/3?claimId=9`, { headers: { authorization: 'Bearer 30' } })).status, 200);
    state.foundAuthorityId = 5;
    assert.equal((await fetch(`${base}/api/reports/photos/3?claimId=9`, { headers: { authorization: 'Bearer 30' } })).status, 403);
    state.photoShared = true;
    const allowed = await fetch(`${base}/api/reports/photos/3?claimId=9`, { headers: { authorization: 'Bearer 20' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
    assert.equal(allowed.headers.get('content-type'), 'image/jpeg');
  });
});

test('proof retrieval is limited to open-case participants and does not inherit photo sharing', async () => {
  const state = fixtureState();
  await withApp(state, async (base) => {
    assert.equal((await fetch(`${base}/api/conversations/proof-attachments/4/content`)).status, 401);
    const claimant = await fetch(`${base}/api/conversations/proof-attachments/4/content`, { headers: { authorization: 'Bearer 20' } });
    assert.equal(claimant.status, 200);
    assert.equal(claimant.headers.get('cache-control'), 'private, no-store');
    state.proofRecipient = 22; state.proofContextClaimant = 22;
    assert.equal((await fetch(`${base}/api/conversations/proof-attachments/4/content`, { headers: { authorization: 'Bearer 20' } })).status, 403);
  });
});

test('found-photo upload callback reauthorizes the report owner and rejects expired or invalid tokens', async () => {
  const state = fixtureState();
  await withApp(state, async (base) => {
    const intent = { reportId: '51', photoType: 'FRONT', storageKey: 'a3db4567-1111-4111-8111-abcdef123456.jpg', contentType: 'image/jpeg' };
    const payload = (token) => ({ type: 'blob.generate-client-token', payload: JSON.stringify({ ...intent, token }) });
    const token = clientToken({ userId: 20 });
    state.ownerAuthorized = false;
    const rejectedOwner = await fetch(`${base}/api/reports/51/photos/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(token)) });
    assert.equal(rejectedOwner.status, 403);
    state.ownerAuthorized = true; state.callbackOwnerAuthorized = false;
    const stale = await fetch(`${base}/api/reports/51/photos/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(token)) });
    assert.equal(stale.status, 500);
    assert.equal(state.deleted, 1);
    state.callbackOwnerAuthorized = true; state.photoDuplicate = true;
    assert.equal((await fetch(`${base}/api/reports/51/photos/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(token)) })).status, 200);
    state.photoDuplicate = false; state.callbackDbFailure = true;
    assert.equal((await fetch(`${base}/api/reports/51/photos/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(token)) })).status, 500);
    assert.equal(state.deleted, 2);
    state.callbackDbFailure = false;
    const expired = await fetch(`${base}/api/reports/51/photos/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(clientToken({ userId: 20 }, '-1s'))) });
    assert.equal(expired.status, 401);
    const invalid = await fetch(`${base}/api/reports/51/photos/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'blob.generate-client-token', payload: '{' }) });
    assert.equal(invalid.status, 401);
  });
});

test('claimant proof uploads reauthorize the participant at callback time and are idempotent', async () => {
  const state = fixtureState();
  await withApp(state, async (base) => {
    const intent = { requestId: '12', storageKey: 'a3db4567-1111-4111-8111-abcdef123456', contentType: 'application/pdf', note: 'Receipt' };
    const token = clientToken({ userId: 20 });
    const sendToken = (clientTokenValue) => fetch(`${base}/api/conversations/proof-requests/12/attachments/client-upload`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'blob.generate-client-token', payload: JSON.stringify({ ...intent, token: clientTokenValue }) }),
    });
    assert.equal((await sendToken(clientToken({ userId: 20 }, '-1s'))).status, 401);
    assert.equal((await fetch(`${base}/api/conversations/proof-requests/12/attachments/client-upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'blob.generate-client-token', payload: '{' }) })).status, 401);
    const send = () => sendToken(token);
    assert.equal((await send()).status, 200);
    state.proofDuplicate = true;
    assert.equal((await send()).status, 200);
    state.proofDuplicate = false; state.proofRecipient = 22;
    assert.equal((await send()).status, 403);
    state.proofRecipient = 20;

    state.proofDuplicate = false; state.proofContextCalls = 0; state.proofContextChangeAfter = 2;
    assert.equal((await send()).status, 500);
    assert.equal(state.deleted, 1);

    state.proofContextCalls = 0; state.proofContextChangeAfter = null; state.invalidProof = true;
    assert.equal((await send()).status, 500);
    assert.equal(state.deleted, 2);

    state.invalidProof = false; state.storageFailure = true;
    assert.equal((await send()).status, 500);
    // A provider outage may leave a private unreferenced Blob; cleanup is intentionally deferred.
    assert.equal(state.deleted, 2);
    state.storageFailure = false; state.proofCallbackDbFailure = true;
    assert.equal((await send()).status, 500);
    assert.equal(state.deleted, 3);
  });
});

test('private media handlers fail safely when database or storage is unavailable', async () => {
  const state = fixtureState();
  await withApp(state, async (base) => {
    state.dbFailure = true;
    assert.equal((await fetch(`${base}/api/reports/photos/3?reportId=51`, { headers: { authorization: 'Bearer 10' } })).status, 500);
    state.dbFailure = false; state.storageFailure = true; state.photoShared = true;
    const failed = await fetch(`${base}/api/reports/photos/3?claimId=9`, { headers: { authorization: 'Bearer 20' } });
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error, 'Unable to retrieve photo');
    state.storageFailure = false; state.dbFailure = true;
    const proofFailed = await fetch(`${base}/api/conversations/proof-attachments/4/content`, { headers: { authorization: 'Bearer 20' } });
    assert.equal(proofFailed.status, 404);
    assert.equal((await proofFailed.json()).error, 'Attachment unavailable');
    state.dbFailure = false; state.storageFailure = true;
    const blobFailed = await fetch(`${base}/api/conversations/proof-attachments/4/content`, { headers: { authorization: 'Bearer 20' } });
    assert.equal(blobFailed.status, 404);
    assert.equal((await blobFailed.json()).error, 'Attachment unavailable');
  });
});
