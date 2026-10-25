# LostLink deployment guide — Vercel

This repository is prepared for two Vercel projects connected to the same GitHub repository: a Vite frontend and an Express API. The application has **not** been deployed, no hosting account has been accessed, and no database has been provisioned or changed.

## 1. Prerequisites

- A GitHub account with access to this repository.
- A Vercel account/team.
- A managed PostgreSQL provider that supports PostGIS and TLS certificate validation. Supabase is one option with documented PostGIS support; verify its extension schema and `search_path` requirements before using it ([Supabase PostGIS setup](https://supabase.com/docs/guides/database/extensions/postgis)).
- A private Vercel Blob store for item photos and chat proof. A private store is required; public Blob stores are not compatible with this application’s access model ([Vercel private storage](https://vercel.com/docs/vercel-blob/private-storage)).
- Node.js 22.12 or later in the Node 22 line and npm for local checks. Both app packages declare a supported Node engine.
- `psql` and `pg_dump` for the one-time database setup, or the provider’s SQL editor for applying the migration files.

Choose a Postgres region close to the backend functions. If your provider supplies a connection pooler, use its TLS-enabled URL for the API when supported. Use a direct/admin connection for the one-time migrations that create PostGIS and database objects. Keep the application database user’s privileges limited to what the app needs after initialization.

### PostGIS compatibility

`database/migrations/001_initial_schema.sql` creates PostGIS and uses unqualified PostGIS types and functions. Enable PostGIS before that migration if your provider installs extensions into a dedicated schema. Confirm the API database role’s `search_path` resolves `geography`, `ST_SetSRID`, `ST_MakePoint`, and the other PostGIS functions used by the SQL. Do not move or recreate PostGIS in a database with existing spatial columns as a deployment workaround; that requires a provider-supported, backup-first procedure.

## 2. Create the two Vercel projects

In Vercel, import the same GitHub repository twice. Vercel supports separate projects by choosing a different root directory for each monorepo project ([Vercel monorepo guide](https://vercel.com/docs/monorepos)).

### Frontend project

- Root Directory: `frontend`
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install` (or leave Vercel’s detected npm command)
- Node.js Version: 22.x
- Required variable: `VITE_API_URL=https://<backend-domain>/api`

`frontend/vercel.json` rewrites SPA routes to the Vite entry page. The API base URL must use HTTPS, contain no username/password, and end in `/api`. A Vite environment variable is compiled into the static bundle, so changing it requires a new frontend build/deployment. Credential-bearing values such as `https://user:password@host/api` are rejected before build output is generated.

### Backend project

- Root Directory: `backend`
- Framework Preset: Express (Vercel detects `backend/src/server.js` as the Express entry point; the existing CommonJS file exports the Express app and listens only when run directly).
- Build Command: no build step is required; install the package dependencies with npm.
- Output Directory: leave unset.
- Node.js Version: 22.x.
- Keep Vercel system environment variables enabled. Blob client-upload callbacks use the deployment URL values that Vercel provides.

The backend is a Vercel Function, not a persistent Node server. Its API remains under `/api`. The implementation no longer depends on an always-running process for chat updates.

## 3. Configure environment variables

Add backend values only to the **backend Vercel project**. Add only `VITE_API_URL` to the frontend project. Do not prefix a secret with `VITE_`; Vite variables are public in the browser bundle.

| Variable | Project | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | Backend | Enables strict production configuration and storage requirements. |
| `DATABASE_URL` | Backend | PostgreSQL connection URL. Takes precedence over individual `DB_*` values. Never log or paste it into support messages. |
| `DB_SSL_CA` | Backend, optional | PEM CA certificate if the provider needs a custom CA. TLS certificate verification remains enabled. |
| `DB_POOL_MAX=3` | Backend | Conservative per-function pool size. Increase only after calculating provider connection limits against concurrent function instances. Maximum accepted value is 10. |
| `DB_CONNECT_TIMEOUT_MS=5000` | Backend | Connection timeout. |
| `DB_IDLE_TIMEOUT_MS=10000` | Backend | Idle pool connection timeout. |
| `DB_STATEMENT_TIMEOUT_MS=15000` | Backend | Database statement timeout. |
| `JWT_SECRET` | Backend | Unique signing secret, at least 32 random bytes. |
| `CUSTODY_CODE_HMAC_KEY` | Backend | Separate secret, at least 32 bytes, used to hash custody codes. Must not equal `JWT_SECRET`. |
| `BLOB_READ_WRITE_TOKEN` | Backend | Server-side credential for the connected **private** Blob store and scoped client-upload tokens. Keep it in Vercel’s encrypted environment settings. |
| `PRIVATE_STORAGE_DRIVER=blob` | Backend | Requires durable private Blob storage in production. The app fails closed if production is configured for local disk. |
| `PRIVATE_STORAGE_ENVIRONMENT` | Backend, cleanup only | Set to `preview` or `production` when using the orphan-prune utility. It must match the private Blob scope marker. |
| `PRIVATE_STORAGE_SCOPE_ID` | Backend, cleanup only | Unique non-secret identifier for that environment’s dedicated private Blob store, 8–80 letters/numbers/`_`/`-`. Preview and Production must use different stores and IDs. |
| `PRUNE_EXPECTED_DATABASE_NAME` | Backend, cleanup only | Exact database name expected by the prune utility; it is compared with PostgreSQL `current_database()` before planning and before each deletion. |
| `ALLOWED_ORIGINS` | Backend | Comma-separated exact frontend origins, no paths. Use HTTPS origins in Production. |
| `CHAT_PROOF_MAX_BYTES=8388608` | Backend, optional | Maximum proof file size (8 MiB). |
| `VITE_API_URL` | Frontend | Public HTTPS backend API base, ending in `/api`. |
| `VITE_NOTIFICATION_POLL_INTERVAL_MS` | Frontend, optional | Notification refresh interval from 30000–300000 ms; defaults to 60000 ms. It is public and contains no secret. |

When using individual database fields instead of `DATABASE_URL`, set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` on the backend project. Production database TLS is always enabled and validates certificates; `DB_SSL_CA` may provide a provider CA. The code removes conflicting `sslmode` URL flags so a URL cannot silently disable validation.

### Generate distinct secrets locally

Run this locally twice, once for each backend secret. Do not send the output to Codex, commit it, or reuse a secret from another project:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set the generated values directly in the backend project’s Vercel Environment Variables. Never put them into frontend settings, source code, `.env.example`, or a GitHub issue.

### Production, Preview, and Development

- **Production:** production database URL, production private Blob store, production-only secrets, and the exact production frontend origin in `ALLOWED_ORIGINS`.
- **Preview:** use a separate non-production database and a separate private Blob store. Generate different JWT and custody HMAC secrets. Allow only the stable Preview frontend domain (or a controlled preview domain) in that backend project’s `ALLOWED_ORIGINS`. Do not point unreviewed previews at production data.
- **Development:** copy `backend/.env.example` to `backend/.env`; local development defaults to private local files and allows `http://localhost:5173`. Copy `frontend/.env.example` to `frontend/.env`. Local uploads use the existing private local directories; Blob credentials are not needed for local tests.

Do not connect one Blob store to both Production and Preview. The prune utility requires a private `lostlink/_cleanup-scope.json` object in each dedicated store containing the exact JSON `{"environment":"preview","scopeId":"<preview-id>"}` or `{"environment":"production","scopeId":"<production-id>"}`. Provision the marker once from a controlled backend operations environment after verifying the selected Vercel project and token. With the backend package installed and that store’s private Blob token set in the controlled shell, create it exactly once:

```js
const { put } = await import('@vercel/blob')
const marker = JSON.stringify({ environment: process.env.PRIVATE_STORAGE_ENVIRONMENT, scopeId: process.env.PRIVATE_STORAGE_SCOPE_ID })
await put('lostlink/_cleanup-scope.json', marker, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' })
```

If the object already exists, stop and compare its contents; do not overwrite a mismatched marker. The utility reads and compares this marker before planning and again before every deletion. A missing, unreadable, or mismatched marker stops cleanup. The marker does not replace the requirement for separate stores.

## 4. Initialize or update PostgreSQL safely

The repository has no automatic migration runner and does not apply migrations during app startup. The current migration order is:

1. `database/migrations/001_initial_schema.sql` — base schema and PostGIS.
2. `database/migrations/002_add_stale_match_status.sql` — adds the stale-match status constraint.
3. `database/migrations/003_claim_photo_sharing.sql` — claim-scoped photo sharing history.
4. `database/migrations/004_authorities_and_custody.sql` — authority destinations/memberships and separate custody records.
5. `database/migrations/005_chat_proof_and_read_receipts.sql` — idempotency, read state, and proof requests/attachments.

There is no migration tracking table. Migration 001 is largely repeatable, but the other files contain ordinary `ALTER`/`CREATE` statements and must not be run twice. For a new empty database, confirm the target connection and backup location, enable PostGIS, then apply each file exactly once in order. For an existing database, inspect its schema and determine the last applied migration before running anything; do not infer migration state from the app version.

### Keep the current local reports and accounts

If you want the hosted site to contain the users, reports, claims, matches, and history from your current local `lostlink` database, migrate that database’s data and schema to the managed provider. Creating a blank hosted database and applying the migrations creates an empty application; it does not copy local records. Take and verify a protected `pg_dump` backup first, create the managed target with compatible PostGIS support, then use the provider’s supported PostgreSQL restore/migration procedure to restore the dump. Keep the dump outside the repository and do not paste either database URL into chat, Git, or logs. After restore, verify all five migration-era schemas and PostGIS objects before pointing Vercel at the target. Do not apply migrations 001–005 again to a restored database. If you instead want a fresh start, use the empty-database migration procedure below and understand that the existing local records are not carried over.

For an empty database, one PowerShell approach is:

```powershell
# Set DATABASE_URL in this shell from your provider's secret manager; do not commit it.
pg_dump "$env:DATABASE_URL" --format=custom --file "C:\Backups\lostlink-before-deploy.dump"

psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/001_initial_schema.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/002_add_stale_match_status.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/003_claim_photo_sharing.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/004_authorities_and_custody.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/005_chat_proof_and_read_receipts.sql
```

Store the backup outside the repository, verify it can be listed/restored, and confirm the database name and host before executing each migration. Do not run demo or seed scripts against Production. Afterward, verify the PostGIS extension, tables, constraints, indexes, triggers, and the central authority record in the provider console. Do not put connection strings in screenshots or logs.

## 5. Configure private file storage

In the Vercel dashboard, create a Blob store with **Private** access and connect it to the backend project. The SDK uses authenticated private reads; every application photo/proof retrieval first checks the current application authorization and then streams the private object through the backend. No public Blob URL is returned as the app’s photo access mechanism. Browser uploads use a short-lived, path- and content-type-scoped capability after backend authorization; it is not the store credential.

The Blob object names use the existing database storage keys under separate `lostlink/item-photos/` and `lostlink/proof-attachments/` prefixes. No database schema migration is required. Production fails closed if private storage is not configured. Local disk remains only a private development/test adapter; it is never selected in Production. Photo and proof permissions remain separate.

### Move existing local files

The app does not copy local files at startup. Existing local files need to be moved before switching the Production backend to Blob:

1. Back up PostgreSQL and the existing private directories.
2. Configure the destination Blob credentials in a secured environment and set `PRIVATE_STORAGE_DRIVER=blob` for the migration process. Configure `PRIVATE_PHOTO_DIR` and `PRIVATE_PROOF_DIR` to the exact local source folders when they differ from the defaults. Relative paths are resolved from the backend process working directory, the same as application local storage.
3. Confirm both configured folders exist, then run a dry run from `backend`: `node scripts/migrate-local-private-files-to-blob.js`. The script reads selected source files and checks content; it does not copy during dry run.
4. Review the counts and missing/unsupported-file errors without exposing filenames.
5. Run `node scripts/migrate-local-private-files-to-blob.js --execute` to copy and verify object hashes.
6. Confirm authorized private retrieval works for each workflow. The utility preserves all database associations and never deletes or rewrites the original files or database rows.

The utility is explicit and non-destructive. Do not run it against Production until the source files, database, and destination private store have been verified.

An interrupted upload can leave a private, unreferenced Blob object. It remains inaccessible through LostLink without authorization and does not change report/claim access. Cleanup is manual, never runs at app startup, and uses a conservative seven-day grace period plus a reviewed candidate manifest.

Before planning cleanup, verify in Vercel that the backend project is connected to its dedicated private store, confirm the target database and backup, then configure `PRIVATE_STORAGE_ENVIRONMENT`, `PRIVATE_STORAGE_SCOPE_ID`, and `PRUNE_EXPECTED_DATABASE_NAME` for that same environment. The command verifies the private scope marker and PostgreSQL `current_database()`; a missing or mismatched identity stops before listing candidates.

From `backend`, generate a private manifest outside the repository (do not share it; it contains object keys):

```powershell
node scripts/prune-private-blob-orphans.js --manifest="$env:TEMP\lostlink-preview-prune.json"
```

Review the manifest’s environment, storage scope, expected database, seven-day grace period, object key, upload time, size, and ETag. Dry run does not delete anything. Do not use a manifest if Preview and Production share a Blob store, or if the target database/store identity is uncertain. To execute only the exact reviewed manifest, use its printed SHA-256 and explicitly repeat the environment and store scope:

```powershell
node scripts/prune-private-blob-orphans.js --execute --manifest="$env:TEMP\lostlink-preview-prune.json" --confirm-environment=preview --confirm-storage-scope=lostlink-preview-unique-id --confirm-manifest-sha256=<printed-sha256>
```

Execution rejects manifests older than 24 hours, rechecks the Blob marker and database name for every candidate, rechecks the database reference immediately before deletion, and verifies the object metadata still matches the approved manifest. Newly referenced, changed, missing, cross-environment, or out-of-prefix objects are never deleted. Any failed database query, provider request, marker check, or object check aborts the run. If identity cannot be verified, do not relax the checks: leave the object in private storage and inspect it manually in the verified environment’s Vercel dashboard only after comparing its key against all relevant database references/backups. Never use a Preview manifest to clean Production.

## 6. Bootstrap the first administrator securely

Public registration continues to create only ordinary `USER` accounts; there is no public administrator-registration endpoint. The application does **not** currently implement email verification. An `ACTIVE` account or an administrator role change does not verify email ownership. Bootstrap only an account whose identity you verified out-of-band. Back up first and use a restricted SQL session. Do not execute the whole sequence as one batch; keep the transaction open while inspecting the returned row:

```sql
BEGIN;
UPDATE users
SET role = 'ADMIN'
WHERE lower(email) = lower('<ADMIN_EMAIL>')
  AND account_status = 'ACTIVE'
RETURNING user_id, email, role;
```

Inspect the returned row while the transaction remains open. If it is not exactly the intended account with role `ADMIN`, run `ROLLBACK;` separately. Only after confirming the account, run `COMMIT;` as a separate command. Query the account again and verify admin-only permissions afterward. Record the operator, date/time, account ID/email, reason, approving authority, and transaction outcome in the organization’s out-of-band security/audit record; do not include credentials.

Do not create an admin from a browser request, do not elevate an unknown account, and do not share the account password. Keep this procedure in a controlled operations record. To revoke access, set the role back to `USER` from the same restricted console and terminate existing sessions by rotating `JWT_SECRET` if necessary.

## 7. Chat and serverless behavior

The old long-lived SSE subscription has been removed. The client refreshes the authorized conversation history every five seconds; PostgreSQL remains the source of truth, and each poll reauthorizes the current user and current authority membership. Existing message idempotency prevents duplicate sends after retries, and a reconnect recovers by fetching stored history. This is near-real-time polling, not a persistent WebSocket connection. Expected update delay is up to about five seconds plus request latency. While the app is open, unread notification counts and an open notification list refresh once a minute by default. `VITE_NOTIFICATION_POLL_INTERVAL_MS` may be set from 30000 to 300000 milliseconds; polling pauses while unauthenticated or the tab is hidden, avoids overlapping refreshes, and resumes on visibility/focus events.

The chat and notification polling architectures have unit coverage, but neither has been exercised against a deployed Vercel project. Verify them in a Preview deployment before Production. If lower-latency push delivery becomes a requirement, use a separately hosted realtime service rather than assuming a Vercel function keeps a connection alive.

## 8. Deploy and verify

1. Review the uncommitted code and tests locally. Commit and push only when you are ready; this task has not committed or pushed anything.
2. Create the backend Vercel project with root `backend`, Node 22.x, and the backend environment variables above.
3. Create the private Blob store and connect it to that backend project.
4. Create the frontend project with root `frontend`, Vite, build `npm run build`, output `dist`, and `VITE_API_URL` set to the backend HTTPS URL ending in `/api`.
5. Set backend `ALLOWED_ORIGINS` to the frontend domain exactly. Add the Preview domain separately in the Preview backend environment.
6. Deploy a Preview first and verify `https://<backend-domain>/api/health` returns only `{"status":"ok"}` and `https://<frontend-domain>/` loads.
7. Test login/registration with an ordinary user, report creation and matching, both direct and authority-assisted claim flows, private photo upload/read/share/revoke, proof upload/download, chat message retry, notifications, and claim handover. Confirm unauthenticated and unrelated users cannot retrieve private files.
8. Check Vercel Function logs for configuration/database errors. Logs should not contain secrets, full connection strings, raw custody codes, file content, private notes, or object keys.
9. Only after Preview checks pass, configure Production variables, verify the Production database backup and migration state, and deploy Production.

## 9. Backups, rollback, and recovery

- Before any Production schema migration, take and verify a managed database backup plus a `pg_dump` backup. Keep it outside this repository and protect its credentials.
- Database migrations have no automated rollback scripts. If an additive migration causes trouble after data has been written, restore the backup into a separate database and point the app to that database after validation; do not drop tables or reverse populated history blindly.
- For application-only regressions, promote a known-good Vercel deployment. Keep the same database and private Blob store unless a separate recovery plan authorizes a switch.
- Keep local private photo/proof originals until Blob copy verification and application retrieval checks pass. The migration utility never removes them.
- Keep a record of which migration files were applied because this repository does not maintain a schema version table.

## 10. Troubleshooting

- **Frontend says `VITE_API_URL` is missing/invalid:** set the frontend Production/Preview variable to an HTTPS API base ending exactly in `/api`, then rebuild.
- **Browser reports a CORS error:** compare the browser’s exact frontend origin to backend `ALLOWED_ORIGINS` (scheme, hostname, and port; no path), and redeploy the backend after updating the correct environment.
- **Database TLS/connection failure:** use the provider’s TLS-enabled URL, confirm the certificate chain and optional `DB_SSL_CA`, and check the provider’s connection-pooler/direct URL guidance. Do not disable certificate verification.
- **PostGIS type/function missing:** enable PostGIS and confirm the API database user’s `search_path` includes the schema where the extension is installed before running the schema migration.
- **Photo/proof upload fails or returns 413:** confirm uploads use the production client-upload endpoints, the connected store is private, `BLOB_READ_WRITE_TOKEN` is available to the backend, and the file is within the configured 8 MiB limit. Browser uploads go directly to Blob to avoid the function body cap.
- **Private media returns 403/404:** confirm current claim, conversation, authority membership/custody, or photo-share state. A private file is not made public to fix an authorization error.
- **Database connection exhaustion:** lower per-function `DB_POOL_MAX`, enable the provider’s connection pooler, or increase database capacity based on observed concurrency.
- **Chat message updates seem delayed:** polling is every five seconds by design; check the browser Network panel and backend/API health. The database remains the source of truth.
- **Blob upload token/callback fails:** keep Vercel system environment variables enabled, check backend deployment URL configuration and function logs, and do not paste Blob tokens into a support ticket.

## Provider and dashboard work still required

The application code is prepared, but manual setup remains: choose the PostgreSQL/PostGIS provider and create a database; verify backups and migration state; create a **private** Blob store and connect it to the backend project; set Production, Preview, and Development environment variables; create the two Vercel projects with the root settings above; set CORS origins and custom domains; perform Preview smoke tests; bootstrap the first administrator; then decide when to promote Production. No provider accounts or secrets are assumed to exist.
