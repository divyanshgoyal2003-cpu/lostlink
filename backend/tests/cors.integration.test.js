'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

process.env.NODE_ENV = 'test';
const app = require('../src/server');
const server = app.listen(0, '127.0.0.1');
let base;

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('CORS allows configured local origin and its authenticated API preflight', async () => {
  const response = await fetch(`${base}/api/auth/me`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const preflight = await fetch(`${base}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
});

test('CORS omits allow headers for an unlisted origin', async () => {
  const response = await fetch(`${base}/api/auth/me`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${base}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});
