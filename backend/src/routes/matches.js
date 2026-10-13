
const express = require("express");
const pool = require("../config/db");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      WITH item_candidates AS MATERIALIZED (
        SELECT
          l.report_id AS lost_report_id,
          f.report_id AS found_report_id,

          l.item_id AS lost_item_id,
          f.item_id AS found_item_id,

          l.report_time AS lost_report_time,
          f.report_time AS found_report_time,

          l.uncertainty_radius_m AS lost_radius_m,
          f.uncertainty_radius_m AS found_radius_m,

          l.location_point AS lost_point,
          f.location_point AS found_point,

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

          LOWER(CONCAT_WS(
            ' ', li.title, li.description
          )) AS lost_text,

          LOWER(CONCAT_WS(
            ' ', fi.title, fi.description
          )) AS found_text

        FROM reports l
        JOIN items li ON li.item_id = l.item_id
        JOIN reports f
          ON f.report_type = 'FOUND'
         AND f.status = 'OPEN'
        JOIN items fi ON fi.item_id = f.item_id

        WHERE l.report_type = 'LOST'
          AND l.status = 'OPEN'
          AND l.report_id <> f.report_id

          -- First filter: broad category compatibility.
          AND li.category = fi.category

          -- Reject known contradictory item types.
          AND NOT (
            (
              (li.title || ' ' || COALESCE(li.description, ''))
                ~* '\\m(headphones?|headsets?)\\M'
              AND
              (fi.title || ' ' || COALESCE(fi.description, ''))
                ~* '\\m(earbuds?|earphones?)\\M'
            )
            OR
            (
              (fi.title || ' ' || COALESCE(fi.description, ''))
                ~* '\\m(headphones?|headsets?)\\M'
              AND
              (li.title || ' ' || COALESCE(li.description, ''))
                ~* '\\m(earbuds?|earphones?)\\M'
            )
          )
      ),

      spatial_candidates AS MATERIALIZED (
        SELECT
          *,
          ST_Distance(lost_point, found_point) AS distance_m,
          (
            ST_Distance(lost_point, found_point)
            <= lost_radius_m + found_radius_m
          ) AS circles_overlap,

          ABS(
            EXTRACT(EPOCH FROM (
              lost_report_time - found_report_time
            ))
          ) / 86400.0 AS days_apart

        FROM item_candidates
      ),

      text_features AS (
        SELECT
          *,
          LOWER(
            REGEXP_REPLACE(
              CONCAT_WS(' ', lost_title, lost_description),
              '[^[:alnum:]]+', ' ', 'g'
            )
          ) AS lost_normalized_text,

          LOWER(
            REGEXP_REPLACE(
              CONCAT_WS(' ', found_title, found_description),
              '[^[:alnum:]]+', ' ', 'g'
            )
          ) AS found_normalized_text,

          LOWER(TRIM(COALESCE(lost_title, '')))
            AS lost_title_norm,

          LOWER(TRIM(COALESCE(found_title, '')))
            AS found_title_norm

        FROM spatial_candidates
      ),

      scored AS (
        SELECT
          *,

          ROUND(
            GREATEST(
              0,
              LEAST(
                100,
                100 * (
                  1 - distance_m /
                  NULLIF(lost_radius_m + found_radius_m, 0)
                )
              )
            )::numeric,
            2
          ) AS location_score,

          100::numeric AS category_score,

          CASE
            WHEN NULLIF(TRIM(lost_color), '') IS NULL
              OR NULLIF(TRIM(found_color), '') IS NULL
              THEN 50
            WHEN LOWER(TRIM(lost_color)) = LOWER(TRIM(found_color))
              THEN 100
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
            WHEN lost_title_norm = ''
              OR found_title_norm = '' THEN 0
            ELSE ROUND(
              (
                100.0 * (
                  SELECT COUNT(*)
                  FROM (
                    SELECT DISTINCT word
                    FROM UNNEST(
                      REGEXP_SPLIT_TO_ARRAY(
                        lost_title_norm, '\\s+'
                      )
                    ) AS word
                    WHERE LENGTH(word) > 1

                    INTERSECT

                    SELECT DISTINCT word
                    FROM UNNEST(
                      REGEXP_SPLIT_TO_ARRAY(
                        found_title_norm, '\\s+'
                      )
                    ) AS word
                    WHERE LENGTH(word) > 1
                  ) shared_words
                )
                /
                NULLIF(
                  (
                    SELECT COUNT(*)
                    FROM (
                      SELECT DISTINCT word
                      FROM UNNEST(
                        REGEXP_SPLIT_TO_ARRAY(
                          lost_title_norm, '\\s+'
                        )
                      ) AS word
                      WHERE LENGTH(word) > 1

                      UNION

                      SELECT DISTINCT word
                      FROM UNNEST(
                        REGEXP_SPLIT_TO_ARRAY(
                          found_title_norm, '\\s+'
                        )
                      ) AS word
                      WHERE LENGTH(word) > 1
                    ) all_words
                  ),
                  0
                )
              )::numeric,
              2
            )
          END AS title_score,

          CASE
            WHEN lost_normalized_text = ''
              OR found_normalized_text = '' THEN 0
            ELSE ROUND(
              (
                100.0 * (
                  SELECT COUNT(*)
                  FROM (
                    SELECT DISTINCT word
                    FROM UNNEST(
                      REGEXP_SPLIT_TO_ARRAY(
                        lost_normalized_text, '\\s+'
                      )
                    ) AS word
                    WHERE LENGTH(word) > 1

                    INTERSECT

                    SELECT DISTINCT word
                    FROM UNNEST(
                      REGEXP_SPLIT_TO_ARRAY(
                        found_normalized_text, '\\s+'
                      )
                    ) AS word
                    WHERE LENGTH(word) > 1
                  ) shared_words
                )
                /
                NULLIF(
                  (
                    SELECT COUNT(*)
                    FROM (
                      SELECT DISTINCT word
                      FROM UNNEST(
                        REGEXP_SPLIT_TO_ARRAY(
                          lost_normalized_text, '\\s+'
                        )
                      ) AS word
                      WHERE LENGTH(word) > 1

                      UNION

                      SELECT DISTINCT word
                      FROM UNNEST(
                        REGEXP_SPLIT_TO_ARRAY(
                          found_normalized_text, '\\s+'
                        )
                      ) AS word
                      WHERE LENGTH(word) > 1
                    ) all_words
                  ),
                  0
                )
              )::numeric,
              2
            )
          END AS description_score

        FROM text_features
      )

      SELECT
        lost_report_id,
        found_report_id,
        lost_title,
        found_title,
        lost_category,
        found_category,
        ROUND(distance_m::numeric, 2) AS distance_m,
        lost_radius_m,
        found_radius_m,
        circles_overlap,
        ROUND(days_apart::numeric, 2) AS days_apart,
        location_score,
        category_score,
        color_score,
        time_score,
        title_score,
        description_score,

        ROUND(
          (
            location_score * 0.45
            + category_score * 0.15
            + color_score * 0.10
            + time_score * 0.15
            + title_score * 0.05
            + description_score * 0.10
          )::numeric,
          2
        ) AS total_score

      FROM scored
      WHERE circles_overlap = TRUE
      ORDER BY total_score DESC, distance_m ASC
      LIMIT 100
    `);

    res.json({
      count: result.rowCount,
      matches: result.rows,
      note:
        "Item-compatible candidates are filtered before spatial scoring. Scores are heuristics, not probabilities or proof of ownership.",
    });
  } catch (error) {
    console.error("Find matches failed:", error.message);

    res.status(500).json({
      error: "Unable to calculate candidate matches",
    });
  }
});

module.exports = router;
