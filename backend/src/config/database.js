'use strict';

function positiveInteger(value, name, fallback, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  return parsed;
}

function buildPoolConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const sslEnabled = production || env.DB_SSL === 'true';
  const ssl = sslEnabled ? {
    rejectUnauthorized: true,
    ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}),
  } : false;
  const common = {
    max: positiveInteger(env.DB_POOL_MAX, 'DB_POOL_MAX', production ? 3 : 10, 10),
    idleTimeoutMillis: positiveInteger(env.DB_IDLE_TIMEOUT_MS, 'DB_IDLE_TIMEOUT_MS', 10000, 120000),
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECT_TIMEOUT_MS, 'DB_CONNECT_TIMEOUT_MS', 5000, 60000),
    maxUses: positiveInteger(env.DB_POOL_MAX_USES, 'DB_POOL_MAX_USES', 7500, 1000000),
    keepAlive: true,
    statement_timeout: positiveInteger(env.DB_STATEMENT_TIMEOUT_MS, 'DB_STATEMENT_TIMEOUT_MS', 15000, 120000),
  };

  if (env.DATABASE_URL) {
    let parsed;
    try { parsed = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL is invalid.'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
    // The pg URL parser otherwise overrides the explicit, certificate-validating TLS config.
    for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
    return { ...common, connectionString: parsed.toString(), ...(ssl ? { ssl } : {}) };
  }

  if (!env.DB_HOST || !env.DB_NAME || !env.DB_USER || !env.DB_PASSWORD) {
    if (production) throw new Error('Configure DATABASE_URL or all DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD values.');
  }
  return {
    ...common,
    host: env.DB_HOST || 'localhost',
    port: positiveInteger(env.DB_PORT, 'DB_PORT', 5432, 65535),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ...(ssl ? { ssl } : {}),
  };
}

module.exports = { buildPoolConfig };
