import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { accessibleProjectIds, assertProjectReadable, assertProjectWriter } from "../projects/access";
import { contentReadSql } from "../access/contentAccessSql";

const ITEM_KINDS = new Set(["card", "exercise"]);
const REVIEW_OUTCOMES = new Set(["correct", "incorrect"]);
const MASTERY_STREAK_TO_MASTER = 3;

interface ObjectiveRow {
  id: string; space_id: string; project_id: string | null; title: string; description: string | null;
  status: string; created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

interface ItemRow {
  id: string; space_id: string; project_id: string | null; objective_id: string | null;
  knowledge_item_id: string; knowledge_item_version: number; item_kind: string; prompt: string; answer: string;
  created_by_user_id: string | null; created_at: unknown;
}

interface MasteryRow {
  id: string; learning_item_id: string; user_id: string; mastery_state: string; correct_streak: number;
  last_reviewed_at: unknown; next_review_at: unknown; created_at: unknown; updated_at: unknown;
}

function objectiveToOut(row: ObjectiveRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, title: row.title, description: row.description, status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function itemToOut(row: ItemRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, objective_id: row.objective_id,
    knowledge_item_id: row.knowledge_item_id, knowledge_item_version: row.knowledge_item_version,
    item_kind: row.item_kind, prompt: row.prompt, answer: row.answer, created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function masteryToOut(row: MasteryRow): Record<string, unknown> {
  return {
    id: row.id, learning_item_id: row.learning_item_id, user_id: row.user_id, mastery_state: row.mastery_state,
    correct_streak: row.correct_streak, last_reviewed_at: dateIso(row.last_reviewed_at), next_review_at: dateIso(row.next_review_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(), updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Learning Domain: an independent global
 * Domain and a Project-contextual Area. Learning Items anchor to a
 * stable, versioned Knowledge item (never a Note directly). Mastery is
 * per-user and kept in its own table, separate from the shared Item content.
 */
export class LearningService {
  constructor(private readonly db: Queryable) {}

  async createObjective(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectId = optionalString(body.project_id);
    if (projectId) await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const title = requiredString(body.title, "title");
    const description = optionalString(body.description);
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO learning_objectives (id, space_id, project_id, title, description, status, created_by_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$7)`,
      [id, identity.spaceId, projectId, title, description, identity.userId, now],
    );
    const row = await this.db.query<ObjectiveRow>(`SELECT * FROM learning_objectives WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
    return objectiveToOut(row.rows[0]!);
  }

  async listObjectives(identity: SpaceUserIdentity, filters: { projectId?: string | null }): Promise<Record<string, unknown>[]> {
    if (filters.projectId) await assertProjectReadable(this.db, identity.spaceId, filters.projectId, identity.userId);
    const params: unknown[] = [identity.spaceId];
    let clause = "";
    if (filters.projectId) {
      params.push(filters.projectId);
      clause = " AND project_id = $2";
    }
    const rows = await this.db.query<ObjectiveRow>(
      `SELECT * FROM learning_objectives WHERE space_id=$1${clause} ORDER BY created_at DESC`,
      params,
    );
    const visible = filters.projectId ? rows.rows : await this.filterProjectAccessible(identity, rows.rows);
    return visible.map(objectiveToOut);
  }

  async createItem(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectId = optionalString(body.project_id);
    if (projectId) await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const objectiveId = optionalString(body.objective_id);
    if (objectiveId) {
      const objective = await this.db.query<{ project_id: string | null }>(
        `SELECT project_id FROM learning_objectives WHERE id=$1 AND space_id=$2`,
        [objectiveId, identity.spaceId],
      );
      if (!objective.rows[0]) throw new HttpError(422, "objective_id not found in this Space");
      if (objective.rows[0].project_id && objective.rows[0].project_id !== projectId) {
        throw new HttpError(422, "objective_id belongs to a different Project");
      }
      if (objective.rows[0].project_id) {
        await assertProjectWriter(this.db, identity.spaceId, objective.rows[0].project_id, identity.userId);
      }
    }
    const knowledgeItemId = requiredString(body.knowledge_item_id, "knowledge_item_id");
    const knowledge = await this.db.query<{ version: number }>(
      `SELECT ki.version FROM knowledge_items ki
         JOIN space_objects so ON so.id=ki.object_id AND so.space_id=ki.space_id
        WHERE ki.object_id=$1 AND ki.space_id=$2
          AND so.visibility='space_shared'
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [knowledgeItemId, identity.spaceId, identity.userId],
    );
    if (!knowledge.rows[0]) throw new HttpError(404, "Shared Knowledge item not found or inaccessible");
    const itemKind = optionalString(body.item_kind) ?? "card";
    if (!ITEM_KINDS.has(itemKind)) throw new HttpError(422, `item_kind must be one of: ${[...ITEM_KINDS].join(", ")}`);
    const prompt = requiredString(body.prompt, "prompt");
    const answer = requiredString(body.answer, "answer");
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO learning_items (id, space_id, project_id, objective_id, knowledge_item_id, knowledge_item_version, item_kind, prompt, answer, created_by_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, identity.spaceId, projectId, objectiveId, knowledgeItemId, knowledge.rows[0].version, itemKind, prompt, answer, identity.userId, now],
    );
    const row = await this.db.query<ItemRow>(`SELECT * FROM learning_items WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
    return itemToOut(row.rows[0]!);
  }

  async listItems(identity: SpaceUserIdentity, filters: { projectId?: string | null; objectiveId?: string | null }): Promise<Record<string, unknown>[]> {
    if (filters.projectId) await assertProjectReadable(this.db, identity.spaceId, filters.projectId, identity.userId);
    if (filters.objectiveId) {
      const objective = await this.db.query<{ project_id: string | null }>(
        `SELECT project_id FROM learning_objectives WHERE id=$1 AND space_id=$2`,
        [filters.objectiveId, identity.spaceId],
      );
      if (!objective.rows[0]) throw new HttpError(404, "Learning Objective not found");
      if (objective.rows[0].project_id) {
        await assertProjectReadable(this.db, identity.spaceId, objective.rows[0].project_id, identity.userId);
      }
      if (filters.projectId && objective.rows[0].project_id && objective.rows[0].project_id !== filters.projectId) {
        throw new HttpError(422, "objective_id belongs to a different Project");
      }
    }
    const params: unknown[] = [identity.spaceId];
    const clauses: string[] = [];
    if (filters.projectId) {
      params.push(filters.projectId);
      clauses.push(`project_id = $${params.length}`);
    }
    if (filters.objectiveId) {
      params.push(filters.objectiveId);
      clauses.push(`objective_id = $${params.length}`);
    }
    const clause = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
    const rows = await this.db.query<ItemRow>(
      `SELECT * FROM learning_items WHERE space_id=$1${clause} ORDER BY created_at DESC`,
      params,
    );
    const visible = filters.projectId ? rows.rows : await this.filterProjectAccessible(identity, rows.rows);
    return visible.map(itemToOut);
  }

  // The global (no project_id filter) surface spans every Project in the
  // Space, but a team Space's per-Project membership is a real access
  // boundary (see modules/projects/access.ts) — a row with a non-null
  // project_id must not leak to a caller who cannot read that Project. Rows
  // with a null project_id are Space-global by definition and always visible
  // to any Space member.
  private async filterProjectAccessible<T extends { project_id: string | null }>(
    identity: SpaceUserIdentity,
    rows: T[],
  ): Promise<T[]> {
    const accessible = await accessibleProjectIds(this.db, identity.spaceId, identity.userId, rows.map((row) => row.project_id));
    return rows.filter((row) => row.project_id === null || accessible.has(row.project_id));
  }

  async recordReview(identity: SpaceUserIdentity, itemId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const outcome = requiredString(body.outcome, "outcome");
    if (!REVIEW_OUTCOMES.has(outcome)) throw new HttpError(422, `outcome must be one of: ${[...REVIEW_OUTCOMES].join(", ")}`);
    const item = await this.db.query<{ id: string; project_id: string | null }>(
      `SELECT id, project_id FROM learning_items WHERE id=$1 AND space_id=$2`,
      [itemId, identity.spaceId],
    );
    if (!item.rows[0]) throw new HttpError(404, "Learning Item not found");
    // A direct-by-id call must respect the same Project boundary as the
    // listing surfaces — a team Space's per-Project membership is real
    // access control, not just a listing filter.
    if (item.rows[0].project_id) await assertProjectReadable(this.db, identity.spaceId, item.rows[0].project_id, identity.userId);

    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      const row = await db.query<MasteryRow>(
        `INSERT INTO learning_item_mastery (
           id, space_id, learning_item_id, user_id, mastery_state, correct_streak,
           last_reviewed_at, next_review_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,'learning',CASE WHEN $5='correct' THEN 1 ELSE 0 END,
           $6,$6::timestamptz + interval '1 day',$6,$6
         )
         ON CONFLICT (learning_item_id, user_id) DO UPDATE SET
           correct_streak=CASE WHEN $5='correct' THEN learning_item_mastery.correct_streak+1 ELSE 0 END,
           mastery_state=CASE
             WHEN $5='incorrect' THEN 'learning'
             WHEN learning_item_mastery.correct_streak+1 >= $7 THEN 'mastered'
             ELSE 'learning'
           END,
           last_reviewed_at=$6,
           next_review_at=$6::timestamptz + CASE
             WHEN $5='correct' AND learning_item_mastery.correct_streak+1 >= $7 THEN interval '7 days'
             ELSE interval '1 day'
           END,
           updated_at=$6
         RETURNING *`,
        [randomUUID(), identity.spaceId, itemId, identity.userId, outcome, now, MASTERY_STREAK_TO_MASTER],
      );
      return masteryToOut(row.rows[0]!);
    });
  }

  async getMasterySummary(identity: SpaceUserIdentity, filters: { projectId?: string | null }): Promise<{ due_count: number; mastered_count: number; learning_count: number }> {
    const params: unknown[] = [identity.spaceId, identity.userId];
    let clause = "";
    if (filters.projectId) {
      await assertProjectReadable(this.db, identity.spaceId, filters.projectId, identity.userId);
      params.push(filters.projectId);
      clause = " AND li.project_id = $3";
    } else {
      const projectRows = await this.db.query<{ project_id: string | null }>(
        `SELECT DISTINCT project_id FROM learning_items WHERE space_id=$1 AND project_id IS NOT NULL`,
        [identity.spaceId],
      );
      const accessible = await accessibleProjectIds(
        this.db, identity.spaceId, identity.userId, projectRows.rows.map((row) => row.project_id),
      );
      params.push([...accessible]);
      clause = " AND (li.project_id IS NULL OR li.project_id = ANY($3::varchar[]))";
    }
    const rows = await this.db.query<{ due_count: number; mastered_count: number; learning_count: number }>(
      `SELECT
         count(*) FILTER (WHERE m.next_review_at IS NOT NULL AND m.next_review_at <= now())::int AS due_count,
         count(*) FILTER (WHERE m.mastery_state = 'mastered')::int AS mastered_count,
         count(*) FILTER (WHERE m.mastery_state = 'learning')::int AS learning_count
       FROM learning_item_mastery m
       JOIN learning_items li ON li.id = m.learning_item_id AND li.space_id = m.space_id
       WHERE m.space_id = $1 AND m.user_id = $2${clause}`,
      params,
    );
    return rows.rows[0] ?? { due_count: 0, mastered_count: 0, learning_count: 0 };
  }
}
