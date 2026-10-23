# ADR 0025: Unpublished Plan Migration Squash

Date: 2026-10-22

## Status

Accepted. The user explicitly requested one formal migration per plan on
master while retaining long-lived databases that applied some development
migrations. This authorizes the tool and the narrow B59 exception; operating
it on an existing database still needs authorization for that database.

## Decision

Published migrations and the baseline remain immutable. Before publication,
an operator may replace a terminal suffix of at least two development
migrations with one formal migration using `ops/scripts/db/squash-migrations.sh`.

Preparation writes a separate directory. The unchanged prefix retains its
SQL and checksums. Merged SQL is the exact original SQL in order, with the
runner's `RESET search_path` boundaries and the strongest maintenance marker.
It is not a newly generated final-schema diff: backfills and intermediate
data transformations must survive. The last Drizzle snapshot becomes the
formal migration's snapshot, linked to the retained prefix.

Conversion is independent of deployment environment. On an explicitly selected
database, the tool requires an exact source-history prefix, applies only
missing source SQL, archives original records and checksums in runner-owned
operations metadata, and replaces the suffix's records with the formal
record. Catch-up, audit and history conversion share one transaction and the
ordinary migrator's advisory lock. A database already at the target, or past
it through normal `up` of later appended migrations, is a no-op; ambiguous or changed histories fail closed. Conversion does not
change the current checkout's migration files.

Default low-level conversion only previews. Applying requires an explicit offline
declaration and backup reference; the CLI checks a supplied custom-format
dump header. Operators stop writers, verify backup restoreability and
rehearse on a restored copy. The tool does not infer publication status,
stop applications, create a backup, repair manual schema drift, validate
arbitrary rewritten SQL equivalence, or authorize deployment. SQL must be
reviewed as transaction-safe, as for the existing migrator; embedded
transaction controls and nontransactional side effects are unsupported.

The explicit Compose `cutover` command wraps that converter with a per-mode
operations lock, pre-stop build/target/history checks, stop of running apps,
backup via the existing dump helper, apply and restore of the prior app set.
It retains PostgreSQL and stops on failure without automatic rollback or
recovery. Production uses its selected published image rather than a local
build. This host-operated lifecycle command is not a product deployment API.

Managed preparation freezes the source and target under the selected instance's
`db/migration-archives/<content-id>/`. Cutover defaults to content-based discovery
in that store, other mode stores and the legacy parent catalog, matched against
the database's applied history as well as the checkout: the first pair's source
must accept that history, each further pair's source must start with the
previous target (a plan squashed again), and the last target must start the
checkout. Identical pairs deduplicate; distinct sequences that both fit
require an explicit override.
The selected pair is imported into the current instance before stopping apps.
No candidate is selected by modification time or a guessed filename.
Preparation seeds pending copies for all already configured local modes.
Each copy resolves once that mode's database carries the target chain (its
own cutover, or normal `up` of the formal chain) and then expires with the
local backups recorded at resolution. External instances must receive the frozen
pair before the source's final copy is retired.

The existing backup retention policy also bounds generated migration safety
dumps. An hourly task runs independently of automatic backup creation. Completed
managed pairs expire only when their recorded local dump/full-backup dependencies
are gone. Pending/failed conversion material and operator-owned source catalogs
are never blindly expired. Local policy cannot discover offsite backups: retain
a source chain/release with those copies. Cutover and pruning share an exclusive
filesystem mutex; failed cutovers pin recovery material until a successful retry.

Archive the old chain outside the repository until all affected databases
and retained backups have an upgrade path. Switch the checkout/image to
the target chain before restarting writers. Future development appends to
that same formal chain; dev and master must not retain competing numbering.
This is not a schema epoch reset and does not reset business data.

## Reuse / Dependency Check

- Existing: `loadMigrations`, checksums, `MIGRATION_LOCK_KEY`, `pg`, Node filesystem
  and argument parsing, Zod, Drizzle snapshots, shared PostgreSQL test fixtures.
- External option evaluated: Drizzle Kit custom migration generation
  (<https://orm.drizzle.team/docs/kit-custom-migrations>) produces SQL, but does
  not own Rainver's `server_schema_migrations` records or conversion audit.
- Choice: a narrow operations companion to the existing runner, no new
  dependency or alternate normal migration engine. No SQL parser or general
  schema-equivalence engine is introduced.
- Retention/discovery extension: reuse `BackupService`, the scheduler registry,
  instance `backup_retention_count`, migration content identities and Node/Zod.
  This is Rainver-specific recovery dependency policy, not a new general backup
  engine or scheduler; no third-party package would replace those semantics.

## Consequences

Master may contain one new formal migration per plan. Databases at different
prefixes of that plan can continue without resets. The explicit source/target
archives are required for conversion; standard `up` never silently rebases
history. Pre-conversion backups retain the old identity and must be restored
using the archived source release before conversion, not forced through a
target release's restore identity checks.

## Addendum (2026-10-22): one-time schema-only rebase of 0001

After the first squash produced `0001_agent_workbench` as the exact composition
of four development files (test converted with the managed tool, audit
`796a6138…`), two more unpublished files (`0002_cli_binding_host_thread`,
`0003_room_conversation_scopes`) were applied to test. Commit `9476ae59` then
regenerated `0001_agent_workbench.sql` as a **final-schema diff** that also
covers those two files and dropped them from the chain. That is outside this
ADR: the new 0001 is not the composition of any archived source, so no frozen
pair for it can pass `loadSquashPlan`, and the dropped files' backfills
(CLI bindings onto Host threads; the Room recipient ledger, Setup and binding
split per Conversation) disappeared from the published upgrade path.

The user explicitly authorized a one-time exception for the test database
only. It was rebased by a guarded metadata-only transaction after a backup and
a restore rehearsal proving identical application schema and data; dev and
prod had applied none of the replaced files. The record lives outside the
repository in `$RAINVER_ROOT/test/db/manual-migration-rebases/20261022-1700/`
(`source/`, `target/`, `align-metadata.sql`, `original-records.json`,
`preflight.json`, rehearsal evidence, `README.txt`); its audit row is
`d0901500…` in `server_schema_migration_conversions`. It is not a frozen pair
and is not a discovery catalog.

Consequences, which bind future work:

- The exception does not widen B59 or this ADR. A merged migration produced by
  the tool remains the exact ordered composition; a final-schema rewrite of
  an applied migration is never repeated. Rewriting history records outside the
  converter needs fresh, explicit, per-database authorization.
- Lost data transitions are restored by an appended migration, never by
  editing an applied one: `0003_repair_upgrade_backfills` (since squashed by
  the managed tool, unaltered, into `0002_skill_library_and_upgrade_repairs`
  together with `0002_skill_library_packages`) reapplies them to
  rows still in the pre-0001 shape and is a no-op on test. Its Room split
  also carries the recipient's open capture gaps into the Conversation scopes
  they may belong to, which stay `partial`, so an upgrade never presents a
  history with a known gap as complete. Execution control snapshots are not
  rewritten; continuity recognizes the recorded split lineage instead.
  Unfinished checkpoint jobs of the retired whole-Room recipient scopes are
  cancelled, so none fails against their residual events after the upgrade.
- The legacy catalog pair `$RAINVER_ROOT/migration-archives/2026-10-22-agent-workbench`
  (id `796a6138…`) is retired for cutover: its target is the superseded
  0001, which no current checkout starts with, so discovery never selects it.
  It is kept only as step one of restoring the backup taken before it.
  Retention never deletes the legacy catalog.
- Backups taken before the rebase carry histories no current release or pair
  accepts; their restore procedure is in `server/migrations/README.md`
  ("Restoring backups from before the 2026-10-22 rebase").

The same review hardened the tool: `cutover` accepts a checkout whose chain
starts with the archived target and runs normal `up` for the rest, records
the stopped application set for a retry, publishes its dump only after
verification, and retention now resolves pending pairs the live database has
already passed, counts recovery points per schema version, and warns instead
of skipping silently.
