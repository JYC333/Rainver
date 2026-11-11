import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { assertProjectReadableLocked, lockActiveProjectForMutation } from "../projects/access.js";
import {assertThreadReadable} from '../inquiry/threadAccess.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import type { QuestionRefinementResult } from "./questionRefineService.js";

interface SessionRow {
  id: string;
  thread_id: string;
  recommended_question: string | null;
  latest_refinement_json: Record<string, unknown> | null;
  assessment_baseline_json: Record<string, unknown> | null;
  research_context_version_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface MessageRow {
  id: string;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "complete" | "failed";
  structured_output_json: Record<string, unknown> | null;
  created_by_user_id: string | null;
  created_at: unknown;
}

export interface QuestionAssessmentProcessingEvent {
  stage: "subquestion_repair";
  status: "detected" | "running" | "completed" | "failed";
  message: string;
  created_at: string;
}

export interface QuestionAssessmentConversation {
  id: string;
  thread_id: string;
  recommended_question: string | null;
  latest_refinement: Record<string, unknown> | null;
  assessment_baseline: Record<string, unknown> | null;
  research_context_version_id: string | null;
  messages: Array<{
    id: string;
    turn_index: number;
    role: "user" | "assistant";
    content: string;
    status: "pending" | "complete" | "failed";
    processing_events: QuestionAssessmentProcessingEvent[];
    /** A completed assistant turn's own structured answer. */
    refinement?: Record<string, unknown>;
    created_by_user_id: string | null;
    created_at: string;
  }>;
  created_at: string;
  updated_at: string;
}

export interface BegunQuestionAssessmentTurn {
  sessionId: string;
  messageId: string;
  turnIndex: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

/** The execution a worker call holds: its Job, claim and attempt. */
export interface QuestionRefineJobLease {
  jobId: string;
  jobType: string;
  workerId: string;
  attempts: number;
}

/** Whether `lease` still holds the Job that performs turn `messageId`; `lock` takes the fence share lock. */
export async function questionRefineLeaseHeld(
  db: Queryable,
  spaceId: string,
  messageId: string,
  lease: QuestionRefineJobLease,
  lock: boolean,
): Promise<boolean> {
  const held = await db.query(
    `SELECT id FROM jobs
      WHERE id=$1 AND space_id=$2 AND job_type=$3 AND status='running'
        AND claimed_by=$4 AND attempts=$5 AND payload_json->>'message_id'=$6${lock ? " FOR SHARE" : ""}`,
    [lease.jobId, spaceId, lease.jobType, lease.workerId, lease.attempts, messageId],
  );
  return held.rows.length > 0;
}

export class ProjectResearchQuestionAssessmentRepository {
  constructor(private readonly db: Queryable) {}

  async lockReadableThread(identity:SpaceUserIdentity,projectId:string,threadId:string):Promise<void>{
    await assertProjectReadableLocked(this.db,identity.spaceId,projectId,identity.userId);
    await this.db.query('SELECT id FROM space_objects WHERE id=$1 AND space_id=$2 FOR SHARE',[threadId,identity.spaceId]);
    await this.db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=$2 ORDER BY id FOR SHARE',[identity.spaceId,threadId]);
    await assertThreadReadable(this.db,identity,projectId,threadId,'read_content');
  }

  async getConversation(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
  ): Promise<QuestionAssessmentConversation | null> {
    return withQueryableTransaction(this.db,async db=>{
    await new ProjectResearchQuestionAssessmentRepository(db).lockReadableThread(identity,projectId,threadId);
    const session = await db.query<SessionRow>(
      `SELECT id,thread_id,recommended_question,latest_refinement_json,assessment_baseline_json,research_context_version_id,created_at,updated_at
         FROM project_research_question_assessment_sessions
        WHERE space_id=$1 AND project_id=$2 AND thread_id=$3`,
      [identity.spaceId, projectId, threadId],
    );
    if (!session.rows[0]) return null;
    const result=await new ProjectResearchQuestionAssessmentRepository(db).readConversation(identity.spaceId,session.rows[0]);
    try{await new ContentAccessAuditService(db).recordReads({spaceId:identity.spaceId,resourceType:'space_object',resourceIds:[threadId],viewerUserId:identity.userId,accessType:'research_question_assessment'});}
    catch{throw new HttpError(503,'Question assessment read audit unavailable');}
    return result;
    });
  }

  async beginTurn(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    content: string,
  ): Promise<BegunQuestionAssessmentTurn> {
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await this.assertThread(projectId, identity.spaceId, threadId, db, true);
      const now = new Date().toISOString();
      const sessionId = randomUUID();
      const session = await db.query<{ id: string }>(
        `INSERT INTO project_research_question_assessment_sessions
           (id,space_id,project_id,thread_id,created_by_user_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (space_id,thread_id) DO UPDATE
           SET updated_at=project_research_question_assessment_sessions.updated_at
         RETURNING id`,
        [sessionId, identity.spaceId, projectId, threadId, identity.userId, now],
      );
      const durableSessionId = session.rows[0]!.id;
      await db.query(
        `SELECT id FROM project_research_question_assessment_sessions
          WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [durableSessionId, identity.spaceId],
      );
      const lastTurn = await db.query<{ last_turn: number }>(
        `SELECT COALESCE(max(turn_index),0)::int AS last_turn
           FROM project_research_question_assessment_messages
          WHERE session_id=$1 AND space_id=$2`,
        [durableSessionId, identity.spaceId],
      );
      const turnIndex = Number(lastTurn.rows[0]?.last_turn ?? 0) + 1;
      const messageId = randomUUID();
      await db.query(
        `INSERT INTO project_research_question_assessment_messages
           (id,space_id,session_id,turn_index,role,content,status,created_by_user_id,created_at)
         VALUES ($1,$2,$3,$4,'user',$5,'pending',$6,$7)`,
        [messageId, identity.spaceId, durableSessionId, turnIndex, content, identity.userId, now],
      );
      const historyRows = await db.query<MessageRow>(
        `SELECT id,turn_index,role,content,status,structured_output_json,created_by_user_id,created_at
           FROM project_research_question_assessment_messages
          WHERE session_id=$1 AND space_id=$2 AND status='complete' AND turn_index < $3
          ORDER BY turn_index, CASE role WHEN 'user' THEN 0 ELSE 1 END`,
        [durableSessionId, identity.spaceId, turnIndex],
      );
      const history = historyRows.rows.map(row => ({
        role: row.role,
        content: row.role === "assistant" && row.structured_output_json
          ? JSON.stringify(row.structured_output_json)
          : row.content,
      }));
      return { sessionId: durableSessionId, messageId, turnIndex, history };
    });
  }

  async completeTurn(
    identity: SpaceUserIdentity,
    turn: BegunQuestionAssessmentTurn,
    result: QuestionRefinementResult,
    establishAssessmentBaseline: boolean,
    lease: QuestionRefineJobLease,
  ): Promise<void> {
    const now = new Date().toISOString();
    // The answer is written only by the call that still holds its Job's
    // execution: running, claimed by this worker on this attempt. The share
    // lock conflicts with cancel, reclaim and fail, so either they wait for
    // this commit or this write sees their terminal status and refuses. A
    // call that outlived its claim (cancelled, reclaimed failed, exhausted)
    // never writes an answer, and nothing calls the provider again.
    const held = await questionRefineLeaseHeld(this.db, identity.spaceId, turn.messageId, lease, true);
    if (!held) throw new HttpError(409, "Question refinement Job no longer owns this turn");
    // Serializes concurrent turns of one session so the projection below is
    // decided against every turn already settled.
    await this.db.query(
      `SELECT id FROM project_research_question_assessment_sessions WHERE id=$1 AND space_id=$2 FOR UPDATE`,
      [turn.sessionId, identity.spaceId],
    );
    const claimed = await this.db.query(
      `UPDATE project_research_question_assessment_messages
          SET status='complete'
        WHERE id=$1 AND session_id=$2 AND space_id=$3 AND role='user' AND status='pending'`,
      [turn.messageId, turn.sessionId, identity.spaceId],
    );
    // Failed, abandoned or already completed: one turn has at most one answer.
    if (claimed.rowCount !== 1) throw new HttpError(409, "Question assessment turn is no longer pending");
    await this.db.query(
      `INSERT INTO project_research_question_assessment_messages
         (id,space_id,session_id,turn_index,role,content,status,structured_output_json,created_at)
       VALUES ($1,$2,$3,$4,'assistant',$5,'complete',$6::jsonb,$7)`,
      [randomUUID(), identity.spaceId, turn.sessionId, turn.turnIndex, result.reply, JSON.stringify(result), now],
    );
    // A turn that finishes after a later turn already answered keeps its own
    // message but must not replace the session's newer projection.
    const newer = await this.db.query(
      `SELECT 1 FROM project_research_question_assessment_messages
        WHERE session_id=$1 AND space_id=$2 AND role='assistant' AND status='complete' AND turn_index>$3 LIMIT 1`,
      [turn.sessionId, identity.spaceId, turn.turnIndex],
    );
    if (newer.rows.length) return;
    await this.db.query(
      `UPDATE project_research_question_assessment_sessions
          SET recommended_question=$1,
              latest_refinement_json=$2::jsonb,
              assessment_baseline_json=CASE
                WHEN $3 THEN $2::jsonb
                WHEN assessment_baseline_json IS NOT NULL THEN assessment_baseline_json
                ELSE COALESCE(latest_refinement_json, $2::jsonb)
              END,
              research_context_version_id=$4,
              updated_at=$5
        WHERE id=$6 AND space_id=$7`,
      [result.recommended_question, JSON.stringify(result), establishAssessmentBaseline, result.research_context_version_id, now, turn.sessionId, identity.spaceId],
    );
  }

  async appendTurnProgress(
    identity: SpaceUserIdentity,
    turn: BegunQuestionAssessmentTurn,
    event: Omit<QuestionAssessmentProcessingEvent, "created_at">,
  ): Promise<void> {
    const entry: QuestionAssessmentProcessingEvent = { ...event, created_at: new Date().toISOString() };
    const updated = await this.db.query(
      `UPDATE project_research_question_assessment_messages
          SET structured_output_json=jsonb_set(
                COALESCE(structured_output_json,'{}'::jsonb),
                '{processing_events}',
                COALESCE(structured_output_json->'processing_events','[]'::jsonb) || $1::jsonb
              )
        WHERE id=$2 AND session_id=$3 AND space_id=$4 AND role='user' AND status='pending'`,
      [JSON.stringify([entry]), turn.messageId, turn.sessionId, identity.spaceId],
    );
    if (updated.rowCount !== 1) throw new HttpError(409, "Question assessment turn is no longer pending");
  }

  async confirmFramework(
    identity: SpaceUserIdentity,
    sessionId: string,
    result: QuestionRefinementResult,
  ): Promise<void> {
    const now = new Date().toISOString();
    const updated = await this.db.query(
      `UPDATE project_research_question_assessment_sessions
          SET recommended_question=$1,
              latest_refinement_json=$2::jsonb,
              assessment_baseline_json=$2::jsonb,
              research_context_version_id=$3,
              updated_at=$4
        WHERE id=$5 AND space_id=$6`,
      [result.recommended_question, JSON.stringify(result), result.research_context_version_id, now, sessionId, identity.spaceId],
    );
    if (updated.rowCount !== 1) throw new HttpError(404, "Question assessment session not found");
  }

  async lockForConfirmation(identity: SpaceUserIdentity, sessionId: string): Promise<string | null> {
    const result = await this.db.query<{ research_context_version_id: string | null }>(
      `SELECT research_context_version_id
         FROM project_research_question_assessment_sessions
        WHERE id=$1 AND space_id=$2
        FOR UPDATE`,
      [sessionId, identity.spaceId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Question assessment session not found");
    return result.rows[0].research_context_version_id;
  }

  async failTurn(identity: SpaceUserIdentity, turn: BegunQuestionAssessmentTurn): Promise<void> {
    await this.db.query(
      `UPDATE project_research_question_assessment_messages
          SET status='failed'
        WHERE id=$1 AND session_id=$2 AND space_id=$3 AND role='user' AND status='pending'`,
      [turn.messageId, turn.sessionId, identity.spaceId],
    );
  }

  async conversationById(spaceId: string, sessionId: string): Promise<QuestionAssessmentConversation> {
    const session = await this.db.query<SessionRow>(
      `SELECT id,thread_id,recommended_question,latest_refinement_json,assessment_baseline_json,research_context_version_id,created_at,updated_at
         FROM project_research_question_assessment_sessions
        WHERE id=$1 AND space_id=$2`,
      [sessionId, spaceId],
    );
    if (!session.rows[0]) throw new HttpError(404, "Question assessment session not found");
    return this.readConversation(spaceId, session.rows[0]);
  }

  private async readConversation(spaceId: string, session: SessionRow): Promise<QuestionAssessmentConversation> {
    const messages = await this.db.query<MessageRow>(
      `SELECT id,turn_index,role,content,status,structured_output_json,created_by_user_id,created_at
         FROM project_research_question_assessment_messages
        WHERE session_id=$1 AND space_id=$2
        ORDER BY turn_index, CASE role WHEN 'user' THEN 0 ELSE 1 END`,
      [session.id, spaceId],
    );
    return {
      id: session.id,
      thread_id: session.thread_id,
      recommended_question: session.recommended_question,
      latest_refinement: session.latest_refinement_json,
      assessment_baseline: session.assessment_baseline_json,
      research_context_version_id: session.research_context_version_id,
      messages: messages.rows.map(row => ({
        id: row.id,
        turn_index: row.turn_index,
        role: row.role,
        content: row.content,
        status: row.status,
        processing_events: processingEvents(row.structured_output_json),
        ...(row.role === "assistant" && row.status === "complete" && row.structured_output_json
          ? { refinement: row.structured_output_json }
          : {}),
        created_by_user_id: row.created_by_user_id,
        created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
      })),
      created_at: dateIso(session.created_at) ?? new Date(0).toISOString(),
      updated_at: dateIso(session.updated_at) ?? new Date(0).toISOString(),
    };
  }

  private async assertThread(
    projectId: string,
    spaceId: string,
    threadId: string,
    db: Queryable = this.db,
    activeOnly = false,
  ): Promise<void> {
    const thread = await db.query<{ id: string }>(
      `SELECT object_id AS id FROM inquiry_threads
        WHERE object_id=$1 AND project_id=$2 AND space_id=$3
          ${activeOnly ? "AND lifecycle_status='active'" : ""}`,
      [threadId, projectId, spaceId],
    );
    if (!thread.rows[0]) throw new HttpError(404, "Inquiry Thread not found");
  }
}

function processingEvents(value: Record<string, unknown> | null): QuestionAssessmentProcessingEvent[] {
  if (!Array.isArray(value?.processing_events)) return [];
  return value.processing_events.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const event = item as Record<string, unknown>;
    if (
      event.stage !== "subquestion_repair"
      || !["detected", "running", "completed", "failed"].includes(String(event.status))
      || typeof event.message !== "string"
      || typeof event.created_at !== "string"
    ) return [];
    return [event as unknown as QuestionAssessmentProcessingEvent];
  });
}
