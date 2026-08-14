# Server Migrations

Do not hand-edit migration SQL for schema changes.

Schema authoring starts in `server/src/db/schema/`. Run `pnpm run schema:generate`
from `server/` to let Drizzle regenerate one baseline from an empty snapshot and
mirror it to `0001_baseline.sql`; `ops/scripts/start.sh` also runs that command
automatically before server image build and database migration. Run
`pnpm run schema:check` to verify the committed Drizzle snapshot matches the
TypeScript schema without touching the database or rewriting files.

The runtime migration runner only applies the SQL committed here and records
checksums in `public.server_schema_migrations`.
