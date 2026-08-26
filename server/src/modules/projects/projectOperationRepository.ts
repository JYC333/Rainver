import { randomUUID } from "node:crypto";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, objectValue, optionalString, requiredString, withQueryableTransaction } from "../routeUtils/common.js";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "./access.js";

const KINDS = new Set(["source_setup", "source_backfill", "research", "custom"]);

interface ProjectOperationRecord extends Record<string, unknown> {
  id: string;
}

type TargetState = "pending" | "done" | "failed";

interface TargetSpec {
  table: string;
  idColumn?: string;
  column: string;
  done: string[];
  failed: string[];
}

const LINK_TARGET_SPECS: Record<string, TargetSpec> = {
  run: { table: "runs", column: "status", done: ["succeeded", "degraded", "cancelled"], failed: ["failed"] },
  job: { table: "jobs", column: "status", done: ["succeeded", "cancelled"], failed: ["failed", "dead_letter"] },
  proposal: { table: "proposals", column: "status", done: ["accepted", "superseded"], failed: ["rejected", "expired"] },
  project_source_binding: { table: "project_source_bindings", column: "status", done: ["active", "archived"], failed: [] },
  source_backfill_plan: { table: "source_backfill_plans", column: "status", done: ["completed", "cancelled"], failed: ["failed"] },
  research_workflow: { table: "project_research_workflows", idColumn: "object_id", column: "status", done: ["completed", "archived"], failed: [] },
};

const LINK_TARGET_PROJECT_SCOPE: Record<string, boolean> = {
  run: true,
  job: false,
  proposal: true,
  artifact: true,
  project_source_binding: true,
  source_backfill_plan: false,
  research_workflow: true,
};

export class ProjectOperationRepository {
  constructor(private readonly db: Queryable) {}

  async create(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, (db) => new ProjectOperationRepository(db).createLocked(identity, projectId, body));
  }

  async createManagedResearch(
    identity: SpaceUserIdentity,
    projectId: string,
    input: {
      title: string;
      intentText: string;
      status: "active" | "waiting_review";
      progress: Record<string, unknown>;
      steps: Array<{ title: string; status: "pending" | "active" | "blocked" | "done" | "skipped"; detail?: Record<string, unknown> }>;
    },
  ): Promise<{ id: string }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        await db.query(
          `INSERT INTO project_operations (
             id, space_id, project_id, kind, title, intent_text, status,
             created_by_user_id, progress_json, created_at, updated_at
           ) VALUES ($1,$2,$3,'research',$4,$5,$6,$7,$8::jsonb,$9,$9)`,
          [id, identity.spaceId, projectId, input.title, input.intentText, input.status,
            identity.userId, JSON.stringify({ projection_mode: "managed", ...input.progress }), now],
        );
        for (let seq = 0; seq < input.steps.length; seq += 1) {
          const step = input.steps[seq]!;
          await db.query(
            `INSERT INTO project_operation_steps
               (id, operation_id, space_id, seq, title, status, detail_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [randomUUID(), id, identity.spaceId, seq, step.title, step.status, JSON.stringify(step.detail ?? {})],
          );
        }
      } catch (error) {
        if (isUniqueViolation(error, "uq_project_operations_active_research_workflow")) {
          throw new HttpError(409, "Another Project Research operation is already active for this workflow");
        }
        throw error;
      }
      return { id };
    });
  }

  async list(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 ORDER BY updated_at DESC`,
      [identity.spaceId, projectId],
    );
    return Promise.all(rows.rows.map((row) => this.get(identity, projectId, row.id)));
  }

  async get(identity: SpaceUserIdentity, projectId: string, operationId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await this.assertOperationInProject(operationId, identity.spaceId, projectId);
    await this.refreshProjection(identity.spaceId, operationId);

    const operation = await this.db.query<ProjectOperationRecord>(
      `SELECT * FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3`,
      [operationId, identity.spaceId, projectId],
    );
    const row = operation.rows[0];
    if (!row) throw new HttpError(404, "Project operation not found");

    const steps = await this.db.query(`SELECT * FROM project_operation_steps WHERE operation_id=$1 AND space_id=$2 ORDER BY seq`, [operationId, identity.spaceId]);
    const links = await this.db.query(`SELECT * FROM project_operation_links WHERE operation_id=$1 AND space_id=$2 ORDER BY created_at`, [operationId, identity.spaceId]);
    return { ...row, steps: steps.rows, links: links.rows };
  }

  async cancel(identity: SpaceUserIdentity, projectId: string, operationId: string) {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await this.assertOperationInProject(operationId, identity.spaceId, projectId);
    const result = await this.db.query<ProjectOperationRecord>(
      `UPDATE project_operations SET status='cancelled', version=version+1, updated_at=$4
        WHERE id=$1 AND space_id=$2 AND project_id=$3 AND status NOT IN ('completed','cancelled')
        RETURNING *`,
      [operationId, identity.spaceId, projectId, new Date().toISOString()],
    );
    if (!result.rows[0]) throw new HttpError(409, "Operation is already terminal");
    return result.rows[0];
  }

  async link(spaceId: string, projectId: string, operationId: string, targetType: string, targetId: string, role = "related"): Promise<void> {
    await this.assertOperationInProject(operationId, spaceId, projectId);
    if (!(targetType in LINK_TARGET_PROJECT_SCOPE)) throw new HttpError(422, "Unsupported operation link target");
    await this.assertLinkTarget(spaceId, projectId, targetType, targetId);
    await this.db.query(
      `INSERT INTO project_operation_links (id, operation_id, space_id, target_type, target_id, role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (operation_id, target_type, target_id) DO NOTHING`,
      [randomUUID(), operationId, spaceId, targetType, targetId, role, new Date().toISOString()],
    );
  }

  /**
   * Updates an operation owned by a higher-level orchestrator.
   *
   * Linked target projection is intentionally not used for these operations:
   * a research operation has human checkpoints and several asynchronous
   * stages, so its lifecycle is richer than the status of any one linked job.
   * `projection_mode=managed` makes that ownership explicit while retaining
   * the normal operation tables and read API.
   */
  async setManagedState(
    spaceId: string,
    projectId: string,
    operationId: string,
    input: {
      status: "draft" | "active" | "waiting_review" | "completed" | "failed" | "cancelled";
      progress: Record<string, unknown>;
      stepStates?: Array<{ seq: number; status: "pending" | "active" | "blocked" | "done" | "skipped"; detail?: Record<string, unknown> }>;
      /**
       * Replace the managed progress document instead of shallow-merging it,
       * so keys the orchestrator removed from its state actually disappear.
       * The `links` projection (maintained by refreshProjection) is preserved.
       */
      replaceProgress?: boolean;
      expectedVersion: number;
    },
  ): Promise<void> {
    await this.assertOperationInProject(operationId, spaceId, projectId);
    const progressSql = input.replaceProgress
      ? `(CASE WHEN progress_json ? 'links' THEN jsonb_build_object('links', progress_json->'links') ELSE '{}'::jsonb END) || $5::jsonb`
      : `COALESCE(progress_json,'{}'::jsonb) || $5::jsonb`;
    const updated = await this.db.query(
      `UPDATE project_operations
          SET status=$4,
              progress_json=${progressSql},
              version=version+1,
              updated_at=$6
        WHERE id=$1 AND space_id=$2 AND project_id=$3 AND version=$7`,
      [operationId, spaceId, projectId, input.status, JSON.stringify({ projection_mode: "managed", ...input.progress }), new Date().toISOString(), input.expectedVersion],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new HttpError(409, "Project operation changed concurrently; reload and retry");
    }
    for (const step of input.stepStates ?? []) {
      await this.db.query(
        `UPDATE project_operation_steps
            SET status=$4, detail_json=COALESCE(detail_json,'{}'::jsonb) || $5::jsonb
          WHERE operation_id=$1 AND space_id=$2 AND seq=$3`,
        [operationId, spaceId, step.seq, step.status, JSON.stringify(step.detail ?? {})],
      );
    }
  }

  private async createLocked(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>) {
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const kind = requiredString(body.kind, "kind");
    if (!KINDS.has(kind)) throw new HttpError(422, "invalid operation kind");
    await this.assertOptionalReference(identity.spaceId, projectId, "run", optionalString(body.initiating_run_id));
    await this.assertOptionalReference(identity.spaceId, projectId, "artifact", optionalString(body.plan_artifact_id));

    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, intent_text, status, created_by_user_id, initiating_run_id, plan_artifact_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10::jsonb,$11,$11)`,
      [
        id,
        identity.spaceId,
        projectId,
        kind,
        requiredString(body.title, "title"),
        optionalString(body.intent_text),
        identity.userId,
        optionalString(body.initiating_run_id),
        optionalString(body.plan_artifact_id),
        JSON.stringify(objectValue(body.progress)),
        now,
      ],
    );

    const steps = Array.isArray(body.steps) ? body.steps : [];
    for (let i = 0; i < steps.length; i++) {
      const step = objectValue(steps[i]);
      await this.db.query(
        `INSERT INTO project_operation_steps (id, operation_id, space_id, seq, title, status, detail_json) VALUES ($1,$2,$3,$4,$5,'pending',$6::jsonb)`,
        [randomUUID(), id, identity.spaceId, i, requiredString(step.title, "step.title"), JSON.stringify(objectValue(step.detail))],
      );
    }
    return this.get(identity, projectId, id);
  }

  private async assertOperationInProject(operationId: string, spaceId: string, projectId: string): Promise<void> {
    const row = await this.db.query(`SELECT 1 FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3`, [operationId, spaceId, projectId]);
    if (!row.rows[0]) throw new HttpError(404, "Project operation not found");
  }

  /**
   * Projects operation status/progress from its linked targets (runs, jobs,
   * proposals, backfill plans, bindings). This is a pure read-model refresh —
   * it never mutates the linked objects and never blocks their own lifecycle.
   */
  private async refreshProjection(spaceId: string, operationId: string): Promise<void> {
    const links = await this.db.query<{ target_type: string; target_id: string }>(
      `SELECT target_type, target_id FROM project_operation_links WHERE operation_id=$1 AND space_id=$2`,
      [operationId, spaceId],
    );
    let pending = 0;
    let failed = 0;
    let done = 0;
    for (const link of links.rows) {
      const state = await this.targetState(spaceId, link.target_type, link.target_id);
      if (state === "failed") failed++;
      else if (state === "done") done++;
      else pending++;
    }

    const current = await this.db.query<{ status: string; progress_json: unknown }>(`SELECT status, progress_json FROM project_operations WHERE id=$1 AND space_id=$2`, [operationId, spaceId]);
    if (current.rows[0]?.status === "cancelled") return;

    // Research and other workflow-owned operations still expose link counts,
    // but their status is advanced by the owning orchestrator and checkpoint
    // decisions rather than inferred from a heterogeneous link set.
    const managed = objectValue(current.rows[0]?.progress_json).projection_mode === "managed";
    if (managed) {
      const linksProjection = { total: links.rows.length, completed: done, failed, pending };
      await this.db.query(
        `UPDATE project_operations
            SET progress_json=COALESCE(progress_json,'{}'::jsonb) || $3::jsonb,
                version=version+1
          WHERE id=$1 AND space_id=$2 AND status <> 'cancelled'
            AND (progress_json->'links') IS DISTINCT FROM $3::jsonb->'links'`,
        [operationId, spaceId, JSON.stringify({ links: linksProjection })],
      );
      return;
    }

    const status = failed ? "failed" : links.rows.length && pending === 0 ? "completed" : links.rows.length ? "active" : "draft";
    const projection = { total: links.rows.length, completed: done, failed, pending };
    const updated = await this.db.query(
      `UPDATE project_operations
          SET status=$3, progress_json=COALESCE(progress_json,'{}'::jsonb) || $4::jsonb,
              version=version+1, updated_at=$5
        WHERE id=$1 AND space_id=$2 AND status <> 'cancelled'
          AND (status IS DISTINCT FROM $3 OR progress_json IS DISTINCT FROM (COALESCE(progress_json,'{}'::jsonb) || $4::jsonb))`,
      [operationId, spaceId, status, JSON.stringify(projection), new Date().toISOString()],
    );
    if ((updated.rowCount ?? 0) === 0) return;
    await this.db.query(
      `UPDATE project_operation_steps
          SET status = CASE
            WHEN $3::int>0 AND seq=$4::int THEN 'blocked'
            WHEN seq<$5::int THEN 'done'
            WHEN seq=$5::int AND $6::int>0 THEN 'active'
            ELSE 'pending'
          END
        WHERE operation_id=$1 AND space_id=$2`,
      [operationId, spaceId, failed, Math.min(done, Math.max(links.rows.length - 1, 0)), done, pending],
    );
  }

  private async targetState(spaceId: string, type: string, id: string): Promise<TargetState> {
    if (type === "artifact") {
      const row = await this.db.query(`SELECT 1 FROM artifacts WHERE id=$1 AND space_id=$2`, [id, spaceId]);
      return row.rows[0] ? "done" : "failed";
    }
    const spec = LINK_TARGET_SPECS[type];
    if (!spec) return "failed";
    const row = await this.db.query<{ status: string }>(`SELECT ${spec.column} AS status FROM ${spec.table} WHERE ${spec.idColumn ?? "id"}=$1 AND space_id=$2`, [id, spaceId]);
    const status = row.rows[0]?.status;
    if (!status) return "failed";
    return spec.failed.includes(status) ? "failed" : spec.done.includes(status) ? "done" : "pending";
  }

  private async assertOptionalReference(spaceId: string, projectId: string, type: "run" | "artifact", id: string | null): Promise<void> {
    if (id) await this.assertLinkTarget(spaceId, projectId, type, id);
  }

  private async assertLinkTarget(spaceId: string, projectId: string, type: string, id: string): Promise<void> {
    if (type === "job") {
      const row = await this.db.query(`SELECT 1 FROM jobs WHERE id=$1 AND space_id=$2 AND payload_json->>'project_id'=$3`, [id, spaceId, projectId]);
      if (!row.rows[0]) throw new HttpError(404, "Operation link target not found");
      return;
    }
    const spec = LINK_TARGET_SPECS[type];
    const table = type === "artifact" ? "artifacts" : spec?.table;
    if (!table) throw new HttpError(422, "Unsupported operation link target");
    const scoped = LINK_TARGET_PROJECT_SCOPE[type];
    const clause = scoped ? " AND project_id=$3" : "";
    const idColumn = type === "artifact" ? "id" : (spec?.idColumn ?? "id");
    const row = await this.db.query(`SELECT 1 FROM ${table} WHERE ${idColumn}=$1 AND space_id=$2${clause}`, [id, spaceId, ...(scoped ? [projectId] : [])]);
    if (!row.rows[0]) throw new HttpError(404, "Operation link target not found");
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; constraint?: unknown };
  return value.code === "23505" && value.constraint === constraint;
}
