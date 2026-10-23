import type { Pool } from "pg";
import { MIGRATION_LOCK_KEY } from "./migrator.js";
import { loadSquashPlan } from "./migrationSquash.js";

// Runner-owned operations metadata, bootstrapped only by explicit conversion.
export const MIGRATION_CONVERSION_AUDIT_SQL = `CREATE TABLE IF NOT EXISTS public.server_schema_migration_conversions (
      id text PRIMARY KEY,
      converted_at timestamptz NOT NULL DEFAULT now(),
      operator_name text NOT NULL DEFAULT current_user,
      database_name text NOT NULL DEFAULT current_database(),
      backup_reference text NOT NULL,
      original_records jsonb NOT NULL,
      manifest jsonb NOT NULL,
      catchup_versions jsonb NOT NULL
    )`;

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

/** Explicit operations companion to the runner, using the same database lock. */
export async function convertMigrationHistory(pool: Pool, sourceDir: string, targetDir: string, options: {
  apply?: boolean;
  offline?: boolean;
  backupReference?: string;
} = {}) {
  const plan = loadSquashPlan(sourceDir, targetDir);
  if (options.apply && (!options.offline || !options.backupReference?.trim())) {
    throw new Error("Apply requires stopped writers (--offline) and a backup reference");
  }
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
    await client.query("BEGIN");
    // No implicit creation: a database must already belong to this migration lineage.
    const { rows } = await client.query<AppliedMigration>(
      "SELECT version, name, checksum, applied_at FROM public.server_schema_migrations ORDER BY version",
    );
    // At the target, or past it through normal `up` of migrations appended to
    // the formal chain: nothing of this pair remains to convert.
    const atTarget = rows.length >= plan.target.length && plan.target.every((file, i) =>
      rows[i].version === file.version && rows[i].name === file.name && rows[i].checksum === file.checksum);
    if (atTarget) {
      await client.query("ROLLBACK");
      return { state: rows.length === plan.target.length ? "already_target" as const : "beyond_target" as const, conversion: plan.id, pending: [] as string[] };
    }
    if (rows.length < plan.common || rows.length > plan.source.length || rows.some((row, i) => {
      const file = plan.source[i];
      return !file || row.version !== file.version || row.name !== file.name || row.checksum !== file.checksum;
    })) throw new Error("Database history is not an exact prefix of the source chain (unknown, missing, or changed migration)");
    const pending = plan.source.slice(rows.length);
    if (!options.apply) {
      await client.query("ROLLBACK");
      return { state: "preview" as const, conversion: plan.id, pending: pending.map((file) => `${file.version}_${file.name}`) };
    }
    // All catch-up DDL/backfills and the record swap commit together. As with
    // ordinary migrations, the operator must review SQL as transaction-safe.
    for (const file of pending) {
      await client.query(file.sql);
      await client.query("RESET search_path");
    }
    // Runner-owned operations metadata, like server_schema_migrations; not an
    // application table or a new migration in the lineage being converted.
    await client.query(MIGRATION_CONVERSION_AUDIT_SQL);
    await client.query(
      `INSERT INTO public.server_schema_migration_conversions
        (id, backup_reference, original_records, manifest, catchup_versions)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
      [plan.id, options.backupReference, JSON.stringify(rows), JSON.stringify(plan.manifest), JSON.stringify(pending.map((file) => file.version))],
    );
    await client.query("DELETE FROM public.server_schema_migrations WHERE version = ANY($1::text[])", [plan.suffix.map((file) => file.version)]);
    await client.query(
      "INSERT INTO public.server_schema_migrations (version,name,checksum) VALUES ($1,$2,$3)",
      [plan.replacement.version, plan.replacement.name, plan.replacement.checksum],
    );
    await client.query("COMMIT");
    return { state: "converted" as const, conversion: plan.id, pending: pending.map((file) => `${file.version}_${file.name}`) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()]).catch(() => {});
    client.release();
  }
}
