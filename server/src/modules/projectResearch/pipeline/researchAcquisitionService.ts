import type { Queryable, SpaceUserIdentity } from "../../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../../routeUtils/common.js";
import { PgJobQueueRepository } from "../../jobs/repository.js";
import { RESEARCH_PIPELINE_START_JOB } from "./researchAcquisitionPipelineJob.js";

export interface StartResearchAcquisitionInput {
  threadId: string;
  intentNote?: string | null;
  originRoomId: string | null;
  originSessionId: string | null;
}

export type StartResearchAcquisitionResult =
  | { status: "queued"; thread_id: string }
  | { status: "already_starting"; thread_id: string };

/**
 * The synchronous half of `research.start_acquisition` (Phase 4): validates
 * the target Thread, applies the "already starting" idempotency guard, and
 * enqueues the background pipeline job. It does not itself run any stage of
 * the pipeline (assessment, evaluate, activate, startInitialIntake) — those
 * run in `ResearchAcquisitionPipelineRunner`, driven by the enqueued job, so
 * this call returns quickly regardless of how long the pipeline takes.
 *
 * The second idempotency layer — a Thread already pinned by an active
 * Workflow — is deliberately not checked here. `startInitialIntakeLocked`
 * already resolves-or-reuses a Thread's Workflow and already throws a 409
 * when a *different* operation is genuinely active for it; duplicating that
 * lookup here would drift from the authority that already exists. The
 * pipeline job catches that 409 and reports it as a `research_pipeline_outcome`
 * event whose payload is `{ status: "stage_failed", stage: "start_intake" }`
 * with a reason describing the conflict — not a distinct outcome kind.
 */
export class ResearchAcquisitionService {
  constructor(private readonly db: Queryable) {}

  async startAcquisition(
    identity: SpaceUserIdentity,
    projectId: string,
    input: StartResearchAcquisitionInput,
  ): Promise<StartResearchAcquisitionResult> {
    return withQueryableTransaction(this.db, async (db) => {
      const thread = await db.query<{ object_id: string }>(
        `SELECT object_id FROM inquiry_threads
          WHERE object_id=$1 AND space_id=$2 AND project_id=$3
            AND kind='question' AND lifecycle_status='active'`,
        [input.threadId, identity.spaceId, projectId],
      );
      if (!thread.rows[0]) {
        throw new HttpError(404, "Inquiry Thread not found or is not an active Question");
      }
      // Serializes the "already starting" check against the enqueue below —
      // without this, two near-simultaneous calls can both see no active job
      // and both enqueue one, each burning a real LLM assessment/live-search
      // pipeline run before either row is visible to the other. Same idiom as
      // `InquiryThreadProposalService.proposeThread`'s coalesce lock.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`research-start-acquisition:${identity.spaceId}:${input.threadId}`],
      );
      const active = await db.query<{ id: string }>(
        `SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2
           AND payload_json->>'thread_id'=$3 AND status IN ('pending','claimed','running') LIMIT 1`,
        [identity.spaceId, RESEARCH_PIPELINE_START_JOB, input.threadId],
      );
      if (active.rows[0]) {
        return { status: "already_starting" as const, thread_id: input.threadId };
      }
      await new PgJobQueueRepository(db).enqueue({
        job_type: RESEARCH_PIPELINE_START_JOB,
        space_id: identity.spaceId,
        user_id: identity.userId,
        payload: {
          thread_id: input.threadId,
          project_id: projectId,
          intent_note: input.intentNote ?? null,
          origin_room_id: input.originRoomId,
          origin_session_id: input.originSessionId,
        },
      });
      return { status: "queued" as const, thread_id: input.threadId };
    });
  }
}
