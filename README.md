# LostLink — Sprint 1 Starter

This starter establishes the database foundation for LostLink using PostgreSQL + PostGIS.

## Included
- `database/migrations/001_initial_schema.sql`: initial relational schema
- `database/seeds/001_demo_data.sql`: small, fictional test dataset
- `database/queries/001_test_location_matching.sql`: query to test geographic candidate retrieval
- `.env.example`: placeholders for later backend configuration
- `.gitignore`: common exclusions

## Prerequisites
- PostgreSQL
- PostGIS extension available for your PostgreSQL installation
- `psql` command-line client (or use pgAdmin Query Tool)

## Create the database
In a PostgreSQL shell or pgAdmin, run:

```sql
CREATE DATABASE lostlink;
```

Connect to `lostlink`, then run the migration file:

```powershell
psql -U postgres -d lostlink -f database/migrations/001_initial_schema.sql
psql -U postgres -d lostlink -f database/seeds/001_demo_data.sql
```

Replace `postgres` with your PostgreSQL username if different. If `psql` is not on PATH, run these files using pgAdmin's Query Tool instead.

## Test the spatial query

```powershell
psql -U postgres -d lostlink -f database/queries/001_test_location_matching.sql
```

The seed coordinates are fictional examples used only to test distance and uncertainty-radius behavior.

## Important design notes
- Both LOST and FOUND reports use `location_point`, `uncertainty_radius_m`, optional `location_accuracy_m`, `location_source`, and optional `location_description`.
- `location_point` is a PostGIS `geography(Point, 4326)` value.
- User uncertainty radius is not the same as GPS measurement accuracy.
- Location score is the primary initial signal; the provisional weights are location 50%, item/category 25%, time 15%, description 10%. These are not validated and must be evaluated.
- The migration enforces score ranges, report types, unique candidate pairs, and core foreign keys.
- Additional cross-row rules (e.g. ensuring a MATCH_RECORDS pair connects a LOST report to a FOUND report) are enforced in the database trigger included here.
- This is Sprint 1's database foundation. Backend authorization, status transition rules, file storage, and application logic are future tasks.
