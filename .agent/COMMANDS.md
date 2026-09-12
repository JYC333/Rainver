# Commands

## Quick Start

```bash
# Enable the package-manager version pinned by the root package.json and install
# every workspace package from the single pnpm lockfile.
corepack enable
pnpm install --frozen-lockfile

# Start everything (Docker Compose). First run creates ~/.rainver-data/dev/.env from template.
# The start script applies the committed migration chain before the app services
# start; it never generates a migration (that is a developer step, below).
./ops/scripts/start.sh

# Other profiles
./ops/scripts/start.sh --test
./ops/scripts/start.sh --prod

# Force rebuild images (dev/test only; prod never builds on the host)
./ops/scripts/start.sh --build

# Start in the background (docker compose up -d). Every service carries
# `restart: unless-stopped`, so a detached stack also comes back after a host
# reboot once Docker is up.
./ops/scripts/start.sh --prod --detach

# Production images: CI (.github/workflows/ci.yml, publish-images job) builds
# server, frontend, sandbox-runner, and deployer after the verify job passes
# and pushes them to ghcr.io/jyc333/rainver-<name>. dev pushes tag `edge`,
# master pushes `stable`, every push also tags `sha-<commit>`. The prod
# compose file pulls `${RAINVER_IMAGE_TAG:-stable}`; set RAINVER_IMAGE_TAG in
# $RAINVER_ROOT/prod/.env to follow edge or pin/roll back to a sha tag. The
# checkout on a prod machine exists only for these scripts and compose files.
# Update a running prod instance (pull images, migrate with pg_dump, recreate):
git pull && ./ops/scripts/start.sh --prod --detach
# Roll back: set RAINVER_IMAGE_TAG=sha-<previous commit> and run the same command.
# The GHCR packages are linked to this repository by the workflow push and
# inherit its public visibility; a prod machine pulls without logging in.
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

# Schema changes: edit server/src/db/schema/, then append the migration
# drizzle-kit derives from the diff. server/migrations/ is an append-only
# chain — 0000_baseline.sql is frozen, and a file any database has applied is
# never edited (the runner records checksums and refuses a changed one).
# Review the generated SQL and add data backfills to it before it is applied
# anywhere; use --custom for an empty file when drizzle-kit cannot derive the
# change (extension, backfill). schema:check is no-write: chain shape,
# declared extensions, and schema drift (prints the SQL a missing migration
# would contain); migrate.sh and the prod image build run it. No database is
# needed for either command. See server/migrations/README.md.
pnpm run schema:generate -- --name add_widget_color
pnpm run schema:generate -- --custom --name enable_pg_trgm
pnpm run schema:check

# A migration that removes something the *running* release still reads cannot
# be applied under a live server. Mark it with `-- rainver:maintenance` on a line of its own near the top
# of the SQL file (the runner scans the first 20 lines): `start.sh` and the UI update then refuse it
# and name the offline command instead (ADR 0016 §10). The distinction
# is compatibility with the running version, not whether a database changes.
SERVER_DATABASE_URL=postgresql://... node dist/db/migrateCli.js maintenance-pending  # exit 10 = pending
```

For the default Docker Compose setup, Postgres is **not** published to the host, so prefer the
ops helper below over direct host migrations.

Offline maintenance upgrade — the only way a maintenance-marked migration is
applied. It pulls images, waits for Runs to finish (never killing one), stops
frontend/server/sandbox-runner/deployer while keeping PostgreSQL, takes the
dump, applies the migration only if the dump succeeded, then starts again. On
failure it leaves the applications stopped, keeps the dump, and rolls nothing
back: restoring is an explicit decision, and changing image tags alone is not
a recovery.

```bash
./ops/scripts/start.sh --prod --maintenance
MAINTENANCE_DRAIN_SECONDS=1800 ./ops/scripts/start.sh --prod --maintenance
```

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
# Run committed migrations (Docker-native by default: the server migration runner
# runs inside a one-shot server container, using the in-network postgres service).
# The normal start script invokes this helper before app services start. The
# helper runs the no-write schema check, then Docker-native mode creates
# POSTGRES_DB when it is missing, then applies every pending migration in order.
# Production image builds also run the same schema check.
./ops/scripts/db/migrate.sh [--mode dev|test|prod]

# Host mode: only when DATABASE_URL points to a reachable external Postgres
# (runs the server migration runner from server/; needs the Node toolchain).
DATABASE_URL=postgresql://... ./ops/scripts/db/migrate.sh --host [--mode dev|test|prod]

# Pre-migration backup: --mode prod ALWAYS takes a pg_dump custom-format dump to
# $RAINVER_ROOT/<mode>/db/dumps/pre-migrate-<ts>.dump before migrations run, and
# aborts if it fails. Opt into the same safety for non-prod modes:
PRE_MIGRATION_BACKUP=1 ./ops/scripts/db/migrate.sh --mode dev
./ops/scripts/db/migrate.sh --mode dev --pre-migration-backup

# Dump database to $RAINVER_ROOT/<mode>/db/dumps/
./ops/scripts/db/dump.sh

# Restore database from a pg_dump custom-format archive
./ops/scripts/db/restore.sh <path/to/dump.dump> [--mode dev|test|prod]

# Save the current dev database as the private reset baseline. The archive is
# written to $RAINVER_ROOT/dev/setup/database.dump (0600), outside the repo. It
# includes encrypted credential rows; CLI login files and provider_keys.key
# remain in $RAINVER_ROOT/dev/secrets.
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

# Sensitive credential and deployment environment material is intentionally separate from normal data archives.
./ops/scripts/system/backup-credentials.sh [--mode dev|test|prod]
# Defaults to restoring secrets and publishing .env.restored for operator review.
./ops/scripts/system/restore-credentials.sh <credential-archive.tar.gz> [--mode dev|test|prod] [--force] [--restore-env]
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

# Tests. A DOM test that fails at ~15s spent `asyncUtilTimeout`
# (src/test/setup.ts) waiting for something that never arrived. Under machine
# load that shows up as a *rotating* failure — a different test each run —
# which reads as flakiness but has been a real render race every time: an
# effect from mount flushing after the click the test just made. Reproduce it
# by running the one file in a loop rather than by re-running the suite.
# `maxTestMs` in src/test/perf-budget.json stays above that ceiling so such a
# failure is reported as a failure, not as a budget violation.
#
# Run this suite alone: its budget *totals* are per-file sums that inflate
# with parallelism, so running it beside the server suite trips the gate
# (~130s/390s against 90s/240s limits) on a suite that is ~60s/185s when it
# has the machine to itself.
pnpm test
```

Docker dev/test frontend services keep `node_modules` inside a container volume.
Their dev entrypoint hashes the root workspace files, `pnpm-lock.yaml`, and package
manifests, then runs `pnpm install --frozen-lockfile` automatically when those
dependency inputs change.

## Runtime CLI copies

A vendor CLI is installed on an **execution host** — the built-in one inside
`sandbox-runner`, or a paired machine — never into the server image and never
into `$RAINVER_HOME`. The Command Center's host card is the place to do it:
"Add agent…" installs a managed copy, "Log in" opens its login terminal, and
"Roll back to <version>" undoes the last upgrade.

The same actions over the API (host owner, or an instance admin for the
built-in host):

```bash
# Install or upgrade the managed copy of one runtime on one host.
curl -X POST http://localhost:3000/api/v1/hosts/<host-id>/installations/claude_code \
  -H "Authorization: Bearer <token>"

# Undo the last upgrade, promoting the version the host kept behind it —
# keeping the latest login and native history in the stable managed HOME.
curl -X POST http://localhost:3000/api/v1/hosts/<host-id>/installations/claude_code/rollback \
  -H "Authorization: Bearer <token>"

# What each copy has left of its subscription (cached), and a fresh reading.
curl http://localhost:3000/api/v1/hosts/<host-id>/usage -H "Authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/hosts/<host-id>/installations/claude_code/own/usage \
  -H "Authorization: Bearer <token>"

# What has changed about every host's runtimes, newest first.
curl http://localhost:3000/api/v1/hosts/runtime-changes -H "Authorization: Bearer <token>"
```

One current version per adapter per host, plus exactly one kept behind it as
the rollback target. An upgrade drains that copy's Runs first and refuses
rather than killing one, so "still in use" is an ordinary answer. There is no
per-Space version policy: the copy a Run uses is decided by the Agent's host
and installation.

## Linux execution host

The public rolling releases are built by
`.github/workflows/host-daemon-release.yml`: `master` publishes `stable`, each
relevant `dev` push publishes `edge`, and the nightly schedule publishes
`nightly` from `dev`. Generate a pairing code in the Hosts panel, install the
self-contained stable build on the target host, then register through the CLI:

```bash
curl -fsSL https://github.com/JYC333/Rainver/releases/download/host-installer/install-host.sh | bash
rainver-host register --server https://rainver.example.com --code <pairing-code>

# Opt-in automatic latest checks, or update once manually:
rainver-host update --auto-update
rainver-host update
rainver-host update --channel edge

# Disconnect this machine permanently:
rainver-host unregister
```

See `packages/host-daemon/README.md` for service/log commands and the
headless-login lingering note.

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
  pg_isready -U Rainver -d Rainver
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
| `BUILTIN_HOST_MAX_CONCURRENT_RUNS` | `3` | Runs the built-in execution host executes at once; bubblewrap has no cgroups, so this and the `sandbox-runner` container's own `cpus`/`mem_limit` are the only capacity levers |
| `ARTIFACT_STORAGE_ROOT` | `$RAINVER_HOME/storage/artifacts` | Managed artifact file storage root used by server artifact export |
| `SERVER_DATABASE_URL` | generated by ops scripts | Server PostgreSQL owner/app URL for bundled compose |
| `SERVER_INTERNAL_TOKEN` | generated by ops scripts | Service token for internal server routes |
| `SERVER_DEBUG` | `false` | Server debug flag for local-only cookie defaults; legacy `DEBUG` is accepted only for old env files |
| `SERVER_TRUSTED_PROXY_HOST` | unset (Compose: `frontend`) | In-network hostname of the frontend proxy; the only peer whose `X-Forwarded-*` is believed, re-resolved every 30 s |

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
curl http://localhost:3000/api/v1/runs/<run_id>/turn \
  -H "Authorization: Bearer <token>"
curl http://localhost:3000/api/v1/runs/<run_id>/turn/stream \
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
