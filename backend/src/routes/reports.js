
const express = require("express");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

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
// Retrieve open reports, newest first.
// We will restrict this endpoint separately before exposing private details.

router.get("/", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.report_id,
        r.report_type,
        r.report_time,
        r.status,
        i.category,
        i.title,
        i.color,
        r.created_at
      FROM reports r
      JOIN items i ON i.item_id = r.item_id
      WHERE r.status = 'OPEN'
      ORDER BY r.created_at DESC
      LIMIT 100
    `);

    return res.json({
      count: result.rowCount,
      reports: result.rows
    });
  } catch (error) {
    console.error("Get reports failed:", error.message);

    return res.status(500).json({
      error: "Unable to retrieve reports"
    });
  }
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
        location_description
      )
      VALUES (
        $1, $2, $3, $4,
        ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
        $7, $8, $9, $10
      )
      RETURNING
        report_id, report_type, report_time, status,
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
      ]
    );

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
      console.error("Report transaction rollback failed:", rollbackError.message);
    }

    console.error("Create report failed:", error.message);

    return res.status(500).json({
      error: "Unable to create report",
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/reports/mine
 * Retrieve reports owned by the authenticated user.
 */
router.get("/mine", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         r.report_id,
         r.report_type,
         r.report_time,
         r.status,
         r.uncertainty_radius_m,
         r.location_description,
         i.item_id,
         i.category,
         i.title,
         i.description,
         i.color,
         i.attributes_json->>'company' AS company,
         ST_Y(r.location_point::geometry) AS latitude,
         ST_X(r.location_point::geometry) AS longitude,
         r.created_at
       FROM reports r
       JOIN items i ON i.item_id = r.item_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.userId]
    );

    return res.json({
      count: result.rowCount,
      reports: result.rows,
    });
  } catch (error) {
    console.error("Get own reports failed:", error.message);

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
      console.error("Update rollback failed:", rollbackError.message);
    }

    console.error("Update report failed:", error.message);

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

  try {
    const result = await pool.query(
      `UPDATE reports
       SET status = 'CANCELLED'
       WHERE report_id = $1
         AND user_id = $2
         AND status = 'OPEN'
       RETURNING report_id, report_type, status`,
      [reportId, req.user.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Open report not found",
      });
    }

    return res.json({
      message: "Report closed successfully",
      report: result.rows[0],
    });
  } catch (error) {
    console.error("Close report failed:", error.message);

    return res.status(500).json({
      error: "Unable to close report",
    });
  }
});

module.exports = router;
