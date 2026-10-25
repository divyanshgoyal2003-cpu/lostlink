'use strict';

const fs = require('node:fs/promises');
const fss = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');

const NAMESPACES = new Set(['item-photos', 'proof-attachments']);

function storageDriver(env = process.env) {
  const driver = env.PRIVATE_STORAGE_DRIVER || (env.NODE_ENV === 'production' ? 'blob' : 'local');
  if (!['blob', 'local'].includes(driver)) throw new Error('PRIVATE_STORAGE_DRIVER must be blob or local.');
  if (env.NODE_ENV === 'production' && driver !== 'blob') throw new Error('Production private storage must use the private Blob provider.');
  return driver;
}

function safeObjectName(value) {
  return typeof value === 'string' && /^[a-f0-9-]+(?:\.(?:jpg|png|webp))?$/.test(value) && !value.includes('..');
}

function localRoot(namespace, env) {
  return path.resolve(namespace === 'item-photos'
    ? (env.PRIVATE_PHOTO_DIR || path.join(__dirname, '../../private-photos'))
    : (env.PRIVATE_PROOF_DIR || path.join(__dirname, '../../private-proof-files')));
}

function configuredLocalRoots(env = process.env) {
  return {
    photos: localRoot('item-photos', env),
    proofs: localRoot('proof-attachments', env),
  };
}

function blobPath(namespace, objectName) {
  return `lostlink/${namespace}/${objectName}`;
}

async function loadBlobSdk() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && process.env.NODE_ENV !== 'production') {
    throw new Error('Private Blob storage credentials are not configured.');
  }
  return import('@vercel/blob');
}

async function readBlobResult(get, pathname, asStream = false) {
  const result = await get(pathname, { access: 'private' });
  if (!result) throw new Error('Private object provider returned no response.');
  if (result.statusCode === 404) return null;
  if (result.statusCode !== 200) throw new Error('Private object provider returned an unsuccessful response.');
  if (!result.stream) throw new Error('Private object provider returned no content stream.');
  if (asStream) {
    const stream = typeof result.stream.pipe === 'function' ? result.stream : Readable.fromWeb(result.stream);
    return { stream, contentLength: Number(result.blob?.size) || null, contentType: result.blob?.contentType || null };
  }
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), contentType: result.blob?.contentType || null };
}

async function putPrivateObject(namespace, objectName, bytes, contentType) {
  if (!NAMESPACES.has(namespace) || !safeObjectName(objectName) || !Buffer.isBuffer(bytes)) {
    throw new Error('Invalid private object upload.');
  }
  if (storageDriver() === 'local') {
    const root = localRoot(namespace, process.env);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, objectName), bytes, { flag: 'wx', mode: 0o600 });
    return;
  }
  const { put } = await loadBlobSdk();
  await put(blobPath(namespace, objectName), bytes, {
    access: 'private',
    addRandomSuffix: false,
    contentType,
    cacheControlMaxAge: 60,
  });
}

async function getPrivateObject(namespace, objectName) {
  if (!NAMESPACES.has(namespace) || !safeObjectName(objectName)) throw new Error('Invalid private object reference.');
  if (storageDriver() === 'local') {
    const root = localRoot(namespace, process.env);
    const filename = path.resolve(root, objectName);
    if (path.dirname(filename) !== root) throw new Error('Invalid private object reference.');
    return { bytes: await fs.readFile(filename), contentType: null };
  }
  const { get } = await loadBlobSdk();
  return readBlobResult(get, blobPath(namespace, objectName));
}

async function getPrivateObjectStream(namespace, objectName) {
  if (!NAMESPACES.has(namespace) || !safeObjectName(objectName)) throw new Error('Invalid private object reference.');
  if (storageDriver() === 'local') {
    const root = localRoot(namespace, process.env);
    const filename = path.resolve(root, objectName);
    if (path.dirname(filename) !== root) throw new Error('Invalid private object reference.');
    const stat = await fs.stat(filename);
    return { stream: fss.createReadStream(filename), contentLength: stat.size, contentType: null };
  }
  const { get } = await loadBlobSdk();
  return readBlobResult(get, blobPath(namespace, objectName), true);
}

async function deletePrivateObject(namespace, objectName) {
  if (!NAMESPACES.has(namespace) || !safeObjectName(objectName)) return;
  if (storageDriver() === 'local') {
    try { await fs.unlink(path.join(localRoot(namespace, process.env), objectName)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  const { del } = await loadBlobSdk();
  await del(blobPath(namespace, objectName));
}

module.exports = {
  storageDriver,
  putPrivateObject,
  getPrivateObject,
  getPrivateObjectStream,
  deletePrivateObject,
  blobPath,
  safeObjectName,
  localRoot,
  configuredLocalRoots,
  readBlobResult,
};
