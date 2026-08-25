# Commands

## Quick Start

```bash
# Enable the package-manager version pinned by the root package.json and install
# every workspace package from the single pnpm lockfile.
corepack enable
pnpm install --frozen-lockfile

# Start everything (Docker Compose). First run creates ~/.aspace/dev/.env from template.
# The start script runs `pnpm run schema:generate` from server/ before image build
# and migration, so TypeScript schema edits are converted to generated artifacts.
./ops/scripts/start.sh

# Other profiles
./ops/scripts/start.sh --test
./ops/scripts/start.sh --prod

# Force rebuild images
./ops/scripts/start.sh --build
```

## Server

```bash
cd server

# Build/typecheck/test
pnpm run build
pnpm run typecheck
pnpm test

# Local iteration: run only the files for the module you touched. The full
# server suite is ~1:40 (web ~40s); one file is 5–20s. Real-Postgres files
# work alone — each clones its own database from the shared template.
pnpm exec vitest run test/memoryApply*                 # a file or glob
pnpm exec vitest run test/roomsDb.test.ts -t "dedupe"  # one test by name
# Do not reach for `vitest --changed` / `vitest related` here: the backend
# import graph is one large cycle, so a single source change selects a
# quarter of the suite (~70s) — barely faster than running everything.
# Run the full suite before committing, or leave it to CI, which runs it on
# every push. Every run prints the ten slowest files by import and test time.

# Real-Postgres tests share one tuned container and reuse it across local runs.
# Opt out when a CI/job boundary requires the container to be stopped afterward.
TESTCONTAINERS_REUSE_ENABLE=false pnpm test

# Explicit schema migrations
SERVER_DATABASE_URL=postgresql://... pnpm run migrate:status
SERVER_DATABASE_URL=postgresql://... pnpm run migrate

# Schema changes: edit server/src/db/schema/, then generate SQL artifacts.
# schema:generate refreshes the empty-database baseline under
# server/drizzle/0000_baseline.sql, with rollback protection.
# The runtime schema is ONE file, server/migrations/0001_baseline.sql: no
# deployment carries data predating it, so a change is folded in rather than
# appended as a numbered upgrade. After schema:generate, copy the Drizzle
# baseline over it (see server/migrations/README.md). schema:check is no-write
# and validates that the schema, the Drizzle baseline and the runtime baseline
# all agree, plus the single-file rule; start.sh runs it before applying
# migrations. No database is needed for either command.
# Rewriting the baseline means recreating the database: the runner refuses a
# changed already-applied file, so run ops/scripts/db/reset-postgres.sh first.
pnpm run schema:generate
pnpm run schema:check
```

For the default Docker Compose setup, Postgres is **not** published to the host, so prefer the
ops helper below over direct host migrations.

Default client-facing API (server): http://localhost:3000/api/v1

In dev/test Docker Compose, server hot reload is enabled: the service
uses the Dockerfile `dev-runtime` target, bind-mounts `server/src` and
`packages/protocol/src`, uses `server/scripts/watch-typescript.mjs` to poll
those bind mounts plus official plugin packages, compile protocol, server, and
official plugins in order, and restart with `node --watch dist/index.js`. This
avoids native watcher failures on Docker bind mounts. Prod still runs compiled
JS only.

## Database scripts (run from repo root)

```bash
# Run generated migrations (Docker-native by default: the server migration runner
# runs inside a one-shot server container, using the in-network postgres service).
# The normal start script first runs schema:generate, then invokes this helper
# before app services start. The helper runs a no-write Drizzle schema check,
# then Docker-native mode creates POSTGRES_DB when it is missing, then applies
# the committed migration SQL. Production image builds also run the same schema
# check.
./ops/scripts/db/migrate.sh [--mode dev|test|prod]

# Host mode: only when DATABASE_URL points to a reachable external Postgres
# (runs the server migration runner from server/).
DATABASE_URL=postgresql://... ./ops/scripts/db/migrate.sh --host [--mode dev|test|prod]

# Pre-migration backup: --mode prod ALWAYS takes a pg_dump custom-format dump to
# $ASPACE_ROOT/<mode>/db/dumps/pre-migrate-<ts>.dump before migrations run, and
# aborts if it fails. Opt into the same safety for non-prod modes:
PRE_MIGRATION_BACKUP=1 ./ops/scripts/db/migrate.sh --mode dev
./ops/scripts/db/migrate.sh --mode dev --pre-migration-backup

# Dump database to $ASPACE_ROOT/<mode>/db/dumps/
./ops/scripts/db/dump.sh

# Restore database from a pg_dump custom-format archive
./ops/scripts/db/restore.sh <path/to/dump.dump> [--mode dev|test|prod]

# Save the current dev database as the private reset baseline. The archive is
# written to $ASPACE_ROOT/dev/setup/database.dump (0600), outside the repo. It
# includes encrypted credential rows; CLI login files and provider_keys.key
# remain in $ASPACE_ROOT/dev/secrets.
./ops/scripts/db/save-dev-setup.sh

# Drop + restore the private dev setup baseline when present + migrate.
# Test/prod never consume the dev baseline. Use --no-dev-setup for a genuinely
# empty dev database.
./ops/scripts/db/reset-postgres.sh [--mode dev|test|prod]
./ops/scripts/db/reset-postgres.sh --mode dev --no-dev-setup

# Open a psql shell
./ops/scripts/db/shell.sh [--mode dev|test|prod]
```

## Backup and restore (run from repo root)

```bash
# Full-system backup with app services stopped (PostgreSQL snapshot + files + manifest).
# Stop frontend, server, and deployer first; postgres must remain running.
# When the server is running, the BackupService API is canonical:
#   POST /api/v1/system/backups/manual
./ops/scripts/system/backup.sh [--mode dev|test|prod] [--include-logs] [--force-running]

# Full-system restore (database + files) from one archive.
# Stop frontend, server, and deployer first; postgres must remain running.
./ops/scripts/system/restore.sh <archive.tar.gz> [--mode dev|test|prod] [--force] [--force-running]

# Credential material is intentionally separate from normal data archives.
./ops/scripts/system/backup-credentials.sh [--mode dev|test|prod]
./ops/scripts/system/restore-credentials.sh <credential-archive.tar.gz> [--mode dev|test|prod] [--force]
```

See [docs/BACKUP_AND_RESTORE.md](../docs/BACKUP_AND_RESTORE.md) for the full model.

## Frontend

```bash
cd apps/web

# Run (development, with hot reload)
pnpm run dev
# → http://localhost:5173

# Build for production
pnpm run build

# Preview production build
pnpm run preview

# Lint  [TODO: configure eslint]
# pnpm run lint
```

Docker dev/test frontend services keep `node_modules` inside a container volume.
Their dev entrypoint hashes the root workspace files, `pnpm-lock.yaml`, and package
manifests, then runs `pnpm install --frozen-lockfile` automatically when those
dependency inputs change.

## Runtime CLI tools

Vendor CLIs are installed as instance runtime tools, not into Docker images.
Only the user whose email matches `INSTANCE_ADMIN_EMAIL` may install or activate
versions. Use the server API after the stack is running:

```bash
curl -X POST http://localhost:3000/api/v1/runtime-tools/claude_code/install \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"version":"latest"}'

curl -X POST http://localhost:3000/api/v1/runtime-tools/codex_cli/install \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"version":"latest"}'

curl http://localhost:3000/api/v1/runtime-tools \
  -H "Authorization: Bearer <token>"
```

Tools are written under `$AGENT_SPACE_HOME/runtime-tools`; npm cache is under
`$AGENT_SPACE_HOME/cache/npm`. Space owners/admins select enabled/default
versions through `PUT /api/v1/runtime-tools/space-policy/{runtime}`.

## Docker

```bash
# Start all services (dev mode — default)
docker compose -f ops/compose/docker-compose.dev.yml up

# Rebuild and restart
docker compose -f ops/compose/docker-compose.dev.yml up --build

# Recreate the server service
docker compose -f ops/compose/docker-compose.dev.yml up server --force-recreate

# View logs
docker compose -f ops/compose/docker-compose.dev.yml logs -f server

# Check PostgreSQL health
docker compose -f ops/compose/docker-compose.dev.yml exec postgres \
  pg_isready -U agent_space -d agent_space
```

## Environment Variables

See `ops/env/.env.dev.example`, `.env.test.example`, and `.env.prod.example`
for the full list. `ops/scripts/start.sh --prod` rejects empty, placeholder, and
development `POSTGRES_PASSWORD` values. Key vars:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | postgresql://... | Optional external DB URL for host-side DB scripts |
| `DEFAULT_USER_ID` | `default_user` | Bootstrap owner; the default space is this owner's personal space (a generated UUID, no fixed space id) |
| `REFLECTOR_MODE` | `pattern` | Set to `llm` to enable AI reflection |
| `MAX_CONCURRENT_DOCKER_RUNS` | `3` | Sandbox concurrency cap |
| `ARTIFACT_STORAGE_ROOT` | `$AGENT_SPACE_HOME/storage/artifacts` | Managed artifact file storage root used by server artifact export |
| `SERVER_DATABASE_URL` | generated by ops scripts | Server PostgreSQL owner/app URL for bundled compose |
| `SERVER_INTERNAL_TOKEN` | generated by ops scripts | Service token for internal server routes |
| `SERVER_DEBUG` | `false` | Server debug flag for local-only cookie defaults; legacy `DEBUG` is accepted only for old env files |
| `RUNTIME_TOOLS_ROOT` | `$AGENT_SPACE_HOME/runtime-tools` | Instance runtime CLI install root |

Providers/credentials, policy enforcement, public sessions, native auth/spaces,
runs, chat turns, context assembly, memory read/proposal-create/apply,
proposal review/apply orchestration, artifact read/export, and the runtime
adapter catalog are fixed server authorities.

## Focused Runs Verification

Focused verification commands from repo root:

```bash
cd packages/protocol
pnpm run typecheck && pnpm test && pnpm run build

cd ../server
pnpm run typecheck
pnpm exec vitest run \
  test/evidenceRedaction.test.ts \
  test/runOrchestrationService.test.ts \
  test/runMaterializationService.test.ts \
  test/runManagedApiAdapter.test.ts \
  test/runVendorCliAdapter.test.ts \
  test/runsRoutes.test.ts \
  test/runtimeHost.test.ts \
  test/config.test.ts \
  test/features.test.ts \
  test/boundaries.test.ts
pnpm run build

```

## SQL Guards

Two layers, both prepare real statements against a migrated schema so a bad
column, an ambiguous reference, or a parameter typed two ways fails at test
time instead of in a rarely-taken production branch.

`test/staticSqlPrepare.test.ts` runs in any normal `vitest run` and covers SQL
written as a complete literal. Runtime-assembled SQL (column-list constants,
clause helpers, builder-generated parameter numbering) is invisible to it, so
that half is captured while the suites run and prepared afterwards:

```bash
cd server
rm -rf .tmp/sql-capture
SQL_CAPTURE_DIR=$PWD/.tmp/sql-capture pnpm exec vitest run
SQL_CAPTURE_DIR=$PWD/.tmp/sql-capture pnpm exec vitest run test/capturedSqlPrepare.test.ts
```

Only statements issued from `src/` are recorded; test fixtures build rows with
their own SQL, including deliberately invalid values. Coverage equals whatever
the DB-backed suites exercise — it rises with test coverage rather than being a
guarantee. Without `SQL_CAPTURE_DIR` the capture shim is inert.

## Model Limit Registry

`server/src/modules/providers/modelSpecs.ts` is the single source for per-model
context windows and output guidance; both Runtime Context planning and provider
request building read it. Every row carries `source` and `verifiedOn`, and
`test/modelSpecs.test.ts` prints how stale the oldest row is on each run. When
adding a model or touching a figure, re-read the vendor page in `source` and
move `verifiedOn` to that day.

## Product acceptance

Run the deterministic product gate from the repository root:

```bash
./ops/scripts/product-acceptance-gate.sh
```

The manual acceptance script, evidence requirements, and opt-in real-provider
smoke setup are documented in
[`architecture/PRODUCT_ACCEPTANCE.md`](architecture/PRODUCT_ACCEPTANCE.md).
The real smoke is never part of the canonical suite and requires dedicated
test data plus explicit short-lived credentials:

```bash
./ops/scripts/product-acceptance-real-smoke.sh
```

Manual stack smoke after a reset/rebuild:

```bash
./ops/scripts/db/reset-postgres.sh --mode dev
./ops/scripts/start.sh --dev --build

# Use a real auth cookie/header from the web session.
curl -X POST http://localhost:3000/api/v1/runs/<run_id>/execute \
  -H "Authorization: Bearer <token>"
curl -X PATCH http://localhost:3000/api/v1/runs/<run_id>/stop \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual smoke"}'
curl http://localhost:3000/api/v1/runs/<run_id>/trace \
  -H "Authorization: Bearer <token>"
curl http://localhost:3000/api/v1/runs/<run_id>/events/stream \
  -H "Authorization: Bearer <token>"
```

## Focused Policy/Proposals Verification

Focused verification commands from repo root:

```bash
cd packages/protocol
pnpm run typecheck && pnpm test && pnpm run build

cd ../server
pnpm run typecheck
pnpm exec vitest run \
  test/policyDecisionCore.test.ts \
  test/policyDecisionContract.test.ts \
  test/policyEnforceService.test.ts \
  test/policyRoutes.test.ts \
  test/proposalsRoutes.test.ts \
  test/config.test.ts \
  test/features.test.ts \
  test/gateway.test.ts \
  test/boundaries.test.ts
pnpm run build
```
