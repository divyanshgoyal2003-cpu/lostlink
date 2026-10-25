'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { putPrivateObject, getPrivateObject, getPrivateObjectStream, deletePrivateObject, readBlobResult } = require('../src/storage/privateObjectStore');

test('private development adapter stores, streams, and removes private files without leaking keys', async () => {
  const previous = {
    driver: process.env.PRIVATE_STORAGE_DRIVER,
    photos: process.env.PRIVATE_PHOTO_DIR,
    proofs: process.env.PRIVATE_PROOF_DIR,
    node: process.env.NODE_ENV,
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lostlink-private-store-'));
  process.env.PRIVATE_STORAGE_DRIVER = 'local';
  process.env.NODE_ENV = 'test';
  process.env.PRIVATE_PHOTO_DIR = path.join(root, 'photos');
  process.env.PRIVATE_PROOF_DIR = path.join(root, 'proofs');
  const key = 'a3db4567-1111-4111-8111-abcdef123456.jpg';
  const original = Buffer.from('private-object-test');
  try {
    await putPrivateObject('item-photos', key, original, 'image/jpeg');
    assert.deepEqual((await getPrivateObject('item-photos', key)).bytes, original);
    const streamed = await getPrivateObjectStream('item-photos', key);
    const chunks = [];
    for await (const chunk of streamed.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), original);
    assert.equal(streamed.contentLength, original.length);
    await assert.rejects(putPrivateObject('item-photos', '../secret.jpg', original, 'image/jpeg'), /Invalid private object upload/);
    await deletePrivateObject('item-photos', key);
    assert.equal(await getPrivateObject('item-photos', key).catch((error) => error.code), 'ENOENT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (previous.driver === undefined) delete process.env.PRIVATE_STORAGE_DRIVER; else process.env.PRIVATE_STORAGE_DRIVER = previous.driver;
    if (previous.photos === undefined) delete process.env.PRIVATE_PHOTO_DIR; else process.env.PRIVATE_PHOTO_DIR = previous.photos;
    if (previous.proofs === undefined) delete process.env.PRIVATE_PROOF_DIR; else process.env.PRIVATE_PROOF_DIR = previous.proofs;
    if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
  }
});

test('private Blob reads require HTTP 200 and a content stream', async () => {
  const get = async () => ({ statusCode: 200, stream: Readable.from([Buffer.from('image')]), blob: { contentType: 'image/jpeg', size: 5 } });
  assert.deepEqual((await readBlobResult(get, 'test/key')).bytes, Buffer.from('image'));
  const streamed = await readBlobResult(get, 'test/key', true);
  assert.equal(streamed.contentLength, 5);
  assert.equal(await readBlobResult(async () => ({ statusCode: 404, stream: null }), 'test/key'), null);
  assert.equal(await readBlobResult(async () => ({ statusCode: 404, stream: null }), 'test/key', true), null);
  await assert.rejects(readBlobResult(async () => null, 'test/key'), /no response/);
  await assert.rejects(readBlobResult(async () => ({ statusCode: 206, stream: Readable.from(['partial']) }), 'test/key'), /unsuccessful response/);
  await assert.rejects(readBlobResult(async () => ({ statusCode: 206, stream: Readable.from(['partial']) }), 'test/key', true), /unsuccessful response/);
  await assert.rejects(readBlobResult(async () => ({ statusCode: 200, stream: null }), 'test/key'), /no content stream/);
  await assert.rejects(readBlobResult(async () => { throw new Error('provider failure'); }, 'test/key'), /provider failure/);
});
