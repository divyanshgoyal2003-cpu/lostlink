'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = require('../src/config/db');
const { storageDriver } = require('../src/storage/privateObjectStore');
const {
  requirePruneIdentity, parseScopeMarker, objectPrefix, buildCandidateManifest,
  manifestSha256, assertManifestScope,
} = require('../src/storage/pruneSafety');

const GRACE_HOURS = 168;

async function listAll(list, prefix) {
  const result = [];
  let cursor;
  do {
    const page = await list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    result.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return result;
}

async function verifyBlobScope(get, identity) {
  const response = await get(identity.markerPath, { access: 'private' });
  if (!response || response.statusCode !== 200 || !response.stream) {
    throw new Error('Private Blob cleanup-scope marker could not be verified. No cleanup was performed.');
  }
  const chunks = [];
  for await (const chunk of response.stream) chunks.push(Buffer.from(chunk));
  return parseScopeMarker(Buffer.concat(chunks), identity);
}

async function assertDatabaseScope(client, expectedDatabase) {
  const result = await client.query('SELECT current_database() AS database_name');
  if (result.rows?.[0]?.database_name !== expectedDatabase) {
    throw new Error('Connected database does not match PRUNE_EXPECTED_DATABASE_NAME. No cleanup was performed.');
  }
}

async function writeManifest(manifest, requestedPath) {
  const destination = path.resolve(requestedPath || path.join(os.tmpdir(), `lostlink-prune-${manifest.environment}-${Date.now()}.json`));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  return { destination, hash: manifestSha256(bytes) };
}

async function deleteReviewedCandidates({ manifest, identity, now = Date.now(), verifyScope, assertDbScope, queryReference, list, del }) {
  assertManifestScope(manifest, identity);
  const generatedAt = Date.parse(manifest.generatedAt);
  if (!Number.isFinite(generatedAt) || now - generatedAt > 24 * 60 * 60 * 1000) {
    throw new Error('Candidate manifest is invalid or older than 24 hours. Generate and review a fresh manifest.');
  }
  if (manifest.graceHours < GRACE_HOURS || !manifest.deletionEnabled) throw new Error('Candidate manifest does not meet the cleanup policy.');
  let deleted = 0;
  for (const candidate of manifest.candidates) {
    const prefix = objectPrefix(candidate.namespace);
    await verifyScope();
    await assertDbScope();
    const reference = await queryReference(candidate.namespace, candidate.objectKey.slice(prefix.length));
    if (reference) continue;
    const fresh = await list({ prefix: candidate.objectKey, limit: 2 });
    const exact = fresh.blobs.find((blob) => blob.pathname === candidate.objectKey);
    if (!exact || !Number.isFinite(Date.parse(candidate.uploadedAt)) ||
        new Date(exact.uploadedAt).toISOString() !== new Date(candidate.uploadedAt).toISOString() ||
        (candidate.size !== null && Number(exact.size) !== candidate.size) ||
        (candidate.etag && exact.etag !== candidate.etag)) {
      throw new Error('Candidate object changed since the manifest was reviewed. No further deletion was performed.');
    }
    await del(candidate.objectKey);
    deleted += 1;
  }
  return deleted;
}

function optionValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const database = dependencies.pool || pool;
  const useStorage = dependencies.storage || await import('@vercel/blob');
  if (storageDriver() !== 'blob') throw new Error('Private Blob storage must be configured.');
  const identity = requirePruneIdentity(process.env);
  await verifyBlobScope(useStorage.get, identity);
  await assertDatabaseScope(database, identity.expectedDatabase);

  if (argv.includes('--execute')) {
    const manifestPath = optionValue(argv, 'manifest');
    const suppliedHash = optionValue(argv, 'confirm-manifest-sha256');
    if (optionValue(argv, 'confirm-environment') !== identity.environment ||
        optionValue(argv, 'confirm-storage-scope') !== identity.scopeId || !manifestPath || !suppliedHash) {
      throw new Error('Deletion requires --manifest, --confirm-environment, --confirm-storage-scope, and --confirm-manifest-sha256.');
    }
    const raw = await fs.readFile(manifestPath);
    if (manifestSha256(raw) !== suppliedHash.toLowerCase()) throw new Error('Candidate manifest hash confirmation does not match.');
    const manifest = JSON.parse(raw.toString('utf8'));
    const deleted = await deleteReviewedCandidates({
      manifest, identity,
      verifyScope: () => verifyBlobScope(useStorage.get, identity),
      assertDbScope: () => assertDatabaseScope(database, identity.expectedDatabase),
      queryReference: async (namespace, key) => {
        const table = namespace === 'item-photos' ? 'item_photos' : 'conversation_proof_attachments';
        const result = await database.query(`SELECT 1 FROM ${table} WHERE storage_key=$1 LIMIT 1`, [key]);
        return result.rowCount > 0;
      },
      list: useStorage.list,
      del: useStorage.del,
    });
    console.log(`Deleted ${deleted} reviewed, still-unreferenced objects from the verified ${identity.environment} storage scope.`);
    return;
  }

  if (argv.some((arg) => arg.startsWith('--confirm-'))) throw new Error('Confirmation flags are only valid with --execute.');
  const [photos, proofs, photoObjects, proofObjects] = await Promise.all([
    database.query('SELECT storage_key FROM item_photos'),
    database.query('SELECT storage_key FROM conversation_proof_attachments'),
    listAll(useStorage.list, objectPrefix('item-photos')),
    listAll(useStorage.list, objectPrefix('proof-attachments')),
  ]);
  const referenced = new Set([
    ...photos.rows.map((row) => `lostlink/item-photos/${String(row.storage_key)}`),
    ...proofs.rows.map((row) => `lostlink/proof-attachments/${String(row.storage_key)}`),
  ]);
  const cutoff = Date.now() - GRACE_HOURS * 60 * 60 * 1000;
  const manifest = buildCandidateManifest({ identity, objects: [...photoObjects, ...proofObjects], referencedKeys: referenced, cutoff });
  manifest.graceHours = GRACE_HOURS;
  const { destination, hash } = await writeManifest(manifest, optionValue(argv, 'manifest'));
  console.log(`Dry run complete for ${identity.environment} storage scope ${identity.scopeId}. Candidate manifest: ${destination}`);
  console.log(`${manifest.candidates.length} candidate(s); no objects were deleted. Manifest SHA-256: ${hash}`);
}

if (require.main === module) {
  main().catch(() => {
    console.error('Private object cleanup stopped. No application database rows or local files were changed. Check environment, scope marker, database identity, and manifest confirmation.');
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { main, listAll, verifyBlobScope, assertDatabaseScope, writeManifest, optionValue, deleteReviewedCandidates };
