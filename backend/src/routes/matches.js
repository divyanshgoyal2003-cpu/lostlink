
const express = require("express");
const pool = require("../config/db");
const {
  MATCH_SCORE_THRESHOLD,
  STRONG_MATCH_THRESHOLD,
  getMatchStrength,
} = require("../config/matching");

const router = express.Router();
const { createNotification } = require("../notifications");

/*
 * Shared candidate query.
 *
 * Pipeline:
 * 1. Filter by category and incompatible item types.
 * 2. Calculate geographic distance for compatible candidates.
 * 3. Calculate title, description, color, category, and time scores.
 * 4. Rank candidates whose uncertainty circles overlap.
 *
 * This query is shared by GET and POST /refresh to keep scoring consistent.
 */
const candidateQuery = `
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

      li.category AS lost_category,
      fi.category AS found_category,

      li.title AS lost_title,
      fi.title AS found_title,

      li.description AS lost_description,
      fi.description AS found_description,

      li.color AS lost_color,
      fi.color AS found_color,

      COALESCE(
        NULLIF(LOWER(TRIM(li.attributes_json->>'company')), ''),
        NULLIF(LOWER(TRIM(li.attributes_json->>'brand')), ''),
        NULLIF(LOWER(TRIM(le.brand)), '')
      ) AS lost_brand,

      COALESCE(
        NULLIF(LOWER(TRIM(fi.attributes_json->>'company')), ''),
        NULLIF(LOWER(TRIM(fi.attributes_json->>'brand')), ''),
        NULLIF(LOWER(TRIM(fe.brand)), '')
      ) AS found_brand,

      COALESCE(
        NULLIF(LOWER(TRIM(li.attributes_json->>'model')), ''),
        NULLIF(LOWER(TRIM(le.model)), '')
      ) AS lost_model,

      COALESCE(
        NULLIF(LOWER(TRIM(fi.attributes_json->>'model')), ''),
        NULLIF(LOWER(TRIM(fe.model)), '')
      ) AS found_model

    FROM reports l
    JOIN items li ON li.item_id = l.item_id
    LEFT JOIN electronics le ON le.item_id = li.item_id

    JOIN reports f
      ON f.report_type = 'FOUND'
     AND f.status = 'OPEN'

    JOIN items fi ON fi.item_id = f.item_id
    LEFT JOIN electronics fe ON fe.item_id = fi.item_id

    WHERE l.report_type = 'LOST'
      AND l.user_id = $1
      AND ($2::bigint IS NULL OR l.report_id = $2::bigint)
      AND l.status = 'OPEN'
      AND l.report_id <> f.report_id

      -- Require the same broad item category.
      AND li.category = fi.category
      -- Reject candidates when both known brands differ.
      AND (
        COALESCE(
          NULLIF(LOWER(TRIM(li.attributes_json->>'company')), ''),
          NULLIF(LOWER(TRIM(li.attributes_json->>'brand')), ''),
          NULLIF(LOWER(TRIM(le.brand)), '')
        ) IS NULL
        OR COALESCE(
          NULLIF(LOWER(TRIM(fi.attributes_json->>'company')), ''),
          NULLIF(LOWER(TRIM(fi.attributes_json->>'brand')), ''),
          NULLIF(LOWER(TRIM(fe.brand)), '')
        ) IS NULL
        OR COALESCE(
          NULLIF(LOWER(TRIM(li.attributes_json->>'company')), ''),
          NULLIF(LOWER(TRIM(li.attributes_json->>'brand')), ''),
          NULLIF(LOWER(TRIM(le.brand)), '')
        ) = COALESCE(
          NULLIF(LOWER(TRIM(fi.attributes_json->>'company')), ''),
          NULLIF(LOWER(TRIM(fi.attributes_json->>'brand')), ''),
          NULLIF(LOWER(TRIM(fe.brand)), '')
        )
      )

      -- Initial rule to reject contradictory headphone/earbud types.
      AND NOT (
        (
          (
            COALESCE(li.title, '') || ' ' ||
            COALESCE(li.description, '')
          ) ~* '\\m(headphones?|headsets?)\\M'

          AND

          (
            COALESCE(fi.title, '') || ' ' ||
            COALESCE(fi.description, '')
          ) ~* '\\m(earbuds?|earphones?)\\M'
        )
        OR
        (
          (
            COALESCE(fi.title, '') || ' ' ||
            COALESCE(fi.description, '')
          ) ~* '\\m(headphones?|headsets?)\\M'

          AND

          (
            COALESCE(li.title, '') || ' ' ||
            COALESCE(li.description, '')
          ) ~* '\\m(earbuds?|earphones?)\\M'
        )
      )
  ),

  spatial_candidates AS MATERIALIZED (
    SELECT
      *,

      ST_Distance(
        lost_point,
        found_point
      ) AS distance_m,

      (
        ST_Distance(lost_point, found_point)
        <= lost_radius_m + found_radius_m
      ) AS circles_overlap,

      ABS(
        EXTRACT(
          EPOCH FROM (lost_report_time - found_report_time)
        )
      ) / 86400.0 AS days_apart

    FROM item_candidates
  ),

  text_features AS (
    SELECT
      *,

      LOWER(
        REGEXP_REPLACE(
          CONCAT_WS(' ', lost_title, lost_description),
          '[^[:alnum:]]+',
          ' ',
          'g'
        )
      ) AS lost_normalized_text,

      LOWER(
        REGEXP_REPLACE(
          CONCAT_WS(' ', found_title, found_description),
          '[^[:alnum:]]+',
          ' ',
          'g'
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

      -- Location score: 0-100.
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

      -- Same broad category is required by the candidate filter.
      100::numeric AS category_score,

      -- Missing colors are treated as unknown, not contradictory.
      CASE
        WHEN NULLIF(TRIM(lost_color), '') IS NULL
          OR NULLIF(TRIM(found_color), '') IS NULL
          THEN 50

        WHEN LOWER(TRIM(lost_color)) =
             LOWER(TRIM(found_color))
          THEN 100

        ELSE 0
      END AS color_score,

      -- Model compatibility: unknown models are neutral; known conflicts score 0.
      CASE
        WHEN NULLIF(TRIM(lost_model), '') IS NULL
          OR NULLIF(TRIM(found_model), '') IS NULL
          THEN 50

        WHEN LOWER(TRIM(lost_model)) = LOWER(TRIM(found_model))
          THEN 100

        ELSE 0
      END AS model_score,

      -- Time proximity score: 0-100.
      CASE
        WHEN days_apart <= 1 THEN 100
        WHEN days_apart <= 7 THEN 80
        WHEN days_apart <= 30 THEN 50
        WHEN days_apart <= 90 THEN 25
        ELSE 0
      END AS time_score,

      -- Title similarity: intersection / union of distinct words.
      CASE
        WHEN lost_title_norm = ''
          OR found_title_norm = ''
          THEN 0

        ELSE ROUND(
          (
            100.0 * (
              SELECT COUNT(*)
              FROM (
                SELECT DISTINCT word
                FROM UNNEST(
                  REGEXP_SPLIT_TO_ARRAY(
                    lost_title_norm,
                    '\\s+'
                  )
                ) AS word
                WHERE LENGTH(word) > 1

                INTERSECT

                SELECT DISTINCT word
                FROM UNNEST(
                  REGEXP_SPLIT_TO_ARRAY(
                    found_title_norm,
                    '\\s+'
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
                      lost_title_norm,
                      '\\s+'
                    )
                  ) AS word
                  WHERE LENGTH(word) > 1

                  UNION

                  SELECT DISTINCT word
                  FROM UNNEST(
                    REGEXP_SPLIT_TO_ARRAY(
                      found_title_norm,
                      '\\s+'
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

      -- Description similarity using combined title + description text.
      CASE
        WHEN lost_normalized_text = ''
          OR found_normalized_text = ''
          THEN 0

        ELSE ROUND(
          (
            100.0 * (
              SELECT COUNT(*)
              FROM (
                SELECT DISTINCT word
                FROM UNNEST(
                  REGEXP_SPLIT_TO_ARRAY(
                    lost_normalized_text,
                    '\\s+'
                  )
                ) AS word
                WHERE LENGTH(word) > 1

                INTERSECT

                SELECT DISTINCT word
                FROM UNNEST(
                  REGEXP_SPLIT_TO_ARRAY(
                    found_normalized_text,
                    '\\s+'
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
                      lost_normalized_text,
                      '\\s+'
                    )
                  ) AS word
                  WHERE LENGTH(word) > 1

                  UNION

                  SELECT DISTINCT word
                  FROM UNNEST(
                    REGEXP_SPLIT_TO_ARRAY(
                      found_normalized_text,
                      '\\s+'
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
  ), scored_candidates AS (
    SELECT
    lost_report_id,
    found_report_id,

    lost_title,
    found_title,

    lost_report_time,
    found_report_time,

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
    model_score,
    time_score,
    title_score,
    description_score,

    ROUND(
      (
         location_score * 0.40
        + category_score * 0.15
        + color_score * 0.10
        + time_score * 0.15
        + title_score * 0.05
        + description_score * 0.05
        + model_score * 0.10
      )::numeric,
      2
    ) AS total_score

    FROM scored

    -- Geographic compatibility is checked after item filtering.
    WHERE circles_overlap = TRUE
  )

  SELECT *
  FROM scored_candidates
  WHERE total_score >= ${MATCH_SCORE_THRESHOLD}
  ORDER BY total_score DESC, distance_m ASC
  LIMIT 100
`;

// GET /api/matches
// Read-only: calculates candidates without modifying match_records.

router.get("/", async (req, res) => {
  const rawLostReportId = req.query.lostReportId;
  let selectedLostReportId = null;
  if (rawLostReportId !== undefined && rawLostReportId !== "") {
    const normalizedId = String(rawLostReportId);
    if (!/^[1-9]\d*$/.test(normalizedId) || !Number.isSafeInteger(Number(normalizedId))) {
      return res.status(400).json({ error: "Invalid lost report ID" });
    }
    selectedLostReportId = normalizedId;
  }

  try {
    if (selectedLostReportId !== null) {
      const ownedReport = await pool.query(
        `SELECT status
         FROM reports
         WHERE report_id = $1 AND user_id = $2 AND report_type = 'LOST'`,
        [selectedLostReportId, req.user.userId]
      );
      if (ownedReport.rowCount === 0) {
        return res.status(404).json({ error: "Lost report not found" });
      }
      if (ownedReport.rows[0].status !== "OPEN") {
        return res.status(409).json({ error: "Selected lost report is not eligible for matching" });
      }
    }

    const result = await pool.query(
      `
      SELECT m.*,
             saved.match_id AS saved_match_id,
             saved.match_status AS saved_match_status,
             saved.calculated_at AS saved_calculated_at,
             saved.total_score AS saved_total_score,
             f.recovery_mode AS found_recovery_mode,
             (f.recovery_mode = 'DIRECT' OR EXISTS (
               SELECT 1 FROM custody_transfer_requests ctr
               WHERE ctr.report_id=f.report_id AND ctr.custody_status='RECEIVED'
             )) AS found_available_to_claim,
             COALESCE(saved.calculated_at, GREATEST(l.created_at, f.created_at)) AS matched_at
      FROM (${candidateQuery}) AS m
      JOIN reports l ON l.report_id = m.lost_report_id
      JOIN reports f ON f.report_id = m.found_report_id
      LEFT JOIN match_records saved
        ON saved.lost_report_id = m.lost_report_id
       AND saved.found_report_id = m.found_report_id
      WHERE l.user_id = $1
        AND (saved.match_id IS NULL OR saved.total_score >= ${MATCH_SCORE_THRESHOLD})
      ORDER BY m.total_score DESC, m.distance_m ASC
      `,
      [req.user.userId, selectedLostReportId]
    );

 return res.json({
      count: result.rowCount,
      scoreThreshold: MATCH_SCORE_THRESHOLD,
      strongMatchThreshold: STRONG_MATCH_THRESHOLD,
      matches: result.rows.map((match) => ({
        matchId: match.saved_match_id == null ? null : String(match.saved_match_id),
        matchScore: Number(match.total_score),
        matchStrength: getMatchStrength(Number(match.total_score)),
        modelScore: Number(match.model_score),
        category: match.lost_category,
        lostTitle: match.lost_title,
        lostReportTime: match.lost_report_time,
        foundReportTime: match.found_report_time,
        matchedAt: match.matched_at,
        approximateDistanceM:
          Math.round(Number(match.distance_m) / 100) * 100,
        daysApart: Number(match.days_apart),
        status: match.saved_match_status || "CANDIDATE",
        canClaim: match.saved_match_id != null && match.found_available_to_claim &&
          ["CANDIDATE", "CHAT_ENABLED"].includes(match.saved_match_status || "CANDIDATE"),
      })),
      note: "Match scores are estimates, not probabilities or proof of ownership.",
    });
  } catch (error) {
    console.error("Find matches failed.");

    return res.status(500).json({
      error: "Unable to calculate candidate matches"
    });
  }
});


// POST /api/matches/refresh
// Persist candidates, updating existing CANDIDATE pairs without duplicates.

router.post("/refresh", async (req, res) => {
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Prevent simultaneous refreshes from interfering with each other.
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [65000, 1]
    );

    // Recalculate eligible candidates using the shared matching query.
    const candidateResult = await client.query(candidateQuery, [req.user.userId, null]);
    const candidates = candidateResult.rows;

    // Keep track of the candidate pairs returned by this refresh.
    const candidatePairs = candidates.map((match) => ({
      lost_report_id: match.lost_report_id,
      found_report_id: match.found_report_id,
    }));

    let insertedOrUpdated = 0;

    // Persist candidates individually using the unique report-pair constraint.
    for (const match of candidates) {
      // The refresh-wide advisory lock makes this existence check and insert
      // one idempotent decision for each persisted report pair.
      const priorMatch = await client.query(
        `SELECT match_id FROM match_records
         WHERE lost_report_id = $1 AND found_report_id = $2`,
        [match.lost_report_id, match.found_report_id]
      );
      const breakdown = {
        location_score: Number(match.location_score),
        category_score: Number(match.category_score),
        color_score: Number(match.color_score),
        model_score: Number(match.model_score),
        title_score: Number(match.title_score),
        description_score: Number(match.description_score),
        distance_m: Number(match.distance_m),
        days_apart: Number(match.days_apart),
      };

      const saved = await client.query(
        `
        INSERT INTO match_records (
          lost_report_id,
          found_report_id,
          location_score,
          item_score,
          time_score,
          description_score,
          total_score,
          score_breakdown,
          match_status,
          calculated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'CANDIDATE', NOW())

        ON CONFLICT (lost_report_id, found_report_id)
        DO UPDATE SET
          location_score = EXCLUDED.location_score,
          item_score = EXCLUDED.item_score,
          time_score = EXCLUDED.time_score,
          description_score = EXCLUDED.description_score,
          total_score = EXCLUDED.total_score,
          score_breakdown = EXCLUDED.score_breakdown,
          match_status = 'CANDIDATE',
          calculated_at = NOW()
        WHERE match_records.match_status IN ('CANDIDATE', 'STALE')

        RETURNING match_id
        `,
        [
          match.lost_report_id,
          match.found_report_id,
          match.location_score,
          match.category_score,
          match.time_score,
          match.description_score,
          match.total_score,
          JSON.stringify(breakdown),
        ]
      );

      if (saved.rowCount > 0) {
        insertedOrUpdated++;
        if (!priorMatch.rowCount) {
          await createNotification(
            client,
            req.user.userId,
            "MATCH_FOUND",
            "MATCH",
            saved.rows[0].match_id
          );
        }
      }
    }

    // Mark old candidates stale if they weren't returned by this refresh.
    // Never change rejected, verified, returned, or active workflow records.
    const staleResult = await client.query(
      `
      UPDATE match_records mr
      SET match_status = 'STALE'
      WHERE mr.match_status = 'CANDIDATE'
        AND EXISTS (
          SELECT 1 FROM reports owned_lost
          WHERE owned_lost.report_id = mr.lost_report_id
            AND owned_lost.user_id = $1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM reports l
          JOIN reports f
            ON f.report_id = mr.found_report_id
          WHERE l.report_id = mr.lost_report_id
            AND f.report_id = mr.found_report_id
            AND l.report_type = 'LOST'
            AND f.report_type = 'FOUND'
            AND l.status = 'OPEN'
            AND f.status = 'OPEN'
        )
      `,
      [req.user.userId]
    );

    // Stale any remaining candidates that are no longer in the result set.
    // An empty candidate set is valid and marks all existing candidates stale.
    if (candidatePairs.length === 0) {
      const emptyResult = await client.query(
        `
        UPDATE match_records
        SET match_status = 'STALE'
        WHERE match_status = 'CANDIDATE'
          AND EXISTS (
            SELECT 1 FROM reports owned_lost
            WHERE owned_lost.report_id = match_records.lost_report_id
              AND owned_lost.user_id = $1
          )
        `,
        [req.user.userId]
      );

      staleResult.rowCount += emptyResult.rowCount;
    } else {
      const stalePairsResult = await client.query(
        `
        UPDATE match_records mr
        SET match_status = 'STALE'
        WHERE mr.match_status = 'CANDIDATE'
          AND EXISTS (
            SELECT 1 FROM reports owned_lost
            WHERE owned_lost.report_id = mr.lost_report_id
              AND owned_lost.user_id = $2
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_to_recordset($1::jsonb)
              AS cp(lost_report_id bigint, found_report_id bigint)
            WHERE cp.lost_report_id = mr.lost_report_id
              AND cp.found_report_id = mr.found_report_id
          )
        `,
        [JSON.stringify(candidatePairs), req.user.userId]
      );

      staleResult.rowCount += stalePairsResult.rowCount;
    }

    await client.query("COMMIT");

    res.json({
  message: "Match refresh completed",
  candidatesFound: candidates.length,
  insertedOrUpdated,
  markedStale: staleResult.rowCount,
  note: "Candidate matches refreshed successfully."
});
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Match refresh rollback failed.");
      }
    }

    console.error("Refresh matches failed.");

    res.status(500).json({
      error: "Unable to refresh persistent matches",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});


module.exports = router;
