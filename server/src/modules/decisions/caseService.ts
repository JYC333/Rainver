import { contentReadSql } from "../access/contentAccessSql.js";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter.js";
import { assertLinkTypeAllowed } from "../ontology/validation.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import {
  HttpError,
  dateIso,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "../projects/access.js";
import { PgTaskRepository } from "../tasks/repository.js";

const CASE_STATUSES = new Set(["open", "decided", "archived"]);

// A Decision Case is an ontology object (ADR 0012): its title, ownership,
// provenance, and timestamps come from `space_objects`.
const CASE_FROM = `decision_cases c
     JOIN space_objects so ON so.id = c.object_id AND so.space_id = c.space_id`;
const CASE_COLUMNS = `c.object_id AS id, c.space_id, c.project_id, so.title, c.framing, c.status,
    c.decided_option_id, c.decided_at, c.decided_by_user_id,
    so.created_by_user_id, so.created_at, so.updated_at`;

interface CaseRow {
  id: string; space_id: string; project_id: string; title: string; framing: string | null; status: string;
  decided_option_id: string | null; decided_at: unknown; decided_by_user_id: string | null;
  created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

interface OptionRow {
  id: string; decision_case_id: string; title: string; description: string | null; status: string;
  created_by_user_id: string | null; created_at: unknown;
}

interface CriterionRow {
  id: string; decision_case_id: string; name: string; weight: number; created_by_user_id: string | null; created_at: unknown;
}

interface ScoreRow {
  id: string; decision_case_id: string; option_id: string; criterion_id: string; score: number;
  rationale: string | null; created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

interface CommitmentRow {
  id: string; decision_case_id: string; statement: string; committed_by_user_id: string | null;
  committed_at: unknown; created_delivery_task_id: string | null; created_at: unknown; updated_at: unknown;
}

function caseToOut(row: CaseRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, title: row.title, framing: row.framing, status: row.status,
    decided_option_id: row.decided_option_id, decided_at: dateIso(row.decided_at), decided_by_user_id: row.decided_by_user_id,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function optionToOut(row: OptionRow): Record<string, unknown> {
  return {
    id: row.id, decision_case_id: row.decision_case_id, title: row.title, description: row.description,
    status: row.status, created_by_user_id: row.created_by_user_id, created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function criterionToOut(row: CriterionRow): Record<string, unknown> {
  return {
    id: row.id, decision_case_id: row.decision_case_id, name: row.name, weight: row.weight,
    created_by_user_id: row.created_by_user_id, created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function scoreToOut(row: ScoreRow): Record<string, unknown> {
  return {
    id: row.id, decision_case_id: row.decision_case_id, option_id: row.option_id, criterion_id: row.criterion_id,
    score: row.score, rationale: row.rationale, created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(), updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function commitmentToOut(row: CommitmentRow): Record<string, unknown> {
  return {
    id: row.id, decision_case_id: row.decision_case_id, statement: row.statement,
    committed_by_user_id: row.committed_by_user_id, committed_at: dateIso(row.committed_at) ?? new Date(0).toISOString(),
    created_delivery_task_id: row.created_delivery_task_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(), updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Decision Domain. A Decision Case
 * references the Inquiry Threads that motivated it and, once a Commitment
 * is recorded, can create a Delivery Task — both are explicit reference
 * actions, never a copy of the source into this module's own tables.
 */
export class DecisionCaseService {
  constructor(private readonly pool: Pool) {}

  async createCase(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    const title = requiredString(body.title, "title");
    const framing = optionalString(body.framing);
    const threadIds = Array.isArray(body.source_thread_ids)
      ? body.source_thread_ids.filter((v): v is string => typeof v === "string")
      : [];
    const now = new Date().toISOString();
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const id = randomUUID();
      const object = buildSpaceObjectInsert({
        id,
        spaceId: identity.spaceId,
        objectType: "decision_case",
        title,
        ownerUserId: identity.userId,
        primaryProjectId: projectId,
        createdByUserId: identity.userId,
        createdAt: now,
      });
      await db.query(object.sql, object.params);
      await db.query(
        `INSERT INTO decision_cases (object_id, space_id, project_id, framing, status)
         VALUES ($1, $2, $3, $4, 'open')`,
        [id, identity.spaceId, projectId, framing],
      );
      for (const threadId of new Set(threadIds)) {
        const thread = await db.query(
          `SELECT object_id AS id FROM inquiry_threads WHERE object_id=$1 AND project_id=$2 AND space_id=$3`,
          [threadId, projectId, identity.spaceId],
        );
        if (!thread.rows[0]) throw new HttpError(422, `source Thread ${threadId} not found in this Project`);
        // Cross-aggregate reference between two ontology objects; the domain
        // join table it replaces had no attributes of its own.
        assertLinkTypeAllowed({
          linkType: "derived_from",
          fromObjectType: "decision_case",
          toObjectType: "inquiry_thread",
          via: "direct",
        });
        await db.query(
          `INSERT INTO object_relations
             (id, space_id, from_object_id, to_object_id, link_type, status, created_by_user_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'derived_from','active',$5,$6,$6)
           ON CONFLICT (space_id, from_object_id, to_object_id, link_type) WHERE status = 'active' DO NOTHING`,
          [randomUUID(), identity.spaceId, id, threadId, identity.userId, now],
        );
      }
      const row = await db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${CASE_FROM} WHERE c.object_id=$1 AND c.space_id=$2`, [id, identity.spaceId]);
      return caseToOut(row.rows[0]!);
    });
  }

  async listCases(identity: SpaceUserIdentity, projectId: string, status?: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.pool, identity.spaceId, projectId, identity.userId);
    const params: unknown[] = [identity.spaceId, projectId];
    let clause = "";
    if (status) {
      if (!CASE_STATUSES.has(status)) throw new HttpError(422, `status must be one of: ${[...CASE_STATUSES].join(", ")}`);
      params.push(status);
      clause = " AND c.status = $3";
    }
    // Project membership is necessary but not sufficient now that a Case is an
    // ontology object: the root's visibility decides who sees it, and a
    // `visibility` column nothing enforces is worse than none.
    params.push(identity.userId);
    const rows = await this.pool.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${CASE_FROM}
        WHERE c.space_id=$1 AND c.project_id=$2${clause}
          AND ${contentReadSql("space_object", "so", `$${params.length}`)}
        ORDER BY so.created_at DESC`,
      params,
    );
    return rows.rows.map(caseToOut);
  }

  async getCase(identity: SpaceUserIdentity, projectId: string, caseId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.pool, identity.spaceId, projectId, identity.userId);
    const row = await this.requireCase(this.pool, identity.spaceId, projectId, caseId, identity.userId);
    const [sources, options, criteria, scores, commitments] = await Promise.all([
      this.pool.query<{ thread_id: string }>(`SELECT to_object_id AS thread_id FROM object_relations WHERE from_object_id=$1 AND space_id=$2 AND link_type='derived_from' AND status='active'`, [caseId, identity.spaceId]),
      this.pool.query<OptionRow>(`SELECT * FROM decision_options WHERE decision_case_id=$1 AND space_id=$2 ORDER BY created_at ASC`, [caseId, identity.spaceId]),
      this.pool.query<CriterionRow>(`SELECT * FROM decision_criteria WHERE decision_case_id=$1 AND space_id=$2 ORDER BY created_at ASC`, [caseId, identity.spaceId]),
      this.pool.query<ScoreRow>(`SELECT * FROM decision_option_scores WHERE decision_case_id=$1 AND space_id=$2`, [caseId, identity.spaceId]),
      this.pool.query<CommitmentRow>(`SELECT * FROM decision_commitments WHERE decision_case_id=$1 AND space_id=$2 ORDER BY created_at ASC`, [caseId, identity.spaceId]),
    ]);
    return {
      ...caseToOut(row),
      source_thread_ids: sources.rows.map((r) => r.thread_id),
      options: options.rows.map(optionToOut),
      criteria: criteria.rows.map(criterionToOut),
      scores: scores.rows.map(scoreToOut),
      commitments: commitments.rows.map(commitmentToOut),
    };
  }

  async addOption(identity: SpaceUserIdentity, projectId: string, caseId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    const title = requiredString(body.title, "title");
    const description = optionalString(body.description);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const decisionCase = await this.requireCase(db, identity.spaceId, projectId, caseId, identity.userId);
      if (decisionCase.status !== "open") throw new HttpError(409, "Options can only be added to an open Decision Case");
      const id = randomUUID();
      await db.query(
        `INSERT INTO decision_options (id, space_id, project_id, decision_case_id, title, description, status, created_by_user_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
        [id, identity.spaceId, projectId, caseId, title, description, identity.userId, now],
      );
      const row = await db.query<OptionRow>(`SELECT * FROM decision_options WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
      return optionToOut(row.rows[0]!);
    });
  }

  async addCriterion(identity: SpaceUserIdentity, projectId: string, caseId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    const name = requiredString(body.name, "name");
    const weight = typeof body.weight === "number" && Number.isInteger(body.weight) ? body.weight : 3;
    if (weight < 1 || weight > 5) throw new HttpError(422, "weight must be between 1 and 5");
    const now = new Date().toISOString();
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const decisionCase = await this.requireCase(db, identity.spaceId, projectId, caseId, identity.userId);
      if (decisionCase.status !== "open") throw new HttpError(409, "Criteria can only be added to an open Decision Case");
      const id = randomUUID();
      await db.query(
        `INSERT INTO decision_criteria (id, space_id, project_id, decision_case_id, name, weight, created_by_user_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, identity.spaceId, projectId, caseId, name, weight, identity.userId, now],
      );
      const row = await db.query<CriterionRow>(`SELECT * FROM decision_criteria WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
      return criterionToOut(row.rows[0]!);
    });
  }

  async scoreOption(identity: SpaceUserIdentity, projectId: string, caseId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    const optionId = requiredString(body.option_id, "option_id");
    const criterionId = requiredString(body.criterion_id, "criterion_id");
    const score = body.score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
      throw new HttpError(422, "score must be an integer between 1 and 5");
    }
    const rationale = optionalString(body.rationale);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await this.requireCase(db, identity.spaceId, projectId, caseId, identity.userId);
      const option = await db.query(`SELECT id FROM decision_options WHERE id=$1 AND decision_case_id=$2 AND space_id=$3`, [optionId, caseId, identity.spaceId]);
      if (!option.rows[0]) throw new HttpError(404, "Option not found in this Decision Case");
      const criterion = await db.query(`SELECT id FROM decision_criteria WHERE id=$1 AND decision_case_id=$2 AND space_id=$3`, [criterionId, caseId, identity.spaceId]);
      if (!criterion.rows[0]) throw new HttpError(404, "Criterion not found in this Decision Case");
      const id = randomUUID();
      await db.query(
        `INSERT INTO decision_option_scores (id, space_id, decision_case_id, option_id, criterion_id, score, rationale, created_by_user_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         ON CONFLICT (option_id, criterion_id) DO UPDATE SET score=$6, rationale=$7, updated_at=$9`,
        [id, identity.spaceId, caseId, optionId, criterionId, score, rationale, identity.userId, now],
      );
      const row = await db.query<ScoreRow>(`SELECT * FROM decision_option_scores WHERE option_id=$1 AND criterion_id=$2 AND space_id=$3`, [optionId, criterionId, identity.spaceId]);
      return scoreToOut(row.rows[0]!);
    });
  }

  async decide(identity: SpaceUserIdentity, projectId: string, caseId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    const optionId = requiredString(body.option_id, "option_id");
    const now = new Date().toISOString();
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const lockedCase = await db.query<CaseRow>(
        `SELECT ${CASE_COLUMNS} FROM ${CASE_FROM} WHERE c.object_id=$1 AND c.space_id=$2 AND c.project_id=$3 FOR UPDATE OF c`,
        [caseId, identity.spaceId, projectId],
      );
      const decisionCase = lockedCase.rows[0];
      if (!decisionCase) throw new HttpError(404, "Decision Case not found");
      if (decisionCase.status !== "open") throw new HttpError(409, `Decision Case already ${decisionCase.status}`);
      const option = await db.query<{ status: string }>(`SELECT status FROM decision_options WHERE id=$1 AND decision_case_id=$2 AND space_id=$3`, [optionId, caseId, identity.spaceId]);
      if (!option.rows[0]) throw new HttpError(404, "Option not found in this Decision Case");
      if (option.rows[0].status !== "active") throw new HttpError(409, "Only an active Option can be decided");
      await db.query(
        `UPDATE decision_cases SET status='decided', decided_option_id=$3, decided_at=$4, decided_by_user_id=$5
         WHERE object_id=$1 AND space_id=$2`,
        [caseId, identity.spaceId, optionId, now, identity.userId],
      );
      // The timestamp lives on the root now, so a domain-only write would
      // leave it stale.
      await db.query(
        `UPDATE space_objects SET updated_at=$1 WHERE id=$2 AND space_id=$3`,
        [now, caseId, identity.spaceId],
      );
      const row = await db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${CASE_FROM} WHERE c.object_id=$1 AND c.space_id=$2`, [caseId, identity.spaceId]);
      return caseToOut(row.rows[0]!);
    });
  }

  async addCommitment(identity: SpaceUserIdentity, projectId: string, caseId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    const statement = requiredString(body.statement, "statement");
    const now = new Date().toISOString();
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const decisionCase = await this.requireCase(db, identity.spaceId, projectId, caseId, identity.userId);
      if (decisionCase.status !== "decided") throw new HttpError(409, "A Commitment requires a decided Decision Case");
      const id = randomUUID();
      await db.query(
        `INSERT INTO decision_commitments (id, space_id, project_id, decision_case_id, statement, committed_by_user_id, committed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7)`,
        [id, identity.spaceId, projectId, caseId, statement, identity.userId, now],
      );
      const row = await db.query<CommitmentRow>(`SELECT * FROM decision_commitments WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
      return commitmentToOut(row.rows[0]!);
    });
  }

  /** Explicit, atomic confirmed Decision -> Delivery Task action. */
  async createDeliveryFromCommitment(
    identity: SpaceUserIdentity,
    projectId: string,
    caseId: string,
    commitmentId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.pool, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.pool, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await this.requireCase(db, identity.spaceId, projectId, caseId, identity.userId);
      const commitment = await db.query<CommitmentRow>(
        `SELECT * FROM decision_commitments
          WHERE id=$1 AND decision_case_id=$2 AND project_id=$3 AND space_id=$4
          FOR UPDATE`,
        [commitmentId, caseId, projectId, identity.spaceId],
      );
      const row = commitment.rows[0];
      if (!row) throw new HttpError(404, "Commitment not found");
      if (row.created_delivery_task_id) throw new HttpError(409, "Delivery already created for this Commitment");

      const task = await new PgTaskRepository(this.pool).createTask(identity, {
        project_id: projectId,
        title: `Deliver: ${row.statement.slice(0, 120)}`,
        task_type: "delivery",
        visibility: "space_shared",
        description: optionalString(body.description),
        metadata_json: { source_decision_commitment_id: commitmentId, source_decision_case_id: caseId },
      }, db);

      const now = new Date().toISOString();
      await db.query(
        `UPDATE decision_commitments SET created_delivery_task_id=$3, updated_at=$4
          WHERE id=$1 AND space_id=$2`,
        [commitmentId, identity.spaceId, task.id, now],
      );
      return { commitment: { ...commitmentToOut(row), created_delivery_task_id: task.id }, task };
    });
  }

  /**
   * The single-Case lookup every read and mutation goes through. It applies the
   * object read gate, not just Project membership: the list already did, and a
   * visibility rule that holds for the list but not for a direct fetch is not a
   * rule. Mutations pass through it too — you should not be able to change what
   * you cannot see.
   */
  private async requireCase(
    db: Queryable,
    spaceId: string,
    projectId: string,
    caseId: string,
    viewerUserId: string,
  ): Promise<CaseRow> {
    const row = await db.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${CASE_FROM}
        WHERE c.object_id=$1 AND c.space_id=$2 AND c.project_id=$3
          AND ${contentReadSql("space_object", "so", "$4")}`,
      [caseId, spaceId, projectId, viewerUserId],
    );
    if (!row.rows[0]) throw new HttpError(404, "Decision Case not found");
    return row.rows[0];
  }
}
