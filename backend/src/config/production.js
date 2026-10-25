'use strict';

const crypto = require('node:crypto');

function isStrongSecret(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32 &&
    !/^change[-_ ]?me|example|your[_ -]?/i.test(value.trim());
}

function parseAllowedOrigins(env = process.env, isProduction = env.NODE_ENV === 'production') {
  const configured = String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (isProduction && configured.length === 0) throw new Error('ALLOWED_ORIGINS must contain at least one production frontend origin.');
  const origins = new Set(configured);
  if (!isProduction) {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }
  for (const origin of origins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('ALLOWED_ORIGINS contains an invalid origin.'); }
    if (parsed.origin !== origin || (isProduction && parsed.protocol !== 'https:')) {
      throw new Error('ALLOWED_ORIGINS entries must be origins only and production origins must use HTTPS.');
    }
  }
  return origins;
}

function validateProductionEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production') return { allowedOrigins: parseAllowedOrigins(env, false) };
  const errors = [];
  if (!isStrongSecret(env.JWT_SECRET)) errors.push('JWT_SECRET must contain at least 32 bytes of non-placeholder secret material.');
  if (!isStrongSecret(env.CUSTODY_CODE_HMAC_KEY)) errors.push('CUSTODY_CODE_HMAC_KEY must contain at least 32 bytes of non-placeholder secret material.');
  if (env.CUSTODY_CODE_TTL_MINUTES !== undefined &&
    (!Number.isInteger(Number(env.CUSTODY_CODE_TTL_MINUTES)) || Number(env.CUSTODY_CODE_TTL_MINUTES) < 1 || Number(env.CUSTODY_CODE_TTL_MINUTES) > 120)) {
    errors.push('CUSTODY_CODE_TTL_MINUTES must be an integer from 1 to 120.');
  }
  if (env.JWT_SECRET && env.CUSTODY_CODE_HMAC_KEY && crypto.timingSafeEqual(
    crypto.createHash('sha256').update(env.JWT_SECRET).digest(),
    crypto.createHash('sha256').update(env.CUSTODY_CODE_HMAC_KEY).digest(),
  )) errors.push('JWT_SECRET and CUSTODY_CODE_HMAC_KEY must be different.');
  if (!env.DATABASE_URL && !(env.DB_HOST && env.DB_NAME && env.DB_USER && env.DB_PASSWORD)) errors.push('Configure DATABASE_URL or DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD.');
  if (!env.BLOB_READ_WRITE_TOKEN) errors.push('BLOB_READ_WRITE_TOKEN is required for private file uploads.');
  try { parseAllowedOrigins(env, true); } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(`Production configuration is incomplete: ${errors.join(' ')}`);
  return { allowedOrigins: parseAllowedOrigins(env, true) };
}

module.exports = { isStrongSecret, parseAllowedOrigins, validateProductionEnvironment };
