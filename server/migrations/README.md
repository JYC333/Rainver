# Server Migrations

Schema authoring starts in `server/src/db/schema/`. Run `pnpm run
schema:generate` from `server/` to regenerate the Drizzle authoring baseline
under `server/drizzle/0000_baseline.sql`. Run `pnpm run schema:check` to verify
the committed Drizzle snapshot matches the TypeScript schema.

**The runtime schema is a single file, `0001_baseline.sql`.** A schema change is
folded into it rather than appended as a numbered upgrade: no deployment
carries data that predates the baseline, so a chain of upgrades would be
history nobody replays and a second place for the schema to disagree with
`src/db/schema/`. Regenerate it from the Drizzle baseline when the schema
changes:

```bash
pnpm run schema:generate
cp drizzle/0000_baseline.sql migrations/0001_baseline.sql
```

The migration runner applies the file and records its checksum in
`public.server_schema_migrations`. The startup/migration scripts run the
no-write schema check first. `server/test/baselineSchema.test.ts` asserts the
single-file rule, so adding a numbered migration is a deliberate edit there
rather than a silent side effect.

**Rewriting the baseline means recreating the database.** The migration runner
records each file's checksum and refuses to reapply a changed one — it cannot
reconcile a rewritten baseline against a database that already has the old one.
So after regenerating, drop and recreate:

```bash
./ops/scripts/db/reset-postgres.sh   # then start.sh / migrate.sh as usual
```

That is the trade the single-file rule accepts, and it is only acceptable while
no deployment carries data worth keeping. If this instance ever does, that is
the moment to reintroduce append-only numbered migrations — and the baseline
stops being rewritable at the same time.

The same applies to **backups**: an archive taken before a baseline rewrite
restores a database whose recorded checksum no longer matches, and the runner
then refuses to start against it. `ops/scripts/system/restore.sh` compares the
two during preflight and refuses before touching anything, so the mismatch
surfaces while you can still pick a different archive.
