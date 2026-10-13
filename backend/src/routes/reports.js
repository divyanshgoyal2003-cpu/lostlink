
const express = require("express");
const pool = require("../config/db");

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
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
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
        ST_Y(r.location_point::geometry) AS latitude,
        ST_X(r.location_point::geometry) AS longitude,
        r.created_at
      FROM reports r
      JOIN items i ON i.item_id = r.item_id
      WHERE r.status = 'OPEN'
      ORDER BY r.created_at DESC
      LIMIT 100
    `);

    res.json({
      count: result.rowCount,
      reports: result.rows,
    });
  } catch (error) {
    console.error("Get reports failed:", error.message);
    res.status(500).json({ error: "Unable to retrieve reports" });
  }
});

// POST /api/reports
// Create an item and its lost/found report atomically.
router.post("/", async (req, res) => {
  const {
    userId,
    category,
    title,
    description = null,
    color = null,
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
    userId == null ||
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
    return res.status(400).json({ error: "Invalid category" });
  }

  if (!VALID_REPORT_TYPES.includes(reportType)) {
    return res.status(400).json({ error: "reportType must be LOST or FOUND" });
  }

  if (!VALID_LOCATION_SOURCES.includes(locationSource)) {
    return res.status(400).json({ error: "locationSource must be GPS or MAP_PIN" });
  }

  if (
    !Number.isInteger(Number(userId)) ||
    Number(userId) <= 0 ||
    !Number.isFinite(Number(latitude)) ||
    !Number.isFinite(Number(longitude)) ||
    Number(latitude) < -90 ||
    Number(latitude) > 90 ||
    Number(longitude) < -180 ||
    Number(longitude) > 180
  ) {
    return res.status(400).json({
      error: "Invalid user ID or geographic coordinates",
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

  if (Number.isNaN(Date.parse(reportTime))) {
    return res.status(400).json({ error: "Invalid reportTime" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Ensure the supplied user exists and is active.
    const userResult = await client.query(
      `SELECT user_id FROM users
       WHERE user_id = $1 AND account_status = 'ACTIVE'`,
      [userId]
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
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
        JSON.stringify(attributes),
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
    await client.query("ROLLBACK");
    console.error("Create report failed:", error.message);

    return res.status(500).json({
      error: "Unable to create report",
    });
  } finally {
    client.release();
  }
});

module.exports = router;
