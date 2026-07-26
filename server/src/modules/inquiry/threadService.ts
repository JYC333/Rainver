import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import {
  HttpError,
  dateIso,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { getDbPool } from "../../db/pool";
import { contentReadSql } from "../access/contentAccessSql";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access";
import { RetrievalProjectionService } from "../retrieval";
import { inquiryRetrievalRegistry } from "./retrievalAdapter";
import { recordThreadRevision } from "./threadRevisionService";

export const NEXT_FOCUS_KINDS = [
  "search_acquisition",
  "read_evidence",
  "synthesize",
  "clarify_or_decompose",
  "design_run_experiment",
  "create_decision_case",
  "create_delivery_task",
  "wait_for_monitoring",
  "promote_knowledge",
  "pause",
] as const;
export type NextFocusKind = (typeof NEXT_FOCUS_KINDS)[number];

const ATTENTION_STATES = ["focused", "monitoring", "backlog", "blocked", "resolved", "rejected", "archived"] as const;
type AttentionState = (typeof ATTENTION_STATES)[number];

const THREAD_RELATION_KINDS = ["decomposes_into", "proposes", "depends_on", "supports", "contradicts", "supersedes", "related_to"] as const;

interface ThreadRow {
  id: string;
  space_id: string;
  project_id: string;
  kind: string;
  statement: string;
  lifecycle_status: string;
  attention_state: string;
  priority: number;
  primary_parent_id: string | null;
  owner_user_id: string | null;
  next_focus_kind: string | null;
  next_focus_note: string | null;
  blocked_reason: string | null;
  version: number;
  created_from: string;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

function threadToOut(row: ThreadRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    kind: row.kind,
    statement: row.statement,
    lifecycle_status: row.lifecycle_status,
    attention_state: row.attention_state,
    priority: row.priority,
    primary_parent_id: row.primary_parent_id,
    owner_user_id: row.owner_user_id,
    next_focus_kind: row.next_focus_kind,
    next_focus_note: row.next_focus_note,
    blocked_reason: row.blocked_reason,
    version: row.version,
    created_from: row.created_from,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

const THREAD_COLUMNS = `
  id, space_id, project_id, kind, statement, lifecycle_status, attention_state, priority,
  primary_parent_id, owner_user_id, next_focus_kind, next_focus_note, blocked_reason,
  version, created_from, created_by_user_id, created_at, updated_at
`;

/**
 * Thread CRUD, working relations, Note links, personal Focus, and Project
 * Inquiry settings. The cognitive Iteration / Definition Revision /
 * work-management commands live in `iterationService.ts` — this file only
 * owns thread identity, structure, and non-cognitive linkage. See plan
 * section 9 and ADR 0011.
 */
export class InquiryThreadService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): InquiryThreadService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new InquiryThreadService(getDbPool(config.databaseUrl));
  }

  async createThread(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const kind = requiredString(body.kind, "kind");
    if (kind !== "question" && kind !== "hypothesis") throw new HttpError(422, "kind must be question or hypothesis");
    const statement = requiredString(body.statement, "statement");
    const primaryParentId = optionalString(body.primary_parent_id);
    const now = new Date().toISOString();
    const threadId = randomUUID();

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      if (primaryParentId) await this.assertThreadInProject(db, identity.spaceId, projectId, primaryParentId);
      const inserted = await db.query<ThreadRow>(
        `INSERT INTO inquiry_threads (
           id, space_id, project_id, kind, statement, lifecycle_status, attention_state, priority,
           primary_parent_id, owner_user_id, created_from, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', 'backlog', 0, $6, $7, 'user', $7, $8, $8)
         RETURNING ${THREAD_COLUMNS}`,
        [threadId, identity.spaceId, projectId, kind, statement, primaryParentId, identity.userId, now],
      );
      if (kind === "question") {
        await db.query(
          `INSERT INTO inquiry_question_states (thread_id, space_id, answer_state, known_gaps, answerability, resolution_criteria)
           VALUES ($1, $2, 'open', NULL, $3, $4)`,
          [threadId, identity.spaceId, optionalString(body.answerability), optionalString(body.resolution_criteria)],
        );
      } else {
        await db.query(
          `INSERT INTO inquiry_hypothesis_states (thread_id, space_id, proposed_claim, predictions, falsification_criteria, evaluation_state)
           VALUES ($1, $2, $3, $4, $5, 'untested')`,
          [
            threadId,
            identity.spaceId,
            optionalString(body.proposed_claim),
            optionalString(body.predictions),
            optionalString(body.falsification_criteria),
          ],
        );
      }
      await recordThreadRevision(db, {
        spaceId: identity.spaceId,
        projectId,
        threadId,
        version: 1,
        kind: kind as "question" | "hypothesis",
        statement,
        changeSignificance: "material",
        userId: identity.userId,
        at: now,
      });
      await new RetrievalProjectionService(db, inquiryRetrievalRegistry).reindex(identity.spaceId, "inquiry_thread", threadId);
      return threadToOut(inserted.rows[0]!);
    });
  }

  async listThreads(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM inquiry_threads
        WHERE space_id = $1 AND project_id = $2
        ORDER BY created_at ASC, id ASC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map(threadToOut);
  }

  async getThread(identity: SpaceUserIdentity, projectId: string, threadId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.getThreadRow(identity.spaceId, projectId, threadId);
    if (!row) throw new HttpError(404, "Thread not found");

    const [questionState, hypothesisState, relations, noteLinks, decisionCases, personalFocus] = await Promise.all([
      row.kind === "question"
        ? this.db.query(`SELECT * FROM inquiry_question_states WHERE thread_id = $1`, [threadId]).then((r) => r.rows[0] ?? null)
        : Promise.resolve(null),
      row.kind === "hypothesis"
        ? this.db.query(`SELECT * FROM inquiry_hypothesis_states WHERE thread_id = $1`, [threadId]).then((r) => r.rows[0] ?? null)
        : Promise.resolve(null),
      this.db.query(
        `SELECT id, from_thread_id, to_thread_id, relation_kind, created_at FROM inquiry_thread_relations
          WHERE space_id = $1 AND project_id=$3 AND (from_thread_id = $2 OR to_thread_id = $2)`,
        [identity.spaceId, threadId, projectId],
      ).then((r) => r.rows),
      this.db.query(
        `SELECT id, note_object_id, link_kind, created_at FROM inquiry_thread_note_links
          WHERE space_id = $1 AND project_id=$4 AND thread_id = $2
            AND note_object_id IN (
              SELECT o.id FROM space_objects o
               WHERE o.space_id = $1 AND ${contentReadSql("space_object", "o", "$3")}
            )`,
        [identity.spaceId, threadId, identity.userId, projectId],
      ).then((r) => r.rows),
      this.db.query(
        `SELECT c.id, c.title, c.status
           FROM decision_case_sources s
           JOIN decision_cases c
             ON c.id = s.decision_case_id
            AND c.space_id = s.space_id
            AND c.project_id = s.project_id
          WHERE s.space_id = $1 AND s.project_id = $2 AND s.thread_id = $3
          ORDER BY c.created_at DESC`,
        [identity.spaceId, projectId, threadId],
      ).then((r) => r.rows),
      this.db.query(
        `SELECT 1 FROM inquiry_thread_personal_focus WHERE thread_id = $1 AND user_id = $2`,
        [threadId, identity.userId],
      ).then((r) => r.rows.length > 0),
    ]);

    return {
      ...threadToOut(row),
      question_state: questionState,
      hypothesis_state: hypothesisState,
      relations,
      note_links: noteLinks,
      decision_cases: decisionCases,
      in_personal_focus: personalFocus,
    };
  }

  // Structure command: working relations between Threads (plan section 9.3).
  // Manual only — AI-proposed structure changes become Candidates
  // in a later phase, per the plan's "manual flows before autonomous
  // candidate generation" sequencing.
  async addRelation(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const fromThreadId = requiredString(body.from_thread_id, "from_thread_id");
    const toThreadId = requiredString(body.to_thread_id, "to_thread_id");
    const relationKind = requiredString(body.relation_kind, "relation_kind");
    if (!THREAD_RELATION_KINDS.includes(relationKind as (typeof THREAD_RELATION_KINDS)[number])) {
      throw new HttpError(422, `relation_kind must be one of: ${THREAD_RELATION_KINDS.join(", ")}`);
    }
    if (fromThreadId === toThreadId) throw new HttpError(422, "from_thread_id and to_thread_id must differ");

    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await this.assertThreadInProject(db, identity.spaceId, projectId, fromThreadId);
      await this.assertThreadInProject(db, identity.spaceId, projectId, toThreadId);
      const inserted = await db.query(
        `INSERT INTO inquiry_thread_relations (id, space_id, project_id, from_thread_id, to_thread_id, relation_kind, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (from_thread_id, to_thread_id, relation_kind) DO NOTHING
         RETURNING id, from_thread_id, to_thread_id, relation_kind, created_at`,
        [randomUUID(), identity.spaceId, projectId, fromThreadId, toThreadId, relationKind, identity.userId, new Date().toISOString()],
      );
      if (inserted.rows[0]) {
        await this.recordStructureEvent(
          db,
          identity,
          projectId,
          fromThreadId,
          "relation_added",
          null,
          { from_thread_id: fromThreadId, to_thread_id: toThreadId, relation_kind: relationKind },
        );
        return inserted.rows[0];
      }
      const existing = await db.query(
        `SELECT id, from_thread_id, to_thread_id, relation_kind, created_at FROM inquiry_thread_relations
          WHERE space_id = $1 AND project_id=$5 AND from_thread_id = $2 AND to_thread_id = $3 AND relation_kind = $4`,
        [identity.spaceId, fromThreadId, toThreadId, relationKind, projectId],
      );
      return existing.rows[0]!;
    });
  }

  async removeRelation(identity: SpaceUserIdentity, projectId: string, relationId: string): Promise<void> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const removed = await db.query<{ from_thread_id: string; to_thread_id: string; relation_kind: string }>(
        `DELETE FROM inquiry_thread_relations
          WHERE id = $1 AND space_id = $2 AND project_id=$3
            AND from_thread_id IN (SELECT id FROM inquiry_threads WHERE project_id = $3 AND space_id = $2)
          RETURNING from_thread_id, to_thread_id, relation_kind`,
        [relationId, identity.spaceId, projectId],
      );
      const edge = removed.rows[0];
      if (edge) {
        await this.recordStructureEvent(db, identity, projectId, edge.from_thread_id, "relation_removed", edge, null);
      }
    });
  }

  // Structure command: primary-parent tree projection (plan section 9.3).
  async setPrimaryParent(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    parentThreadId: string | null,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await this.assertThreadInProject(db, identity.spaceId, projectId, threadId);
      if (parentThreadId) {
        if (parentThreadId === threadId) throw new HttpError(422, "A Thread cannot be its own parent");
        await this.assertThreadInProject(db, identity.spaceId, projectId, parentThreadId);
        const cycle = await db.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM inquiry_threads WHERE primary_parent_id=$1 AND space_id=$2 AND project_id=$3
             UNION ALL
             SELECT t.id FROM inquiry_threads t JOIN descendants d ON t.primary_parent_id=d.id
              WHERE t.space_id=$2 AND t.project_id=$3
           ) SELECT 1 FROM descendants WHERE id=$4 LIMIT 1`,
          [threadId, identity.spaceId, projectId, parentThreadId],
        );
        if (cycle.rows[0]) throw new HttpError(422, "primary_parent_id would create a cycle");
      }
      const before = await db.query<{ primary_parent_id: string | null }>(
        `SELECT primary_parent_id FROM inquiry_threads WHERE id=$1 AND space_id=$2`,
        [threadId, identity.spaceId],
      );
      const updated = await db.query<ThreadRow>(
        `UPDATE inquiry_threads SET primary_parent_id = $1, updated_at = $2
          WHERE id = $3 AND space_id = $4
          RETURNING ${THREAD_COLUMNS}`,
        [parentThreadId, new Date().toISOString(), threadId, identity.spaceId],
      );
      if (!updated.rows[0]) throw new HttpError(404, "Thread not found");
      await this.recordStructureEvent(
        db,
        identity,
        projectId,
        threadId,
        "primary_parent_changed",
        { primary_parent_id: before.rows[0]?.primary_parent_id ?? null },
        { primary_parent_id: parentThreadId },
      );
      return threadToOut(updated.rows[0]);
    });
  }

  // Deep writing uses the unified Note model (plan section 9.7) — this only
  // creates the link, never a copy of Note content.
  async linkNote(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const noteObjectId = requiredString(body.note_object_id, "note_object_id");
    const linkKind = optionalString(body.link_kind) ?? "linked_note";
    if (linkKind !== "primary_working_note" && linkKind !== "linked_note") {
      throw new HttpError(422, "link_kind must be primary_working_note or linked_note");
    }
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await this.assertThreadInProject(db, identity.spaceId, projectId, threadId);
      // A private Note is only linkable by its own owner — Project write
      // access to the Thread does not imply read access to another member's
      // private Note.
      const note = await db.query<{ object_id: string }>(
        `SELECT n.object_id FROM notes n
           JOIN space_objects o ON o.id = n.object_id AND o.space_id = n.space_id
          WHERE n.object_id = $1 AND n.space_id = $2
            AND ${contentReadSql("space_object", "o", "$3")}`,
        [noteObjectId, identity.spaceId, identity.userId],
      );
      if (!note.rows[0]) throw new HttpError(422, "Note not found in this Space");
      const inserted = await db.query(
        `INSERT INTO inquiry_thread_note_links (id, space_id, project_id, thread_id, note_object_id, link_kind, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (thread_id, note_object_id) DO UPDATE SET link_kind = EXCLUDED.link_kind
         RETURNING id, thread_id, note_object_id, link_kind, created_at`,
        [randomUUID(), identity.spaceId, projectId, threadId, noteObjectId, linkKind, identity.userId, new Date().toISOString()],
      );
      return inserted.rows[0]!;
    });
  }

  async unlinkNote(identity: SpaceUserIdentity, projectId: string, threadId: string, noteObjectId: string): Promise<void> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await db.query(
        `DELETE FROM inquiry_thread_note_links
          WHERE space_id = $1 AND project_id=$4 AND thread_id = $2 AND note_object_id = $3
            AND thread_id IN (SELECT id FROM inquiry_threads WHERE project_id = $4 AND space_id = $1)
            AND note_object_id IN (
              SELECT o.id FROM space_objects o
               WHERE o.space_id=$1 AND ${contentReadSql("space_object", "o", "$5")}
            )`,
        [identity.spaceId, threadId, noteObjectId, projectId, identity.userId],
      );
    });
  }

  async setPersonalFocus(identity: SpaceUserIdentity, projectId: string, threadId: string, inFocus: boolean): Promise<void> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await this.assertThreadInProject(this.db, identity.spaceId, projectId, threadId);
    if (inFocus) {
      await this.db.query(
        `INSERT INTO inquiry_thread_personal_focus (id, space_id, project_id, thread_id, user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, thread_id) DO NOTHING`,
        [randomUUID(), identity.spaceId, projectId, threadId, identity.userId, new Date().toISOString()],
      );
    } else {
      await this.db.query(
        `DELETE FROM inquiry_thread_personal_focus WHERE space_id = $1 AND thread_id = $2 AND user_id = $3`,
        [identity.spaceId, threadId, identity.userId],
      );
    }
  }

  async listPersonalFocus(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM inquiry_threads t
         JOIN inquiry_thread_personal_focus f ON f.thread_id = t.id
        WHERE t.space_id = $1 AND t.project_id = $2 AND f.user_id = $3
        ORDER BY f.created_at DESC`,
      [identity.spaceId, projectId, identity.userId],
    );
    return rows.rows.map(threadToOut);
  }

  async getSharedFocusWipLimit(identity: SpaceUserIdentity, projectId: string): Promise<number> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.db.query<{ shared_focus_wip_limit: number }>(
      `SELECT shared_focus_wip_limit FROM inquiry_project_settings WHERE project_id = $1 AND space_id = $2`,
      [projectId, identity.spaceId],
    );
    return row.rows[0]?.shared_focus_wip_limit ?? 3;
  }

  async setSharedFocusWipLimit(identity: SpaceUserIdentity, projectId: string, limit: number): Promise<number> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    if (!Number.isInteger(limit) || limit < 1) throw new HttpError(422, "shared_focus_wip_limit must be a positive integer");
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const row = await db.query<{ shared_focus_wip_limit: number }>(
        `INSERT INTO inquiry_project_settings (project_id, space_id, shared_focus_wip_limit, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id) DO UPDATE SET shared_focus_wip_limit = $3, updated_at = $4
         RETURNING shared_focus_wip_limit`,
        [projectId, identity.spaceId, limit, now],
      );
      return row.rows[0]!.shared_focus_wip_limit;
    });
  }

  async countFocusedThreads(spaceId: string, projectId: string, db: Queryable = this.db): Promise<number> {
    const row = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM inquiry_threads WHERE space_id = $1 AND project_id = $2 AND attention_state = 'focused'`,
      [spaceId, projectId],
    );
    return Number(row.rows[0]?.total ?? "0");
  }

  async assertThreadInProject(db: Queryable, spaceId: string, projectId: string, threadId: string): Promise<void> {
    const row = await db.query<{ id: string }>(
      `SELECT id FROM inquiry_threads WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [threadId, spaceId, projectId],
    );
    if (!row.rows[0]) throw new HttpError(422, "Thread not found in this Project");
  }

  private async getThreadRow(spaceId: string, projectId: string, threadId: string): Promise<ThreadRow | null> {
    const row = await this.db.query<ThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM inquiry_threads WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [threadId, spaceId, projectId],
    );
    return row.rows[0] ?? null;
  }

  private async recordStructureEvent(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
    actionKind: string,
    fromValue: unknown,
    toValue: unknown,
  ): Promise<void> {
    await db.query(
      `INSERT INTO inquiry_thread_structure_events
        (id, space_id, project_id, thread_id, action_kind, from_value_json, to_value_json, actor_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
      [
        randomUUID(),
        identity.spaceId,
        projectId,
        threadId,
        actionKind,
        fromValue === null ? null : JSON.stringify(fromValue),
        toValue === null ? null : JSON.stringify(toValue),
        identity.userId,
        new Date().toISOString(),
      ],
    );
  }
}

export { threadToOut, THREAD_COLUMNS, ATTENTION_STATES, type ThreadRow, type AttentionState };
