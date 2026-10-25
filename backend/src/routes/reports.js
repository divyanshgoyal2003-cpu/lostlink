
const express = require("express");
const crypto = require("node:crypto");
const pool = require("../config/db");
const { putPrivateObject, getPrivateObject, getPrivateObjectStream, deletePrivateObject } = require("../storage/privateObjectStore");
const { handlePrivateClientUpload, clientIntent } = require("../storage/clientUpload");
const authenticateToken = require("../middleware/auth");
const { createNotification } = require("../notifications");
const { currentUser, hasActiveAuthorityMembership } = require("../authorityAccess");

const router = express.Router();
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = new Set(["FRONT", "BACK", "SIDE", "DISTINGUISHING_DETAIL"]);

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let first = true;
  let hasData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const crc = pngCrc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (bytes.readUInt32BE(offset + 8 + length) !== crc) return false;
    if (first) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 12000 || height > 12000) return false;
      first = false;
    }
    if (type === "IDAT") hasData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) return false;
      ended = true;
      break;
    }
    offset = end;
  }
  return !first && hasData && ended;
}

function isJpeg(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      if (offset + length >= bytes.length - 2) return false;
      hasScan = true;
      break;
    }
    offset += length;
  }
  return hasFrame && hasScan;
}

function isWebp(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  let hasImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) return false;
    if (
      (type === "VP8 " && size >= 10 && bytes.subarray(offset + 11, offset + 14).equals(Buffer.from([0x9d, 0x01, 0x2a]))) ||
      (type === "VP8L" && size >= 5 && bytes[offset + 8] === 0x2f)
    ) hasImageChunk = true;
    offset += 8 + size + (size & 1);
  }
  return hasImageChunk && offset === bytes.length;
}

const PHOTO_FORMATS = {
  "image/jpeg": { extension: ".jpg", matches: isJpeg },
  "image/png": { extension: ".png", matches: isPng },
  "image/webp": { extension: ".webp", matches: isWebp },
};

function safePhotoId(value) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function photoMetadata(row) {
  return { photoId: String(row.photo_id), photoType: row.photo_type, uploadedAt: row.uploaded_at };
}

async function removePrivatePhoto(storageKey) {
  await deletePrivateObject("item-photos", storageKey);
}

function validatePhoto(contentType, bytes) {
  const format = PHOTO_FORMATS[contentType];
  if (!format || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES || !format.matches(bytes)) {
    return null;
  }
  return format;
}

function parsePrivatePhotoBody(req, res, next) {
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: PHOTO_MAX_BYTES })(req, res, (error) => {
    if (!error) return next();
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Photo must be 8 MB or smaller" });
    return res.status(400).json({ error: "Unable to read image upload" });
  });
}

router.post("/:id/photos/client-upload", async (req, res) => {
  const reportId = req.params.id;
  if (!/^[1-9]\d*$/.test(reportId) || !Number.isSafeInteger(Number(reportId))) return res.status(400).json({ error: "Invalid report ID" });
  const parsed = clientIntent(req);
  if (!parsed) return res.status(401).json({ error: "Authentication required" });
  const { intent } = parsed;
  if (String(intent.reportId) !== reportId || !PHOTO_TYPES.has(intent.photoType) || typeof intent.storageKey !== "string") return res.status(400).json({ error: "Invalid photo upload request" });
  const ext = intent.storageKey.slice(intent.storageKey.lastIndexOf("."));
  const expectedType = ext === ".jpg" ? "image/jpeg" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : null;
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(intent.storageKey) || !expectedType || intent.contentType !== expectedType) return res.status(400).json({ error: "Invalid photo upload request" });

  return handlePrivateClientUpload(req, res, {
    namespace: "item-photos",
    allowedContentTypes: [expectedType],
    maximumSizeInBytes: PHOTO_MAX_BYTES,
    getObjectName: (value) => value.storageKey,
    authorize: async (userId, clientIntentValue) => {
      if (String(clientIntentValue.reportId) !== reportId || clientIntentValue.photoType !== intent.photoType || clientIntentValue.storageKey !== intent.storageKey || clientIntentValue.contentType !== expectedType) return null;
      const owner = await pool.query(
        `SELECT 1 FROM reports r JOIN users u ON u.user_id=r.user_id
         WHERE r.report_id=$1 AND r.user_id=$2 AND r.report_type='FOUND'
           AND r.status='OPEN' AND u.account_status='ACTIVE'`,
        [reportId, userId]
      );
      return owner.rowCount ? { reportId: Number(reportId), photoType: intent.photoType, contentType: expectedType } : null;
    },
    onCompleted: async (blob, trusted) => {
      const objectName = trusted.objectName;
      const object = await getPrivateObject("item-photos", objectName);
      const format = object && blob.contentType === trusted.contentType ? validatePhoto(blob.contentType, object.bytes) : null;
      if (!format) {
        await deletePrivateObject("item-photos", objectName).catch(() => {});
        throw new Error("Photo content is invalid.");
      }
      let client;
      let oldKey = null;
      let committed = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        const report = await client.query(
          `SELECT r.item_id FROM reports r JOIN users u ON u.user_id=r.user_id
           WHERE r.report_id=$1 AND r.user_id=$2 AND r.report_type='FOUND'
             AND r.status='OPEN' AND u.account_status='ACTIVE' FOR UPDATE OF r`,
          [trusted.reportId, trusted.userId]
        );
        if (!report.rowCount) throw new Error("Report authorization changed.");
        const itemId = report.rows[0].item_id;
        const existing = await client.query(
          `SELECT photo_id, storage_key FROM item_photos
           WHERE item_id=$1 AND photo_type=$2 ORDER BY uploaded_at DESC, photo_id DESC LIMIT 1 FOR UPDATE`,
          [itemId, trusted.photoType]
        );
        if (existing.rowCount && existing.rows[0].storage_key === objectName) {
          await client.query("COMMIT"); committed = true; return;
        }
        if (existing.rowCount) {
          oldKey = existing.rows[0].storage_key;
          await client.query("UPDATE item_photos SET storage_key=$2, uploaded_at=NOW() WHERE photo_id=$1", [existing.rows[0].photo_id, objectName]);
        } else {
          await client.query("INSERT INTO item_photos(item_id,storage_key,photo_type) VALUES($1,$2,$3)", [itemId, objectName, trusted.photoType]);
        }
        await client.query("COMMIT"); committed = true;
      } catch (error) {
        if (client && !committed) await client.query("ROLLBACK").catch(() => {});
        if (!committed) await deletePrivateObject("item-photos", objectName).catch(() => {});
        throw error;
      } finally { client?.release(); }
      if (oldKey) await deletePrivateObject("item-photos", oldKey).catch(() => console.error("Unable to remove replaced private photo."));
    },
  });
});

// Photo bytes are accepted as a raw image body, never as a public/object URL.
router.put(
  "/:id/photos",
  authenticateToken,
  (req, res, next) => {
    if (process.env.NODE_ENV === "production") return res.status(410).json({ error: "Use the private client upload flow" });
    return next();
  },
  async (req, res, next) => {
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ error: "Invalid report ID" });
    try {
      const owner = await pool.query(
        `SELECT 1 FROM reports r JOIN users u ON u.user_id=r.user_id
         WHERE r.report_id=$1 AND r.user_id=$2 AND r.report_type='FOUND'
           AND r.status='OPEN' AND u.account_status='ACTIVE'`,
        [req.params.id, req.user.userId]
      );
      return owner.rowCount ? next() : res.status(404).json({ error: "Open found report not found" });
    } catch { return res.status(500).json({ error: "Unable to authorize photo upload" }); }
  },
  parsePrivatePhotoBody,
  async (req, res) => {
    const reportId = req.params.id;
    const photoType = req.get("X-Photo-Type");
    if (!/^[1-9]\d*$/.test(reportId) || !Number.isSafeInteger(Number(reportId))) {
      return res.status(400).json({ error: "Invalid report ID" });
    }
    if (!PHOTO_TYPES.has(photoType)) {
      return res.status(400).json({ error: "Photo type must be FRONT, BACK, SIDE, or DISTINGUISHING_DETAIL" });
    }
    const format = validatePhoto(req.get("Content-Type")?.split(";")[0], req.body);
    if (!format) {
      return res.status(415).json({ error: "Upload a valid JPEG, PNG, or WebP image under 8 MB" });
    }

    const storageKey = `${crypto.randomUUID()}${format.extension}`;
    let client;
    let savedFile = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const report = await client.query(
        `SELECT r.item_id
         FROM reports r JOIN items i ON i.item_id = r.item_id
         WHERE r.report_id = $1 AND r.user_id = $2
           AND r.report_type = 'FOUND' AND r.status = 'OPEN'
         FOR UPDATE OF r, i`,
        [reportId, req.user.userId]
      );
      if (!report.rowCount) {
        await client.query("ROLLBACK");
        await removePrivatePhoto(storageKey);
        return res.status(404).json({ error: "Open found report not found" });
      }

      await putPrivateObject("item-photos", storageKey, req.body, req.get("Content-Type")?.split(";")[0]);
      savedFile = true;

      const itemId = report.rows[0].item_id;
      const existing = await client.query(
        `SELECT photo_id, storage_key FROM item_photos
         WHERE item_id = $1 AND photo_type = $2
         ORDER BY uploaded_at DESC, photo_id DESC LIMIT 1 FOR UPDATE`,
        [itemId, photoType]
      );
      let result;
      if (existing.rowCount) {
        result = await client.query(
          `UPDATE item_photos SET storage_key = $2, uploaded_at = NOW()
           WHERE photo_id = $1 RETURNING photo_id, photo_type, uploaded_at`,
          [existing.rows[0].photo_id, storageKey]
        );
      } else {
        result = await client.query(
          `INSERT INTO item_photos (item_id, storage_key, photo_type)
           VALUES ($1, $2, $3) RETURNING photo_id, photo_type, uploaded_at`,
          [itemId, storageKey, photoType]
        );
      }
      await client.query("COMMIT");
      savedFile = false;
      if (existing.rowCount) await removePrivatePhoto(existing.rows[0].storage_key).catch(() => console.error("Unable to remove replaced private photo."));
      return res.status(existing.rowCount ? 200 : 201).json({ photo: photoMetadata(result.rows[0]) });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* keep the original error */ }
      }
      if (savedFile) {
        try { await removePrivatePhoto(storageKey); } catch { /* orphan cleanup can be retried */ }
      }
      console.error("Upload found report photo failed.");
      return res.status(500).json({ error: "Unable to save report photo" });
    } finally {
      if (client) client.release();
    }
  }
);

// Finder-only metadata listing; storage keys never leave the server.
router.get("/:id/photos", authenticateToken, async (req, res) => {
  const reportId = req.params.id;
  if (!/^[1-9]\d*$/.test(reportId) || !Number.isSafeInteger(Number(reportId))) {
    return res.status(400).json({ error: "Invalid report ID" });
  }
  try {
    const result = await pool.query(
      `SELECT p.photo_id, p.photo_type, p.uploaded_at
       FROM reports r JOIN item_photos p ON p.item_id = r.item_id
       WHERE r.report_id = $1 AND r.user_id = $2 AND r.report_type = 'FOUND'
       ORDER BY p.photo_type, p.photo_id`,
      [reportId, req.user.userId]
    );
    if (!result.rowCount) {
      const owned = await pool.query(
        `SELECT 1 FROM reports WHERE report_id = $1 AND user_id = $2 AND report_type = 'FOUND'`,
        [reportId, req.user.userId]
      );
      if (!owned.rowCount) return res.status(404).json({ error: "Found report not found" });
    }
    return res.json({ photos: result.rows.map(photoMetadata) });
  } catch (error) {
    console.error("List found report photos failed.");
    return res.status(500).json({ error: "Unable to list report photos" });
  }
});

// Authenticated binary retrieval. A claimant must present the specific claim ID.
router.get("/photos/:photoId", authenticateToken, async (req, res) => {
  if (!safePhotoId(req.params.photoId)) return res.status(400).json({ error: "Invalid photo ID" });
  const claimId = req.query.claimId;
  const requestedReportId = req.query.reportId;
  if (claimId == null && !safePhotoId(String(requestedReportId || ""))) {
    return res.status(400).json({ error: "A reportId or claimId is required" });
  }
  try {
    const result = await pool.query(
      `SELECT p.photo_id, p.storage_key, r.report_id AS found_report_id, r.user_id AS finder_id,
              r.authority_id
       FROM item_photos p
       JOIN reports r ON r.item_id = p.item_id AND r.report_type = 'FOUND'
         AND ($2::bigint IS NULL OR r.report_id = $2)
       WHERE p.photo_id = $1
       ORDER BY r.report_id`,
      [req.params.photoId, requestedReportId || null]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Photo not found" });
    let selected = null;
    for (const photo of result.rows) {
      if (claimId == null && Number(photo.finder_id) === req.user.userId) {
        selected = photo;
        break;
      }
      // Verified physical custody grants the assigned active authority access
      // to these private report photos without a claimant sharing grant.
      if (claimId == null && requestedReportId && photo.authority_id &&
          await hasActiveAuthorityMembership(pool, req.user.userId, photo.authority_id,
            { requireCustody: true, reportId: photo.found_report_id })) {
        selected = photo;
        break;
      }
      if (!safePhotoId(String(claimId || ""))) continue;
      const access = await pool.query(
        `SELECT c.claimant_user_id, conv.conversation_status, f.authority_id,
                EXISTS (SELECT 1 FROM claim_photo_shares s
                        WHERE s.claim_id = c.claim_id AND s.revoked_at IS NULL) AS shared
         FROM claim_requests c
         JOIN match_records m ON m.match_id = c.match_id
         JOIN reports f ON f.report_id = m.found_report_id
         LEFT JOIN conversations conv ON conv.claim_id = c.claim_id
         WHERE c.claim_id = $1 AND m.found_report_id = $2`,
        [claimId, photo.found_report_id]
      );
      if (!access.rowCount) continue;
      const row = access.rows[0];
      const finderAllowed = Number(photo.finder_id) === req.user.userId;
      const claimantAllowed = Number(row.claimant_user_id) === req.user.userId && row.shared;
      const current = await currentUser(pool, req.user.userId);
      const staffAllowed = current?.account_status === "ACTIVE" &&
        (current.role === "ADMIN" || (current.role === "STAFF" && !row.authority_id)) &&
        row.conversation_status === "OPEN";
      const authorityAllowed = row.shared && row.conversation_status === "OPEN" &&
        await hasActiveAuthorityMembership(pool, req.user.userId, row.authority_id, { requireCustody: true, reportId: photo.found_report_id });
      if (finderAllowed || claimantAllowed || staffAllowed || authorityAllowed) {
        selected = photo;
        break;
      }
    }
    if (!selected) return res.status(403).json({ error: "You are not authorized to view this photo" });

    const object = await getPrivateObjectStream("item-photos", selected.storage_key);
    if (!object) return res.status(404).json({ error: "Photo not found" });
    const extension = selected.storage_key.slice(selected.storage_key.lastIndexOf("."));
    const contentType = extension === ".jpg" ? "image/jpeg" : extension === ".png" ? "image/png" : "image/webp";
    res.set({
      "Content-Type": contentType,
      ...(object.contentLength ? { "Content-Length": String(object.contentLength) } : {}),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    object.stream.on("error", () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    return object.stream.pipe(res);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "BLOB_NOT_FOUND") return res.status(404).json({ error: "Photo not found" });
    console.error("Retrieve private photo failed.");
    return res.status(500).json({ error: "Unable to retrieve photo" });
  }
});

const VALID_CATEGORIES = [
  "ELECTRONICS",
  "DOC_CARDS",
  "ACCESSORIES",
  "CLOTHING",
  "BAGS",
  "OTHER",
];

const VALID_REPORT_TYPES = ["LOST", "FOUND"];
const VALID_LOCATION_SOURCES = ["GPS", "MAP_PIN"];

// GET /api/reports
// General report browsing is retired. Use the authorized My Matches workflow
// for candidate discovery and /mine for owner-scoped report management.
router.get("/", authenticateToken, (req, res) => {
  return res.status(410).json({
    error: "General report browsing is unavailable. Use My Matches to find qualifying candidates.",
  });
});


// POST /api/reports
// Create an item and its lost/found report atomically.
// The authenticated user's ID comes from the verified JWT.
router.post("/", authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  const {
    category,
  title,
  description = null,
  color,
  company,
  attributes = {},
    reportType,
    reportTime,
    recoveryMode = "DIRECT",
    authorityId = null,
    latitude,
    longitude,
    uncertaintyRadiusM = 75,
    locationAccuracyM = null,
    locationSource,
    locationDescription = null,
  } = req.body;

  // Validate required fields.
  if (
    !category ||
    !title ||
    !reportType ||
    !reportTime ||
    latitude == null ||
    longitude == null ||
    !locationSource
  ) {
    return res.status(400).json({
      error: "Missing required report fields",
    });
  }

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      error: "Invalid category",
    });
  }

  if (!VALID_REPORT_TYPES.includes(reportType)) {
    return res.status(400).json({
      error: "reportType must be LOST or FOUND",
    });
  }

  if (!VALID_LOCATION_SOURCES.includes(locationSource)) {
    return res.status(400).json({
      error: "locationSource must be GPS or MAP_PIN",
    });
  }

  if (!['DIRECT', 'AUTHORITY'].includes(recoveryMode) ||
      recoveryMode === 'AUTHORITY' && !/^[1-9]\d*$/.test(String(authorityId || '')) ||
      recoveryMode === 'DIRECT' && authorityId != null && authorityId !== '') {
    return res.status(400).json({ error: "Choose direct recovery or a valid authority destination" });
  }
  if (reportType === 'LOST' && recoveryMode !== 'DIRECT') {
    return res.status(400).json({ error: "Only found reports can be assigned to an authority" });
  }

  if (
    !Number.isFinite(Number(latitude)) ||
    !Number.isFinite(Number(longitude)) ||
    Number(latitude) < -90 ||
    Number(latitude) > 90 ||
    Number(longitude) < -180 ||
    Number(longitude) > 180
  ) {
    return res.status(400).json({
      error: "Invalid geographic coordinates",
    });
  }

  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > 160
  ) {
    return res.status(400).json({
      error: "Title must contain 1–160 characters",
    });
  }

  if (
    description !== null &&
    (typeof description !== "string" || description.length > 5000)
  ) {
    return res.status(400).json({
      error: "Description must be a string of at most 5000 characters",
    });
  }

 if (
  typeof color !== "string" ||
  color.trim().length === 0 ||
  color.length > 100
) {
  return res.status(400).json({
    error: "Color is required and must be at most 100 characters",
  });
}
if (
  typeof company !== "string" ||
  company.trim().length === 0 ||
  company.length > 120
) {
  return res.status(400).json({
    error: "Company or brand is required and must be at most 120 characters",
  });
}
  if (
    !Number.isFinite(Number(uncertaintyRadiusM)) ||
    Number(uncertaintyRadiusM) < 0 ||
    Number(uncertaintyRadiusM) > 5000
  ) {
    return res.status(400).json({
      error: "uncertaintyRadiusM must be between 0 and 5000",
    });
  }

  if (
    locationAccuracyM != null &&
    (!Number.isFinite(Number(locationAccuracyM)) ||
      Number(locationAccuracyM) < 0)
  ) {
    return res.status(400).json({
      error: "locationAccuracyM must be non-negative",
    });
  }

  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  ) {
    return res.status(400).json({
      error: "attributes must be a JSON object",
    });
  }
  // Electronics reports must include a structured model.
  if (category === "ELECTRONICS") {
    if (
      typeof attributes.model !== "string" ||
      attributes.model.trim().length === 0 ||
      attributes.model.trim().length > 100
    ) {
      return res.status(400).json({
        error:
          "Model is required for electronics and must be at most 100 characters",
      });
    }
  }
  if (
    typeof reportTime !== "string" ||
    Number.isNaN(Date.parse(reportTime))
  ) {
    return res.status(400).json({
      error: "Invalid reportTime",
    });
  }

  if (
    locationDescription !== null &&
    (typeof locationDescription !== "string" ||
      locationDescription.length > 500)
  ) {
    return res.status(400).json({
      error: "Location description must be a string of at most 500 characters",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Ensure the authenticated user still exists and is active.
    const userResult = await client.query(
      `SELECT user_id FROM users
       WHERE user_id = $1 AND account_status = 'ACTIVE'`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "User does not exist or is not active",
      });
    }

    if (recoveryMode === 'AUTHORITY') {
      const eligibleDestination = await client.query(
        `SELECT authority_id FROM authority_destinations
         WHERE authority_id = $1 AND verification_status = 'VERIFIED'
           AND destination_status = 'ACTIVE' FOR SHARE`,
        [authorityId]
      );
      if (!eligibleDestination.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Select a verified, active authority destination" });
      }
    }

    const itemResult = await client.query(
      `INSERT INTO items
        (category, title, description, color, attributes_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING item_id, category, title, description, color, created_at`,
      [
        category,
        title.trim(),
        description,
        color,
        JSON.stringify({
          ...attributes,
          company: company.trim(),
        }),
      ]
    );

    const item = itemResult.rows[0];

    const reportResult = await client.query(
      `INSERT INTO reports (
        user_id,
        item_id,
        report_type,
        report_time,
        location_point,
        uncertainty_radius_m,
        location_accuracy_m,
        location_source,
        location_description,
        recovery_mode,
        authority_id
      )
      VALUES (
        $1, $2, $3, $4,
        ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
        $7, $8, $9, $10, $11, $12
      )
      RETURNING
        report_id, report_type, report_time, status,
        recovery_mode, authority_id,
        uncertainty_radius_m, location_accuracy_m,
        location_source, location_description, created_at`,
      [
        userId,
        item.item_id,
        reportType,
        reportTime,
        Number(longitude),
        Number(latitude),
        Number(uncertaintyRadiusM),
        locationAccuracyM == null ? null : Number(locationAccuracyM),
        locationSource,
        locationDescription,
        recoveryMode,
        recoveryMode === 'AUTHORITY' ? authorityId : null,
      ]
    );

    if (recoveryMode === 'AUTHORITY') {
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
         VALUES ($1, 'AUTHORITY_REPORT_ASSIGNED', 'REPORT', $2, $3::jsonb)`,
        [userId, reportResult.rows[0].report_id, JSON.stringify({ recoveryMode, authorityId: Number(authorityId), initialAssignment: true })]
      );
      const authorityMembers = await client.query(
        `SELECT user_id FROM authority_memberships WHERE authority_id=$1 AND membership_status='ACTIVE'`,
        [authorityId]
      );
      for (const member of authorityMembers.rows) {
        await createNotification(client, member.user_id, "AUTHORITY_CASE_ASSIGNED", "REPORT", reportResult.rows[0].report_id);
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Report created successfully",
      item,
      report: reportResult.rows[0],
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Report transaction rollback failed.");
    }

    console.error("Create report failed.");

    return res.status(error.code === "23514" ? 400 : 500).json({
      error: error.code === "23514" ? "Authority destination is no longer eligible" : "Unable to create report",
    });
  } finally {
    client.release();
  }
});

/** GET /api/reports/mine/history - returned found reports owned by the user. */
router.get("/mine/history", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.report_id, r.report_type, r.report_time, r.status, r.updated_at,
              i.category, i.title, r.recovery_mode, ad.name AS authority_name
       FROM reports r
       JOIN items i ON i.item_id = r.item_id
       LEFT JOIN authority_destinations ad ON ad.authority_id = r.authority_id
       WHERE r.user_id = $1 AND r.report_type = 'FOUND' AND r.status = 'RETURNED'
       ORDER BY r.updated_at DESC, r.report_id DESC`,
      [req.user.userId]
    );
    return res.json({ count: result.rowCount, reports: result.rows });
  } catch (error) {
    console.error("Get returned report history failed.");
    return res.status(500).json({ error: "Unable to retrieve return history" });
  }
});

/** GET /api/reports/mine - active reports owned by the authenticated user. */
router.get("/mine", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         r.report_id,
         r.report_type,
         r.report_time,
         r.status,
         r.uncertainty_radius_m,
         r.location_accuracy_m,
         r.location_source,
         r.location_description,
         i.item_id,
         i.category,
         i.title,
         i.description,
         i.color,
         i.attributes_json->>'company' AS company,
         (SELECT COALESCE(jsonb_object_agg(attribute.key, attribute.value), '{}'::jsonb)
          FROM jsonb_each(i.attributes_json) AS attribute
          WHERE attribute.key !~* '(password|token|secret|credential|api.?key|storage|photo|proof|evidence|serial|identifier|holder|reviewer|verification|private)') AS item_attributes,
         ST_Y(r.location_point::geometry) AS latitude,
         ST_X(r.location_point::geometry) AS longitude,
         r.created_at,
         r.recovery_mode,
         r.authority_id,
         ad.name AS authority_name,
         latest_custody.custody_transfer_id,
         latest_custody.custody_status,
         latest_custody.initiated_at AS custody_initiated_at,
         latest_custody.received_at AS custody_received_at
       FROM reports r
       JOIN items i ON i.item_id = r.item_id
       LEFT JOIN authority_destinations ad ON ad.authority_id = r.authority_id
       LEFT JOIN LATERAL (
         SELECT custody_transfer_id, custody_status, initiated_at, received_at
         FROM custody_transfer_requests ctr WHERE ctr.report_id = r.report_id
         ORDER BY initiated_at DESC, custody_transfer_id DESC LIMIT 1
       ) latest_custody ON TRUE
       WHERE r.user_id = $1
         AND r.status <> 'RETURNED'
         AND NOT (r.report_type = 'FOUND' AND EXISTS (
           SELECT 1 FROM custody_transfer_requests received
           WHERE received.report_id = r.report_id AND received.custody_status = 'RECEIVED'
         ))
       ORDER BY r.created_at DESC`,
      [req.user.userId]
    );

    return res.json({
      count: result.rowCount,
      reports: result.rows,
    });
  } catch (error) {
    console.error("Get own reports failed.");

    return res.status(500).json({
      error: "Unable to retrieve your reports",
    });
  }
});

/**
 * PATCH /api/reports/:id
 * Update an open report owned by the authenticated user.
 */
router.patch("/:id", authenticateToken, async (req, res) => {
  const reportId = req.params.id;

  if (!/^[1-9]\d*$/.test(reportId)) {
    return res.status(400).json({ error: "Invalid report ID" });
  }

  const { title, description, color, category } = req.body;

  if (
    title === undefined &&
    description === undefined &&
    color === undefined &&
    category === undefined
  ) {
    return res.status(400).json({
      error: "Provide at least one field to update",
    });
  }

  if (
    title !== undefined &&
    (typeof title !== "string" ||
      title.trim().length === 0 ||
      title.length > 160)
  ) {
    return res.status(400).json({
      error: "Title must contain 1–160 characters",
    });
  }

  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || description.length > 5000)
  ) {
    return res.status(400).json({
      error: "Description must be at most 5000 characters",
    });
  }

 if (
  color !== undefined &&
  (
    typeof color !== "string" ||
    color.trim().length === 0 ||
    color.length > 100
  )
) {
  return res.status(400).json({
    error: "Color must be non-empty and at most 100 characters",
  });
}

  if (
    category !== undefined &&
    !VALID_CATEGORIES.includes(category)
  ) {
    return res.status(400).json({ error: "Invalid category" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Only update a report belonging to this authenticated user.
    const reportResult = await client.query(
      `SELECT r.report_id, r.item_id
       FROM reports r
       WHERE r.report_id = $1
         AND r.user_id = $2
         AND r.status = 'OPEN'
         AND NOT EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                         WHERE ctr.report_id = r.report_id AND ctr.custody_status = 'RECEIVED')
       FOR UPDATE`,
      [reportId, req.user.userId]
    );

    if (reportResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Open report not found",
      });
    }

    const itemId = reportResult.rows[0].item_id;

    const updates = [];
    const values = [];
    let index = 1;

    if (title !== undefined) {
      updates.push(`title = $${index++}`);
      values.push(title.trim());
    }

    if (description !== undefined) {
      updates.push(`description = $${index++}`);
      values.push(description);
    }

    if (color !== undefined) {
      updates.push(`color = $${index++}`);
      values.push(color);
    }

    if (category !== undefined) {
      updates.push(`category = $${index++}`);
      values.push(category);
    }

    values.push(itemId);

    const updateResult = await client.query(
      `UPDATE items
       SET ${updates.join(", ")}
       WHERE item_id = $${index}
       RETURNING item_id, category, title, description, color`,
      values
    );

    await client.query("COMMIT");

    return res.json({
      message: "Report updated successfully",
      item: updateResult.rows[0],
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Update rollback failed.");
    }

    console.error("Update report failed.");

    return res.status(500).json({
      error: "Unable to update report",
    });
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/reports/:id/close
 * Close an open report owned by the authenticated user.
 */
router.patch("/:id/close", authenticateToken, async (req, res) => {
  const reportId = req.params.id;

  if (!/^[1-9]\d*$/.test(reportId)) {
    return res.status(400).json({ error: "Invalid report ID" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await client.query(
      `SELECT report_id, report_type, authority_id
       FROM reports r WHERE report_id=$1 AND user_id=$2 AND status='OPEN'
         AND NOT EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                         WHERE ctr.report_id=r.report_id AND ctr.custody_status='RECEIVED')
       FOR UPDATE`,
      [reportId, req.user.userId]
    );
    if (!report.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Open report not found" });
    }
    const pending = await client.query(
      `UPDATE custody_transfer_requests SET custody_status='CANCELLED', cancelled_at=NOW(), updated_at=NOW()
       WHERE report_id=$1 AND custody_status='PENDING_RECEIPT'
       RETURNING custody_transfer_id, authority_id`,
      [reportId]
    );
    for (const transfer of pending.rows) {
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, entity_id, metadata)
         VALUES ($1, 'CUSTODY_TRANSFER_CANCELLED', 'CUSTODY_TRANSFER', $2, $3::jsonb)`,
        [req.user.userId, transfer.custody_transfer_id, JSON.stringify({ reportId: Number(reportId), authorityId: Number(transfer.authority_id), reason: "REPORT_CLOSED" })]
      );
    }
    const updated = await client.query(
      `UPDATE reports SET status='CANCELLED', updated_at=NOW() WHERE report_id=$1
       RETURNING report_id, report_type, status`,
      [reportId]
    );
    await client.query("COMMIT");
    return res.json({ message: "Report closed successfully", report: updated.rows[0] });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* retain original error */ }
    console.error("Close report failed.");
    return res.status(500).json({
      error: "Unable to close report",
    });
  } finally {
    client.release();
  }
});

module.exports = router;
