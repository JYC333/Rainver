import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { withDbTransaction } from "../routeUtils/common.js";

export const REMOTE_DISPATCH_AGENT_KIND = "system_remote_dispatch";

/**
 * control-center-phase2-plan.md P2 (C8): "The server-side Agent entity
 * stops being a dispatch precondition." A remote-host dispatch's real
 * selection unit is (host, workspace, runtime) — D1 already strips every
 * server-Agent input (no runtime context, no provider resolution) from a
 * remote run, so requiring the caller to have created or picked one was
 * pure ceremony. `runs.agent_id`/`agent_version_id` stay NOT NULL FKs
 * (changing that would ripple through the whole runs subsystem), so this is
 * the sanctioned shim: one lazily created, space-shared, system-owned Agent
 * per space, reused across every dispatch in that space — the same pattern
 * already used for `system_source_annotator`/`system_research`/etc (see
 * `sourceAnnotation/agent.ts`'s `ensureSourceAnnotatorAgent`).
 *
 * This row is written directly, not through `PgAgentRepository.create()`:
 * that path's `resolveRuntimeConfig` requires either a real model provider
 * (for `model_api`-family adapter types — `ensureSourceAnnotatorAgent`
 * pays that cost because its agent genuinely runs) or a registered CLI
 * runtime tool version (for `local_cli`-family types like `claude_code`) —
 * both are real, unavoidable requirements for an agent that will actually
 * execute, and neither applies here: this row's `adapter_type` is never
 * read by anything (a remote run's execution is driven entirely by
 * `runs.adapter_type`/D1's bypass of agent-based resolution), so paying
 * either cost would make working remote dispatch depend on unrelated
 * server-host configuration (a model provider or an installed CLI image)
 * that has nothing to do with it.
 *
 * This is a registered cleanup item (deferred-register.md), not a
 * permanent model: it must be replaced when the next-phase agent/Room-
 * supervision model lands, per C8.
 */
export async function ensureRemoteDispatchAgent(pool: Pool, spaceId: string): Promise<{ id: string; current_version_id: string }> {
  const existing = await pool.query<{ id: string; current_version_id: string | null }>(
    `SELECT id, current_version_id
       FROM agents
      WHERE space_id = $1
        AND agent_kind = $2
        AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
    [spaceId, REMOTE_DISPATCH_AGENT_KIND],
  );
  const found = existing.rows[0];
  if (found?.current_version_id) {
    return { id: found.id, current_version_id: found.current_version_id };
  }

  const agentId = randomUUID();
  const versionId = randomUUID();
  const now = new Date().toISOString();
  try {
    await withDbTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO agents (
           id, space_id, owner_user_id, name, description, status, agent_kind,
           visibility, access_level, created_at, updated_at
         ) VALUES ($1, $2, NULL, $3, $4, 'active', $5, 'space_shared', 'full', $6, $6)`,
        [
          agentId,
          spaceId,
          "Remote dispatch",
          "System-managed placeholder Agent for remote-host dispatches — see ensureRemoteDispatchAgent's doc comment.",
          REMOTE_DISPATCH_AGENT_KIND,
          now,
        ],
      );
      await client.query(
        `INSERT INTO agent_versions (
           id, agent_id, space_id, version_label, system_prompt,
           model_config_json, runtime_config_json, context_policy_json, memory_policy_json,
           capabilities_json, tool_permissions_json, runtime_policy_json, created_at
         ) VALUES ($1, $2, $3, 'v1', NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
        [versionId, agentId, spaceId, now],
      );
      await client.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [agentId, versionId]);
    });
  } catch (error) {
    // Two concurrent first-ever dispatches into the same brand-new space
    // can both miss the SELECT above and both reach this INSERT —
    // `uq_agents_system_remote_dispatch_per_space` correctly rejects the
    // loser rather than allowing two system agents to exist, but the loser
    // must not surface that as a raw 500: it lost only the race to create
    // the row, not its own dispatch, and the winner's row is exactly what
    // it needed anyway. Demonstrated reachable by this module's own
    // concurrency test (P2 discovery review), unlike the identical,
    // pre-existing, still-unhandled gap in `ensureSourceAnnotatorAgent`.
    if (!isUniqueViolation(error)) throw error;
    const winner = await pool.query<{ id: string; current_version_id: string | null }>(
      `SELECT id, current_version_id
         FROM agents
        WHERE space_id = $1
          AND agent_kind = $2
          AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1`,
      [spaceId, REMOTE_DISPATCH_AGENT_KIND],
    );
    const row = winner.rows[0];
    if (!row?.current_version_id) throw error;
    return { id: row.id, current_version_id: row.current_version_id };
  }
  return { id: agentId, current_version_id: versionId };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}
