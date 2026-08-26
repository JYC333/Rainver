import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry.js";
import {
  isChineseTitle,
  type ConversationContinuationRegistry,
} from "../proposals/continuationRegistry.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { InquiryThreadService } from "./threadService.js";

/** Creates the canonical Thread only after a reviewing user accepts the draft. */
export function registerInquiryThreadProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("inquiry_thread_create", async (context: ProposalApplyContext): Promise<ProposalApplyResult> => {
    const { db, proposal, userId } = context;
    if (!proposal.project_id) throw new HttpError(422, "inquiry_thread_create proposal is missing project_id");
    const payload = proposal.payload_json ?? {};
    const {
      proposal_type: _proposalType,
      action_id: _actionId,
      project_id: _projectId,
      ...body
    } = payload;
    const thread = await new InquiryThreadService(db).createThread(
      { spaceId: proposal.space_id, userId },
      proposal.project_id,
      { ...body, producer_idempotency_key: proposal.id },
    );
    return {
      result_type: "inquiry_thread",
      result: { thread_id: (thread as { id?: string }).id },
    };
  });
}

/**
 * Continuation for an accepted `inquiry_thread_create`: the typed fix for
 * "accepted the question, then nothing" (plan Phase 2). Names an activity
 * (`advance_accepted_thread`), not a forced tool — the continuation run
 * still chooses among whichever research-execution tools its Room allowance
 * currently grants (plan Phase 1 decision: that choice is the model's own
 * judgment, never a server-side gate).
 */
export function registerInquiryThreadContinuation(registry: ConversationContinuationRegistry): void {
  registry.register("inquiry_thread_create", async ({ db, proposal }) => {
    const [siblingCount, thread] = await Promise.all([
      pendingSiblingCount(db, proposal.space_id, proposal.created_by_run_id, proposal.id),
      createdThreadId(db, proposal.space_id, proposal.id),
    ]);
    const chinese = isChineseTitle(proposal.proposed_title || "the proposal");
    const instruction = chinese
      ? `用户已确认这个研究问题。原批次仍有 ${siblingCount} 个研究问题提案等待确认；不要创建、改写或重新提交任何研究问题。用一句话确认已创建的问题，然后只推进这个已确认的问题。`
      : `The user accepted this research question. ${siblingCount} question proposal(s) from the original batch still await review. Do not create, rewrite, or resubmit any research questions. Confirm the created question in one sentence, then proceed only with that accepted question.`;
    return {
      directive: "advance_accepted_thread",
      instruction,
      context: { thread_id: thread, pending_sibling_count: siblingCount },
    };
  });
}

async function pendingSiblingCount(
  db: Queryable,
  spaceId: string,
  createdByRunId: string | null,
  proposalId: string,
): Promise<number> {
  if (!createdByRunId) return 0;
  const result = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total
       FROM proposals
      WHERE space_id = $1
        AND created_by_run_id = $2
        AND proposal_type = 'inquiry_thread_create'
        AND status = 'pending'
        AND id <> $3`,
    [spaceId, createdByRunId, proposalId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function createdThreadId(db: Queryable, spaceId: string, proposalId: string): Promise<string | null> {
  const result = await db.query<{ object_id: string }>(
    `SELECT object_id FROM inquiry_threads WHERE space_id=$1 AND producer_idempotency_key=$2`,
    [spaceId, proposalId],
  );
  return result.rows[0]?.object_id ?? null;
}
