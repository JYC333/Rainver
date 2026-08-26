import { randomUUID } from "node:crypto";
import type {
  SourcePolicyEnvelope,
  SourceRecipeDefinition,
  SourceRecipeDryRunResult,
} from "@rainver/protocol";
import { dateIso, type Queryable } from "../../routeUtils/common.js";
import { getSourceChannelScanTask, upsertSourceChannelScanTask } from "../sourceConnectionScheduler.js";
import { resolveRequestedSourceSchedule } from "../sourceScheduleInput.js";

/**
 * SQL access for `source_recipe_versions` (Level 2 Source recipes). Follows
 * the `source_handler_versions` conventions: version_number is max+1 with a
 * unique-violation retry, status transitions are guarded in SQL so a
 * concurrent activation/dry-run cannot resurrect a superseded version.
 */

export const RECIPE_VERSION_COLUMNS = `id, space_id, source_connection_id, version_number,
  recipe_json, policy_envelope_json, primitive_versions_json, status,
  created_by_user_id, proposal_id, test_result_json,
  created_at, activated_at, superseded_at`;

export interface RecipeVersionRow {
  id: string;
  space_id: string;
  source_connection_id: string;
  version_number: number;
  recipe_json: unknown;
  policy_envelope_json: unknown;
  primitive_versions_json: unknown;
  status: string;
  created_by_user_id: string | null;
  proposal_id: string | null;
  test_result_json: unknown;
  created_at: Date | string;
  activated_at: Date | string | null;
  superseded_at: Date | string | null;
}

export function recipeVersionOut(row: RecipeVersionRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    source_connection_id: row.source_connection_id,
    version_number: row.version_number,
    recipe_json: row.recipe_json ?? {},
    policy_envelope_json: row.policy_envelope_json ?? {},
    primitive_versions_json: row.primitive_versions_json ?? null,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    proposal_id: row.proposal_id,
    test_result_json: row.test_result_json ?? null,
    created_at: dateIso(row.created_at),
    activated_at: dateIso(row.activated_at),
    superseded_at: dateIso(row.superseded_at),
  };
}

export async function insertSourceRecipeVersion(
  db: Queryable,
  input: {
    spaceId: string;
    connectionId: string;
    recipe: SourceRecipeDefinition;
    policyEnvelope: SourcePolicyEnvelope;
    primitiveVersions: Record<string, number>;
    createdByUserId: string | null;
  },
): Promise<RecipeVersionRow> {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await db.query<RecipeVersionRow>(
        `INSERT INTO source_recipe_versions (
           id, space_id, source_connection_id, version_number, recipe_json,
           policy_envelope_json, primitive_versions_json, status, created_by_user_id, created_at
         )
         SELECT $1, $2, $3, COALESCE(MAX(version_number), 0) + 1, $4::jsonb,
                $5::jsonb, $6::jsonb, 'draft', $7, $8
           FROM source_recipe_versions
          WHERE space_id = $2::character varying AND source_connection_id = $3::character varying
         RETURNING ${RECIPE_VERSION_COLUMNS}`,
        [
          randomUUID(),
          input.spaceId,
          input.connectionId,
          JSON.stringify(input.recipe),
          JSON.stringify(input.policyEnvelope),
          JSON.stringify(input.primitiveVersions),
          input.createdByUserId,
          now,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("unreachable: recipe version_number insert retry exhausted");
}

export async function getSourceRecipeVersion(
  db: Queryable,
  spaceId: string,
  connectionId: string,
  versionId: string,
): Promise<RecipeVersionRow | null> {
  const result = await db.query<RecipeVersionRow>(
    `SELECT ${RECIPE_VERSION_COLUMNS} FROM source_recipe_versions
      WHERE space_id = $1 AND source_connection_id = $2 AND id = $3`,
    [spaceId, connectionId, versionId],
  );
  return result.rows[0] ?? null;
}

export async function listSourceRecipeVersions(
  db: Queryable,
  spaceId: string,
  connectionId: string,
  page: { limit: number; offset: number },
): Promise<{ rows: RecipeVersionRow[]; total: number }> {
  const rows = await db.query<RecipeVersionRow>(
    `SELECT ${RECIPE_VERSION_COLUMNS} FROM source_recipe_versions
      WHERE space_id = $1 AND source_connection_id = $2
      ORDER BY version_number DESC
      LIMIT $3 OFFSET $4`,
    [spaceId, connectionId, page.limit, page.offset],
  );
  const total = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM source_recipe_versions
      WHERE space_id = $1 AND source_connection_id = $2`,
    [spaceId, connectionId],
  );
  return { rows: rows.rows, total: Number(total.rows[0]?.count ?? 0) };
}

/**
 * Records a dry-run result on a draft/test_failed version: a succeeded
 * dry-run keeps the version `draft` (eligible for activation), anything else
 * flips it to `test_failed`. Returns null when the version is no longer in a
 * testable status (e.g. it was activated or disabled concurrently).
 */
export async function recordSourceRecipeDryRunOutcome(
  db: Queryable,
  spaceId: string,
  versionId: string,
  dryRun: SourceRecipeDryRunResult,
): Promise<RecipeVersionRow | null> {
  const nextStatus = dryRun.status === "succeeded" ? "draft" : "test_failed";
  const result = await db.query<RecipeVersionRow>(
    `UPDATE source_recipe_versions
        SET status = $3, test_result_json = $4::jsonb
      WHERE id = $1 AND space_id = $2
        AND status IN ('draft', 'test_failed')
      RETURNING ${RECIPE_VERSION_COLUMNS}`,
    [versionId, spaceId, nextStatus, JSON.stringify(dryRun)],
  );
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

/**
 * Supersedes the previous active recipe version (if any), activates
 * `versionId`, and flips the connection's active pointer/status/schedule.
 * Shared by the inside-envelope activation path and the
 * `source_recipe_activation` proposal applier. Runs on the caller's
 * Queryable — the caller owns the transaction.
 */
export async function activateSourceRecipeVersionTx(
  db: Queryable,
  input: {
    spaceId: string;
    connectionId: string;
    versionId: string;
    previousActiveVersionId: string | null;
    nextCheckAt?: unknown;
    scheduleRule?: unknown;
  },
): Promise<string> {
  const now = new Date().toISOString();
  const existingScheduleTask = await db.query<{ id: string }>(
    `SELECT id FROM source_channels WHERE source_connection_id = $1 AND space_id = $2 AND status <> 'archived' ORDER BY updated_at DESC LIMIT 1`,
    [input.connectionId, input.spaceId],
  );
  const channelId = existingScheduleTask.rows[0]?.id;
  if (!channelId) throw new Error("Source recipe connection has no active channel");
  const scheduleTask = await getSourceChannelScanTask(db, channelId);
  const currentConnection = await db.query<{
    id: string;
    space_id: string;
    fetch_frequency: string;
    schedule_rule_json: unknown;
    owner_user_id: string;
  }>(
    `SELECT sc.id, sc.space_id, sc.owner_user_id, ch.fetch_frequency, ch.schedule_rule_json
       FROM source_connections sc
       JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.id = $3
      WHERE sc.id = $1 AND sc.space_id = $2
      FOR UPDATE`,
    [input.connectionId, input.spaceId, channelId],
  );
  const current = currentConnection.rows[0];
  const schedule = current
    ? resolveRequestedSourceSchedule({
        body: { next_check_at: input.nextCheckAt, schedule_rule: input.scheduleRule },
        status: "active",
        fetchFrequency: current.fetch_frequency,
        existingNextCheckAt: scheduleTask?.next_run_at,
        existingScheduleRule: current.schedule_rule_json,
      })
    : null;
  if (input.previousActiveVersionId) {
    await db.query(
      `UPDATE source_recipe_versions SET status = 'superseded', superseded_at = $3 WHERE id = $1 AND space_id = $2`,
      [input.previousActiveVersionId, input.spaceId, now],
    );
  }
  await db.query(
    `UPDATE source_recipe_versions SET status = 'active', activated_at = $3 WHERE id = $1 AND space_id = $2`,
    [input.versionId, input.spaceId, now],
  );
  const updatedConnection = await db.query<{
    id: string;
    space_id: string;
    owner_user_id: string;
    status: string;
  }>(
    `UPDATE source_connections
        SET active_recipe_version_id = $3,
            repair_status = 'ok',
            status = 'active',
            updated_at = $4
      WHERE id = $1 AND space_id = $2
      RETURNING id, space_id, owner_user_id, status`,
    [input.connectionId, input.spaceId, input.versionId, now],
  );
  const connection = updatedConnection.rows[0];
  if (connection && schedule) {
    await db.query(
      `UPDATE source_channels SET status='active', fetch_frequency=$3, schedule_rule_json=$4::jsonb, updated_at=$5 WHERE id=$1 AND space_id=$2`,
      [channelId, input.spaceId, current?.fetch_frequency ?? "daily", JSON.stringify(schedule.scheduleRule ?? null), now],
    );
    await upsertSourceChannelScanTask(db, {
      channel: {
        id: channelId,
        space_id: input.spaceId,
        owner_user_id: connection.owner_user_id,
        status: "active",
        fetch_frequency: current?.fetch_frequency ?? "daily",
      },
      nextRunAt: schedule.nextRunAt,
      updatedAt: now,
    });
  }
  return now;
}
