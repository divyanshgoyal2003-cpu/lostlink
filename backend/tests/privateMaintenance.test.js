'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { requirePruneIdentity, parseScopeMarker, buildCandidateManifest, assertManifestScope } = require('../src/storage/pruneSafety');
const { deleteReviewedCandidates, verifyBlobScope, assertDatabaseScope } = require('../scripts/prune-private-blob-orphans');
const { migrateRows, resolveSourceDirectories, validateSourceDirectories } = require('../scripts/migrate-local-private-files-to-blob');

const identity = { environment: 'preview', scopeId: 'lostlink-preview-a1', expectedDatabase: 'lostlink_preview', markerPath: 'lostlink/_cleanup-scope.json' };
const prefix = 'lostlink/item-photos/';
const object = { pathname: `${prefix}a3db4567-1111-4111-8111-abcdef123456.jpg`, uploadedAt: '2025-01-01T00:00:00.000Z', size: 12, etag: 'etag-1' };

test('prune requires environment, store scope, and exact database identity', () => {
  assert.throws(() => requirePruneIdentity({}), /PRIVATE_STORAGE_ENVIRONMENT/);
  assert.throws(() => requirePruneIdentity({ PRIVATE_STORAGE_ENVIRONMENT: 'preview' }), /PRIVATE_STORAGE_SCOPE_ID/);
  assert.deepEqual(requirePruneIdentity({ PRIVATE_STORAGE_ENVIRONMENT: 'preview', PRIVATE_STORAGE_SCOPE_ID: identity.scopeId, PRUNE_EXPECTED_DATABASE_NAME: identity.expectedDatabase }), identity);
});

test('a shared or wrong-environment Blob store marker is rejected', () => {
  assert.equal(parseScopeMarker(Buffer.from(JSON.stringify({ environment: 'preview', scopeId: identity.scopeId })), identity), true);
  assert.throws(() => parseScopeMarker(Buffer.from(JSON.stringify({ environment: 'production', scopeId: 'lostlink-production-a1' })), identity), /does not match/);
  assert.throws(() => parseScopeMarker(Buffer.from('not-json'), identity), /missing or invalid/);
});

test('prune verifies the private marker and exact configured database name', async () => {
  const bytes = Buffer.from(JSON.stringify({ environment: identity.environment, scopeId: identity.scopeId }));
  assert.equal(await verifyBlobScope(async (pathname, options) => {
    assert.equal(pathname, identity.markerPath); assert.deepEqual(options, { access: 'private' });
    return { statusCode: 200, stream: Readable.from([bytes]) };
  }, identity), true);
  await assert.rejects(verifyBlobScope(async () => ({ statusCode: 404, stream: null }), identity), /could not be verified/);
  await assertDatabaseScope({ query: async () => ({ rows: [{ database_name: identity.expectedDatabase }] }) }, identity.expectedDatabase);
  await assert.rejects(assertDatabaseScope({ query: async () => ({ rows: [{ database_name: 'lostlink_production' }] }) }, identity.expectedDatabase), /does not match/);
});

test('candidate manifest excludes current DB references and objects outside private namespaces', () => {
  const cutoff = Date.now();
  const manifest = buildCandidateManifest({
    identity,
    objects: [object, { ...object, pathname: 'lostlink/proof-attachments/another-key' }, { ...object, pathname: 'lostlink/production/item-photos/private.jpg' }],
    referencedKeys: new Set([object.pathname]),
    cutoff,
  });
  assert.equal(manifest.candidates.length, 0);
  const unreferenced = buildCandidateManifest({ identity, objects: [object], referencedKeys: new Set(), cutoff });
  assert.equal(unreferenced.candidates.length, 1);
  assert.equal(unreferenced.candidates[0].environment, 'preview');
  assert.equal(unreferenced.candidates[0].storageScope, identity.scopeId);
  assert.equal(unreferenced.candidates[0].objectKey, object.pathname);
  assert.throws(() => assertManifestScope({ ...unreferenced, environment: 'production' }, identity), /does not match/);
  assert.throws(() => assertManifestScope({ ...unreferenced, candidates: [{ ...unreferenced.candidates[0], objectKey: 'lostlink/production/secret' }] }, identity), /outside/);
});

function approvedManifest() {
  const manifest = buildCandidateManifest({ identity, objects: [object], referencedKeys: new Set(), cutoff: Date.now() });
  manifest.graceHours = 168;
  return manifest;
}

test('stale or changed candidate snapshots fail closed', async () => {
  let deletions = 0;
  const manifest = approvedManifest();
  const options = {
    manifest: { ...manifest, generatedAt: '2000-01-01T00:00:00.000Z' }, identity,
    verifyScope: async () => {}, assertDbScope: async () => {}, queryReference: async () => false,
    list: async () => ({ blobs: [object] }), del: async () => { deletions += 1; },
  };
  await assert.rejects(deleteReviewedCandidates(options), /older than 24 hours/);
  await assert.rejects(deleteReviewedCandidates({ ...options, manifest, list: async () => ({ blobs: [{ ...object, etag: 'changed' }] }) }), /changed since/);
  assert.equal(deletions, 0);
});

test('new references are rechecked immediately and are never deleted', async () => {
  let deletions = 0;
  const count = await deleteReviewedCandidates({
    manifest: approvedManifest(), identity,
    verifyScope: async () => {}, assertDbScope: async () => {}, queryReference: async () => true,
    list: async () => { throw new Error('must not list after reference found'); }, del: async () => { deletions += 1; },
  });
  assert.equal(count, 0);
  assert.equal(deletions, 0);
});

test('database or storage-scope recheck failures abort before deletion', async () => {
  let deletions = 0;
  const base = { manifest: approvedManifest(), identity, queryReference: async () => false, list: async () => ({ blobs: [object] }), del: async () => { deletions += 1; } };
  await assert.rejects(deleteReviewedCandidates({ ...base, verifyScope: async () => { throw new Error('scope changed'); }, assertDbScope: async () => {} }), /scope changed/);
  await assert.rejects(deleteReviewedCandidates({ ...base, verifyScope: async () => {}, assertDbScope: async () => { throw new Error('database unavailable'); } }), /database unavailable/);
  assert.equal(deletions, 0);
});

test('default and configured migration paths match app storage resolution', async () => {
  const defaults = resolveSourceDirectories({});
  assert.match(defaults.photos, /backend[\\/]private-photos$/);
  assert.match(defaults.proofs, /backend[\\/]private-proof-files$/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lostlink-migration-config-'));
  const previous = process.cwd();
  try {
    process.chdir(root);
    const configured = resolveSourceDirectories({ PRIVATE_PHOTO_DIR: '.data/photo-source', PRIVATE_PROOF_DIR: 'private/proof-source' });
    assert.equal(configured.photos, path.join(root, '.data', 'photo-source'));
    assert.equal(configured.proofs, path.join(root, 'private', 'proof-source'));
    await assert.rejects(validateSourceDirectories(configured), /source directory is missing/);
    await fs.mkdir(configured.photos, { recursive: true });
    await fs.mkdir(configured.proofs, { recursive: true });
    await validateSourceDirectories(configured);
    const fixture = Buffer.from('isolated fixture; never uploaded in dry run');
    const key = 'a3db4567-1111-4111-8111-abcdef123456.jpg';
    await fs.writeFile(path.join(configured.photos, key), fixture);
    assert.deepEqual(await migrateRows('item-photos', [{ storage_key: key }], configured.photos, false), { migrated: 1, skipped: 0 });
    assert.deepEqual(await fs.readFile(path.join(configured.photos, key)), fixture);
  } finally { process.chdir(previous); await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid production storage configuration is rejected before migration', () => {
  assert.throws(() => resolveSourceDirectories({ NODE_ENV: 'production', PRIVATE_STORAGE_DRIVER: 'local' }), /must use the private Blob provider/);
});
