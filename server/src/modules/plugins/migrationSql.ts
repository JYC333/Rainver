import type { Queryable } from "../routeUtils/common.js";
import { operationSqlCode } from "../../db/operationSql.js";
import { pluginRoleNames } from "./roleReconcile.js";

const HEADER = "-- rainver:plugin-squash ";
export interface PluginMigrationSql { id: string; sql: string }

function encode(steps: readonly PluginMigrationSql[]): string {
  return `${HEADER}${JSON.stringify(steps.map(({ id, sql }) => [id, sql.length]))}\n${steps.map(({ sql }) => sql).join("\n")}`;
}

/** Lengths preserve the original SQL text and keep the merged file reviewable. */
export function originalPluginMigrations(sql: string): PluginMigrationSql[] | null {
  if (!isMergedPluginMigration(sql)) return null;
  const headerEnd = sql.indexOf("\n");
  const boundaries: unknown = JSON.parse(sql.slice(HEADER.length, headerEnd));
  if (!Array.isArray(boundaries) || boundaries.length < 2 || boundaries.some((entry) => !Array.isArray(entry) ||
      entry.length !== 2 || typeof entry[0] !== "string" || !/^\d{4}_[a-z][a-z0-9_]*$/.test(entry[0]) ||
      !Number.isSafeInteger(entry[1]) || entry[1] < 0)) {
    throw new Error("Invalid plugin squash migration boundaries");
  }
  let start = headerEnd + 1;
  const steps = boundaries.map(([id, length]: [string, number]) => {
    const step = sql.slice(start, start + length);
    start += length + 1;
    return { id, sql: step };
  });
  if (encode(steps) !== sql || steps.some(({ id }, index) => index > 0 && id <= steps[index - 1].id)) {
    throw new Error("Invalid plugin squash SQL boundaries");
  }
  return steps;
}

export function isMergedPluginMigration(sql: string): boolean {
  return sql.startsWith(HEADER);
}

export function mergedPluginMigrationSql(files: readonly PluginMigrationSql[]): string {
  return encode(files);
}

function sqlSteps(sql: string): string[] {
  return originalPluginMigrations(sql)?.flatMap((step) => sqlSteps(step.sql)) ?? [sql];
}

/** Shared by the normal installer and the offline converter. Always called in a transaction. */
export async function applyOperationMigrationSql(db: Queryable, pluginId: string, sql: string, previousId?: string): Promise<void> {
  const { ddl, schema } = pluginRoleNames(pluginId);
  const steps = sqlSteps(sql);
  for (const [index, step] of steps.entries()) {
    // Journal rows written in this transaction use now(). Existing rows keep
    // their real timestamp, including the predecessor of a partial cutover.
    await db.query(`SELECT set_config('rainver.previous_migration_applied_at', CASE WHEN $3::boolean THEN now()::text ELSE coalesce((
      SELECT applied_at::text FROM public.plugin_migrations WHERE plugin_id=$1 AND migration_id=$2 AND status='applied'
    ), '') END, true)`, [pluginId, previousId ?? null, index > 0]);
    await db.query(`SET LOCAL ROLE ${ddl}`);
    await db.query(`SET LOCAL search_path=${schema},pg_temp`);
    for (const statement of step.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue;
      const code = operationSqlCode(statement);
      if (code.includes(';') || /\b(?:temp|temporary)\b/i.test(code) || !/^(create|alter|drop|comment|insert|update|delete)\b/i.test(code) || /\bset_config\b/i.test(code)) {
        throw new Error('Migration transaction/session control refused');
      }
      await db.query(statement);
    }
    const role = (await db.query<{ role: string }>('SELECT current_user AS role')).rows[0]!.role;
    if (role !== ddl) throw new Error('Migration role tripwire');
    await db.query('SET LOCAL ROLE NONE');
    await db.query('SET LOCAL search_path=public');
  }
}
