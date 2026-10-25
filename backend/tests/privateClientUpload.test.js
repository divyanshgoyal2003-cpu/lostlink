'use strict';

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { test } = require('node:test');
const { handlePrivateClientUpload, clientIntent } = require('../src/storage/clientUpload');

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('private client upload requires a valid authenticated token and scoped pathname', async () => {
  const previous = { node: process.env.NODE_ENV, jwt: process.env.JWT_SECRET };
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'test-jwt-secret-with-at-least-thirty-two-bytes';
  try {
    const token = jwt.sign({ userId: 17, role: 'USER' }, process.env.JWT_SECRET);
    const payload = { token, reportId: '51', photoType: 'FRONT', storageKey: 'a3db4567-1111-4111-8111-abcdef123456.jpg', contentType: 'image/jpeg' };
    const req = { body: { type: 'blob.generate-client-token', payload: JSON.stringify(payload) } };
    assert.equal(clientIntent(req).userId, 17);
    assert.equal(clientIntent({ body: { type: 'blob.generate-client-token', payload: JSON.stringify({ ...payload, token: 'invalid' }) } }), null);

    const response = fakeResponse();
    let authorized = false;
    let completed = false;
    const result = await handlePrivateClientUpload(req, response, {
      namespace: 'item-photos',
      allowedContentTypes: ['image/jpeg'],
      maximumSizeInBytes: 8 * 1024 * 1024,
      getObjectName: (value) => value.storageKey,
      authorize: async (userId) => { authorized = userId === 17; return authorized ? { reportId: 51, photoType: 'FRONT' } : null; },
      onCompleted: async (_blob, trusted) => { completed = trusted.userId === 17 && trusted.reportId === 51; },
      handleUpload: async ({ onBeforeGenerateToken, onUploadCompleted }) => {
        const scope = await onBeforeGenerateToken('lostlink/item-photos/a3db4567-1111-4111-8111-abcdef123456.jpg', JSON.stringify(payload));
        assert.deepEqual(scope.allowedContentTypes, ['image/jpeg']);
        assert.equal(scope.maximumSizeInBytes, 8 * 1024 * 1024);
        assert.ok(scope.validUntil > Date.now());
        const trusted = JSON.parse(scope.tokenPayload);
        assert.equal(trusted.userId, 17);
        await onUploadCompleted({ blob: { pathname: 'lostlink/item-photos/a3db4567-1111-4111-8111-abcdef123456.jpg' }, tokenPayload: scope.tokenPayload });
        return { type: 'blob.generate-client-token', clientToken: 'short-lived-test-token' };
      },
    });
    assert.equal(result, response);
    assert.equal(authorized, true);
    assert.equal(completed, true);
    assert.equal(JSON.stringify(response.body).includes('blob.vercel-storage.com'), false);
    assert.equal(JSON.stringify(response.body).includes('storageKey'), false);
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
    if (previous.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.jwt;
  }
});

test('unauthorized upload token requests fail closed without issuing a capability', async () => {
  const previousNode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const response = fakeResponse();
    const result = await handlePrivateClientUpload({ body: { type: 'blob.generate-client-token', payload: '{}' } }, response, {
      namespace: 'proof-attachments',
      allowedContentTypes: ['application/pdf'],
      maximumSizeInBytes: 100,
      getObjectName: (value) => value.storageKey,
      authorize: async () => { throw new Error('must not authorize'); },
      onCompleted: async () => {},
      handleUpload: async () => { throw new Error('must not issue upload token'); },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.stringify(response.body).includes('must not'), false);
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
  }
});
