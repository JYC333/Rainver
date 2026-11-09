# Server Migrations

Schema authoring starts in `server/src/db/schema/`. This directory is the
append-only chain the server migration runner applies, and at the same time the
drizzle-kit output directory: `NNNN_<name>.sql` files in order, plus `meta/`
with the Drizzle journal and the snapshot each file was diffed from.

**`0000_baseline.sql` is the 2026-10-15 access, reading and execution
integrity schema epoch** ([ADR 0024](../../.agent/decisions/0024-access-reading-and-execution-integrity-schema-epoch.md)).
It is drizzle-kit output generated from `src/db/schema/` against an empty
chain, so every object in it has a Drizzle definition `schema:check` can see.
It carries no retired column or table, no backfill, no `NOT VALID` check and
no compatibility path.

Its one hand-added line is the `CREATE EXTENSION` at the top, which drizzle-kit
does not model and the `vector` columns need first. Never regenerate it from a
`pg_dump` of a migrated database: a dump carries catalog names — renamed
columns' NOT NULL constraints, for one — that no Drizzle definition mentions,
and every new instance would then be created carrying them.
Databases from an earlier epoch cannot be upgraded or restored into this epoch;
the operator must recreate them from this baseline. Applying this repository
does not reset any database or preserve or transform earlier rows. The baseline is frozen
and every later schema change is a new numbered file. A file that a database
has applied is never edited: the runner records each file's checksum in
`public.server_schema_migrations` and refuses to start against a changed one.
`server/test/baselineSchema.test.ts` pins the baseline hash and the contiguous
chain shape so accidental drift fails in CI. The narrow unpublished-plan
squash exception is described below and in
[ADR 0025](../../.agent/decisions/0025-unpublished-migration-squash.md).

The unpublished `dev` suffix formerly numbered `0005`–`0022` is composed into
`0005_project_reading_and_source_goals.sql`. The published `0000`–`0004`
prefix is unchanged. The formal file retains every original statement, backfill
and inter-file `RESET search_path` in order; its snapshot is the former final
snapshot linked to `0004`. Schema authoring still appends after this chain.

The following unpublished `dev` suffix `0006_topic_following` through
`0012_reader_note_personal_space` is now composed into
`0006_following_and_reader.sql`. The published `0000`–`0005` SQL and snapshots
remain byte-for-byte unchanged. Topic membership/judgment/change deliveries,
Reader positions, document-note creation and the Personal Space association
backfill remain in their exact original order, separated by `RESET search_path`.
The final former `0012` snapshot is relinked to `0005`; development then resumed
at `0007` (now consolidated below). This was one branch increment, not a
baseline/schema-epoch rewrite.
The managed preparation archived this source/target pair alongside the earlier
pair; an instance that applied any of `0006`–`0012` needs explicit ADR 0025
history conversion before normal upgrades, not checksum overrides or a reset.
No live database conversion or deployment is performed by this consolidation.


Preparation archived the original and target chains with the managed squash
tool outside the source tree. Before updating any database that applied the
former suffix, use ADR 0025's archived-pair discovery and explicit offline
cutover procedure; ordinary `up` cannot replace its migration history.
This source consolidation does not perform a database cutover or authorize one.

## Current dev branch consolidation (2026-11-02)

The six unpublished migrations `0007_information_briefings` through
`0012_project_private_deep_reading` are composed into `0007_project_reading.sql`.
The published `0000`–`0006` SQL and snapshots are byte-for-byte unchanged.
All six original SQL bodies, including backfills and per-file `RESET search_path`
boundaries, remain in order. The final former `0012` snapshot is linked to
`0006`; the next migration is `0008`.

Reuse / Dependency Check: this consolidation uses the existing ADR 0025
`prepare` tool, ordered SQL validator and history converter, with no new
schema generator, dependencies or migration engine.

The managed source/target pair has content identity
`5bb48ff82dd378d4c88f7902d120db1d1c00a50dee544040c62d9a98098857ba`
and is retained outside the repository under each configured local mode's
`db/migration-archives/`. Keep this pair with affected databases/backups;
external instances need a copy before switching migration chains. A database
that applied any former `0007`–`0012` must use explicit ADR 0025 conversion,
not normal `up` against changed history. A database through published `0006`
or a fresh database uses normal `up`. This source consolidation does not
convert an instance database, restart services or deploy the application.

## Changing the schema

```bash
cd server
# 1. edit server/src/db/schema/
# 2. append the migration drizzle-kit derives from the diff
pnpm run schema:generate -- --name add_widget_color
# 3. read the generated SQL; add data backfills or ordering fixes to that
#    same file if the plain DDL is not enough. It is editable until it has
#    been applied somewhere — after that, write another migration.
# 4. verify (no database needed)
pnpm run schema:check
```

`schema:check` fails when the chain is malformed (gap, duplicate, journal and
files disagreeing, missing snapshot), when an extension declared in
`src/db/schema/database-features.json` is created by no migration, or when
`src/db/schema/` has changes no migration captures. It runs drizzle-kit
against a scratch copy of the chain and prints the SQL that would be generated.
Both `ops/scripts/db/migrate.sh` (dev/test) and the production server image
build run it.

Some changes drizzle-kit cannot derive — a new extension, a data backfill, or a
constraint that depends on existing rows. Start from an empty file:

```bash
pnpm run schema:generate -- --custom --name enable_pg_trgm
```

drizzle-kit only ever sees `--out` relative to `server/`; the script handles
that, and treats any error text in drizzle-kit's output as a failure because
drizzle-kit exits 0 on a failed snapshot read.

## Applying

Migrations are explicit ops commands, never a server-startup side effect.
`ops/scripts/start.sh` runs `ops/scripts/db/migrate.sh` before the app
services come up; `--mode prod` takes a `pg_dump` first whenever a migration
is pending (`pre-migrate-<ts>-from-<applied version>.dump`; a start with
nothing pending takes none, and an unanswered pending check still dumps). See
`.agent/COMMANDS.md`. Within this schema epoch, an older build's database can
be brought forward by the normal migration step. A pre-epoch backup is not
compatible: restore preflight rejects its migration identity/checksum, and
forcing that check does not make the old schema startable. Recreate the
instance from this epoch's baseline instead.

Plugin-owned tables keep their own chains under
`plugins/official/<id>/migrations/`, run by the plugin installer.

## Squashing an unpublished plan without resetting existing databases

One plan may produce several development migrations while master receives
one new formal migration. Published migrations and `0000_baseline.sql` remain
fixed. The operator selects the first unpublished migration; the tool cannot
infer which files have been released. Only a terminal suffix of at least two
files is eligible. This explicit workflow has no environment-name restriction:
dev, test, and other databases using this server runner are supported through
`SERVER_DATABASE_URL`. It does not convert other frameworks' tracking tables
or pre-epoch databases.

### Prepare and retain the old chain

Freeze the complete original chain, including SQL and `meta/`, before changing
the checkout. The managed preparation command handles the archive location:

```bash
pnpm --dir server run build
./ops/scripts/db/squash-migrations.sh prepare --mode dev \
  --from 0001 --name agent_attention_plan
```

`prepare` and `convert --host` run the built libraries on the host and refuse
any Node other than 24 (the repository's engines range). This defaults to the
checkout's `server/migrations` as source and prints the
managed `db/migration-archives/<content-id>/` location containing frozen
`source/`, `target/` and a recovery state record. Review and adopt `target/`
as the checkout's chain. Preparation does not change the checkout. An explicit
`--source DIR --output DIR` still writes a separate operator-owned target;
that output must not exist and must be separate from the source. Preparation
does not edit the source or connect to a database. It retains the unchanged
prefix, appends one migration, and updates the Drizzle journal and final
snapshot link for continued generation. SQL-only archives are supported;
when `meta/` exists its journal/snapshots must be complete.

Managed preparation seeds a pending copy in every other already configured
local mode (`dev`, `test`, `prod` with an existing `.env`). Each mode owns its
copy and conversion state, so dev cleanup cannot erase an idle test instance's
upgrade path. A pending copy resolves once that mode's own database carries
the target chain, whether by cutover or by normal `up` of the formal chain
(production's usual path, or a fresh database); retention then records the
local dumps/backups present at that moment as its dependencies and expires it
after they are gone. A database still on the source history keeps it pending.
For external instances, distribute the frozen pair before retiring the
source's last copy.

Merged SQL preserves **every source operation in order**, including backfills
and intermediate alterations, with the runner's `RESET search_path` between
files and any maintenance requirement at the top. Do not edit the result or
replace it with a final-schema diff: conversion rejects SQL that differs from
this exact composition. (The one recorded exception, the 2026-10-22 rebase of
`0001_agent_workbench`, is described below; it is not a precedent.) Review SQL
as trusted, transaction-safe migration code:
embedded BEGIN/COMMIT/ROLLBACK, concurrent index operations, external effects,
and sequence operations that cannot roll back are unsupported. Existing SQL
that drops data retains that effect; the converter adds no reset or cleanup.

### Preview each database

The root operations entrypoint defaults to a one-shot server container.
`--mode dev|test|prod` uses the existing shared Compose resolver and that
mode's existing `.env`/`.server.env`; it does not generate environment files
or start database services. Use a server image built with the current libraries.
Archive and backup paths are mounted read-only at their absolute host paths.
For example, preview test (omit `--mode` for dev):

```bash
./ops/scripts/db/squash-migrations.sh convert --mode test \
  --source /path/to/archived-migrations --target /path/to/merged-migrations
```

For any other reachable PostgreSQL, use `convert --host` instead of
`--mode test`, with `SERVER_DATABASE_URL` (or `DATABASE_URL`) set through the
normal secure operator environment. Host mode uses the locally built libraries.
This selection is not restricted to dev/test.

Default preview only reads history under the migration lock. It does not
execute pending SQL, create tables or alter records. `pending` lists the
source files still to execute. If A/B/C/D are merged and only A/B were applied,
only C/D run during conversion. A fully applied source needs no business SQL.
A database with just the retained prefix can also convert; a fresh database
should use normal merged-chain `up`. Missing history tables, changed
names/checksums, gaps, unexpected versions and different baselines fail before
catch-up. A history at the target, or past it through normal `up` of later
appended migrations (`beyond_target`), is a no-op.

### Rehearse, back up and apply explicitly

For a standard Compose instance, the complete cutover is one command from
the repository root:

```bash
./ops/scripts/db/squash-migrations.sh cutover --mode test
```

This command **executes** conversion. Finish active work before running it
from a host terminal: the Room/web connection will disconnect during the stop.
It matches the database's applied history and the checkout's migration
identities against managed mode stores and the legacy
`$RAINVER_ROOT/migration-archives/` catalog, then imports the frozen pairs
into this instance. The first pair's source must accept the applied history
exactly as conversion does; after several squashes, an instance still on an
older plan's source therefore gets that plan's pair, not the newest one. Each
further pair's source must start with the previous pair's target (a formal
migration squashed again), and the last target must be the checkout's chain or
a prefix of it. The shortest such sequence is chosen, ending at the longest
target; a database that already carries a target the checkout starts with gets
that pair as a no-op. Identical pairs deduplicate. Missing/ambiguous matches
stop before an outage; `--archive DIR` is an optional explicit override.
It serializes cutovers per environment; requires an already-running PostgreSQL;
builds the dev/test server image before stopping anything (prod uses its
selected published image); verifies the image and checkout carry the same chain starting with the
last pair's target and previews the first pair against the live history; records and stops running
or restarting application services while keeping PostgreSQL; takes a fresh
custom dump to a hidden `.partial` file, checks its readability and only then
publishes it as `pre-squash-<ts>-<random>.dump`; applies each pair's
conversion in order (each commits on its own, so after a failure the database
rests on the previous target and a retry selects only the remaining pairs); runs
normal `up` for migrations appended after the last target (applications are
stopped, so a maintenance migration is allowed); then recreates the server
with the verified image and restores only the recorded apps. Build/preflight
failure causes no outage. A later failure stops the sequence with no automatic
rollback or restart; inspect the reported backup and container state. The
stopped set stays recorded in `db/.migration-cutover.active/apps`, so a
successful retry restarts it even though nothing is running any more.

Generated `pre-migrate`/`pre-squash` dumps are pruned hourly to the configured
backup retention count of recovery points, independently of automatic backup
creation. Pre-migrate dumps naming the same applied version (`-from-NNNN`)
are retries before one schema change and count once: only the newest is kept,
so they cannot evict the dump taken before an earlier change. Resolved
managed pairs expire after their recorded local dump and full-system backup
dependencies disappear. Pending pairs this database has not passed and failed
conversions remain pinned. A held mutex or an unfinished-cutover marker pauses
retention with a scheduler warning (marked probably stale after 24 hours)
that names the recovery command. Manual dumps, manual full-system backups,
hidden partial dumps and external source catalogs are not deleted.
Keep source releases/chains with offsite backups; local cleanup cannot track
copies elsewhere. The operations guide documents stale-mutex recovery.

The lifecycle wrapper is specific to Rainver Compose services. The underlying
`convert --host` remains available for any matching external PostgreSQL, whose
application lifecycle must be handled by its operator. The detailed/manual
procedure below remains useful for that case. A dump readability check is not
a restore rehearsal.

Rehearse on a restored backup copy first: verify required schema/data
invariants and a subsequent migration. The exact-SQL/history checks establish
lineage; they do **not** inspect or repair manual schema drift or prove
business-data invariants. Preview is not a SQL execution rehearsal.

Stop application writers and migration jobs, take a fresh `pg_dump -Fc`
backup using the existing backup helpers, verify restoreability, then apply:

```bash
./ops/scripts/db/squash-migrations.sh convert --mode test \
  --source /path/to/archived-migrations --target /path/to/merged-migrations \
  --apply --offline --backup /path/to/database-before-conversion.dump
```

`--offline` declares that writers are stopped; the tool does not stop them.
The CLI checks the backup is a nonempty file with a custom-dump header; that
does not prove its target, freshness, completeness or restoreability. The
absolute backup reference is recorded; credentials and business rows are not
written to the audit.

Catch-up SQL, record conversion and audit commit in **one transaction** under
the same advisory lock as ordinary `up`. Transactional SQL failure leaves
the original history/data in place. Runner-owned operations metadata
`public.server_schema_migration_conversions` stores original versions, names,
checksums and timestamps, source/target identities, newly executed versions,
operator/database and backup reference; future dumps include it. Only the
replaced suffix's migration records change. Repeating the frozen source/target
conversion at that target is a no-op.

Before restarting writers, deploy/use the merged chain. Resume development
from that same chain; update SQL **and** `meta/` together and run
`pnpm --dir server run schema:check`. Do not append to the old source chain. Preparation
and conversion do not alter the checkout, merge branches, publish or deploy.
A database with later migrations is outside this frozen conversion pair;
the converter is not a general history repair tool.

Pre-conversion backups retain their old migration identity. Restore with the
archived source release and normal restore checks, then convert; do not force
them through the target release's restore preflight. Keep source archives
until the corresponding backup retention period ends.

## Squashes after 0002

- `0003_vendor_session_owned_conversation.sql` is `prepare --from 0003` over
  the four development files that retired the server-side conversation
  mechanisms (CLI bindings, local CLI runtime state and the Git gate, the
  rolling Room summary tables, then the host-thread standing digest). Archive
  `089614ce…` in each mode's `db/migration-archives/`; a database that applied
  the development files (test did) is converted with `cutover`, a fresh one
  takes the formal file by normal `up`.

- `0004_remove_capability_layer.sql` is `prepare --from 0004` over
  `0004_remove_capability_layer` (offline: it drops the `capability_*` tables
  a pre-0004 release reads) and `0005_retire_evolution_targets_and_rename_skills`.
  Archive `35152e5d…` in each mode's `db/migration-archives/`. Test applied
  both development files and is converted with `cutover`; dev and prod had no
  database and take the formal file by normal `up`. The one-off data
  statements (superseding capability proposals, archiving retired Evolution
  targets, `converted` → `reviewed`, `capability_overlay` → `skill_overlay`)
  stay in the composition because conversion requires the exact original
  SQL; on every database that can still reach this file they match no rows.

## The 2026-10-22 rebase of 0001 (one-time exception)

`0001_agent_workbench.sql` was first produced by `prepare` as the exact
composition of `0001_agent_attention_read_states` … `0004_conversation_session_config`,
and test was converted with the managed tool. Two more development files,
`0002_cli_binding_host_thread` and `0003_room_conversation_scopes`, were then
applied to test, after which 0001 was regenerated as a final-schema diff that
also covers them, and both were removed. ADR 0025's addendum records the
user-authorized, test-only metadata rebase that followed; dev and prod had
applied none of the replaced files.

- The repair, first appended as `0003_repair_upgrade_backfills.sql` and now
  the second part of `0002_skill_library_and_upgrade_repairs.sql` (squashed
  with `0002_skill_library_packages` by `prepare --from 0002`; archive
  `528ab5b0…` in each mode's `db/migration-archives/`), restores the data transitions those
  files carried for every database reaching 0001 by normal `up`: active CLI
  bindings regain their Host thread where it is uniquely derivable; Room
  recipient ledgers, latest Setups and thread-following bindings split into
  per-Conversation scopes; bindings no dispatch can reach any more are
  rotated rather than left active. Open capture gaps of a split recipient
  follow the history: a Run's gap moves, replay payload included, to that
  Run's Conversation scope; a gap no Run attributes (a reconciliation
  mismatch) is copied into every split Conversation scope. Those scopes stay
  `partial` until the gap is replayed or a clean rescan resolves it. Moved
  events keep naming Runs whose audit snapshots name the recipient scope;
  continuity reads that split lineage instead of rewriting the snapshots
  (`.agent/modules/runtime-context.md`, Continuity). Unfinished checkpoint
  jobs queued for a whole-Room recipient scope are cancelled: no turn writes
  that scope any more, and the events the split leaves on it have sequence
  holes, so such a job could only fail and retry. It changes nothing on test.
- Chains and evidence live outside the repository:
  - `$RAINVER_ROOT/migration-archives/2026-10-22-agent-workbench/` — the
    original squash pair (source: the four development files; target: the
    first composed 0001, checksum `46de5ec9…`). Retired for cutover: no current
    checkout starts with that target, so discovery never selects it. Keep it
    with the backups below.
  - `$RAINVER_ROOT/test/db/manual-migration-rebases/20261022-1700/` —
    `source/` (0000, composed 0001, 0002_cli_binding_host_thread,
    0003_room_conversation_scopes), `target/` (0000, current 0001
    `1c7b4c54…`), the guarded `align-metadata.sql`, original records and
    rehearsal evidence. It is not a squash pair (`loadSquashPlan` rejects it by
    design) and is not a discovery catalog.

### Restoring backups from before the 2026-10-22 rebase

Neither the current release nor any frozen pair accepts these histories
directly. Rehearse on a scratch database first, keep applications stopped,
and treat each step as an explicit operator action.

| Backup (test `db/dumps/`) | Recorded history |
|---|---|
| `pre-squash-zlas6OtL.dump` | 0000 + the four original development files |
| `dump-20261022-165704.dump`, `dump-20261022-165940.dump` | 0000, composed 0001 (`46de5ec9…`), 0002_cli_binding_host_thread, 0003_room_conversation_scopes |

1. Restore the dump with `ops/scripts/db/restore.sh` (DB-only restore has no
   migration-identity preflight).
2. For `pre-squash-zlas6OtL.dump` only: convert with the legacy pair, e.g.
   `squash-migrations.sh convert --mode test --source …/2026-10-22-agent-workbench/source --target …/2026-10-22-agent-workbench/target`
   (preview, then `--apply --offline --backup FILE`), then bring it to the
   rebase source by normal migration with that chain:
   `SERVER_MIGRATIONS_DIR=…/manual-migration-rebases/20261022-1700/source` and
   `node dist/db/migrateCli.js up` in a server container with that directory
   mounted.
3. Run `…/manual-migration-rebases/20261022-1700/align-metadata.sql` with
   `psql -v ON_ERROR_STOP=1` against the restored database. Its guards refuse
   any history other than the exact rebase source and verify the result. It
   rewrites only `server_schema_migrations` and adds the conversion audit row
   (on a database that already has that row, remove the audit `INSERT` from a
   reviewed copy instead).
4. Run the normal `ops/scripts/db/migrate.sh`; it applies the migrations after
   0001, including the repair, which finds nothing to change.

## Problem-engine branch consolidation (2026-11-04)

Unpublished0009–0021 are now the single `0009_problem_engine.sql`, prepared
with ADR0025's canonical tool. Published0000–0008 SQL and snapshots are
unchanged. Every source SQL statement/backfill, RESET search_path boundary and
the strongest maintenance requirement is retained, including static archives,
the0020 top-level Run/reference ACL repair and0021 ordering-marker removal.
The final0021 snapshot is relinked to0008; next development migration is0010.

The frozen source/target pair is registered **only in test**, content identity
`a1290f83fe0bb2e49d09988de51c4c5a0e6ebc7aa986927f2089816269280e83`,
under its `db/migration-archives/`. No dev/prod preparation or deployment is
implied. Preserve/distribute this pair with backups carrying the source history.
An existing source-prefix database requires canonical offline `convert`, not
normal up or checksum overrides. Fresh/published0008 databases use normal up.
Intermediate development SQL test copies have been removed. Tests upgrade
representative0008 rows through the current formal migration directly.


### Final retired-model removal (2026-11-04)

The former formal0009 plus a Drizzle-generated retirement0010 are again
composed by ADR0025 into the sole0009_problem_engine. The generated section
removes only dedicated imported stage-event rows and the dedicated static
archive table; normal event references to those rows fail closed for review.
Existing instances require a verified private export and backup before this
explicit offline deletion. The previous formal0009 stays intact in its frozen
source archive, not overwritten in any applied tracking table. Current test's
new pair is b4e42a4ccc1176877c43e85a391a979258652a8825380a34b7753f5039a7c356;
old recovery pairs and backups are retained. No old-model schema, event registry,
UI display or complete development-chain test fixture remains in application
code. Historical SQL names remain only as ordered version records required by
exact composition, not runtime compatibility. Published0000–0008 are unchanged.


## Private functional-release rehearsal (2026-11-09)

This private candidate consolidates only the isolated-workspace feature:
former `0017_isolated_execution_workspaces` through
`0020_workspace_source_release_operations` become
`0017_isolated_workspaces_and_retention.sql`. It is the exact ordered
composition produced by ADR 0025's existing `prepare` tool, including both
shared-source backfills, every intermediate alteration, per-file
`RESET search_path`, and the strongest maintenance marker. The final former
`0020` snapshot is linked to `0016`. SQL and snapshots through `0016` remain
byte-for-byte unchanged; the next new migration is `0018`.

Other functional migrations (`0011` operation idempotency, `0012` plugin
lifecycle, `0013`/`0014` decision effects, `0015` Host tool presentation and
`0016` Folder IO intents) remain independent. Reducing file count does not
authorize reordering these features or rewriting the applied Folder IO prefix.
The candidate has 18 migrations including the 11-file master prefix, rather
than the original 21. This is not a new schema epoch or a one-file baseline.

The frozen source is the complete migration directory at dev commit
`1f10e745bad67516c4080da7f11df0340e3b1fcf`. Retain a complete external source/target
archive before any actual release or instance conversion. An instance that
applied former `0017` through `0020` requires explicit offline ADR 0025
conversion; normal `up` refuses the changed history. Instances through `0016`
use normal `up` with the maintenance requirement. This rehearsal changes no
running database or shared branch and authorizes no deployment.

Reuse / Dependency Check: existing `prepareSquash`, `loadSquashPlan`,
`convertMigrationHistory`, schema checks and shared real-PostgreSQL fixtures;
no new migration engine, dependency, or schema-diff rewrite.

## Historical Folder IO prefix and original isolated workspace suffix (2026-11-07)

The applied dev/test prefix ends at `0016_project_folder_io_intents.sql`.
Its SQL SHA-256 is
`d9f71a47ef6e95f046901e6af5c4da815aebe156e391b4fa1ea45a683f353307`.
The complete `0000`–`0016` applied SQL, including
`0015_host_tool_presentation.sql`, retains its original names, numbers and bytes.

The original isolated-workspace feature was appended as
`0017_isolated_execution_workspaces.sql`, generated by `schema:generate` against
the original Folder IO snapshot. The final snapshot retains both Folder IO and
isolated-workspace schema changes. New schema changes append after this suffix.

A previous source integration assigned `0016` to isolated workspaces and moved
Folder IO to `0017`, incorrectly assuming Folder IO had never been applied.
That chain conflicts with an instance recording `0016_project_folder_io_intents`;
restoring its exact original SQL and snapshot, then regenerating the workspace
suffix, resolves the mismatch without changing any database checksum or row.
The migration error names the incoming file; the tracking table's applied name
and checksum identify the immutable original migration.

Databases through the published Folder IO prefix use normal checksum-enforcing
`up` to apply only the new workspace migration. No history conversion, checksum
override or database reset is needed. The real-PG upgrade regression verifies
that applied migration names/checksums/timestamps and existing Folder IO data
survive the upgrade, and that repeating the migration applies nothing.

Do not renumber a file merely because it is still uncommitted. A migration that
any instance has applied is already immutable. If a different instance has
applied an incompatible suffix, identify and preserve that history before any
upgrade; use the explicit ADR 0025 archive/conversion workflow where applicable.
This source repair does not apply pending migrations or restart an instance.

### Former 0020 remains an offline maintenance operation (2026-11-08)

Former `0020_workspace_source_release_operations.sql`, now composed into
`0017_isolated_workspaces_and_retention.sql`, carries `-- rainver:maintenance`.
It replaces the `workspace_source_releases` key `(host_id, commit)` with
`(host_id, commit, operation_id)`; the previous release claims with
`ON CONFLICT (host_id, commit)`, which fails once that key is gone, and its
backfill of every unconfirmed claim is complete only while no older server
claims or confirms meanwhile. `start.sh` and the UI update therefore refuse it
and name `./ops/scripts/start.sh --maintenance`, which waits for Runs, stops the
applications (PostgreSQL stays up), takes the dump, applies it and starts the
new release. A failure leaves the applications stopped with the dump kept; it
is never applied under a running older server.
