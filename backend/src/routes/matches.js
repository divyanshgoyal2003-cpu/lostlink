
const express = require("express");
const pool = require("../config/db");

const router = express.Router();

// GET /api/matches
// Find candidate pairs between open LOST and FOUND reports.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      WITH candidate_pairs AS (
        SELECT
          l.report_id AS lost_report_id,
          f.report_id AS found_report_id,

          l.item_id AS lost_item_id,
          f.item_id AS found_item_id,

          l.report_time AS lost_report_time,
          f.report_time AS found_report_time,

          l.uncertainty_radius_m AS lost_radius_m,
          f.uncertainty_radius_m AS found_radius_m,

          l.location_description AS lost_location_description,
          f.location_description AS found_location_description,

          li.category AS lost_category,
          fi.category AS found_category,

          li.title AS lost_title,
          fi.title AS found_title,

          li.description AS lost_description,
          fi.description AS found_description,

          li.color AS lost_color,
          fi.color AS found_color,

          ST_Distance(
            l.location_point,
            f.location_point
          ) AS distance_m,

          (
            ST_Distance(l.location_point, f.location_point)
            <= l.uncertainty_radius_m + f.uncertainty_radius_m
          ) AS circles_overlap,

          ABS(
            EXTRACT(EPOCH FROM (l.report_time - f.report_time))
          ) / 86400.0 AS days_apart

        FROM reports l
        JOIN items li ON li.item_id = l.item_id
        JOIN reports f ON f.report_type = 'FOUND'
        JOIN items fi ON fi.item_id = f.item_id

        WHERE l.report_type = 'LOST'
          AND l.status = 'OPEN'
          AND f.status = 'OPEN'
          AND l.report_id <> f.report_id
      ),

      scored AS (
        SELECT
          *,

          ROUND(
            GREATEST(
              0,
              100 * (
                1 - distance_m /
                NULLIF(lost_radius_m + found_radius_m, 0)
              )
            )::numeric,
            2
          ) AS location_score,

          CASE
            WHEN lost_category = found_category THEN 100
            ELSE 0
          END AS category_score,

          CASE
            WHEN LOWER(COALESCE(lost_color, ''))
                 = LOWER(COALESCE(found_color, ''))
                 AND COALESCE(lost_color, '') <> ''
              THEN 100
            WHEN COALESCE(lost_color, '') = ''
                 OR COALESCE(found_color, '') = ''
              THEN 50
            ELSE 0
          END AS color_score,

          CASE
            WHEN days_apart <= 1 THEN 100
            WHEN days_apart <= 7 THEN 80
            WHEN days_apart <= 30 THEN 50
            WHEN days_apart <= 90 THEN 25
            ELSE 0
          END AS time_score,

          CASE
            WHEN LOWER(COALESCE(lost_title, ''))
                 = LOWER(COALESCE(found_title, ''))
              THEN 100
            WHEN LOWER(COALESCE(lost_title, ''))
                 LIKE '%' || LOWER(COALESCE(found_title, '')) || '%'
              OR LOWER(COALESCE(found_title, ''))
                 LIKE '%' || LOWER(COALESCE(lost_title, '')) || '%'
              THEN 80
            WHEN lost_category = found_category
              THEN 50
            ELSE 0
          END AS title_score

        FROM candidate_pairs
      )

      SELECT
        lost_report_id,
        found_report_id,
        lost_title,
        found_title,
        lost_category,
        found_category,
        distance_m,
        lost_radius_m,
        found_radius_m,
        circles_overlap,
        days_apart,
        location_score,
        category_score,
        color_score,
        time_score,
        title_score,

        ROUND(
          (
            location_score * 0.50
            + category_score * 0.15
            + color_score * 0.10
            + time_score * 0.15
            + title_score * 0.10
          )::numeric,
          2
        ) AS total_score

      FROM scored

      -- Only show pairs whose uncertainty circles overlap.
      WHERE circles_overlap = TRUE

      ORDER BY total_score DESC, distance_m ASC
      LIMIT 100
    `);

    res.json({
      count: result.rowCount,
      matches: result.rows,
      note: "Scores are heuristic candidates, not probabilities or proof of ownership.",
    });
  } catch (error) {
    console.error("Find matches failed:", error.message);

    res.status(500).json({
      error: "Unable to calculate candidate matches",
    });
  }
});

module.exports = router;
