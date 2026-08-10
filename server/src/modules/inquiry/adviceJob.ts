import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry";
import { PgJobQueueRepository } from "../jobs/repository";
import type { Queryable } from "../routeUtils/common";
import { pinnedResearchThreadId } from "../projectResearch/workflowOntology";
import { InquiryAdviceService, type AdviceTriggerKind } from "./adviceService";

export const INQUIRY_ADVICE_JOB_TYPE = "inquiry_next_step_advice";

/**
 * Automatic advice is queued, never generated inline: the commands that
 * trigger it (recording an Iteration, consolidating a Candidate, finishing a
 * search) must not wait on a provider call, and must still succeed when the
 * provider is unavailable.
 *
 * Only Threads the project has actually focused on are refreshed automatically.
 * Focus is bounded by the shared WIP limit, which is what keeps the automatic
 * spend bounded too; every other Thread generates advice on request.
 */
export async function queueAdviceForFocusedThread(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string | null;
    projectId: string;
    threadId: string;
    triggerKind: AdviceTriggerKind;
  },
): Promise<void> {
  // Advice needs an identity for its ACL check and its metering subject. A
  // system-initiated path with no actor queues nothing rather than a job that
  // could only fail and retry to its attempt limit.
  if (!input.userId) return;

  const focused = await db.query<{ id: string }>(
    `SELECT object_id AS id FROM inquiry_threads
      WHERE object_id = $1 AND space_id = $2 AND project_id = $3
        AND lifecycle_status = 'active' AND attention_state = 'focused'`,
    [input.threadId, input.spaceId, input.projectId],
  );
  if (!focused.rows[0]) return;

  // A burst of triggers on one Thread (a monitoring batch landing several
  // material Signals, say) would otherwise buy several provider calls whose
  // results all overwrite each other. One pending refresh already covers the
  // Thread's latest state, because the job reads that state when it runs.
  const alreadyQueued = await db.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE job_type = $1 AND space_id = $2
        AND status IN ('pending', 'claimed', 'running')
        AND payload_json->>'thread_id' = $3
      LIMIT 1`,
    [INQUIRY_ADVICE_JOB_TYPE, input.spaceId, input.threadId],
  );
  if (alreadyQueued.rows[0]) return;

  await new PgJobQueueRepository(db).enqueue({
    job_type: INQUIRY_ADVICE_JOB_TYPE,
    space_id: input.spaceId,
    user_id: input.userId,
    payload: {
      project_id: input.projectId,
      thread_id: input.threadId,
      trigger_kind: input.triggerKind,
    },
  });
}

/**
 * Best-effort wrapper for callers inside a domain command: advice is an aid,
 * so failing to queue it must never fail the command that triggered it.
 */
export async function tryQueueAdviceForFocusedThread(
  db: Queryable,
  input: Parameters<typeof queueAdviceForFocusedThread>[1],
): Promise<void> {
  try {
    await queueAdviceForFocusedThread(db, input);
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/**
 * Same, addressed by the research Workflow rather than the Thread, so a
 * research caller does not have to resolve the Thread pin itself. A Workflow
 * with no pinned Thread simply queues nothing.
 */
export async function tryQueueAdviceForWorkflowThread(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string | null;
    projectId: string;
    workflowId: string;
    triggerKind: AdviceTriggerKind;
  },
): Promise<void> {
  try {
    const threadId = await pinnedResearchThreadId(db, {
      workflowId: input.workflowId,
      spaceId: input.spaceId,
      projectId: input.projectId,
    });
    if (!threadId) return;
    await queueAdviceForFocusedThread(db, {
      spaceId: input.spaceId,
      userId: input.userId,
      projectId: input.projectId,
      threadId,
      triggerKind: input.triggerKind,
    });
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

export function registerInquiryAdviceHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  registry.register(INQUIRY_ADVICE_JOB_TYPE, async (job) => {
    const projectId = stringValue(job.payload.project_id);
    const threadId = stringValue(job.payload.thread_id);
    const triggerKind = stringValue(job.payload.trigger_kind) ?? "iteration_recorded";
    const userId = job.user_id;
    if (!projectId) throw new Error("inquiry_next_step_advice handler: missing project_id");
    if (!threadId) throw new Error("inquiry_next_step_advice handler: missing thread_id");
    if (!userId) throw new Error("inquiry_next_step_advice handler: missing user_id");

    const db = getDbPool(config.databaseUrl!);
    const service = new InquiryAdviceService(db, config);
    const advice = await service.generateAdvice(
      { spaceId: job.space_id, userId },
      projectId,
      threadId,
      triggerKind as AdviceTriggerKind,
    );
    return {
      advice_id: advice.id,
      thread_id: advice.thread_id,
      recommended_focus_kind: advice.recommended_focus_kind,
    };
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
