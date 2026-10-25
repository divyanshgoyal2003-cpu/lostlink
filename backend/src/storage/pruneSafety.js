'use strict';

const crypto = require('node:crypto');
const { safeObjectName } = require('./privateObjectStore');

const NAMESPACES = new Set(['item-photos', 'proof-attachments']);

function requirePruneIdentity(env) {
  const environment = env.PRIVATE_STORAGE_ENVIRONMENT;
  const scopeId = env.PRIVATE_STORAGE_SCOPE_ID;
  const expectedDatabase = env.PRUNE_EXPECTED_DATABASE_NAME;
  if (!['preview', 'production'].includes(environment)) {
    throw new Error('Set PRIVATE_STORAGE_ENVIRONMENT to preview or production before pruning.');
  }
  if (typeof scopeId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(scopeId)) {
    throw new Error('Set a unique PRIVATE_STORAGE_SCOPE_ID for this private Blob store.');
  }
  if (typeof expectedDatabase !== 'string' || !/^[^\0\r\n]{1,63}$/.test(expectedDatabase)) {
    throw new Error('Set PRUNE_EXPECTED_DATABASE_NAME to the exact database name for this environment.');
  }
  return { environment, scopeId, expectedDatabase, markerPath: 'lostlink/_cleanup-scope.json' };
}

function parseScopeMarker(bytes, identity) {
  let marker;
  try { marker = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('Private Blob cleanup-scope marker is missing or invalid.'); }
  if (marker?.environment !== identity.environment || marker?.scopeId !== identity.scopeId) {
    throw new Error('Private Blob cleanup-scope marker does not match this environment and scope.');
  }
  return true;
}

function objectPrefix(namespace) {
  if (!NAMESPACES.has(namespace)) throw new Error('Invalid private object namespace.');
  return `lostlink/${namespace}/`;
}

function buildCandidateManifest({ identity, objects, referencedKeys, cutoff }) {
  const referenced = referencedKeys instanceof Set ? referencedKeys : new Set(referencedKeys);
  const candidates = [];
  for (const object of objects) {
    const namespace = object.pathname?.startsWith(objectPrefix('item-photos')) ? 'item-photos'
      : object.pathname?.startsWith(objectPrefix('proof-attachments')) ? 'proof-attachments' : null;
    if (!namespace) continue;
    const prefix = objectPrefix(namespace);
    const uploadedAt = new Date(object.uploadedAt).getTime();
    if (!object.pathname.startsWith(prefix) || !safeObjectName(object.pathname.slice(prefix.length)) || referenced.has(object.pathname) ||
        !Number.isFinite(uploadedAt) || uploadedAt > cutoff) continue;
    candidates.push({
      environment: identity.environment,
      storageScope: identity.scopeId,
      namespace,
      objectKey: object.pathname,
      uploadedAt: new Date(uploadedAt).toISOString(),
      size: Number.isFinite(Number(object.size)) ? Number(object.size) : null,
      etag: typeof object.etag === 'string' ? object.etag : null,
    });
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    environment: identity.environment,
    storageScope: identity.scopeId,
    expectedDatabase: identity.expectedDatabase,
    graceHours: 168,
    deletionEnabled: true,
    candidates,
  };
}

function manifestSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertManifestScope(manifest, identity) {
  if (!manifest || manifest.version !== 1 || manifest.environment !== identity.environment ||
      manifest.storageScope !== identity.scopeId || manifest.expectedDatabase !== identity.expectedDatabase ||
      !Array.isArray(manifest.candidates)) {
    throw new Error('Candidate manifest does not match the verified environment, storage scope, and database.');
  }
  for (const candidate of manifest.candidates) {
    const prefix = objectPrefix(candidate.namespace);
    if (candidate.environment !== identity.environment || candidate.storageScope !== identity.scopeId ||
        typeof candidate.objectKey !== 'string' || !candidate.objectKey.startsWith(prefix) ||
        !safeObjectName(candidate.objectKey.slice(prefix.length))) {
      throw new Error('Candidate manifest contains an object outside the approved environment scope.');
    }
  }
}

module.exports = { requirePruneIdentity, parseScopeMarker, objectPrefix, buildCandidateManifest, manifestSha256, assertManifestScope };
