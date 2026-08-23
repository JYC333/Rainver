# Server Migrations

Schema authoring starts in `server/src/db/schema/`. Run `pnpm run
schema:generate` from `server/` to regenerate the Drizzle authoring baseline
under `server/drizzle/0000_baseline.sql`; it never rewrites numbered runtime
migrations. Run `pnpm run schema:check` to verify the committed Drizzle
snapshot matches the TypeScript schema and that the numbered migration chain is
still present and immutable.

Runtime upgrades are explicit, append-only SQL files under this directory
(`0001_baseline.sql`, then the next numbered migration). The migration runner
applies those files in order and records checksums in
`public.server_schema_migrations`. The startup/migration scripts run the
no-write schema check before applying the chain.
