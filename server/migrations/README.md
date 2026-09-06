# Server Migrations

Schema authoring starts in `server/src/db/schema/`. This directory is the
append-only chain the server migration runner applies, and at the same time
the drizzle-kit output directory: `NNNN_<name>.sql` files in order, plus
`meta/` with the Drizzle journal and the snapshot each file was diffed from.

**`0000_baseline.sql` is frozen** (since 2026-09-06, when the first deployment
started carrying data). Every schema change after it is a new numbered file.
A file that any database has applied is never edited: the runner records each
file's checksum in `public.server_schema_migrations` and refuses to start
against a changed one. `server/test/baselineSchema.test.ts` pins the
baseline's hash and the chain shape so this fails in CI, not on an instance.

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
`src/db/schema/` has changes no migration captures — it runs drizzle-kit
against a scratch copy of the chain and prints the SQL that would be
generated. Both `ops/scripts/db/migrate.sh` (dev/test) and the production
server image build run it.

Some changes drizzle-kit cannot derive — a new extension, a data backfill, a
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
services come up; `--mode prod` always takes a `pg_dump` first. See
`.agent/COMMANDS.md`. An instance on an older migration is brought forward by
the normal migrate step, so a backup taken on an older build restores into a
newer one; `ops/scripts/system/restore.sh` checks during preflight that this
build carries the backup's last migration with the same checksum.

Plugin-owned tables keep their own chains under
`plugins/official/<id>/migrations/`, run by the plugin installer.
