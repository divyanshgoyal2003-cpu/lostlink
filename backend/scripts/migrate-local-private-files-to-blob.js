'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = require('../src/config/db');
const { storageDriver, safeObjectName, putPrivateObject, getPrivateObject, configuredLocalRoots } = require('../src/storage/privateObjectStore');

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function migrateRows(namespace, rows, sourceDir, execute) {
  const resolvedRoot = await fs.realpath(sourceDir);
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const key = String(row.storage_key);
    if (!safeObjectName(key)) throw new Error('A database file reference is not a supported key. No source files were changed.');
    const source = path.resolve(resolvedRoot, key);
    if (path.dirname(source) !== resolvedRoot) throw new Error('A file reference resolved outside its private source directory.');
    const actualSource = await fs.realpath(source);
    if (path.dirname(actualSource) !== resolvedRoot) throw new Error('A local file resolves outside its configured private source directory.');
    const bytes = await fs.readFile(actualSource);
    const expectedType = namespace === 'item-photos'
      ? ({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(key)])
      : row.content_type;
    if (!expectedType || bytes.length === 0 || bytes.length > (namespace === 'item-photos' ? 8 : 8) * 1024 * 1024) {
      throw new Error('A local file failed the supported type or size check. No source files were changed.');
    }
    if (!execute) { migrated += 1; continue; }
    let existing = null;
    try { existing = await getPrivateObject(namespace, key); }
    catch (error) { if (![404, 'BLOB_NOT_FOUND'].includes(error.status || error.code)) throw error; }
    if (existing) {
      if (hash(existing.bytes) !== hash(bytes)) throw new Error('An existing private object differs from its local source. Resolve it before continuing.');
      skipped += 1;
      continue;
    }
    await putPrivateObject(namespace, key, bytes, expectedType);
    const stored = await getPrivateObject(namespace, key);
    if (!stored || hash(stored.bytes) !== hash(bytes)) throw new Error('Private storage verification failed. The original file remains intact.');
    migrated += 1;
  }
  return { migrated, skipped };
}

function resolveSourceDirectories(env = process.env) {
  // Use the same resolver as local storage so relative paths follow the app's cwd semantics.
  storageDriver(env);
  const roots = configuredLocalRoots(env);
  return { photos: roots.photos, proofs: roots.proofs };
}

async function validateSourceDirectories(sourceDirs, fsImpl = fs) {
  for (const [name, directory] of Object.entries(sourceDirs)) {
    let stat;
    try { stat = await fsImpl.stat(directory); }
    catch { throw new Error(`Configured ${name} source directory is missing: ${directory}`); }
    if (!stat.isDirectory()) throw new Error(`Configured ${name} source path is not a directory: ${directory}`);
  }
}

async function main() {
  const execute = process.argv.includes('--execute');
  const driver = storageDriver();
  if (execute && driver !== 'blob') throw new Error('Set PRIVATE_STORAGE_DRIVER=blob before running with --execute.');
  const sourceDirs = resolveSourceDirectories(process.env);
  await validateSourceDirectories(sourceDirs);
  const photos = await pool.query('SELECT storage_key FROM item_photos ORDER BY photo_id');
  const proofs = await pool.query('SELECT storage_key, content_type FROM conversation_proof_attachments ORDER BY proof_attachment_id');
  const photoResult = await migrateRows('item-photos', photos.rows, sourceDirs.photos, execute);
  const proofResult = await migrateRows('proof-attachments', proofs.rows, sourceDirs.proofs, execute);
  console.log(`${execute ? 'Copied and verified' : 'Dry run found'} ${photoResult.migrated + proofResult.migrated} private files; ${photoResult.skipped + proofResult.skipped} already matched.`);
  console.log('Original local files were not deleted. Database rows were not changed.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Private-file migration stopped. Original files were not deleted; review configuration and source/database associations.');
    if (process.env.NODE_ENV !== 'production') console.error(error.message);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { main, migrateRows, resolveSourceDirectories, validateSourceDirectories };
