import { defineConfig } from "drizzle-kit";

// Generator-only config: Drizzle schema is the authoring source, but
// drizzle-kit is never used to apply migrations against a live database
// (no `drizzle-kit migrate` / `push`). `server/migrations/` is both the
// drizzle-kit output directory (numbered SQL plus `meta/` journal and
// snapshots) and the directory the server migration runner applies, so
// `pnpm run schema:generate -- --name <name>` appends the next migration to
// the same chain the runner will replay. Applied files are immutable.
//
// `generate`/`check` (the day-to-day and CI commands) are purely file-based
// and never touch a database, so SERVER_DATABASE_URL is not required for them.
// `schema:check` runs drizzle-kit against a temporary copy of the chain and
// fails if a migration would be produced, so build checks do not mutate the
// repo. Only the one-time bootstrap `pull` (and `push`, which this project
// doesn't use) need real credentials; they'll fail with an ordinary connection
// error if SERVER_DATABASE_URL is unset.

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.SERVER_DATABASE_URL ?? "postgresql://unset/unset",
  },
  // server_schema_migrations is owned and created by src/db/migrator.ts
  // (ensureMigrationsTable), not by application schema — excluded from
  // introspection/diffing so drizzle never proposes touching it.
  tablesFilter: ["!server_schema_migrations"],
});
