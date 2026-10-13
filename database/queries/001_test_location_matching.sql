-- Test query: show FOUND reports compatible with each LOST report.
-- ST_Distance returns metres because location_point is geography.
-- Circle overlap is a compatibility signal, not proof of a match.
SELECT
    l.report_id AS lost_report_id,
    f.report_id AS found_report_id,
    ROUND(ST_Distance(l.location_point, f.location_point)::numeric, 2) AS distance_m,
    l.uncertainty_radius_m AS lost_radius_m,
    f.uncertainty_radius_m AS found_radius_m,
    (ST_Distance(l.location_point, f.location_point)
        <= l.uncertainty_radius_m + f.uncertainty_radius_m) AS uncertainty_circles_overlap,
    l.location_description AS lost_location_description,
    f.location_description AS found_location_description,
    ROUND(
        GREATEST(
            0,
            100 * (1 - ST_Distance(l.location_point, f.location_point)
                / NULLIF(l.uncertainty_radius_m + f.uncertainty_radius_m, 0))
        )::numeric, 2
    ) AS illustrative_location_score
FROM reports l
JOIN reports f ON f.report_type = 'FOUND'
WHERE l.report_type = 'LOST'
  AND l.status IN ('OPEN', 'MATCHED')
  AND f.status IN ('OPEN', 'MATCHED')
ORDER BY
    (ST_Distance(l.location_point, f.location_point)
        <= l.uncertainty_radius_m + f.uncertainty_radius_m) DESC,
    ST_Distance(l.location_point, f.location_point) ASC;
