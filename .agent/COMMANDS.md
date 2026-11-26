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
# In the interactive log view, press d to detach or Ctrl+C to stop the stack.

# Other profiles (from a checkout)
./ops/scripts/start.sh --test
./ops/scripts/start.sh --prod

# Production host without a checkout: one-line bootstrap and start.
curl -fsSL https://github.com/jyc333/rainver/releases/download/prod-stable/install-prod.sh | bash
# It prompts for the administrator email; start.sh generates the DB password.
# To run noninteractively, set RAINVER_ADMIN_EMAIL for the bash process.
# The installer adds ~/.local/bin/rainver; add ~/.local/bin to PATH if needed.
# Host operations after installation:
rainver status
rainver logs -f server
rainver stop
rainver start
rainver restart
rainver restart server
rainver update
rainver version
# start/restart use existing images; update downloads the current verified
# production bundle, backs up/migrates, and starts the matching images.

# Force rebuild images (dev/test only; prod never builds on the host)
./ops/scripts/start.sh --build

# Start in the background (docker compose up -d). Every service carries
# `restart: unless-stopped`, so a detached stack also comes back after a host
# reboot once Docker is up.
./ops/scripts/start.sh --prod --detach

# Production images: CI (.github/workflows/ci.yml, publish-images job) builds
# server, frontend, sandbox-runner, and deployer after the verify job passes
# and pushes all four by `sha-<commit>` to ghcr.io/jyc333/rainver-<name>.
# Promotion then advances `edge` for dev or `stable` for master. The
# production start path resolves the channel from the server and pulls the
# complete release by SHA. CI reuses already-published commit images on reruns.
# Set RAINVER_IMAGE_TAG in
# $RAINVER_ROOT/prod/.env to follow edge or pin/roll back to a sha tag. The
# checkout is optional on a prod machine; the standalone bundle carries the
# scripts, compose files, and migration files for host-side inspection.
# Update a running prod instance (pull images, migrate with pg_dump, recreate):
# Checkout deployment: update ops and recreate the stack.
git pull && ./ops/scripts/start.sh --prod --detach
# Standalone deployment: rainver update (or rerun the one-line installer).
# For a pinned bundle: rainver update --sha <40-character commit SHA>
# An existing prod .env must set RAINVER_IMAGE_TAG=sha-<same commit>.
# Rolling back across a database migration also requires a compatible dump restore.
# Use the same selected SHA for restore and the subsequent startup.
# The GHCR packages are linked to this repository by the workflow push and
# inherit its public visibility; a prod machine pulls without logging in.
```

## Test timing semantics

Server/web import, individual-test and cumulative performance budgets are
advisory: measurements, slowest files and exceeded thresholds remain visible,
without changing a completed run's exit status. Reader browser elapsed-time
budgets also warn. Real assertions and runner/configuration errors still fail.

All packages disable Vitest's elapsed-runtime failures with `testTimeout: 0`
and `hookTimeout: 0`; server browser configs inherit these settings. The existing
reporter warns on completed tests or files (including hooks) exceeding 5s;
server/web also keep their end-of-run budget warnings. Functional observation waits still fail when their
expected state never appears. Production safety deadlines are unchanged.

A stuck local test can hang indefinitely. Cancel it with Ctrl-C or the terminal
tool's existing session cancellation. CI retains its outer job timeouts (verify:
45 minutes). A cancelled/unfinished run is **incomplete**, never passed and not
an assertion failure; check the exit/signal even if earlier cases passed. See
[Testing Strategy](architecture/TESTING_STRATEGY.md#execution-deadlines-are-not-completed-performance-measurements)
for warning and cancellation limitations.

```bash
# Focused budget semantics regression checks, from repository root.
# Loads the real package configs; build protocol first (pnpm --filter @rainver/protocol build).
node --test tools/vitest/budgetReporter.test.mjs tools/typescript/prepareIncremental.test.mjs
```

## Server

```bash
cd server

# One verification flow: prepares workspace dependencies once, then checks
# types and runs Vitest without repeating lifecycle prehooks.
pnpm run verify

# Independent entry points still prepare workspace dependencies correctly.
# Warm preparation removes stale compiler output pairs and emits no unchanged
# outputs; missing JS/declarations or a changed lock discard compiler metadata.
# Build/typecheck/test
pnpm run build
pnpm run typecheck
pnpm test

# Integration setup checks official plugin source, protocol build inputs, and
# packaged files by content. A warm matching package is reused. Linux builders
# serialize with flock and stage compilation before publishing cached files.

# Local iteration: run only the files for the module you touched. The full
# server suite is ~1:40 (web ~40s); one file is 5–20s. Real-Postgres files
# work alone — each clones its own database from the shared template.
pnpm exec vitest run --project pure --project pure-isolated  # reviewed pure files, no Docker/plugin setup
pnpm exec vitest run test/memoryApply*                 # a file or glob
pnpm exec vitest run test/roomsDb -t "dedupe"          # one test by name
# A long suite split across entry files (roomsDb.1/2/3.test.ts registering
# roomsDb.suite.ts) is run by its shared prefix, as above.
# Do not reach for `vitest --changed` / `vitest related` here: the backend
# import graph is one large cycle, so a single source change selects a
# quarter of the suite (~70s) — barely faster than running everything.
# Run the full suite before committing, or leave it to CI, which runs it on
# every push. Every run prints the ten slowest files by import and test time.

# The full suite includes two real-Chromium cases (pluginFrontendDb against a
# Vite dev server; taskLifecycleOperationsDb's Task Detail case against the
# built web app). That case refuses up front a missing apps/web/dist, or one
# whose dist/build-inputs.json (the content hash of every file the build read)
# no longer matches the checkout. Prepare them as CI does: Chromium once per
# machine (Playwright Core's locked version picks its matching build), web
# after any change to what it bundles.
pnpm --dir ../apps/web exec playwright-core install chromium
pnpm --filter @rainver/protocol --filter @rainver/reader-document build && pnpm --filter @rainver/web build

# Real-Postgres tests share one tuned container and reuse it across local runs.
# Opt out when a CI/job boundary requires the container to be stopped afterward.
TESTCONTAINERS_REUSE_ENABLE=false pnpm test

# Explicit schema migrations
SERVER_DATABASE_URL=postgresql://... pnpm run migrate:status
SERVER_DATABASE_URL=postgresql://... pnpm run migrate

# Explicit unpublished-plan squash/conversion, independent of environment.
# Default convert is read-only. Apply requires stopped writers and a backup.
# Full procedure: server/migrations/README.md.
pnpm run build
../ops/scripts/db/squash-migrations.sh --help
# Prepare a managed source/target pair, selecting the first unpublished migration.
# prepare and convert --host run on the host and require Node 24.
../ops/scripts/db/squash-migrations.sh prepare --mode dev --from 0001 --name plan_name
# One-command formal Compose cutover (archives auto-matched by content and the
# database's applied history; after several squashes an instance on an older
# source converts pair by pair; the last target may be a prefix of the
# checkout, later migrations then run by normal `up`). This records and stops running/restarting applications,
# backs up, converts, and restores them on success; after a failure, rerun the
# same command to finish and restart the recorded applications.
../ops/scripts/db/squash-migrations.sh cutover --mode test
# --archive DIR is an optional explicit override for external/ambiguous catalogs.
# Generated safety dumps use the shared backup retention count (per schema
# recovery point); managed pairs stay pinned until their database has passed
# the target and all recorded backup dependencies expire. Cleanup is hourly and
# logs a warning while a cutover marker or stale mutex blocks it.
# The one-time 2026-10-22 rebase of 0001 and restoring backups from before it:
# server/migrations/README.md.

# Schema changes: edit server/src/db/schema/, then append the migration
# drizzle-kit derives from the diff. This epoch starts from the single
# server/migrations/0000_baseline.sql; after release it is frozen and future
# migrations append to it. A file any database has applied is never edited.
# Databases/backups from the previous schema epoch cannot be upgraded or
# restored into this one; instances must be recreated from the new baseline.
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
# 0017_isolated_workspaces_and_retention includes former 0020: the previous release's source
# claim fails once its key is replaced (server/migrations/README.md).
SERVER_DATABASE_URL=postgresql://... node dist/db/migrateCli.js maintenance-pending  # exit 10 = pending
# Any pending migration (migrate.sh asks before its pre-migration dump): prints
# the latest applied version, then pending files; exit 10 = pending, 0 = none.
SERVER_DATABASE_URL=postgresql://... node dist/db/migrateCli.js pending
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

In dev Docker Compose, server hot reload is enabled: the service
uses the Dockerfile `dev-runtime` target, bind-mounts `server/src` and
`packages/protocol/src`, uses `server/scripts/watch-typescript.mjs` to poll
those bind mounts plus official plugin packages, compile protocol, server, and
official plugins in order, and restart the server after the complete build
succeeds. This
avoids native watcher failures on Docker bind mounts. Test and prod run compiled
JS only. Test builds the same server `runtime` and frontend Nginx `prod` targets
locally, without mounting application source or watching for changes. Update it
from the checkout with `./ops/scripts/start.sh --test --build --detach`; this
builds the server before applying its bundled migrations, builds the other
services, and recreates changed containers while preserving test data. Run it
when no work is in flight. Omitting `--build` reuses existing images. For real
work, enable backups and opt into a pre-migration dump with
`PRE_MIGRATION_BACKUP=1 ./ops/scripts/start.sh --test --build --detach`.

## Database scripts (run from repo root)

```bash
# Run committed migrations (Docker-native by default: the server migration runner
# runs inside a one-shot server container, using the in-network postgres service).
# The normal start script invokes this helper before app services start. The
# helper enforces the no-write schema check (at image build time for test/prod,
# at invocation for dev/host), then Docker-native mode creates POSTGRES_DB when
# it is missing and applies every pending migration in order.
./ops/scripts/db/migrate.sh [--mode dev|test|prod]

# Host mode: only when DATABASE_URL points to a reachable external Postgres
# (runs the server migration runner from server/; needs the Node toolchain).
DATABASE_URL=postgresql://... ./ops/scripts/db/migrate.sh --host [--mode dev|test|prod]

# Pre-migration backup: --mode prod takes a pg_dump custom-format dump to
# $RAINVER_ROOT/<mode>/db/dumps/pre-migrate-<ts>-from-<version>.dump whenever a
# migration is pending (none when nothing is pending; an unanswered check still
# dumps), and aborts if it fails. Opt into the same safety for non-prod modes:
PRE_MIGRATION_BACKUP=1 ./ops/scripts/db/migrate.sh --mode dev
./ops/scripts/db/migrate.sh --mode dev --pre-migration-backup

# Operation-manifest package changes also require the existing stopped-writer
# maintenance path on an existing database; pending/status checks use the image's
# compiled packages. No package changes means no plugin role DDL on ordinary up.
# Explicit owner-only diagnostics/repair, from server/ using the matching built
# image/packages, applications stopped and a verified pre-change backup:
# node dist/db/migrateCli.js plugin-install [--repair-failed]
# node dist/db/migrateCli.js plugin-reconcile
# These raw CLI commands do not stop apps or make a backup themselves. Never run
# them against production without explicit operational authorization. Both restore
# scripts call plugin-reconcile after --no-owner --no-acl restore. Legacy plugin
# public migrations are excluded from the operation-package installer/reconcile.
# The bundled `phd_application` package is such a change: a database without it
# reports it pending until that maintenance path installs `plugin_phd_application`.
# The rebuilt `diary` package (Plan 7) is one too; on a database that had the
# legacy Diary, that install also adopts `public.diary_*` rows once (kept in place).

# Operation-package schema (developer step, from server/): author the package's
# schema.ts, then generate its migration. NODE_PATH lets the package-local
# config resolve drizzle from server/node_modules; generated SQL must not create
# the schema (the offline installer provisions it). Example:
NODE_PATH=node_modules node node_modules/drizzle-kit/bin.cjs generate \
  --config ../plugins/official/phd_application/drizzle.config.ts --name <name>
# List the new id in the manifest's `migrations`, then rebuild packages:
node scripts/build-official-plugins.mjs

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
# Test/prod never consume the dev baseline. After the schema-epoch reset, a
# pre-epoch saved baseline is incompatible: use --no-dev-setup when explicitly
# recreating an empty dev database (only with separate operator authorization).
./ops/scripts/db/reset-postgres.sh [--mode dev|test|prod]
./ops/scripts/db/reset-postgres.sh --mode dev --no-dev-setup

# Open a psql shell
./ops/scripts/db/shell.sh [--mode dev|test|prod]
```

Least-privilege runtime/backup database roles ([ADR 0031](decisions/0031-runtime-database-roles.md)).
Explicit operator commands; activation needs per-instance authorization and the
procedure in [deployment](modules/deployment.md#least-privilege-database-roles-adr-0031):

```bash
./ops/scripts/db/runtime-roles.sh plan     [--mode dev|test|prod]   # read-only
./ops/scripts/db/runtime-roles.sh apply    [--mode ...] --yes       # owner channel
./ops/scripts/db/runtime-roles.sh activate [--mode ...] --yes       # services stopped
./ops/scripts/db/runtime-roles.sh rollback [--mode ...] --yes       # services stopped
# Isolated verification (test container only; the dump/restore case needs the
# docker CLI to reach the test container and fails rather than rehearsing ACLs):
cd server && pnpm exec vitest run test/runtimeRolesDb.test.ts
cd ops/scripts && python3 -m unittest test_runtime_roles
# `plan` lists each role's effective privileges beyond its target (`exceeds`);
# `apply` refuses such a role until an operator repairs it explicitly.
```

## Backup and restore (run from repo root)

```bash
# Full-system backup with app services stopped (PostgreSQL snapshot + files + manifest).
# Stop frontend, server, and deployer first; postgres must remain running.
# When the server is running, the BackupService API is canonical:
#   POST /api/v1/system/backups/manual
# It is `system.backup.create`: send an Idempotency-Key, then read the receipt's
#   GET /api/v1/system/commands/<command-id> for the archive name.
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

# There is no lint script.

# Tests. A DOM wait that hits `asyncUtilTimeout` (15s, src/test/setup.ts)
# is a test waiting for something that never arrived. An effect from mount
# can flush after the click the test just made. Reproduce that by running
# the one file in a loop.
# Performance budget exceedances only warn; DOM wait errors still fail.
# Run this suite alone. Its budget totals are per-file sums and grow when
# another suite runs beside it.
pnpm test

# Real layout regression (separate from jsdom): build, then check the Room and
# Agent Work routes with mixed Markdown at mobile/desktop breakpoints, the
# Library Reader with a synthetic Chinese/English article, and the Project
# Agents / Rooms entries in both themes and locales (screenshots go to /tmp;
# COLLAB_SHOTS overrides /tmp/rainver-collab-shots).
# Playwright Core is a dev dependency; it does not download browsers on install.
pnpm exec playwright-core install chromium
pnpm run build
pnpm run test:layout
# CHROMIUM_EXECUTABLE=/path/to/chromium selects an existing local browser.
# LAYOUT_BASE_URL=http://localhost:3100 checks an already hosted build instead.
# All API requests are mocked in the browser; no instance data is changed.
```

The Docker dev frontend keeps `node_modules` inside a container volume.
Its dev entrypoint hashes the root workspace files, `pnpm-lock.yaml`, and package
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

# The Space's subscription lines (warning / reserve), and moving them (owner/admin).
curl http://localhost:3000/api/v1/providers/subscription-quota-policy -H "Authorization: Bearer <token>"
curl -X PUT http://localhost:3000/api/v1/providers/subscription-quota-policy \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"warn_pct":70,"reserve_pct":85}'

# A conversation's logins, windows and held Agent-triggered turns; continue anyway (Project writer).
curl http://localhost:3000/api/v1/rooms/<room-id>/conversations/<session-id>/quota -H "Authorization: Bearer <token>"
curl -X POST http://localhost:3000/api/v1/rooms/<room-id>/conversations/<session-id>/quota/continue \
  -H "Authorization: Bearer <token>"

# What has changed about every host's runtimes, newest first.
curl http://localhost:3000/api/v1/hosts/runtime-changes -H "Authorization: Bearer <token>"
```

For fast local development of a separately installed Host, build and install
the current checkout without publishing to GitHub:

```bash
./ops/scripts/host/build-local-release.sh --install
```

The helper emits the same verified archives and `SHA256SUMS` consumed by the
normal installer, using a local `file://` release source. Use `--output DIR`
when the release should remain available for a later manual install.
The helper uses Node 24 from PATH when available, otherwise reuses the installed
Host's `runtime/node-current/bin/node` (respecting `RAINVER_HOST_INSTALL_ROOT`
and `XDG_DATA_HOME`). It selects that runtime for pnpm and all build children
without changing the calling shell. If neither location provides Node 24, it
stops with instructions to install or activate the version in `.nvmrc`.

One current version per adapter per host, plus exactly one kept behind it as
the rollback target. An upgrade drains that copy's Runs first and refuses
rather than killing one, so "still in use" is an ordinary answer. There is no
per-Space version policy: the copy a Run uses is decided by the Agent's host
and installation.

## Linux execution host

The public rolling releases are built by
`.github/workflows/host-daemon-release.yml`: `master` publishes `stable`, each
relevant `dev` push publishes `edge`, and the nightly schedule publishes
`nightly` from `dev`. The workflow pins the channel branch's commit once
(exact `refs/heads/` checkout), typechecks and tests the daemon and its
workspace packages at that commit before building, and one publish step owns
the immutable `host-build-<sha>` release and the channel tag. Its release logic
is checked locally, without GitHub, by
`cd ops/scripts && python3 -m unittest test_host_release_workflow`. Generate a pairing code in the Hosts panel, install the
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
  pg_isready -U rainver -d rainver
```

## Environment Variables

See `ops/env/.env.dev.example`, `.env.test.example`, and `.env.prod.example`
for the full list. `ops/scripts/start.sh --prod` rejects empty, placeholder, and
development `POSTGRES_PASSWORD` values. Key vars:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | postgresql://... | Optional external DB URL for host-side DB scripts |
| `JOBS_WORKER_CONCURRENCY` | `8` | Concurrent background job lanes (1–64); independent of execution-host capacity and per-session/directory locks |
| `BUILTIN_HOST_MAX_CONCURRENT_RUNS` | `3` | Runs the built-in execution host executes at once; bubblewrap has no cgroups, so this and the `sandbox-runner` container's own `cpus`/`mem_limit` are the only capacity levers |
| `ARTIFACT_STORAGE_ROOT` | `$RAINVER_HOME/storage/artifacts` | Managed artifact file storage root used by server artifact export |
| `SERVER_DATABASE_URL` | generated by ops scripts | Server PostgreSQL owner/app URL for bundled compose |
| `SERVER_INTERNAL_TOKEN` | generated by ops scripts | Service token for internal server routes |
| `SERVER_DEBUG` | `false` | Server debug flag for local-only cookie defaults. When it is unset, `DEBUG` is read. Do not add a third name |
| `SERVER_TRUSTED_PROXY_HOST` | unset (Compose: `frontend`) | In-network hostname of the frontend proxy; the only peer whose `X-Forwarded-*` is believed, re-resolved every 30 s |

Providers/credentials, policy enforcement, public sessions, native auth/spaces,
runs, chat turns, context assembly, memory read/proposal-create/apply,
proposal review/apply orchestration, artifact read/export, and the runtime
adapter catalog are fixed server authorities.

## Focused Runs Verification

Focused verification commands from repo root. The server's `pretest`,
`pretypecheck` and `prebuild` already run `build:workspace-deps`
(`@rainver/protocol`, `@rainver/outbound-guard`, `@rainver/folder-read`,
`@rainver/reader-document`; the host-daemon's adds `@rainver/agent-cli`), so a
server step never needs the protocol built by hand first. The web app typechecks
against the built `@rainver/protocol` and `@rainver/reader-document`; build them
(`pnpm --filter @rainver/reader-document build`) after changing their sources.
In the dev Compose stack the server's TypeScript watcher rebuilds
`reader-document` itself, but the web container uses the build baked into its
image: after changing `packages/reader-document`, rebuild and restart the
frontend service (`docker compose -f ops/compose/docker-compose.dev.yml up -d --build frontend`). Run the protocol's own checks when the change
touches the contract, not as a build step for the server:

```bash
cd packages/protocol
pnpm run typecheck && pnpm test          # contract change only

cd ../server
pnpm run typecheck
pnpm exec vitest run \
  test/evidenceRedaction.test.ts \
  test/runOrchestrationService.test.ts \
  test/runMaterializationService.test.ts \
  test/remoteHostCliAdapter.test.ts \
  test/runsRoutes.test.ts \
  test/runtimeAuthority.test.ts \
  test/config.test.ts \
  test/features.test.ts \
  test/boundaries.test.ts
pnpm run build

```

## ACP Recovery Verification

Focused ACP recovery acceptance (no real credentials or inference):

```bash
cd packages/host-daemon
pnpm exec vitest run test/acpConformance.test.ts test/acpCleanup.test.ts
cd ../../apps/web
pnpm run build
node --test src/__tests__/runtime-recovery.browser.mjs
```

The browser fixture uses synthetic APIs; screenshots are written under
`/tmp/rainver-acp-experience-shots` (`RUNTIME_RECOVERY_SHOTS` overrides it).
The native-process fixtures isolate HOME and configuration, while the ACP
packages are the actual lockfile pins. Upstream account/inference availability
still requires separate real-account acceptance.

## Isolated Workspace Retention Verification

Focused checks for source retention/reclamation (real PostgreSQL for the server
file; real Git repositories in a temporary Host config for the daemon file):

```bash
cd packages/host-daemon
pnpm exec vitest run test/workspaceRetention.test.ts test/workspaceIgnoredSweep.test.ts test/daemonLease.test.ts test/taskWorktree.test.ts test/workspaceReview.test.ts test/capabilities.test.ts
cd ../../server
pnpm exec vitest run test/workspaceRetentionDb.test.ts test/workspaceSourceFenceDb.test.ts test/hostThreadsDb.test.ts test/agentWorkspacesDb.test.ts test/delegatedWorkspacePlacementDb.test.ts test/hostUploads.test.ts
cd ../apps/web
pnpm exec vitest run src/modules/runs/WorkspaceChangesCard.test.tsx src/modules/conversation/TurnWorkspaceSummary.test.tsx src/modules/project_files/ProjectAgentWorkspacesPage.test.tsx
pnpm run build
node --test src/__tests__/workspace-concurrency.browser.mjs
node --test src/__tests__/agent-workspaces.browser.mjs
```

Reclaim-6 adds exact adopting-checkpoint pins in the existing recovery namespace.
The retention files cover historical same-file edits, force rewrite, dirty/new
sources, unpublished-parent recovery, capture reply replay, state-only clocks,
and a 22-branch equal-tip group that remains unproven. These are isolated PG/Git
checks; they do not audit or clean live unknown branches.

Controlled publication, adoption reconciliation and Active management add:

```bash
cd packages/host-daemon
pnpm exec vitest run test/publicationChain.test.ts test/gitBranchAlign.test.ts test/repositoryGate.test.ts test/branchAlignIsolation.test.ts test/branchAlignDurability.test.ts test/workspaceNativeIntegration.test.ts
cd ../../server
pnpm exec vitest run test/workspaceActiveManagementDb.test.ts test/operationExecutorDb.test.ts
```

Browser screenshots go to `/tmp/rainver-workspace-shots` (`WORKSPACE_SHOTS`
overrides it) and `/tmp/rainver-agent-workspace-shots` (`AGENT_WORKSPACE_SHOTS`);
all APIs are synthetic. Frozen-review regressions additionally exercise real-PG
checkpoint contributors, recursive adoption authorization, replay after parent movement,
Host refusal and basis uploads; the browser fixture includes refused-review messages.
The second fixture covers the per-request collapsed
summary with an explicit delegation, the conversation pending-work entry and
Files & Code › Agent workspaces (entry, details, history, return).

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
`test/modelSpecs.test.ts` checks that every row has a source and a valid
verification date. When adding a model or touching a figure, re-read the vendor page in `source` and
move `verifiedOn` to that day.

## Problem engine upgrade verification

The one-time new-model cutover is documented
in [PROBLEM_ENGINE_UPGRADE](architecture/PROBLEM_ENGINE_UPGRADE.md). There is no
runtime problemUpgradeAudit CLI. Use the standard migrator and offline operators,
not an application fallback or manual per-request backfill.

## Product acceptance

Run the deterministic product gate from the repository root. It requires an
available Docker runtime, PostgreSQL fixtures, and Playwright Chromium.

```bash
pnpm --filter @rainver/web exec playwright-core install chromium
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

Focused verification commands from repo root; as above, the server steps build
their own workspace dependencies:

```bash
cd packages/protocol
pnpm run typecheck && pnpm test          # contract change only

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


### Unified reading browser acceptance

After building `apps/web`, run from `server/`:

```bash
pnpm exec vitest run --config vitest.reading-browser.config.ts
```

Uses the existing Playwright Chromium (`CHROMIUM_EXECUTABLE` may select another
installed executable) and shared real PostgreSQL fixture. Reading, preferences,
daily edition and Reader requests execute real module routes against the isolated
DB; unrelated Shell metadata is fixture-backed and Service Workers are blocked.
Screenshots default to `/tmp/rainver-reading-stage-three`; set
`READING_SCREENSHOT_DIR` to another temporary artifact directory if needed.
This explicit browser config does not run in the canonical server suite or
change its thresholds. It never connects to a running product database.

### PWA lifecycle browser checks

From `apps/web` with Node 24, after a production build into `dist` and a second
build of a different checkout into another directory:

```bash
PWA_PREVIOUS_BUILD_DIR=/tmp/<previous-build> node --test src/__tests__/pwa-lifecycle.browser.mjs
```

Without `PWA_PREVIOUS_BUILD_DIR` only the clean-install case runs. The two
builds must differ in their `ProjectFilesPage` and `CodeMirrorEditor` chunks.
`PWA_ENGINES` (default `chromium,webkit`) selects the engines for the cases
where the person stays at, then leaves, the unsaved-input prompt from Settings
and from the failed-feature panel. The update
cases cover waiting activation, Settings reload and a tab left on the previous
build lazy-loading its editor through the retained assets
(`docker/retain-previous-assets.sh`, run against a temporary store; the nginx
fallback order is mirrored by the fixture, not run through nginx). The script's
locking, rollback, pruning and failure handling are covered by
`cd server && pnpm exec vitest run test/frontendAssetRetention.test.ts`.

Mobile PWA measurements and release-switch cases across three builds use
`tools/perf-baselines/pwa-mobile.mjs`. Run them as bounded per-engine,
per-case processes (`CASES`, `SAMPLES=0`; see that directory's README, ⑤ PWA)
instead of one full matrix; each process ends with a terminal state line.

## Sources execution foundation verification

Select Node 24. The framework comparison installs use fixed candidate locks in
an external temp directory; they are not the isolated adapter's throughput.
The actual Host runtime uses pinned BasicCrawler/Cheerio, a serial trusted queue,
isolated dependency-free handlers, and private checkpoints (ADR 0026).

```bash
pnpm --filter @rainver/protocol --filter @rainver/outbound-guard build
pnpm --dir packages/host-daemon run build
node tools/source-engine/benchmark.mjs /tmp/rainver-source-benchmark --install > /tmp/source-benchmark.json

cd packages/protocol
pnpm run typecheck
pnpm exec vitest run test/hostWire.test.ts
cd ../host-daemon
pnpm run typecheck
pnpm exec vitest run test/sourceExecution.test.ts test/sourceCollection.test.ts test/sourceCollectionCloseout.test.ts test/sourceFraming.test.ts test/sourceExecutionChannel.test.ts test/sourceRecoveryOs.test.ts
# Explicit OS smoke; standard suite reports these cases skipped.
SOURCE_EXECUTION_OS_SMOKE=1 pnpm exec vitest run test/sourceExecution.test.ts test/sourceCollection.test.ts test/sourceCollectionCloseout.test.ts test/sourceFraming.test.ts test/sourceExecutionChannel.test.ts test/sourceRecoveryOs.test.ts
```

From repo root, test the direct cgroup backend without a usable user bus.
The transient test unit only delegates its own private subtree; the actual
executor does not invoke user systemd. No instance data is used. A temporary
bubblewrap binary may be supplied with systemd-run's
`--setenv=SOURCE_EXECUTION_BWRAP=/tmp/bwrap/usr/bin/bwrap` if needed; no system
installation is necessary. Requires user systemd with DelegateSubgroup support
only to provision the private test subtree, not inside the execution backend.

```bash
systemd-run --user --quiet --pipe --wait --collect --property=Delegate=yes --property=DelegateSubgroup=manager "$(command -v node)" "$PWD/tools/source-engine/direct-smoke.mjs"
cd server
pnpm exec vitest run test/sourceRequestQuotaDb.test.ts test/sourceRequestBrokerDb.test.ts test/sourceRequestReviewDb.test.ts test/sourceExecutionTransport.test.ts test/hostFolderReadRegistry.test.ts test/hostsRoutes.test.ts test/agentGuides.test.ts test/boundaries.test.ts test/testHygiene.test.ts
pnpm run schema:check
```

The shared real-PG fixture creates only test databases. Ordinary sandbox Docker
or local-listen failures require the tool approval path; never substitute a fake
DB. The standard sandbox-runner still needs an administrator-delegated writable
cgroup v2 subtree selected by `RAINVER_SOURCE_CGROUP_ROOT`; readonly cgroup mounts
fail closed. `RAINVER_SOURCES_EXECUTION=1` is explicit Host opt-in, never a trust
mode exemption. No compose privilege widening, live deployment or generated-code
activation is performed by these commands.


Disposable standard-image Sources refusal check (uses an existing local image;
no instance mounts or additional container privileges; build Host first):

```bash
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --env RAINVER_SOURCES_EXECUTION=1 \
  --mount type=bind,source="$PWD",target=/checkout,readonly \
  --entrypoint node rainver-test-sandbox-runner:latest \
  /checkout/tools/source-engine/container-refusal.mjs
```

This checks capability absence => `refused`, zero requests. It is not successful
execution inside the standard container. That separate deployment gate needs
administrator cgroup/userns authorization; do not add privileges to make this
negative test pass. Direct backend also requires `/usr/bin/prlimit`.


Cutover preflight: stop before deployment and inventory the target database
**offline**. The original0017 section (now within0009_problem_engine) deliberately fails if any Step has a non-modern
method; do not guess a conversion or start an old writer against the new schema.
Only test maintenance is authorized for this cleanup. Dev/prod require separate
authorization, offline inventory, backup and an explicitly reviewed conversion;
they must not inherit test's zero-legacy-Step assumption. The original0020 section preserves imported
history's canonical top-level ACL/provenance fields. Source histories0009–0021
require ADR0025 frozen-pair conversion before starting the composed chain;
never rewrite checksums or use ordinary up to replace applied history.

### Current ACP compatibility verification

From `packages/host-daemon`, run `pnpm exec vitest run test/acpConformance.test.ts
test/acpCleanup.test.ts test/adapterInstallation.test.ts` (arguments on one line).
The actual resolved wrappers use isolated fake native processes, no live login
or inference. Workspace postinstall prepares Claude cleanup; to repeat use
`node tools/acp/prepare-adapters.mjs packages/host-adapters packages/host-daemon`
from the root. Preparation patches each wrapper file independently, so a rerun
completes one interrupted halfway, and `--resolve-candidates` writes the
catalog only after every root matched. Scheduled/manual CI resolves latest stable candidates while
ordinary frozen installs preserve the lockfile snapshot.
The repository ACP catalog lives in `packages/protocol/src/acpAdapters.json`;
preparation verifies it against the installed distributions. Native CLI updates
use the Host controls independently of the bridge release.

From `apps/web`, build first, then run `node --test --test-name-pattern='live input'
src/__tests__/runtime-recovery.browser.mjs` (one line). Set `CHROMIUM_EXECUTABLE`
when Chromium is outside Playwright's default cache. Screenshots default to
`/tmp/rainver-acp-experience-shots`; browser routes use offline fixtures.

## Operation plugin platform acceptance (isolated tests only)

Use Node 24 and the existing Playwright Chromium (CHROMIUM_EXECUTABLE can select
another installed executable); no product DB or role changes are needed.

```bash
REQUIRE_TEST_POSTGRES=true PLUGIN_VISUAL_OUT=/tmp/rainver-plugin-platform-visual \
  pnpm --dir server exec vitest run test/pluginFrontendDb.test.ts --maxWorkers=1
```

This starts a local Vite acceptance-mode frontend against focused real-PG server
modules, drives actual operations/Proposal/Jobs/restore and emits screenshots
outside the repo. Authentication bootstrap/seams select seeded real people; domain data is
real isolated PG (not cookie/SSO acceptance). Normal frontend builds do not activate the demonstration plugin.
See [the permanent matrix](architecture/OFFICIAL_OPTIONAL_MODULES.md#operation-platform-acceptance).

Plugin Agent data access and core ports ([ADR 0030](decisions/0030-plugin-agent-data-access.md);
Node 24, shared real PG, isolated fixture plugins only):

```bash
cd server && pnpm exec vitest run test/pluginDataAccessDb.test.ts test/pluginCorePortsDb.test.ts
cd apps/web && pnpm exec vitest run src/modules/runs/__tests__/RunPluginDataPanel.test.tsx src/modules/conversation/ConversationRunControls.test.tsx
# Built app + synthetic APIs (build web first); screenshots to /tmp.
cd apps/web && node --test src/__tests__/plugin-data-access.browser.mjs
```

Sensitive-read isolated launch (ADR 0030 §4a; Linux with `/usr/bin/bwrap`; build
`packages/protocol`, `packages/agent-cli` and `packages/host-daemon` first; only
local synthetic listeners; never skips):

```bash
cd packages/host-daemon && pnpm exec vitest run test/modelChannel.test.ts test/strictNamespace.test.ts test/execution.test.ts
cd packages/host-daemon && node test/modelChannel.acceptance.mjs && node test/networkNamespace.acceptance.mjs
cd server && pnpm exec vitest run test/pluginDataAccessDb.test.ts test/remoteProviderBindingFrame.test.ts test/providerProxyServer.test.ts
```

The installed vendor CLIs on that model-only lease (explicit smoke, skipped
otherwise; Linux with unprivileged user and network namespaces and `ip`;
needs `claude` and `codex` on PATH, fails if either is missing; only a local
synthetic provider, no live credential):

```bash
cd server && MODEL_ONLY_CLI_SMOKE=1 pnpm exec vitest run test/modelOnlyLeaseVendorCliSmoke.test.ts
```

Idle reclamation focused regressions (same runtime; shared real PG required):
from `packages/host-daemon`, run `pnpm exec vitest run test/workspaceRetention.test.ts
 test/taskWorktree.test.ts test/daemonLease.test.ts test/config.test.ts`; from `server`, run `REQUIRE_TEST_POSTGRES=true pnpm exec
 vitest run test/workspaceRetentionDb.test.ts test/workspaceSourceFenceDb.test.ts`.
The retention DB file includes real Host Git capture/lost-reply/acknowledgement/
idle-expiry cleanup, plus parent pin downgrade and blocked-ref retry checks.
Preflight Docker and loopback permissions before starting these checks.

### Ignored workspace recovery (Host owner, local installation)

List snapshots with `rainver-host ignored list --location <location> --limit 256`.
The JSON response is `{items, errors, next}`; repeat with `--after <next>` until
`next` is null (maximum limit 512). An empty items page may still have `next`.
`--key <listed-key>` reads an exact snapshot/status directly. For
mutations stop the Host first (service or foreground); CLI and daemon share a
Linux kernel flock. util-linux `flock` must be available.
Use keys from the list, and an existing destination for restoration:

```bash
rainver-host ignored restore --location <location> --key <key> --destination <directory>
rainver-host ignored discard --location <location> --key <key> --confirm-discard
rainver-host ignored rebuildable --location <location> --key <key> --confirm-rebuildable
```

For continuous future outputs, register an exact directory prefix at the Location
checkout, or use a listed blocked workspace key to validate its original root:

```bash
rainver-host ignored declare-root --location <location> --prefix build/cache --confirm-rebuildable
rainver-host ignored declare-root --location <location> --key <listed-key> --prefix build/cache --confirm-rebuildable
```

The declaration applies per Location; capture revalidates paths, sensitive content
and symlinks. Only matching roots expire in 30 days; mixed unknown siblings remain.
Large explicitly reconstructible roots use same-filesystem moves under the active
root quota, while unknown content keeps the 1 GiB bound. Snapshot `rebuildable`
authority applies only to that reviewed snapshot. Unknown assets never expire automatically. Restore refuses
collisions. The list also exposes legacy UUID snapshot keys for recovery. See [Hosts](modules/hosts.md#idle-reclamation-preservation-and-checkpoint-pin-lifecycle)
for quotas, interrupted-journal recovery and current deduplication limits.
### Host daemon combined verification

From `packages/host-daemon`, `pnpm run verify` prepares protocol, outbound-guard,
folder-read and agent-cli once, then runs typecheck and tests directly. Separate
`pnpm run typecheck` and `pnpm test` keep their preparation hooks. CI's explicit
library builds and these hooks share TypeScript incremental metadata in each
library's `dist`; no environment variable bypasses preparation.


### Bounded workspace reclamation regressions

Preflight Node 24, offline dependencies, Docker availability and loopback access.
From `packages/host-daemon`, run `pnpm exec vitest run test/workspaceRetention.test.ts
test/workspaceIgnoredSweep.test.ts test/daemonLease.test.ts test/taskMerge.test.ts
test/workspaceRetentionBarriers.test.ts`. From `server`, run
`REQUIRE_TEST_POSTGRES=true pnpm exec vitest run test/workspaceRetentionDb.test.ts
test/workspaceSourceFenceDb.test.ts test/agentGuides.test.ts --maxWorkers=1`.
The million-file/dependency trees are never enumerated by these fixtures; the
10,050-snapshot test does perform real temporary-directory creation, fsync,
retirement and child-process restart continuation. It can exceed one minute on
slow disks; wait for actual convergence, not a fixed one-hour scheduler tick.
The receipt fixture proves immediate 4,200-reply deletion without aging. Tests
retain corrupt/unknown content and verify bytes, epoch replay refusal and real
post-release Git conflict-resolution startup. None audits or cleans live assets.
For paths containing `:`, invoke package-local `node node_modules/vitest/vitest.mjs`
and `node node_modules/typescript/bin/tsc` from their owning packages if pnpm
cannot construct PATH; these execute the same tools in this worktree.


The retention fixtures also cover 600 legacy retired manifests plus a saturated
128-slot active inventory (including corruption), exact retired restore/expiry,
same-epoch candidate journal replay, ignored-refusal convergence and a slow
Git-stage scheduling fault. The PG file proves source E release to E+1 followed
by renewed candidate cleanup and actual branch/worktree absence, and reaches all
250 waiting proof owners across 63 rounds that each exceed the five-minute floor.
For a narrow repair iteration use `-t 'renews candidate|250 waiting|frozen attempt'`
in the server file and `-t 'over 512|same-epoch candidate|ignored refusals|rotates maintenance|conflict-resolution candidate'`
in the Host file. A name-filtered run's unselected tests are not environment skips.

Candidate disposal/legacy upgrade focused checks (Node 24, same worktree, real PG
and temporary Host Git; Docker and loopback preflight required): from
`packages/host-daemon`, `node node_modules/vitest/vitest.mjs run test/workspaceRetention.test.ts -t 'tombstones a cleaned candidate|conflict-resolution candidate'`;
from `server`, `REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/workspaceRetentionDb.test.ts -t 'frozen attempt epoch|renews candidate cleanup' --maxWorkers=1`.
These prove candidate-only E+1 fencing and journal expiry, safe missing-epoch
resolution, multi-attempt owner backfill/real deletion, and unknown/live retention.

### Workspace landing lifecycle verification

Use Node 24 and the same checkout's workspace dependencies. From `server`, run
`REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/workspaceRetentionDb.test.ts --maxWorkers=1`.
For native response and reader admission regressions run
`test/hostThreadsDb.test.ts test/delegatedWorkspacePlacementDb.test.ts` with
`-t 'finishes native integration|pending publication'`. These tests use the
shared real PostgreSQL template and isolated Host Git fixtures, not product data.
From `apps/web`, run the owning workspace card/summary tests, build, then
`node --test --test-name-pattern='one collapsed|Files & Code entry' src/__tests__/agent-workspaces.browser.mjs`.
The browser fixture uses real Chromium with synthetic API data in both themes,
English/Chinese and 390/1280 widths. `AGENT_WORKSPACE_SHOTS` selects an external
screenshot directory. It does not establish live multi-Agent resource convergence.

My Agents (cross-Space list, Agent stop/restore, Project-only plugin assistants):
from `server`, `REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/myAgentsDb.test.ts test/pluginAgentRolesDb.test.ts`;
from `apps/web`, `src/modules/agents src/__tests__/agent-disable.test.tsx src/__tests__/my-agents-api.test.ts src/__tests__/shell.test.tsx src/modules/plugins/PluginAgentSetup.test.tsx`,
then build and `node --test src/__tests__/my-agents.browser.mjs` (real Chromium, synthetic APIs, both
themes, English/Chinese, 390/1280; `MY_AGENTS_SHOTS` selects the screenshot directory, default
`/tmp/rainver-my-agents-shots`).


Focused bounded-slot lifecycle verification (Node 24, owning package cwd):
from `server`, use `REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run
test/delegatedWorkspacePlacementDb.test.ts test/workspaceRetentionDb.test.ts
-t 'converges real parallel|confirmed released slot|backfills only a trustworthy|keeps one integration'
--maxWorkers=1` (one command). This uses real PG and temporary Host Git; three
parallel merge/cancel/failure rounds keep two reusable temporary slots, return
to one main tree/branch and zero temporary trees/branches, and retain readable
unmerged recovery refs. From `packages/host-daemon`, run
`node node_modules/vitest/vitest.mjs run test/workspaceRetention.test.ts
-t 'preserves an unmerged cancelled|durably links'`: separate built Host processes
exercise lost-reply/restart and stale cleanup after rematerialization.
Browser fixture screenshots remain presentation evidence only, not proof of
physical convergence or a deployed Host upgrade.


Reused-slot lifecycle regression (Node 24, offline lockfile dependencies, Docker
and loopback permission preflight; package-local commands also work in paths
containing `:`): from `server`, run `REQUIRE_TEST_POSTGRES=true node
node_modules/vitest/vitest.mjs run test/delegatedWorkspacePlacementDb.test.ts
test/hostThreadsDb.test.ts test/workspaceRetentionDb.test.ts
test/workspaceSourceFenceDb.test.ts test/workspaceFrozenRetryDb.test.ts
--maxWorkers=1` (one command). Host native and preservation guards: from
`packages/host-daemon`, run `node node_modules/vitest/vitest.mjs run
test/workspaceNativeIntegration.test.ts test/workspaceRetention.test.ts
test/workspaceRetentionBarriers.test.ts`. Name-filtered unselected cases are
not environment skips. Local fixture transports do not prove live vendor login.


### Slot release admission regressions

Use Node 24 and offline installed dependencies in this same isolated worktree.
A colon in the worktree path requires direct package-local compiler/runner paths.
Prepare protocol, outbound-guard, folder-read, reader-document and agent-cli with
their existing incremental prebuild helper and `node node_modules/typescript/bin/tsc
-p tsconfig.build.json` before checking server/Host consumers. From `server`:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json
REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/delegatedWorkspacePlacementDb.test.ts test/workspaceRetentionDb.test.ts test/hostThreadsDb.test.ts test/workspaceSourceFenceDb.test.ts test/agentGuides.test.ts test/jobsSchedulers.test.ts --maxWorkers=1
```

From `packages/host-daemon`, run `node node_modules/vitest/vitest.mjs run
 test/workspaceRetention.test.ts test/workspaceNativeIntegration.test.ts
 test/taskWorktree.test.ts test/workspaceReview.test.ts test/capabilities.test.ts`.
The placement fixture proves a two-hour capacity queue starts a fresh release
clock, persisted retries time out without renewal, hold deadline/release wakeup,
claimed-Job hold-release wakeup without stale-deadline overwrite,
old awaiting/blocked use settlement before reuse, checkpoint attention that survives
cleanup summary/retry until saved evidence, and stale scan fencing. Fixed coordinator plus two participants permits total three trees,
including in a larger Room; five Host-Git rounds measure that actual peak with
process leases and final primary-one/temporary-zero convergence. These are
isolated fixture resources, not an audit or cleanup of live unknown assets.

### Real agent_run slot admission verification

Use Node 24 and offline lockfile dependencies in this same worktree, with
Docker/shared PostgreSQL and loopback permission. In colon-containing paths use
the direct package-local tools. From `server`:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json
REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/delegatedWorkspacePlacementDb.test.ts test/runOrchestrationService.test.ts test/jobsSchedulers.test.ts test/workspaceRetentionDb.test.ts test/workspaceActiveManagementDb.test.ts test/hostThreadsDb.test.ts test/workspaceSourceFenceDb.test.ts test/agentGuides.test.ts --maxWorkers=1
```

The placement file includes JobWorker → agent_run handler → executeRun, using
real PostgreSQL and a deterministic ACP Host (no supplier inference). Capacity,
release-pending and multi-day hold each defer twice, retain queued Run/delegation,
spend no attempt, release execution locks, then launch exactly once after release
with attempt 1 and no orphan event. It also covers queued/racing cancellation,
authorization revoked during wait, reclaim-now/discard/shorter-hold wakeups for
pending and claimed Jobs with app/DB clock skew, exact workspace/use isolation,
minimum ordinary capacity, cross-Task safety refusal, and independent first-time
checkpoint attention. Existing temporary Host-Git lifecycle rounds remain in the
file; these fixture results do not prove live-provider or unknown-asset cleanup.

Published-source reviewed reclamation: from `server`, Node 24,
`REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/workspaceActiveManagementDb.test.ts test/workspaceRetentionDb.test.ts test/workspaceSourceFenceDb.test.ts test/agentGuides.test.ts --maxWorkers=1`.
The active-management file uses real PG Operation Core and temporary Host Git
for integrated/no-change receipt preservation, legacy verifying refusal and
settlement, concurrent same-key admission, exact-tip release and history expiry.
These fixtures do not deploy code or remove live workspace assets.

### Interrupted workspace cleanup recovery

From `packages/protocol`, run `node node_modules/typescript/bin/tsc -p tsconfig.build.json`
and `node node_modules/vitest/vitest.mjs run`. From `server`, run
`REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/workspaceRetentionDb.test.ts test/workspaceActiveManagementDb.test.ts test/workspaceSourceFenceDb.test.ts --maxWorkers=1`.
The new cases cover atomic epoch/plan rollback, identical lost-receipt delivery,
duplicate enqueue, source-null unchanged/dirty/offline/active Host observations,
and same-person cross-conversation recovery without publication/deletion grants.
They use the existing real PostgreSQL clone and temporary Host Git fixtures;
no product database or real retained workspace is touched. A missing container
runtime or denied child-process Git prevents acceptance and must be reported.
Run the Host retention, barriers and durability files listed above as well;
retained receipts and epoch/CAS guards remain part of the same contract.

## Gmail acceptance (read-only MVP and V2 monitoring)

Node 24 (for example `PATH=$HOME/.nvm/versions/node/v24.22.2/bin:$PATH`),
`pnpm install --frozen-lockfile --offline`, Docker for the shared real-PG test
container; Google is stubbed at `fetch`, no instance data or real mailbox is
used. In a colon-containing worktree path use the package-local tools below
(`node_modules/.bin` is not on PATH). Current behaviour and its tests are in
[Sources → Personal Gmail connections](modules/sources.md#personal-gmail-connections-connection-lifecycle-new-mail-monitors-legacy-project-selections);
open acceptance items are in the [deferred register](tasks/deferred-register.md#gmail--real-environment-acceptance-and-limits).

```bash
# Workspace deps, then protocol and outbound-guard (each package directory).
for p in protocol outbound-guard folder-read reader-document agent-cli; do
  (cd packages/$p && node ../../tools/typescript/prepareIncremental.mjs && node node_modules/typescript/bin/tsc -p tsconfig.build.json)
done
(cd packages/protocol && node node_modules/vitest/vitest.mjs run)
(cd packages/outbound-guard && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && node node_modules/vitest/vitest.mjs run)

cd server
node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json
# Production build (`pnpm build`: emits the ignored server/dist).
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/db/schema-migrations.mjs check && node node_modules/drizzle-kit/bin.cjs check --config=drizzle.config.ts
REQUIRE_TEST_POSTGRES=true node node_modules/vitest/vitest.mjs run test/gmailAgentReadDb.test.ts test/gmailRoomReadAcceptanceDb.test.ts test/gmailPrivateReadHandoffDb.test.ts test/sensitiveRuntimeProfileDb.test.ts test/pluginDataAccessDb.test.ts test/memoryDirectWritesDb.test.ts test/contextTaint.test.ts test/privateToolCalls.test.ts test/gmailMonitorSyncDb.test.ts test/proposalPrivateOwnerGate.test.ts test/policyEnforcementPoints.test.ts test/gmailSyncContract.test.ts test/agentGroupsService.test.ts test/gmailBrokerDb.test.ts test/gmailConnectionDb.test.ts test/gmailMailReadDb.test.ts test/gmailMessageText.test.ts test/gmailOAuthTransport.test.ts test/gmailReadContract.test.ts test/sourceRequestBrokerDb.test.ts test/sourceRequestQuotaDb.test.ts test/sourceRequestReviewDb.test.ts test/sourceCustomSourceCredential.test.ts test/managedSubscriptionOAuth.test.ts test/managedSubscriptionOAuthDb.test.ts test/providersCredentialsAuthority.test.ts test/credentialSpendDb.test.ts test/operationRoutes.test.ts test/operationExecutorDb.test.ts test/projectSourceOperationsDb.test.ts test/agentGuides.test.ts test/config.test.ts test/baselineSchema.test.ts test/leafDomainRepositoryBehavior.test.ts test/jobsSchedulers.test.ts test/hostsRoutes.test.ts test/boundaries.test.ts test/testHygiene.test.ts

cd ../apps/web
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run src/__tests__/gmail-api.test.ts src/__tests__/api-entrypoint.test.ts src/modules/sources/__tests__/GmailConnectionsCard.test.tsx src/modules/sources/__tests__/GmailMonitorsCard.test.tsx src/modules/projects/__tests__/ProjectGmailThreads.test.tsx src/modules/sources/__tests__/SourceAccessPage.test.tsx src/modules/projects/__tests__/SourcesAreaPage.test.tsx src/modules/sources/__tests__/SourceChannelsPage.test.tsx src/modules/conversation/__tests__/gmailPrivateReadCard.test.tsx
node node_modules/vite/bin/vite.js build
# Visual check after a presentation change (built app, synthetic APIs; part of
# test:layout; screenshots in GMAIL_SHOTS, default /tmp/rainver-gmail-shots):
node --test src/__tests__/gmail-sources.browser.mjs
```

Pre-commit full suites, once each, bounded so a hang ends as **incomplete**:
`REQUIRE_TEST_POSTGRES=true timeout --signal=INT --kill-after=60 2700 node node_modules/vitest/vitest.mjs run`
from `server` (needs the web build and Playwright Chromium for its two browser
cases) and `timeout --signal=INT --kill-after=60 1800 node node_modules/vitest/vitest.mjs run`
from `apps/web`. A real Google client, consent or mailbox is outside these
commands and needs explicit configuration and authorization.
