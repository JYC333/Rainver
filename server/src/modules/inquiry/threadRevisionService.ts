import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { emitDomainChangeEvent } from "../knowledgePromotion/outbox";

export type ThreadChangeSignificance = "trivial" | "material";

/**
 * Immutable full-content snapshot for one Thread version, written from
 * exactly two call sites — iterationService.ts's reviseDefinition and
 * recordIteration — and emits the matching `domain_change_outbox` event in
 * the SAME transaction. This is the one place that decides
 * `inquiry_thread_revisions.change_significance`, the non-LLM staleness
 * signal the revalidation worker keys off: a `wording_only` Definition
 * Revision is 'trivial'; a `semantic_change` revision or any recorded
 * Iteration is 'material' (an Iteration is, by definition, a confirmed
 * cognitive-position change).
 */
export async function recordThreadRevision(db: Queryable, input: {
  spaceId: string;
  projectId: string;
  threadId: string;
  version: number;
  kind: "question" | "hypothesis";
  statement: string;
  answerState?: string | null;
  evaluationState?: string | null;
  confidence?: number | null;
  changeSignificance: ThreadChangeSignificance;
  userId: string | null;
  at: string;
}): Promise<void> {
  const stateSnapshot = input.kind === "question"
    ? await db.query<{
      current_answer_summary: string | null; answer_state: string; known_gaps: string | null;
      answerability: string | null; resolution_criteria: string | null;
    }>(
      `SELECT current_answer_summary, answer_state, known_gaps, answerability, resolution_criteria
         FROM inquiry_question_states WHERE thread_id=$1 AND space_id=$2`,
      [input.threadId, input.spaceId],
    ).then((result) => result.rows[0] ?? null)
    : await db.query<{
      proposed_claim: string | null; predictions: string | null; falsification_criteria: string | null;
      evaluation_state: string; confidence: number | null; confidence_method: string | null;
    }>(
      `SELECT proposed_claim, predictions, falsification_criteria, evaluation_state, confidence, confidence_method
         FROM inquiry_hypothesis_states WHERE thread_id=$1 AND space_id=$2`,
      [input.threadId, input.spaceId],
    ).then((result) => result.rows[0] ?? null);
  if (!stateSnapshot) throw new Error(`Inquiry Thread ${input.threadId} has no ${input.kind} state`);

  const answerState = input.kind === "question"
    ? (stateSnapshot as { answer_state: string }).answer_state
    : null;
  const evaluationState = input.kind === "hypothesis"
    ? (stateSnapshot as { evaluation_state: string }).evaluation_state
    : null;
  const confidence = input.kind === "hypothesis"
    ? (stateSnapshot as { confidence: number | null }).confidence
    : null;
  const hash = createHash("sha256")
    .update(JSON.stringify({
      statement: input.statement,
      state: stateSnapshot,
    }))
    .digest("hex");
  const revisionId = randomUUID();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO inquiry_thread_revisions (
       id, space_id, project_id, thread_id, version, kind, statement, answer_state, evaluation_state, confidence,
       state_snapshot_json, content_hash, change_significance, created_by_user_id, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
     ON CONFLICT (thread_id, version) DO NOTHING
     RETURNING id`,
    [revisionId, input.spaceId, input.projectId, input.threadId, input.version, input.kind, input.statement,
      answerState, evaluationState, confidence, JSON.stringify(stateSnapshot),
      hash, input.changeSignificance, input.userId, input.at],
  );
  if (!inserted.rows[0]) return;
  await emitDomainChangeEvent(db, {
    spaceId: input.spaceId,
    sourceKind: "inquiry_thread",
    sourceId: input.threadId,
    sourceRef: { kind: "inquiry_thread_revision", thread_id: input.threadId, revision_id: revisionId, version: input.version, content_hash: hash },
    changeKind: "inquiry_thread_revision_created",
    changeSignificance: input.changeSignificance,
    occurredAt: input.at,
  });
}
