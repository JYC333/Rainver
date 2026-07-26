# Database and Transactions

## Transaction Helper Pattern

`withTransaction` (`server/src/db/tx.ts`) owns transaction control for
server repositories: `BEGIN`, `COMMIT`, rollback on error, and client release.

- Wraps an existing `pg` pool/client boundary.
- Does **not** provide generic query methods.
- Keeps transaction ownership visible at service/repository call sites.

Repositories and stores still own domain queries and row construction. The
transaction helper owns only transaction control.

`withQueryableTransaction` (`server/src/modules/routeUtils/common.ts`) accepts
either a pool or an already checked-out `pg` `PoolClient`. It identifies an
existing client by its `release()` method; `pg` clients also expose `connect()`
on their prototype, so `connect` alone is not a valid Pool discriminator.
Existing clients join the caller's transaction without issuing a nested
`BEGIN`/`COMMIT`.

## Transaction Ownership Rules

- API routes may open or receive a transaction helper, but must not scatter
  commits across unrelated operations.
- Workflow/service layer owns commit for multi-object workflows.
- Repository/store helpers may query and write, but must not commit unless
  explicitly documented as a standalone operation.
- Low-level helpers must not commit invisibly when used by proposal apply, run execution, job terminal state, or Project Folder lifecycle workflows.
- `commit()` should appear only in approved transaction-owner modules or explicit standalone operations.
- `rollback()` belongs at workflow boundaries and failed transaction recovery
  paths, not inside unrelated low-level helpers.

## Savepoint and Best-Effort Rules

**Best-effort evidence** (use a separate short transaction):
- RunStep metadata and terminal detail
- Auxiliary Activity records
- Traces and read logs
- Non-critical replay/read audit rows

**Critical writes** (must not be abandoned due to evidence write failures):
- Run terminal status
- Proposal status
- MemoryEntry creation, update, archive, and provenance/source fields
- Policy row creation and supersession
- Job terminal state
- Project Folder lifecycle state
- Backup manifest/archive state

If a transaction fails, callers must not continue as though the transaction were clean.

## External Call Boundary

Do not hold an open transaction while calling:
- Runtime adapters
- LLM/model providers
- Deployers
- Backup tar/snapshot creation
- External file/system commands
- Network APIs

Required pattern:
1. Open short transaction.
2. Write pending/running/context state.
3. Commit.
4. Perform external work **outside** the transaction.
5. Open short transaction.
6. Persist result or failure.

Proposal appliers are the explicit exception for small compensatable file
operations such as `code_patch`: the applier returns an external rollback handle
to the transaction owner. The handle remains live until `COMMIT` succeeds and
is invoked if commit fails; post-commit telemetry callbacks run only after a
successful commit and never participate in the critical write outcome.

`RunOrchestrationService` applies this: setup state is committed before adapter execution; result/failure is persisted in a separate transaction afterward.

## Backup and Restore Consistency

- `BackupService` uses `pg_dump -Fc` (custom format) for a consistent PostgreSQL database snapshot, independent from the ORM Session. `db_snapshot_method` is `"pg_dump_custom"` in the manifest.
- If `pg_dump` fails, the backup fails closed — no partial archive is produced.
- Full-system backup also copies file data. The database dump and file copies are not one cross-resource transaction, so restore verification checks artifact rows against restored files.
- Run `ops/scripts/system/verify-restore.sh` after restore to verify server
  migration rows, core table counts, and `artifacts.storage_path` file consistency.
- Long-running app transactions must be avoided so backups stay fresh.
- Backup metadata and manifests must not contain raw secrets.
- `backups/` is always excluded from backup archives (recursion prevention).
- **`db/postgres` is the live PostgreSQL data directory — it is never copied into a backup
  archive.** The database is captured logically with `pg_dump -Fc`; copying the live data
  directory is not a supported backup. The manifest records `db/postgres/ (live PostgreSQL data)`
  in its excluded paths.
- **Manifest version metadata.** Every manifest (online `BackupService` and offline
  `ops/scripts/system/backup.sh`) records `backup_format`, `app_version`, `git_commit`,
  `schema_migration_version`, `schema_migration_checksum`, `postgres_server_version`, and
  `pg_dump_version`. Each value is best-effort and may be `null`; gathering it never aborts a backup.
- **Restore preflight validates version metadata.** `ops/scripts/system/restore.sh` reads the
  manifest, prints the recorded versions, and warns clearly on `backup_format` or PostgreSQL
  major-version mismatch. Manifest metadata is never silently ignored.

## Database: PostgreSQL

- **PostgreSQL is the server database.** Server database URLs use
  PostgreSQL connection strings. The app rejects non-PostgreSQL URLs at startup.
- **Local compose/env resolution** is shared by `ops/scripts/start.sh`, `ops/scripts/db/*.sh`,
  and `ops/scripts/system/*.sh` through `ops/scripts/lib/local-compose.sh`: mode validation,
  `ASPACE_ROOT`, `$ASPACE_ROOT/<mode>`, `$MODE_ROOT/.env`, `AGENT_SPACE_MODE_ROOT`,
  compose project/file, and `docker compose --env-file "$ENV_FILE"` are one path.
- Local PostgreSQL containers have stable mode-specific names:
  `agent-space-dev-postgres`, `agent-space-test-postgres`, and `agent-space-prod-postgres`.
- Schema authoring is owned by Drizzle definitions under `server/src/db/schema/`.
  `server/drizzle/` stores Drizzle's generated snapshot/migration metadata, and
  `server/migrations/` stores the generated SQL artifacts that the server
  migration runner applies. During the consolidated-baseline phase, generated
  SQL is merged into `server/migrations/0001_baseline.sql` rather than leaving
  a new `0002_*` file. Do not hand-edit migration SQL for schema changes; edit
  the Drizzle schema and run `npm run schema:generate`.
  `ops/scripts/start.sh` also runs `npm run schema:generate` from `server/`
  before building the server image or applying migrations, so startup keeps the
  generated artifacts in sync with TypeScript schema files.
- In bundled compose modes, server uses the Postgres owner/app role from
  `POSTGRES_USER`/`POSTGRES_PASSWORD`; ops scripts generate
  `SERVER_DATABASE_URL` from those values and do not maintain a separate
  per-table app role.
- Boolean defaults are PostgreSQL-native (`true`/`false`).
- **Migration command path** (`ops/scripts/db/migrate.sh`): defaults to Docker-native. The normal
  `ops/scripts/start.sh` path first runs `npm run schema:generate` from `server/`, then this helper
  runs a no-write Drizzle schema check, verifying the committed Drizzle snapshot matches
  `server/src/db/schema/` before any database bootstrap. Docker-native mode then creates
  `POSTGRES_DB` if the target database is missing, and finally runs `node dist/db/migrateCli.js up`
  inside a one-shot server container using the in-network `postgres` host (Postgres is not
  published to the host). Production server image builds also run `npm run schema:check` so prod
  artifacts are validated before release. Deleting the database and then running migrate is a
  valid empty-instance initialization path. `--host` runs the same schema check and migration
  runner from `server/` only against an explicitly configured, reachable external Postgres; run
  `npm run schema:generate` yourself before host-mode migrate when schema files changed.
  `ops/scripts/db/reset-postgres.sh` reuses this path after dropping the target DB so it is
  recreated by migrate and never left empty/unmigrated.
  `ops/scripts/start.sh` invokes schema generation and then this migration helper before starting
  app services; the server service process itself still does not run migrations on startup.
  Dev/test compose bind-mounts `server/migrations/` so generated local migration artifacts are
  visible to the one-shot migration container. Prod uses migrations bundled into the server
  image; build the image for a new release before starting prod.
  If Docker-native migration starts the compose `postgres` service, it stops that service on
  exit; DB-only dump/restore/reset and offline system backup/restore/verify use the same
  start/stop ownership rule. They leave a pre-existing running database untouched.
- **Pre-migration backup safety** (`ops/scripts/db/migrate.sh`): `--mode prod` requires a
  pre-migration `pg_dump -Fc` backup before server migrations run, written to
  `$ASPACE_ROOT/<mode>/db/dumps/pre-migrate-<timestamp>.dump`. If that dump fails, migration
  aborts before migrations touch the schema. Non-prod modes skip it for convenience; opt in with
  `PRE_MIGRATION_BACKUP=1` or `--pre-migration-backup`.
- **Fresh-instance bootstrap** is server-owned: on an empty migrated DB it
  idempotently ensures the default personal space, default owner user + active
  membership, system memories, and default note collections — the usable initial state.
- PostgreSQL data lives under `$ASPACE_ROOT/<mode>/db/postgres` (bind-mounted into the postgres container).
- Database dumps live under `$ASPACE_ROOT/<mode>/db/dumps`.
- Local test mode reaches the server API through the frontend proxy at `localhost:3100/api/v1`; compose-internal web traffic uses `http://server:8010`.
- Job queue uses `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent claim. `jobs.scheduled_at`
  is NOT NULL with a server default, and DB CHECK constraints enforce the allowed `status` set,
  `attempts >= 0`, and `max_attempts > 0`.
- `RunStep` has DB-level `UniqueConstraint(run_id, step_index)`.
- `BackupService` uses a local advisory lock file (`backups/.backup.lock`, fcntl-based) and fails closed when `pg_dump` fails.
- Backup/restore uses `pg_dump -Fc --no-owner --no-acl` (custom format) and `pg_restore`. Backups are disabled by default; prod fails fast at startup unless `BACKUP_ENABLED=true` or `BACKUP_ACCEPT_NO_BACKUP=true`.

## Deployment Topology Assumption

Current local deployment assumes one server process owns bootstrap and schedulers. Migrations are explicit ops commands. Multi-server deployment is out of current scope and requires separate bootstrap/scheduler leadership.

## Rules

- Use explicit FK, index, and unique constraints.
- Timestamps must be UTC with timezone.
- Store large files in storage; store metadata and relative paths in DB.
- Avoid long transactions and transaction-spanning external calls.
- Do not rely on application-only `MAX()+1` ordering for distributed writers without a future lock/constraint note. Current `RunStep.step_index` uses `MAX()+1` — a documented distributed-runner risk.

## Scoped Settings Store

Low-frequency instance, space, user, and space-user settings use the
generic `settings(scope_type, scope_id, settings_key, settings_json)` table.
Business modules must not hand-write `settings` table CRUD. They define a typed
descriptor with a stable key, scope type, defaults, parser, and serializer, then
read/write through `server/src/modules/settings/ScopedSettingsStore`.
Use the settings module helpers to encode composite `space_user` scope ids.

The store owns row identity, create-if-missing, upsert, timestamp updates,
`updated_by_user_id`, and JSON-object normalization. Owning modules still own
business validation and public response shapes. This keeps one table for sparse
settings without turning it into a generic domain service or moving product
rules out of their owning modules. Scheduler cursor/state belongs in the
scheduler task store, not in scoped user setting rows.

When adding a new setting:

- Reuse `server/src/modules/settings/ScopedSettingsStore`; do not add
  feature-specific tables such as `space_<feature>_settings`,
  `user_<feature>_settings`, or `instance_<feature>_settings`.
- Define a typed descriptor with a stable `settings_key`, exact scope
  (`instance`, `space`, `user`, or `space_user`), defaults, parser, and
  serializer. Register shared keys in `server/src/modules/settings/keys.ts`
  when they are consumed outside one module.
- Keep business authorization and response shape in the owning module. The
  generic store owns persistence mechanics only.
- Use env/config only for deployment hard limits or process wiring. Runtime
  product policy that an instance admin, space admin, or user can configure
  belongs in scoped settings.

## Scheduler Task Store

Per-scope scheduler cursors and state use the scheduler-owned
`scheduler_tasks` table, keyed by `(task_type, task_key)`. Scheduler fan-out
features define a stable task type and task key, while `scheduler_tasks` owns
`next_run_at`, `last_run_at`, status, scope identity, and task-local
`state_json`.

Business modules must not create one scheduler state table per feature. They
read/write scheduler task rows through `server/src/modules/scheduler/PgSchedulerTaskStore`
and keep product settings in scoped settings or domain tables. The durable
`jobs` table remains the execution queue; `scheduler_tasks` is only scheduler
cursor/state metadata used to decide when to enqueue or fire work.
Current recurring scheduler cursors include daily capture reports
(`daily_capture_report`), automation schedules (`automation`), and source
source connection scans (`source_connection_scan`).
Do not move execution-queue timestamps such as `jobs.scheduled_at` or
domain work-item due timestamps such as `memory_maintenance_jobs.run_after`
into `scheduler_tasks`; those rows are the work being processed, not the
recurring scheduler cursor that discovers work.

When adding a new scheduler:

- Put the in-process task registration and lifecycle wiring in
  `server/src/modules/scheduler`, with tick behavior delegated to the owning
  product module.
- Store recurring cursor/state in `scheduler_tasks` via `PgSchedulerTaskStore`.
  Do not add feature-specific scheduler state tables or recurring cursor columns
  such as `next_run_at`, `next_check_at`, `last_run_at`, or `last_checked_at`
  to product tables.
- Use a stable `task_type` and `task_key`, plus the correct scope columns
  (`space_id`, `user_id`) so rows can be inspected and controlled later.
- Keep `jobs` for execution queue rows and retries. A scheduler may enqueue a
  job, but the scheduler cursor must remain separate from the queued work.

## Anti-Patterns

- A massive `DatabaseService` or `DatabaseOperations` class owning everything.
- Moving every query into one file mechanically.
- Low-level helper commits inside accepted proposal apply.
- Catching `IntegrityError`/`DBAPIError` and continuing without rollback or savepoint isolation.
- Runtime/model/deployer/backup calls inside long DB transactions.
- Persisting raw secrets in inspectable DB fields or backup manifests.
- Shell scripts writing business DB state directly.
- Hard-deleting Project Folder metadata because a path is missing.

## Transaction Audit Summary

| Area | Transaction owner | External call risk |
|---|---|---|
| Run creation | runs module | Low |
| Runtime execution | `RunOrchestrationService` — setup commit before adapter | High: adapter/sandbox |
| RunStep writes | Caller — savepoint-isolated best-effort | Low per step |
| Artifact persistence | Caller (`RunOrchestrationService`) | File storage write |
| Proposal creation / acceptance / rejection | proposals module | Code patch file write |
| Memory proposal apply | `PgProposalApplyService.accept` — one commit with rollback on failure | Source monitoring only (in-process) |
| Policy proposal apply | `PgProposalApplyService.accept` — one commit | None |
| Activity capture | `ActivityService` | None |
| Sources daily briefing Activity pointer | Source post-processing repository short upsert after successful run; auxiliary failure logged | None |
| Activity consolidation | One short commit per activity outcome | Low (consolidation model call possible) |
| Job queue / handlers | Short standalone commits; auxiliary events isolated | Handler execution |
| Project Folder archive/unregister | Single-row status update commit; physical directory left untouched | None |
| BackupService | Independent from ORM — no business commits | Tar/snapshot/file IO |
| Deployment/deployer client | No durable DB job state currently | High: socket/network |

## Known Future Work

- **Distributed multi-host locking** — current single-process advisory lock does not extend to multi-host. Requires a real distributed lock service.
- **Stronger RunStep ordering under distributed writers** — current `MAX()+1` approach is not safe under concurrent writers. Requires DB sequence or distributed counter.

## Schema Authoring (drizzle-kit as a generator)

Current schema state is declared as TypeScript under `server/src/db/schema/`
(one file per module-ish domain area, e.g. `tasks.ts`, `runs.ts`,
`retrieval.ts`; see `index.ts` for the full list). This is **schema
declaration only** — it is not a query layer. Repositories keep writing
hand-written SQL through `pg`; nothing about how queries are written
changes.

**Generator vs. applier — a strict split:**
- `server/src/db/schema/` is the schema authoring source for tables,
  constraints, indexes, and foreign keys that Drizzle can represent.
- `server/migrations/` remains the canonical generated/applied schema history.
- `server/src/db/migrator.ts` is the only schema applier for real databases.
  It reads ordered `NNNN_*.sql` files, rejects duplicate version prefixes,
  records checksums, and holds the migration advisory lock.
- `drizzle-kit` (config: `server/drizzle.config.ts`) only generates plain
  `.sql` files by diffing `src/db/schema/**` against
  `server/drizzle/meta/*.json` snapshots. It is not used to apply anything
  to a live database (no `drizzle-kit migrate` / `push` in this project).
- `server/drizzle/` (generator output + `meta/` snapshots) is **committed to
  git**: the snapshots are the state `generate` diffs against on every
  machine/CI run, not disposable build output.
- `server/scripts/db/schema-sync.mjs` bridges generated SQL into the applied
  migration directory. During the consolidated-baseline phase, every
  non-bootstrap journal entry in `server/drizzle/meta/_journal.json` must have
  a content-matching body inside `server/migrations/0001_baseline.sql`, and
  migration version prefixes must be unique.

**Changing a table:**
1. Edit the relevant file under `src/db/schema/`.
2. `npm run schema:generate` (from `server/`) — runs `drizzle-kit generate`,
   then merges the generated SQL from `server/drizzle/` into
   `server/migrations/0001_baseline.sql`. Drizzle's own internal numbering
   starts at 0000 and is never used directly by the runtime migrator.
   `ops/scripts/start.sh` runs this automatically before image build and
   migration; run it manually when you want to review generated files before
   starting the stack.
3. Review the generated SQL now consolidated into `0001_baseline.sql`. Do not
   hand-edit it for ordinary schema changes; fix the Drizzle schema and
   regenerate.
4. `npm run schema:check` (CI-safe, no database needed) fails if schema TS
   was edited without regenerating, or if a drizzle-generated migration
   wasn't merged into `server/migrations/0001_baseline.sql`. It also fails on
   duplicate migration version prefixes.

**Narrow custom-SQL boundary:**
Some PostgreSQL primitives are not expressible in the Drizzle DSL here:
data backfills, changes to the `retrieval_object_type` DOMAIN's `CHECK`
values, and Postgres extensions (`CREATE EXTENSION`). Those must be isolated
custom SQL migrations/fragments and must not be ad hoc edits to generated
table-structure SQL. They must not change table structure that
`src/db/schema/` describes unless the schema files are updated in the same
change. `schema:check` is file-based: it compares `src/db/schema/**` against
committed `server/drizzle/meta/` snapshots and checks generated migrations
were merged into `server/migrations/0001_baseline.sql`. It does not inspect a
live database or re-read custom SQL migrations for structural drift.

**Schema representation notes:**
- The `retrieval_object_type` Postgres DOMAIN (a closed enum used by ~10
  retrieval/knowledge columns) is represented with `customType` in
  `src/db/schema/_types.ts`; the DOMAIN definition itself lives in SQL
  migrations.
- `retrieval_chunks.embedding` is a deliberately *unconstrained* pgvector
  column (no fixed dimension — enforced per-row by a CHECK tying
  `embedding_dimensions` to `vector_dims(embedding)`); drizzle-orm's
  built-in `vector()` helper always emits a fixed `vector(N)`, so it can't
  represent this column. It is represented with `customType`.
- `retrieval_chunks.tsv` is represented with a `tsvector` `customType`.
- Default btree operator classes are omitted from schema declarations and
  snapshots. The HNSW half-vector ANN index keeps its required
  `halfvec_cosine_ops` operator class inside the raw SQL index expression.

**Normal workflow does not use `drizzle-kit pull`.** The day-to-day tools
(`schema:generate`, `schema:check`) diff only against committed
`server/drizzle/meta/*.json` snapshots. `pull` is not a schema parity check
for this repository.
