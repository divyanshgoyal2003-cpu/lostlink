'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPoolConfig } = require('../src/config/database');
const { parseAllowedOrigins, validateProductionEnvironment } = require('../src/config/production');
const { storageDriver, safeObjectName, blobPath } = require('../src/storage/privateObjectStore');

const validProduction = {
  NODE_ENV: 'production',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  CUSTODY_CODE_HMAC_KEY: 'fedcba9876543210fedcba9876543210',
  DATABASE_URL: 'postgresql://app:secret@db.example.test:5432/lostlink?sslmode=require&application_name=lostlink',
  BLOB_READ_WRITE_TOKEN: 'private-token-placeholder-for-tests',
  ALLOWED_ORIGINS: 'https://lostlink.example.test',
};

test('production secrets and exact HTTPS origin are required without exposing values', () => {
  const result = validateProductionEnvironment(validProduction);
  assert.deepEqual([...result.allowedOrigins], ['https://lostlink.example.test']);
  assert.throws(() => validateProductionEnvironment({ ...validProduction, JWT_SECRET: '' }), /JWT_SECRET/);
  assert.throws(() => validateProductionEnvironment({ ...validProduction, CUSTODY_CODE_HMAC_KEY: '' }), /CUSTODY_CODE_HMAC_KEY/);
  assert.throws(() => validateProductionEnvironment({ ...validProduction, CUSTODY_CODE_HMAC_KEY: validProduction.JWT_SECRET }), /must be different/);
  assert.throws(() => validateProductionEnvironment({ ...validProduction, CUSTODY_CODE_TTL_MINUTES: '0' }), /CUSTODY_CODE_TTL_MINUTES/);
  assert.throws(() => validateProductionEnvironment({ ...validProduction, ALLOWED_ORIGINS: 'http://lostlink.example.test' }), /HTTPS/);
  assert.throws(() => validateProductionEnvironment({ ...validProduction, BLOB_READ_WRITE_TOKEN: '' }), /BLOB_READ_WRITE_TOKEN/);
});

test('CORS allowlist is exact and local development origins remain available', () => {
  assert.throws(() => parseAllowedOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.test/path' }, true), /origins only/);
  const local = parseAllowedOrigins({ NODE_ENV: 'development', ALLOWED_ORIGINS: 'http://localhost:4000' }, false);
  assert.ok(local.has('http://localhost:5173'));
  assert.ok(local.has('http://localhost:4000'));
});

test('DATABASE_URL takes precedence and production TLS verifies certificates', () => {
  const config = buildPoolConfig({ ...validProduction, DB_HOST: 'ignored.example', DB_POOL_MAX: '9' });
  assert.equal(config.max, 9);
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
  assert.equal(new URL(config.connectionString).searchParams.get('application_name'), 'lostlink');
  assert.equal(Object.hasOwn(config, 'password'), false);
});

test('individual database variables work locally and production refuses incomplete settings', () => {
  const config = buildPoolConfig({ NODE_ENV: 'development', DB_HOST: 'localhost', DB_NAME: 'lostlink', DB_USER: 'app', DB_PASSWORD: 'secret' });
  assert.equal(config.host, 'localhost');
  assert.equal(config.ssl, undefined);
  assert.throws(() => buildPoolConfig({ NODE_ENV: 'production', DB_HOST: 'db.example', DB_NAME: 'lostlink', DB_USER: 'app' }), /Configure DATABASE_URL/);
});

test('private storage fails closed in production and object names cannot escape storage roots', () => {
  assert.equal(storageDriver({ NODE_ENV: 'production' }), 'blob');
  assert.throws(() => storageDriver({ NODE_ENV: 'production', PRIVATE_STORAGE_DRIVER: 'local' }), /must use the private Blob provider/);
  assert.equal(safeObjectName('a3db4567-1111-4111-8111-abcdef123456.jpg'), true);
  assert.equal(safeObjectName('../secret'), false);
  assert.equal(blobPath('item-photos', 'a3db4567-1111-4111-8111-abcdef123456.jpg'), 'lostlink/item-photos/a3db4567-1111-4111-8111-abcdef123456.jpg');
});
