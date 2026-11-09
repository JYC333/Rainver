import type { CanonicalToolCall } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { getDbPool } from '../../db/pool.js';
import { resolveAgentActorId } from '../../db/actorResolver.js';
import { PgRunRepository, type AgentRunRecord } from './repository.js';

export function defaultActionEventSink(config: ServerConfig, run: AgentRunRecord) {
  if (!config.databaseUrl) return undefined;
  const db=getDbPool(config.databaseUrl);
  const repository = new PgRunRepository(db);

  return async (
    eventType: "action_invoked" | "action_completed",
    call: CanonicalToolCall,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    try {
      await repository.appendRunEvent({
        run_id: run.id,
        space_id: run.space_id,
        event_type: eventType,
        status: eventType === "action_invoked" ? "running" : (metadata.ok === false ? "failed" : "succeeded"),
        actor_id: await resolveAgentActorId(db,run.space_id,run.agent_id),
        ...(typeof metadata.error_code === "string" ? { error_code: metadata.error_code } : {}),
        ...(typeof metadata.error_message === "string" ? { error_message: metadata.error_message } : {}),
        metadata_json: { action_id: call.name, action_version: 1, tool_call_id: call.id, instructed_by_user_id: run.instructed_by_user_id ?? null, ...metadata },
      });
    } catch {
      // RunEvent evidence follows the execution-model best-effort rule; the
      // PolicyGateway decision record remains the fail-closed audit seam.
    }
  };
}
