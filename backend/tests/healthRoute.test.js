'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const pool = require('../src/config/db');
const app = require('../src/server');

async function startServer(t) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('health failure logs only sanitized diagnostics and keeps the response generic', async (t) => {
  const error = new Error('sensitive connection details');
  error.code = 'ECONNREFUSED';
  error.password = 'must-not-be-logged';
  const logged = [];

  t.mock.method(pool, 'query', async () => { throw error; });
  t.mock.method(console, 'error', (...args) => logged.push(args));

  const baseUrl = await startServer(t);
  const response = await fetch(baseUrl + '/api/health');

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    status: 'error',
    message: 'Database connection failed',
  });
  assert.deepEqual(logged, [[
    'Database health check failed.',
    { name: 'Error', code: 'ECONNREFUSED' },
  ]]);
});

test('health failure falls back to safe diagnostic values', async (t) => {
  const logged = [];
  t.mock.method(pool, 'query', async () => { throw {}; });
  t.mock.method(console, 'error', (...args) => logged.push(args));

  const baseUrl = await startServer(t);
  const response = await fetch(baseUrl + '/api/health');

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    status: 'error',
    message: 'Database connection failed',
  });
  assert.deepEqual(logged, [[
    'Database health check failed.',
    { name: 'Error', code: 'NO_CODE' },
  ]]);
});
