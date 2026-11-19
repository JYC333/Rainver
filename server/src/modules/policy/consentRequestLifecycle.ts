import type { Queryable } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";

/**
 * Ends a person's pending core data tool consent requests (ADR 0033) when what they would allow goes away,
 * inside that writer's own transaction: opt-out, disconnect, reconnect, re-authorization and forget (by
 * connection), leaving a Project (by Project) and account disable (all of the person's). The request becomes
 * `expired` — decided by nobody, never approvable again, so regaining access never revives it — and its
 * waiting Run is cancelled through the ordinary reconcile job. A request made before its binding was frozen
 * (ADR 0032's per-Run consent) ends by the connection its refused call named.
 */
export async function endPendingCoreConsentRequests(db: Queryable, input: {
  ownerUserId: string; spaceId?: string; projectId?: string; connectionId?: string;
}): Promise<string[]> {
  // Imported late: the core tools module imports the Gmail consent module that calls this.
  const { coreDataTools } = await import("../plugins/coreDataTools.js");
  const actions = coreDataTools().map((tool) => tool.pin.action_id);
  const ended = (await db.query<{ id: string; space_id: string; run_id: string; agent_id: string }>(
    `UPDATE authorization_requests ar SET status='expired', decided_at=now()
      WHERE ar.status='pending' AND ar.request_kind='plugin_data' AND ar.action_id=ANY($1::varchar[])
        AND ar.instructed_by_user_id=$2 AND (ar.consent_owner_user_id IS NULL OR ar.consent_owner_user_id=$2)
        AND ($3::varchar IS NULL OR ar.space_id=$3)
        AND ($4::varchar IS NULL OR COALESCE(ar.consent_project_id, ar.project_id)=$4)
        AND ($5::varchar IS NULL OR COALESCE(ar.consent_connection_id, ar.resource_id)=$5)
      RETURNING ar.id, ar.space_id, ar.run_id, ar.agent_id`,
    [actions, input.ownerUserId, input.spaceId ?? null, input.projectId ?? null, input.connectionId ?? null],
  )).rows;
  const queue = new PgJobQueueRepository(db);
  for (const request of ended) {
    await queue.enqueue({
      job_type: "authorization_request_reconcile",
      space_id: request.space_id,
      user_id: input.ownerUserId,
      agent_id: request.agent_id,
      payload: { authorization_request_id: request.id, run_id: request.run_id },
      max_attempts: 900,
    });
  }
  return ended.map((request) => request.id);
}
