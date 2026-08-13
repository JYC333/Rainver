import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry";
import { PgJobQueueRepository } from "../jobs/repository";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common";
import { pinnedResearchThreadId } from "../projectResearch/workflowOntology";
import { InquiryAdviceService, type AdviceTriggerKind } from "./adviceService";
import { completeBackgroundStep } from "./stepService";

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
  await withQueryableTransaction(db, async (tx) => {
    // Serialize bursts for this Thread so they cannot each observe an empty
    // pending queue and enqueue duplicate replacement work.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [input.spaceId, input.threadId]);

    const invalidatedAt = new Date().toISOString();
    // Lock every active job before touching advice. The worker's claim uses
    // FOR UPDATE SKIP LOCKED, so it either claimed before this statement (and
    // we see its new status) or skips the row until we cancel it. Generation's
    // persistence guard takes the same job-then-advice lock order, preventing
    // the former job/advice deadlock.
    await tx.query(
      `SELECT id FROM jobs
        WHERE job_type = $1 AND space_id = $2
          AND status IN ('pending', 'claimed', 'running')
          AND payload_json->>'thread_id' = $3
        FOR UPDATE`,
      [INQUIRY_ADVICE_JOB_TYPE, input.spaceId, input.threadId],
    );

    // A provider request may already be in flight. Mark every started job as
    // superseded; its pre-persist guard locks and checks this same row, closing
    // the race in either transaction order.
    await tx.query(
      `UPDATE jobs
          SET payload_json = payload_json || jsonb_build_object('advice_superseded_at', $4::text),
              updated_at = $4::timestamptz
        WHERE job_type = $1 AND space_id = $2
          AND status IN ('claimed', 'running')
          AND payload_json->>'thread_id' = $3`,
      [INQUIRY_ADVICE_JOB_TYPE, input.spaceId, input.threadId, invalidatedAt],
    );
    // Pending jobs are cancelled rather than reused. All matching active rows
    // remain locked from the SELECT above, so no worker can move a row between
    // the status-specific updates.
    await tx.query(
      `UPDATE jobs
          SET status = 'cancelled', completed_at = $4::timestamptz,
              updated_at = $4::timestamptz
        WHERE job_type = $1 AND space_id = $2 AND status = 'pending'
          AND payload_json->>'thread_id' = $3`,
      [INQUIRY_ADVICE_JOB_TYPE, input.spaceId, input.threadId, invalidatedAt],
    );

    // A relevant domain event makes the existing recommendation unsafe to keep
    // presenting immediately. This follows job locking to preserve the shared
    // lock order with automatic generation. `dismissed` is the existing retired
    // state; the row is the latest suggestion, not an advice audit log.
    await tx.query(
      `UPDATE inquiry_thread_advice
          SET status = 'dismissed', updated_at = $4
        WHERE space_id = $1 AND project_id = $2 AND thread_id = $3 AND status = 'open'`,
      [input.spaceId, input.projectId, input.threadId, invalidatedAt],
    );

    // Advice needs an identity for its ACL check and metering. An actorless or
    // unfocused event retires old output but buys no replacement provider call.
    if (!input.userId) return;
    const focused = await tx.query<{ id: string }>(
      `SELECT object_id AS id FROM inquiry_threads
        WHERE object_id = $1 AND space_id = $2 AND project_id = $3
          AND lifecycle_status = 'active' AND attention_state = 'focused'`,
      [input.threadId, input.spaceId, input.projectId],
    );
    if (!focused.rows[0]) return;

    // Every older pending job was cancelled and every started job was fenced,
    // so this is the one current replacement for the serialized event burst.
    await new PgJobQueueRepository(tx).enqueue({
      job_type: INQUIRY_ADVICE_JOB_TYPE,
      space_id: input.spaceId,
      user_id: input.userId,
      payload: {
        project_id: input.projectId,
        thread_id: input.threadId,
        trigger_kind: input.triggerKind,
      },
    });
  });
}

/** Locks and checks the queue row immediately before an automatic result is stored. */
export async function adviceJobMayPersist(db: Queryable, jobId: string): Promise<boolean> {
  const row = await db.query<{ superseded: boolean }>(
    `SELECT payload_json ? 'advice_superseded_at' AS superseded
       FROM jobs WHERE id = $1 AND job_type = $2 FOR UPDATE`,
    [jobId, INQUIRY_ADVICE_JOB_TYPE],
  );
  return row.rows[0]?.superseded === false;
}

export async function runInquiryAdviceJob(
  db: Queryable,
  service: InquiryAdviceService,
  job: {
    job_id: string;
    space_id: string;
    user_id: string | null;
    payload: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const projectId = stringValue(job.payload.project_id);
  const threadId = stringValue(job.payload.thread_id);
  const triggerKind = stringValue(job.payload.trigger_kind) ?? "iteration_recorded";
  const userId = job.user_id;
  if (!projectId) throw new Error("inquiry_next_step_advice handler: missing project_id");
  if (!threadId) throw new Error("inquiry_next_step_advice handler: missing thread_id");
  if (!userId) throw new Error("inquiry_next_step_advice handler: missing user_id");

  // A failed provider attempt is returned to pending by the generic worker.
  // Check the durable supersession marker before spending on a retry; the
  // second guarded check below still covers an event arriving during the call.
  if (!(await adviceJobMayPersist(db, job.job_id))) {
    return { thread_id: threadId, superseded: true };
  }
  const advice = await service.generateAdvice(
    { spaceId: job.space_id, userId },
    projectId,
    threadId,
    triggerKind as AdviceTriggerKind,
    { beforePersist: (tx) => adviceJobMayPersist(tx, job.job_id) },
  );
  if (!advice) return { thread_id: threadId, superseded: true };
  return {
    advice_id: advice.id,
    thread_id: advice.thread_id,
    recommended_focus_kind: advice.recommended_focus_kind,
  };
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
 * Marks a Thread's evidence-gathering step finished because its search
 * actually finished.
 *
 * This is why a step is a record rather than a label: the search knows it is
 * done, so the user should never have to come back and say so. Best-effort and
 * post-commit like the advice queue beside it — a completion that fails must
 * not fail the search that triggered it.
 */
export async function tryCompleteSearchStepForWorkflow(
  db: Queryable,
  input: { spaceId: string; projectId: string; workflowId: string },
): Promise<void> {
  try {
    const threadId = await pinnedResearchThreadId(db, {
      workflowId: input.workflowId,
      spaceId: input.spaceId,
      projectId: input.projectId,
    });
    if (!threadId) return;
    await completeBackgroundStep(db, {
      spaceId: input.spaceId,
      threadId,
      kind: "search_acquisition",
      at: new Date().toISOString(),
      targetRefKind: "research_workflow",
      targetRefId: input.workflowId,
    });
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
    const db = getDbPool(config.databaseUrl!);
    const service = new InquiryAdviceService(db, config);
    return runInquiryAdviceJob(db, service, job);
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
