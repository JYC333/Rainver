import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import {
  HttpError,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { THREAD_COLUMNS, threadToOut, type ThreadRow } from "./threadService";
import { NEXT_FOCUS_KINDS, type NextFocusKind } from "./threadService";
import { RetrievalProjectionService } from "../retrieval";
import { inquiryRetrievalRegistry } from "./retrievalAdapter";
import { recordThreadRevision } from "./threadRevisionService";

// Protected cognitive fields. Only `recordIteration` may write these — the
// generic project PATCH route does not exist for Threads at all, and this
// service's own `reviseDefinition`/`updateWork` deliberately never read
// these keys. This is the concrete mechanism behind plan section 9.4's
// "Protected cognitive fields are writable only through the Iteration
// command."
const QUESTION_COGNITIVE_FIELDS = ["current_answer_summary", "answer_state", "known_gaps", "answerability"] as const;
const HYPOTHESIS_COGNITIVE_FIELDS = ["evaluation_state", "confidence", "confidence_method"] as const;

const QUESTION_ANSWER_STATES = ["open", "partial", "answered", "unanswerable"] as const;
const HYPOTHESIS_EVALUATION_STATES = ["untested", "supported", "challenged", "contradicted", "inconclusive"] as const;

interface QuestionStateRow {
  current_answer_summary: string | null;
  answer_state: string;
  known_gaps: string | null;
  answerability: string | null;
  resolution_criteria: string | null;
}
interface HypothesisStateRow {
  proposed_claim: string | null;
  predictions: string | null;
  falsification_criteria: string | null;
  evaluation_state: string;
  confidence: number | null;
  confidence_method: string | null;
}

export class InquiryIterationService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): InquiryIterationService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquiryIterationService(getDbPool(config.databaseUrl));
  }

  // The cognitive Iteration command (plan section 9.4). Substantive user
  // edits to the confirmed position create this directly — no proposal is
  // needed for a direct user edit; AI-proposed changes become Candidates in
  // the Candidate review service, not here.
  async recordIteration(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const changeSummary = requiredString(body.change_summary, "change_summary");
    const confirmedNextFocus = optionalString(body.confirmed_next_focus);
    if (confirmedNextFocus && !NEXT_FOCUS_KINDS.includes(confirmedNextFocus as NextFocusKind)) {
      throw new HttpError(422, `confirmed_next_focus must be one of: ${NEXT_FOCUS_KINDS.join(", ")}`);
    }
    const now = new Date().toISOString();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const threadRow = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM inquiry_threads WHERE id = $1 AND space_id = $2 AND project_id = $3 FOR UPDATE`,
        [threadId, identity.spaceId, projectId],
      );
      const thread = threadRow.rows[0];
      if (!thread) throw new HttpError(404, "Thread not found");
      if (thread.lifecycle_status !== "active") {
        throw new HttpError(409, "Only an active Thread can record an Iteration");
      }

      let previousPosition: Record<string, unknown>;
      let newPosition: Record<string, unknown>;

      if (thread.kind === "question") {
        const current = await db.query<QuestionStateRow>(
          `SELECT current_answer_summary, answer_state, known_gaps, answerability, resolution_criteria
             FROM inquiry_question_states WHERE thread_id = $1 FOR UPDATE`,
          [threadId],
        );
        const state = current.rows[0];
        if (!state) throw new HttpError(500, "Question state row missing");
        previousPosition = pick(state, QUESTION_COGNITIVE_FIELDS);
        const answerState = optionalString(body.answer_state);
        if (answerState && !QUESTION_ANSWER_STATES.includes(answerState as (typeof QUESTION_ANSWER_STATES)[number])) {
          throw new HttpError(422, `answer_state must be one of: ${QUESTION_ANSWER_STATES.join(", ")}`);
        }
        const updated = await db.query<QuestionStateRow>(
          `UPDATE inquiry_question_states SET
             current_answer_summary = CASE WHEN $1::boolean THEN $2 ELSE current_answer_summary END,
             answer_state = COALESCE($3, answer_state),
             known_gaps = CASE WHEN $4::boolean THEN $5 ELSE known_gaps END,
             answerability = CASE WHEN $6::boolean THEN $7 ELSE answerability END
           WHERE thread_id = $8
           RETURNING current_answer_summary, answer_state, known_gaps, answerability, resolution_criteria`,
          [
            hasOwn(body, "current_answer_summary"),
            optionalString(body.current_answer_summary),
            answerState,
            hasOwn(body, "known_gaps"),
            optionalString(body.known_gaps),
            hasOwn(body, "answerability"),
            optionalString(body.answerability),
            threadId,
          ],
        );
        newPosition = pick(updated.rows[0]!, QUESTION_COGNITIVE_FIELDS);
      } else {
        const current = await db.query<HypothesisStateRow>(
          `SELECT proposed_claim, predictions, falsification_criteria, evaluation_state, confidence, confidence_method
             FROM inquiry_hypothesis_states WHERE thread_id = $1 FOR UPDATE`,
          [threadId],
        );
        const state = current.rows[0];
        if (!state) throw new HttpError(500, "Hypothesis state row missing");
        previousPosition = pick(state, HYPOTHESIS_COGNITIVE_FIELDS);
        const evaluationState = optionalString(body.evaluation_state);
        if (evaluationState && !HYPOTHESIS_EVALUATION_STATES.includes(evaluationState as (typeof HYPOTHESIS_EVALUATION_STATES)[number])) {
          throw new HttpError(422, `evaluation_state must be one of: ${HYPOTHESIS_EVALUATION_STATES.join(", ")}`);
        }
        const confidence = hasOwn(body, "confidence") ? optionalNumber(body.confidence, "confidence") : undefined;
        if (confidence !== undefined && confidence !== null && (confidence < 0 || confidence > 100)) {
          throw new HttpError(422, "confidence must be between 0 and 100");
        }
        const updated = await db.query<HypothesisStateRow>(
          `UPDATE inquiry_hypothesis_states SET
             evaluation_state = COALESCE($1, evaluation_state),
             confidence = CASE WHEN $2::boolean THEN $3 ELSE confidence END,
             confidence_method = CASE WHEN $4::boolean THEN $5 ELSE confidence_method END
           WHERE thread_id = $6
           RETURNING proposed_claim, predictions, falsification_criteria, evaluation_state, confidence, confidence_method`,
          [
            evaluationState,
            confidence !== undefined,
            confidence ?? null,
            hasOwn(body, "confidence_method"),
            optionalString(body.confidence_method),
            threadId,
          ],
        );
        newPosition = pick(updated.rows[0]!, HYPOTHESIS_COGNITIVE_FIELDS);
      }

      if (JSON.stringify(previousPosition) === JSON.stringify(newPosition)) {
        throw new HttpError(422, "An Iteration must change at least one protected cognitive field");
      }
      const previousConfidence = typeof previousPosition.confidence === "number" ? previousPosition.confidence : null;
      const nextConfidence = typeof newPosition.confidence === "number" ? newPosition.confidence : null;
      const confidenceDelta =
        previousConfidence !== null && nextConfidence !== null ? nextConfidence - previousConfidence : null;

      const iterationId = randomUUID();
      const inserted = await db.query(
        `INSERT INTO inquiry_iterations (
           id, space_id, project_id, thread_id, trigger_kind, trigger_ref, input_refs_json,
           previous_position_json, new_position_json, confidence_delta, change_summary,
           reasoning_summary, unresolved_gaps, confirmed_next_focus, created_by_user_id, created_by_run_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          iterationId,
          identity.spaceId,
          projectId,
          threadId,
          optionalString(body.trigger_kind) ?? "user_edit",
          optionalString(body.trigger_ref),
          JSON.stringify(Array.isArray(body.input_refs) ? body.input_refs : []),
          JSON.stringify(previousPosition),
          JSON.stringify(newPosition),
          confidenceDelta,
          changeSummary,
          optionalString(body.reasoning_summary),
          optionalString(body.unresolved_gaps),
          confirmedNextFocus,
          identity.userId,
          null,
          now,
        ],
      );

      const nextFocusUpdate = confirmedNextFocus
        ? { kind: confirmedNextFocus, note: optionalString(body.next_focus_note) }
        : null;
      const updatedThread = await db.query<ThreadRow>(
        `UPDATE inquiry_threads SET
           version = version + 1,
           updated_at = $1,
           next_focus_kind = COALESCE($2, next_focus_kind),
           next_focus_note = CASE WHEN $2::text IS NOT NULL THEN $3 ELSE next_focus_note END,
           blocked_reason = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE blocked_reason END
         WHERE id = $4 AND space_id = $5
         RETURNING ${THREAD_COLUMNS}`,
        [now, nextFocusUpdate?.kind ?? null, nextFocusUpdate?.note ?? null, threadId, identity.spaceId],
      );

      const finalThread = updatedThread.rows[0]!;
      // An Iteration is, by definition, a confirmed cognitive-position
      // change (the guard above already rejected a no-op Iteration), so its
      // revision is always 'material' — never a candidate for 'trivial'.
      await recordThreadRevision(db, {
        spaceId: identity.spaceId, projectId, threadId, version: finalThread.version, kind: thread.kind as "question" | "hypothesis",
        statement: finalThread.statement,
        answerState: thread.kind === "question" ? optionalString(newPosition.answer_state) : null,
        evaluationState: thread.kind === "hypothesis" ? optionalString(newPosition.evaluation_state) : null,
        confidence: thread.kind === "hypothesis" && typeof newPosition.confidence === "number" ? newPosition.confidence : null,
        changeSignificance: "material",
        userId: identity.userId,
        at: now,
      });

      await new RetrievalProjectionService(db, inquiryRetrievalRegistry).reindex(identity.spaceId, "inquiry_thread", threadId);
      return { ...inserted.rows[0], thread: threadToOut(finalThread) };
    });
  }

  async listIterations(identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query(
      `SELECT i.* FROM inquiry_iterations i
         JOIN inquiry_threads t ON t.id = i.thread_id AND t.space_id = i.space_id
        WHERE i.space_id = $1 AND i.project_id = $2 AND i.thread_id = $3
        ORDER BY i.created_at DESC`,
      [identity.spaceId, projectId, threadId],
    );
    return rows.rows;
  }

  // Thread Definition Revision command (plan section 9.4). `wording_only`
  // updates presentation text without a Definition Revision's structural
  // consequence; `semantic_change` cannot be downgraded by the client and
  // must choose narrow-in-place, child-with-a-new-Thread, or
    // supersede-with-a-new-Thread.
  async reviseDefinition(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const revisionKind = requiredString(body.revision_kind, "revision_kind");
    if (revisionKind !== "wording_only" && revisionKind !== "semantic_change") {
      throw new HttpError(422, "revision_kind must be wording_only or semantic_change");
    }
    const newStatement = requiredString(body.new_statement, "new_statement");
    const structureAction = optionalString(body.structure_action);
    if (revisionKind === "semantic_change") {
      if (structureAction !== "narrow" && structureAction !== "child" && structureAction !== "supersede") {
        throw new HttpError(422, "semantic_change requires structure_action: narrow, child, or supersede");
      }
    } else if (structureAction) {
      throw new HttpError(422, "structure_action is only valid for semantic_change");
    }
    const now = new Date().toISOString();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const threadRow = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM inquiry_threads WHERE id = $1 AND space_id = $2 AND project_id = $3 FOR UPDATE`,
        [threadId, identity.spaceId, projectId],
      );
      const thread = threadRow.rows[0];
      if (!thread) throw new HttpError(404, "Thread not found");
      if (thread.lifecycle_status !== "active") {
        throw new HttpError(409, "Only an active Thread can revise its Definition");
      }

      // Claim/prediction/falsification/resolution-criteria content is
      // substantive, not wording — only a semantic_change revision may touch
      // it. `wording_only` is restricted to cosmetic statement text so it
      // cannot be used to smuggle a material definition change through.
      if (revisionKind === "semantic_change" && structureAction === "narrow") {
        await this.applyDefinitionFieldUpdates(db, thread, body);
      }

      if (revisionKind === "wording_only" || structureAction === "narrow") {
        await db.query(
          `INSERT INTO inquiry_thread_statement_revisions (
             id, space_id, project_id, thread_id, revision_kind, previous_statement, new_statement, structure_action, impact_note, created_by_user_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [randomUUID(), identity.spaceId, projectId, threadId, revisionKind, thread.statement, newStatement, structureAction, optionalString(body.impact_note), identity.userId, now],
        );
        const updated = await db.query<ThreadRow>(
          `UPDATE inquiry_threads SET statement = $1, version = version + 1, updated_at = $2
            WHERE id = $3 AND space_id = $4 RETURNING ${THREAD_COLUMNS}`,
          [newStatement, now, threadId, identity.spaceId],
        );
        const revised = updated.rows[0]!;
        const cognitiveState = await this.currentCognitiveState(db, threadId, thread.kind);
        await recordThreadRevision(db, {
          spaceId: identity.spaceId, projectId, threadId, version: revised.version, kind: thread.kind as "question" | "hypothesis",
          statement: revised.statement,
          answerState: cognitiveState.answerState, evaluationState: cognitiveState.evaluationState, confidence: cognitiveState.confidence,
          changeSignificance: revisionKind === "wording_only" ? "trivial" : "material",
          userId: identity.userId,
          at: now,
        });
        await new RetrievalProjectionService(db, inquiryRetrievalRegistry).reindex(identity.spaceId, "inquiry_thread", threadId);
        return { thread: threadToOut(revised), superseded_by_thread_id: null };
      }

      // child/supersede: create a new Thread carrying the revised definition.
      // The historical Thread is deliberately not mutated before the branch.
      const newThreadId = randomUUID();
      await db.query(
        `INSERT INTO inquiry_threads (
           id, space_id, project_id, kind, statement, lifecycle_status, attention_state, priority,
           primary_parent_id, owner_user_id, created_from, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', 'backlog', $6, $7, $8, 'user', $8, $9, $9)`,
        [
          newThreadId,
          identity.spaceId,
          projectId,
          thread.kind,
          newStatement,
          thread.priority,
          structureAction === "child" ? thread.id : thread.primary_parent_id,
          identity.userId,
          now,
        ],
      );
      if (thread.kind === "question") {
        await db.query(
          `INSERT INTO inquiry_question_states (thread_id, space_id, answer_state, resolution_criteria)
           SELECT $1, space_id, 'open', resolution_criteria FROM inquiry_question_states WHERE thread_id = $2`,
          [newThreadId, threadId],
        );
      } else {
        await db.query(
          `INSERT INTO inquiry_hypothesis_states (thread_id, space_id, proposed_claim, predictions, falsification_criteria, evaluation_state)
           SELECT $1, space_id, proposed_claim, predictions, falsification_criteria, 'untested' FROM inquiry_hypothesis_states WHERE thread_id = $2`,
          [newThreadId, threadId],
        );
      }
      await this.applyDefinitionFieldUpdates(db, { ...thread, id: newThreadId }, body);
      // A child/superseding Thread is a brand-new promotable entity — record
      // its initial (version 1) revision now rather than leaving a gap
      // until its first Iteration or wording revision.
      const newThreadCognitiveState = await this.currentCognitiveState(db, newThreadId, thread.kind);
      await recordThreadRevision(db, {
        spaceId: identity.spaceId, projectId, threadId: newThreadId, version: 1, kind: thread.kind as "question" | "hypothesis",
        statement: newStatement,
        answerState: newThreadCognitiveState.answerState, evaluationState: newThreadCognitiveState.evaluationState, confidence: newThreadCognitiveState.confidence,
        changeSignificance: "material",
        userId: identity.userId,
        at: now,
      });
      const relationKind = structureAction === "child" ? "decomposes_into" : "supersedes";
      await db.query(
        `INSERT INTO inquiry_thread_relations (id, space_id, project_id, from_thread_id, to_thread_id, relation_kind, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        structureAction === "child"
          ? [randomUUID(), identity.spaceId, projectId, threadId, newThreadId, relationKind, identity.userId, now]
          : [randomUUID(), identity.spaceId, projectId, newThreadId, threadId, relationKind, identity.userId, now],
      );
      await db.query(
        `INSERT INTO inquiry_thread_statement_revisions (
           id, space_id, project_id, thread_id, revision_kind, previous_statement, new_statement, structure_action, impact_note, created_by_user_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [randomUUID(), identity.spaceId, projectId, threadId, revisionKind, thread.statement, newStatement, structureAction, optionalString(body.impact_note), identity.userId, now],
      );
      await db.query(
        `INSERT INTO inquiry_thread_structure_events
          (id,space_id,project_id,thread_id,action_kind,from_value_json,to_value_json,actor_user_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
        [
          randomUUID(),
          identity.spaceId,
          projectId,
          threadId,
          structureAction === "child" ? "definition_child_created" : "definition_superseded",
          JSON.stringify({ thread_id: threadId, statement: thread.statement }),
          JSON.stringify({ thread_id: newThreadId, statement: newStatement }),
          identity.userId,
          now,
        ],
      );
      if (structureAction === "child") {
        const child = await db.query<ThreadRow>(
          `SELECT ${THREAD_COLUMNS} FROM inquiry_threads WHERE id = $1 AND space_id = $2`,
          [newThreadId, identity.spaceId],
        );
        await new RetrievalProjectionService(db, inquiryRetrievalRegistry).reindex(identity.spaceId, "inquiry_thread", newThreadId);
        return { thread: threadToOut(child.rows[0]!), child_of_thread_id: threadId, superseded_by_thread_id: null };
      }
      await db.query(
        `INSERT INTO inquiry_thread_lifecycle_events
          (id,space_id,project_id,thread_id,from_status,to_status,reason,actor_user_id,created_at)
         VALUES ($1,$2,$3,$4,$5,'superseded',$6,$7,$8)`,
        [randomUUID(), identity.spaceId, projectId, threadId, thread.lifecycle_status, optionalString(body.impact_note), identity.userId, now],
      );
      const supersededThread = await db.query<ThreadRow>(
        `UPDATE inquiry_threads SET lifecycle_status = 'superseded', attention_state = 'archived', updated_at = $1
          WHERE id = $2 AND space_id = $3 RETURNING ${THREAD_COLUMNS}`,
        [now, threadId, identity.spaceId],
      );
      const projection = new RetrievalProjectionService(db, inquiryRetrievalRegistry);
      await projection.reindex(identity.spaceId, "inquiry_thread", threadId);
      await projection.reindex(identity.spaceId, "inquiry_thread", newThreadId);
      return { thread: threadToOut(supersededThread.rows[0]!), superseded_by_thread_id: newThreadId };
    });
  }

  private async currentCognitiveState(
    db: Queryable,
    threadId: string,
    kind: string,
  ): Promise<{ answerState: string | null; evaluationState: string | null; confidence: number | null }> {
    if (kind === "question") {
      const row = await db.query<{ answer_state: string }>(`SELECT answer_state FROM inquiry_question_states WHERE thread_id = $1`, [threadId]);
      return { answerState: row.rows[0]?.answer_state ?? null, evaluationState: null, confidence: null };
    }
    const row = await db.query<{ evaluation_state: string; confidence: number | null }>(
      `SELECT evaluation_state, confidence FROM inquiry_hypothesis_states WHERE thread_id = $1`,
      [threadId],
    );
    return { answerState: null, evaluationState: row.rows[0]?.evaluation_state ?? null, confidence: row.rows[0]?.confidence ?? null };
  }

  private async applyDefinitionFieldUpdates(db: Queryable, thread: ThreadRow, body: Record<string, unknown>): Promise<void> {
    if (thread.kind === "question" && hasOwn(body, "new_resolution_criteria")) {
      await db.query(`UPDATE inquiry_question_states SET resolution_criteria = $1 WHERE thread_id = $2`, [
        optionalString(body.new_resolution_criteria),
        thread.id,
      ]);
    }
    if (thread.kind === "hypothesis") {
      if (hasOwn(body, "new_proposed_claim") || hasOwn(body, "new_predictions") || hasOwn(body, "new_falsification_criteria")) {
        await db.query(
          `UPDATE inquiry_hypothesis_states SET
             proposed_claim = CASE WHEN $1::boolean THEN $2 ELSE proposed_claim END,
             predictions = CASE WHEN $3::boolean THEN $4 ELSE predictions END,
             falsification_criteria = CASE WHEN $5::boolean THEN $6 ELSE falsification_criteria END
           WHERE thread_id = $7`,
          [
            hasOwn(body, "new_proposed_claim"),
            optionalString(body.new_proposed_claim),
            hasOwn(body, "new_predictions"),
            optionalString(body.new_predictions),
            hasOwn(body, "new_falsification_criteria"),
            optionalString(body.new_falsification_criteria),
            thread.id,
          ],
        );
      }
    }
  }

  // Work-management command (plan section 9.4): priority, owner, Focus
  // membership, Current Next Focus, blocking reason. Audited action history,
  // never a cognitive Iteration — this method never touches
  // inquiry_question_states/inquiry_hypothesis_states/inquiry_iterations, and
  // never reads `body.statement` or any cognitive field, by construction.
  async updateWork(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const now = new Date().toISOString();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const threadRow = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM inquiry_threads WHERE id = $1 AND space_id = $2 AND project_id = $3 FOR UPDATE`,
        [threadId, identity.spaceId, projectId],
      );
      const thread = threadRow.rows[0];
      if (!thread) throw new HttpError(404, "Thread not found");

      const requestedPriority = hasOwn(body, "priority") ? optionalNumber(body.priority, "priority") : undefined;
      if (requestedPriority === null) throw new HttpError(422, "priority must be a number");
      const nextPriority = requestedPriority ?? thread.priority;
      if (!Number.isInteger(nextPriority)) throw new HttpError(422, "priority must be an integer");
      const nextOwner = hasOwn(body, "owner_user_id") ? optionalString(body.owner_user_id) : thread.owner_user_id;
      if (nextOwner) {
        const owner = await db.query(
          `SELECT 1 FROM space_memberships
            WHERE space_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,
          [identity.spaceId, nextOwner],
        );
        if (!owner.rows[0]) throw new HttpError(422, "owner_user_id must be an active Space member");
      }
      const nextAttention = hasOwn(body, "attention_state") ? requiredString(body.attention_state, "attention_state") : thread.attention_state;
      if (nextAttention === "resolved" || nextAttention === "rejected" || nextAttention === "archived") {
        throw new HttpError(422, "Terminal states must be changed through the lifecycle command");
      }
      if (!["focused", "monitoring", "backlog", "blocked"].includes(nextAttention)) {
        throw new HttpError(422, "attention_state must be focused, monitoring, backlog, or blocked");
      }
      const nextFocusKind = hasOwn(body, "next_focus_kind") ? optionalString(body.next_focus_kind) : thread.next_focus_kind;
      const nextFocusNote = hasOwn(body, "next_focus_note") ? optionalString(body.next_focus_note) : thread.next_focus_note;
      const nextBlockedReason = hasOwn(body, "blocked_reason") ? optionalString(body.blocked_reason) : thread.blocked_reason;

      if (nextFocusKind && !NEXT_FOCUS_KINDS.includes(nextFocusKind as NextFocusKind)) {
        throw new HttpError(422, `next_focus_kind must be one of: ${NEXT_FOCUS_KINDS.join(", ")}`);
      }
      // Next Focus invariant (plan section 9.5): an active, human-focused
      // Thread needs exactly one Current Next Focus or an explicit
      // blocking/waiting reason.
      let wipLimitExceeded = false;
      if (nextAttention === "focused" && Boolean(nextFocusKind) === Boolean(nextBlockedReason)) {
        throw new HttpError(422, "A focused Thread needs exactly one of next_focus_kind or blocked_reason");
      }
      if (nextAttention === "focused" && thread.attention_state !== "focused") {
        const focusedCount = await db.query<{ total: string }>(
          `SELECT count(*)::text AS total FROM inquiry_threads WHERE space_id = $1 AND project_id = $2 AND attention_state = 'focused'`,
          [identity.spaceId, projectId],
        );
        const limitRow = await db.query<{ shared_focus_wip_limit: number }>(
          `SELECT shared_focus_wip_limit FROM inquiry_project_settings WHERE project_id = $1 AND space_id = $2`,
          [projectId, identity.spaceId],
        );
        const limit = limitRow.rows[0]?.shared_focus_wip_limit ?? 3;
        wipLimitExceeded = Number(focusedCount.rows[0]?.total ?? "0") >= limit;
      }

      const events: Array<[string, string | null, string | null]> = [];
      if (nextPriority !== thread.priority) events.push(["priority", String(thread.priority), String(nextPriority)]);
      if (nextOwner !== thread.owner_user_id) events.push(["owner", thread.owner_user_id, nextOwner]);
      if (nextAttention !== thread.attention_state) events.push(["attention_state", thread.attention_state, nextAttention]);
      if (nextFocusKind !== thread.next_focus_kind) events.push(["next_focus_kind", thread.next_focus_kind, nextFocusKind]);
      if (nextBlockedReason !== thread.blocked_reason) events.push(["blocked_reason", thread.blocked_reason, nextBlockedReason]);

      for (const [actionKind, fromValue, toValue] of events) {
        await db.query(
          `INSERT INTO inquiry_thread_work_events (id, space_id, project_id, thread_id, action_kind, from_value, to_value, actor_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), identity.spaceId, projectId, threadId, actionKind, fromValue, toValue, identity.userId, now],
        );
      }

      const updated = await db.query<ThreadRow>(
        `UPDATE inquiry_threads SET
           priority = $1, owner_user_id = $2, attention_state = $3,
           next_focus_kind = $4, next_focus_note = $5, blocked_reason = $6, updated_at = $7
         WHERE id = $8 AND space_id = $9
         RETURNING ${THREAD_COLUMNS}`,
        [nextPriority, nextOwner, nextAttention, nextFocusKind, nextFocusNote, nextBlockedReason, now, threadId, identity.spaceId],
      );
      return { ...threadToOut(updated.rows[0]!), wip_limit_exceeded: wipLimitExceeded };
    });
  }

  async listWorkEvents(identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query(
      `SELECT e.* FROM inquiry_thread_work_events e
         JOIN inquiry_threads t ON t.id = e.thread_id AND t.space_id = e.space_id
        WHERE e.space_id = $1 AND t.project_id = $2 AND e.thread_id = $3
        ORDER BY e.created_at DESC`,
      [identity.spaceId, projectId, threadId],
    );
    return rows.rows;
  }

  async transitionLifecycle(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const toStatus = requiredString(body.lifecycle_status, "lifecycle_status");
    const allowed = ["active", "resolved", "rejected", "archived"] as const;
    if (!allowed.includes(toStatus as (typeof allowed)[number])) {
      throw new HttpError(422, `lifecycle_status must be one of: ${allowed.join(", ")}`);
    }
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const row = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM inquiry_threads
          WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,
        [threadId, identity.spaceId, projectId],
      );
      const current = row.rows[0];
      if (!current) throw new HttpError(404, "Thread not found");
      if (current.lifecycle_status === "superseded") throw new HttpError(409, "A superseded Thread cannot transition");
      if (current.lifecycle_status === toStatus) throw new HttpError(409, `Thread is already ${toStatus}`);
      const attention = toStatus === "active" ? "backlog" : toStatus;
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO inquiry_thread_lifecycle_events
          (id, space_id, project_id, thread_id, from_status, to_status, reason, actor_user_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), identity.spaceId, projectId, threadId, current.lifecycle_status, toStatus, optionalString(body.reason), identity.userId, now],
      );
      const updated = await db.query<ThreadRow>(
        `UPDATE inquiry_threads SET lifecycle_status=$1, attention_state=$2,
           next_focus_kind=NULL, next_focus_note=NULL, blocked_reason=NULL, updated_at=$3
         WHERE id=$4 AND space_id=$5 RETURNING ${THREAD_COLUMNS}`,
        [toStatus, attention, now, threadId, identity.spaceId],
      );
      await new RetrievalProjectionService(db, inquiryRetrievalRegistry).reindex(identity.spaceId, "inquiry_thread", threadId);
      return threadToOut(updated.rows[0]!);
    });
  }
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(422, `${label} must be a number`);
  return n;
}

function pick<T extends object>(row: T, keys: readonly string[]): Record<string, unknown> {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source[key];
  return out;
}
