
const express = require("express");
const pool = require("../config/db");
const {
  MATCH_SCORE_THRESHOLD,
  STRONG_MATCH_THRESHOLD,
  MATCH_WEIGHTS,
  GENERIC_MATCH_TERMS,
  UNKNOWN_MATCH_VALUES,
  getMatchStrength,
} = require("../config/matching");

const router = express.Router();
const { createNotification } = require("../notifications");
const genericWordSql = `(${GENERIC_MATCH_TERMS.map((word) => `'${word}'`).join(", ")})`;
const unknownMatchValuesSql = `(${UNKNOWN_MATCH_VALUES.map((value) => `'${value}'`).join(", ")})`;
const knownValueSql = (expression) => `CASE
  WHEN NULLIF(LOWER(REGEXP_REPLACE(TRIM(${expression}), '[^[:alnum:]]+', ' ', 'g')), '') IN ${unknownMatchValuesSql} THEN NULL
  ELSE NULLIF(LOWER(TRIM(${expression})), '')
END`;
const totalScoreSql = Object.entries(MATCH_WEIGHTS)
  .map(([score, weight]) => `${score} * ${weight}`)
  .join(" + ");
const itemWeightTotal = MATCH_WEIGHTS.category_score + MATCH_WEIGHTS.color_score + MATCH_WEIGHTS.brand_model_score;
const itemScoreSql = `ROUND(((category_score * ${MATCH_WEIGHTS.category_score}) + (color_score * ${MATCH_WEIGHTS.color_score}) + (brand_model_score * ${MATCH_WEIGHTS.brand_model_score})) / ${itemWeightTotal}, 2)`;

/*
 * Shared candidate query.
 *
 * Pipeline:
 * 1. Filter by exact category, incompatible item types, and known brand conflicts.
 * 2. Calculate distance and elapsed time for eligible report pairs.
 * 3. Score normalized informative text, color, category, and brand/model evidence.
 * 4. Keep only overlapping uncertainty circles with actionable identifying evidence.
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
        ${knownValueSql("li.attributes_json->>'company'")},
        ${knownValueSql("li.attributes_json->>'brand'")},
        ${knownValueSql("le.brand")}
      ) AS lost_brand,

      COALESCE(
        ${knownValueSql("fi.attributes_json->>'company'")},
        ${knownValueSql("fi.attributes_json->>'brand'")},
        ${knownValueSql("fe.brand")}
      ) AS found_brand,

      COALESCE(
        ${knownValueSql("li.attributes_json->>'model'")},
        ${knownValueSql("le.model")}
      ) AS lost_model,

      COALESCE(
        ${knownValueSql("fi.attributes_json->>'model'")},
        ${knownValueSql("fe.model")}
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

      CASE
        WHEN isfinite(lost_report_time) AND isfinite(found_report_time)
          THEN ABS(EXTRACT(EPOCH FROM (lost_report_time - found_report_time))) / 86400.0
        ELSE NULL
      END AS days_apart

    FROM item_candidates
    WHERE lost_brand IS NULL OR found_brand IS NULL
      OR LOWER(REGEXP_REPLACE(TRIM(lost_brand), '[^[:alnum:]]+', ' ', 'g'))
       = LOWER(REGEXP_REPLACE(TRIM(found_brand), '[^[:alnum:]]+', ' ', 'g'))
  ),

  text_features AS (
    SELECT
      *,
      LOWER(REGEXP_REPLACE(COALESCE(lost_title, ''), '[^[:alnum:]]+', ' ', 'g')) AS lost_title_norm,
      LOWER(REGEXP_REPLACE(COALESCE(found_title, ''), '[^[:alnum:]]+', ' ', 'g')) AS found_title_norm,
      LOWER(REGEXP_REPLACE(COALESCE(lost_description, ''), '[^[:alnum:]]+', ' ', 'g')) AS lost_description_norm,
      LOWER(REGEXP_REPLACE(COALESCE(found_description, ''), '[^[:alnum:]]+', ' ', 'g')) AS found_description_norm
    FROM spatial_candidates
  ),
  token_features AS (
    SELECT
      *,
      ARRAY(SELECT DISTINCT word FROM REGEXP_SPLIT_TO_TABLE(lost_title_norm, '\\s+') AS token(word) WHERE LENGTH(word) > 1 AND word NOT IN ${genericWordSql}) AS lost_title_tokens,
      ARRAY(SELECT DISTINCT word FROM REGEXP_SPLIT_TO_TABLE(found_title_norm, '\\s+') AS token(word) WHERE LENGTH(word) > 1 AND word NOT IN ${genericWordSql}) AS found_title_tokens,
      ARRAY(SELECT DISTINCT word FROM REGEXP_SPLIT_TO_TABLE(lost_description_norm, '\\s+') AS token(word) WHERE LENGTH(word) > 1 AND word NOT IN ${genericWordSql}) AS lost_description_tokens,
      ARRAY(SELECT DISTINCT word FROM REGEXP_SPLIT_TO_TABLE(found_description_norm, '\\s+') AS token(word) WHERE LENGTH(word) > 1 AND word NOT IN ${genericWordSql}) AS found_description_tokens
    FROM text_features
  ),
  text_counts AS (
    SELECT
      *,
      (SELECT COUNT(*) FROM (SELECT word FROM UNNEST(lost_title_tokens) AS lost(word) INTERSECT SELECT word FROM UNNEST(found_title_tokens) AS found(word)) shared) AS title_shared_count,
      (SELECT COUNT(*) FROM (SELECT word FROM UNNEST(lost_title_tokens) AS lost(word) UNION SELECT word FROM UNNEST(found_title_tokens) AS found(word)) all_words) AS title_union_count,
      (SELECT COUNT(*) FROM (SELECT word FROM UNNEST(lost_description_tokens) AS lost(word) INTERSECT SELECT word FROM UNNEST(found_description_tokens) AS found(word)) shared) AS description_shared_count,
      (SELECT COUNT(*) FROM (SELECT word FROM UNNEST(lost_description_tokens) AS lost(word) UNION SELECT word FROM UNNEST(found_description_tokens) AS found(word)) all_words) AS description_union_count
    FROM token_features
  ),
  scored AS (
    SELECT
      *,
      CASE
        WHEN lost_radius_m + found_radius_m = 0 THEN CASE WHEN distance_m = 0 THEN 100 ELSE 0 END
        ELSE ROUND(GREATEST(0, LEAST(100, 100 * (1 - distance_m / (lost_radius_m + found_radius_m))))::numeric, 2)
      END AS location_score,
      100::numeric AS category_score,
      CASE
        WHEN NULLIF(TRIM(lost_color), '') IS NULL OR NULLIF(TRIM(found_color), '') IS NULL THEN 50
        WHEN LOWER(REGEXP_REPLACE(TRIM(lost_color), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_color), '[^[:alnum:]]+', ' ', 'g')) THEN 100
        ELSE 0
      END AS color_score,
      CASE
        WHEN lost_model IS NULL OR found_model IS NULL THEN 50
        WHEN LOWER(REGEXP_REPLACE(TRIM(lost_model), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_model), '[^[:alnum:]]+', ' ', 'g')) THEN 100
        ELSE 0
      END AS model_score,
      CASE
        WHEN lost_brand IS NULL OR found_brand IS NULL THEN 50
        WHEN LOWER(REGEXP_REPLACE(TRIM(lost_brand), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_brand), '[^[:alnum:]]+', ' ', 'g')) THEN 100
        ELSE 0
      END AS brand_score,
      CASE
        WHEN lost_brand IS NULL OR found_brand IS NULL THEN
          CASE WHEN lost_model IS NULL OR found_model IS NULL THEN 50
            WHEN LOWER(REGEXP_REPLACE(TRIM(lost_model), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_model), '[^[:alnum:]]+', ' ', 'g')) THEN 100 ELSE 0 END
        WHEN lost_model IS NULL OR found_model IS NULL THEN
          CASE WHEN LOWER(REGEXP_REPLACE(TRIM(lost_brand), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_brand), '[^[:alnum:]]+', ' ', 'g')) THEN 100 ELSE 0 END
        ELSE ROUND((
          CASE WHEN LOWER(REGEXP_REPLACE(TRIM(lost_brand), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_brand), '[^[:alnum:]]+', ' ', 'g')) THEN 100 ELSE 0 END
          + CASE WHEN LOWER(REGEXP_REPLACE(TRIM(lost_model), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_model), '[^[:alnum:]]+', ' ', 'g')) THEN 100 ELSE 0 END
        )::numeric / 2, 2)
      END AS brand_model_score,
      (
        (lost_brand IS NOT NULL AND found_brand IS NOT NULL
          AND LOWER(REGEXP_REPLACE(TRIM(lost_brand), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_brand), '[^[:alnum:]]+', ' ', 'g')))
        OR (lost_model IS NOT NULL AND found_model IS NOT NULL
          AND LOWER(REGEXP_REPLACE(TRIM(lost_model), '[^[:alnum:]]+', ' ', 'g')) = LOWER(REGEXP_REPLACE(TRIM(found_model), '[^[:alnum:]]+', ' ', 'g')))
      ) AS brand_model_match_evidence,
      CASE
        WHEN NOT isfinite(lost_report_time) OR NOT isfinite(found_report_time) THEN 50
        WHEN days_apart <= 1 THEN 100
        WHEN days_apart <= 7 THEN 80
        WHEN days_apart <= 30 THEN 50
        WHEN days_apart <= 90 THEN 25
        ELSE 0
      END AS time_score,
      CASE WHEN title_union_count = 0 THEN 0 ELSE ROUND((100.0 * title_shared_count / title_union_count)::numeric, 2) END AS title_score,
      CASE WHEN description_union_count = 0 THEN 0 ELSE ROUND((100.0 * description_shared_count / description_union_count)::numeric, 2) END AS description_score
    FROM text_counts
  ),
  scored_candidates AS (
    SELECT
      lost_report_id,
      found_report_id,
      lost_title,
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
      brand_score,
      brand_model_score,
      brand_model_match_evidence,
      time_score,
      title_score,
      description_score,
      ${itemScoreSql} AS item_score,
      ROUND((${totalScoreSql})::numeric, 2) AS total_score
    FROM scored
    WHERE circles_overlap = TRUE
  )

  SELECT *
  FROM scored_candidates
  WHERE total_score >= ${MATCH_SCORE_THRESHOLD}
    -- Location, time, category, and unknown neutral factors alone are not identifying evidence.
    AND (title_score > 0 OR description_score > 0 OR brand_model_match_evidence = TRUE)
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
        scoreBreakdown: {
          location: Number(match.location_score),
          category: Number(match.category_score),
          color: Number(match.color_score),
          time: Number(match.time_score),
          title: Number(match.title_score),
          description: Number(match.description_score),
          brandModel: Number(match.brand_model_score),
        },
        category: match.lost_category,
        lostTitle: match.lost_title,
        lostReportTime: match.lost_report_time,
        foundReportTime: match.found_report_time,
        matchedAt: match.matched_at,
        approximateDistanceM:
          Math.round(Number(match.distance_m) / 100) * 100,
        daysApart: match.days_apart == null ? null : Number(match.days_apart),
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
        brand_score: Number(match.brand_score),
        brand_model_score: Number(match.brand_model_score),
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
          match.item_score,
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
