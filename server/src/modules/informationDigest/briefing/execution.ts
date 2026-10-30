import { HttpError, type Queryable } from "../../routeUtils/common.js";
import { PgConversationBackendRepository } from "../../sessions/conversationBackendRepository.js";
import { assertSourcePromptEgressAllowed } from "../../sources/sourcePromptEgress.js";
import type { SourceConnectionRow } from "../../sources/sourceRepositoryRows.js";

export interface BriefingExecution { agent_id: string; runtime_profile_id: string }

/**
 * The model a briefing runs on: the requester's own active Agent and an
 * enabled runtime profile usable by them now — the same rule material
 * processing uses. No system Agent's authority is borrowed.
 */
export async function selectExecution(db: Queryable, spaceId: string, userId: string, requested: Partial<BriefingExecution>): Promise<BriefingExecution> {
  const selected = (await db.query<BriefingExecution>(
    `SELECT a.id AS agent_id, p.id AS runtime_profile_id
       FROM agents a JOIN agent_runtime_profiles p ON p.agent_id = a.id AND p.space_id = a.space_id
      WHERE a.space_id = $1 AND a.owner_user_id = $2 AND a.status = 'active' AND a.agent_kind <> 'system_assistant'
        AND p.enabled = true AND ($3::varchar IS NULL OR a.id = $3) AND ($4::varchar IS NULL OR p.id = $4)
      ORDER BY p.is_default DESC, a.created_at, p.id LIMIT 1`,
    [spaceId, userId, requested.agent_id ?? null, requested.runtime_profile_id ?? null],
  )).rows[0];
  if (!selected) throw new HttpError(409, "Choose one of your Agents with an enabled runtime to generate briefings", { code: "briefing_execution_setup_required" });
  const option = (await new PgConversationBackendRepository(db).listOptions(spaceId, userId, selected.agent_id))
    .find((candidate) => candidate.runtime_profile_id === selected.runtime_profile_id);
  if (!option || option.usable === false) throw new HttpError(409, "The selected Agent runtime is not usable now", { code: "briefing_execution_setup_required" });
  return selected;
}

/** Whether a Source consents to this execution's model destination; the one Sources gate, never a copy. */
export async function sourceEgressAllowed(db: Queryable, spaceId: string, connectionId: string, execution: BriefingExecution): Promise<boolean> {
  const connection = (await db.query<SourceConnectionRow>(
    `SELECT * FROM source_connections WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
    [connectionId, spaceId],
  )).rows[0];
  if (!connection) return false;
  try {
    await assertSourcePromptEgressAllowed(db, connection, execution.agent_id, execution.runtime_profile_id);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 403) return false;
    throw error;
  }
}
