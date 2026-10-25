'use strict';

const jwt = require('jsonwebtoken');
const { blobPath, safeObjectName } = require('./privateObjectStore');

function parseIntent(value) {
  try {
    const intent = JSON.parse(value || '{}');
    if (!intent || typeof intent !== 'object' || typeof intent.token !== 'string') return null;
    const claims = jwt.verify(intent.token, process.env.JWT_SECRET);
    const userId = Number(claims?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !['USER', 'STAFF', 'ADMIN'].includes(claims?.role)) return null;
    return { intent, userId };
  } catch { return null; }
}

function clientIntent(req) {
  if (req.body?.type !== 'blob.generate-client-token') return null;
  return parseIntent(req.body?.payload);
}

async function handlePrivateClientUpload(req, res, options) {
  if (process.env.NODE_ENV !== 'production') return res.status(404).json({ error: 'Private client uploads are only enabled in production.' });
  try {
    const handleUpload = options.handleUpload || (await import('@vercel/blob/client')).handleUpload;
    const response = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const parsed = parseIntent(clientPayload);
        if (!parsed) throw new Error('Upload authorization failed.');
        const { intent, userId } = parsed;
        const key = options.getObjectName(intent);
        if (!safeObjectName(key) || pathname !== blobPath(options.namespace, key)) throw new Error('Upload request is invalid.');
        const trustedPayload = await options.authorize(userId, intent, key);
        if (!trustedPayload) throw new Error('Upload authorization failed.');
        return {
          allowedContentTypes: options.allowedContentTypes,
          maximumSizeInBytes: options.maximumSizeInBytes,
          validUntil: Date.now() + 10 * 60 * 1000,
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ ...trustedPayload, userId, objectName: key }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let trusted;
        try { trusted = JSON.parse(tokenPayload); } catch { throw new Error('Upload completion is invalid.'); }
        const key = trusted.objectName;
        if (!safeObjectName(key) || blob.pathname !== blobPath(options.namespace, key)) throw new Error('Upload completion is invalid.');
        await options.onCompleted(blob, trusted);
      },
    });
    // The SDK response contains only a short-lived, path-scoped upload capability.
    // No Blob URL or storage pathname is returned by this application's API.
    return res.status(200).json(response);
  } catch {
    const completion = req.body?.type === 'blob.upload-completed';
    return res.status(completion ? 500 : 400).json({ error: 'Private upload could not be authorized or completed.' });
  }
}

module.exports = { handlePrivateClientUpload, clientIntent };
