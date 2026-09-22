# Server Migrations

Schema authoring starts in `server/src/db/schema/`. This directory is the
append-only chain the server migration runner applies, and at the same time
the drizzle-kit output directory: `NNNN_<name>.sql` files in order, plus
`meta/` with the Drizzle journal and the snapshot each file was diffed from.

**`0000_baseline.sql` starts the 2026-09-21 ACP runtime-authority schema epoch.**
It is drizzle-kit output, generated from `src/db/schema/` against an empty
chain, so every object in it has a Drizzle definition `schema:check` can see.
Its one hand-added line is the `CREATE EXTENSION` at the top, which drizzle-kit
does not model and the `vector` columns need first. Never regenerate it from a
`pg_dump` of a migrated database: a dump carries catalog names — renamed
columns' NOT NULL constraints, for one — that no Drizzle definition mentions,
and every new instance would then be created carrying them.
Databases from the prior epoch cannot be upgraded or restored into this epoch;
they must be recreated from this baseline. The reset intentionally does not
preserve or transform prior-epoch rows. After release, this baseline is frozen
and every later schema change is a new numbered file. A file that a database
has applied is never edited: the runner records each file's checksum in
`public.server_schema_migrations` and refuses to start against a changed one.
`server/test/baselineSchema.test.ts` pins the baseline hash and new-epoch chain
shape so accidental drift fails in CI, not on an instance.

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
`.agent/COMMANDS.md`. Within this schema epoch, an older build's database can
be brought forward by the normal migration step. A pre-epoch backup is not
compatible: restore preflight rejects its migration identity/checksum, and
forcing that check does not make the old schema startable. Recreate the
instance from this epoch's baseline instead.

Plugin-owned tables keep their own chains under
`plugins/official/<id>/migrations/`, run by the plugin installer.
