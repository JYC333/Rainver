import { contentReadSql } from "../access/contentAccessSql";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter";
import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalString,
  requiredString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import {
  assertProjectReadable,
  assertProjectWriter,
  assertProjectFolderInProject,
  lockActiveProjectForMutation,
} from "../projects/access";
import { enumValue, EXECUTOR_TYPES, normalizeExecutorConfig } from "./common";

const DEFINITION_STATUSES = new Set(["draft", "active", "paused", "completed", "archived"]);
const VERSION_STATUSES = new Set(["draft", "approved", "archived"]);

interface DefinitionRow {
  id: string; space_id: string; project_id: string; name: string; objective: string | null;
  primary_hypothesis_thread_id: string | null; status: string;
  baseline_run_id: string | null; best_run_id: string | null;
  created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

interface VersionRow {
  id: string; space_id: string; definition_id: string; version: number;
  executor_type: string; config_json: unknown; planned_summary: string | null; status: string;
  created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

function definitionToOut(row: DefinitionRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, name: row.name, objective: row.objective,
    primary_hypothesis_thread_id: row.primary_hypothesis_thread_id, status: row.status,
    baseline_run_id: row.baseline_run_id, best_run_id: row.best_run_id,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function versionToOut(row: VersionRow): Record<string, unknown> {
  return {
    id: row.id, definition_id: row.definition_id, version: row.version,
    executor_type: row.executor_type, config: objectValue(row.config_json),
    planned_summary: row.planned_summary, status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Experiment Definition + Version. The stable identity of an
 * Experiment and its immutable, versioned execution configuration —
 * `managed_code_comparison` is one `executor_type` this domain supports, not
 * a second top-level Experiment concept (the old
 * project_experiment_campaigns/runs/provenance model is retired in the same
 * change; see experiments/runService.ts for the managed_code_comparison
 * config shape it replaces).
 */

// An Experiment Definition is an ontology object (ADR 0012): the former `name`
// is the root's `title`, and ownership, provenance, and timestamps come from
// `space_objects`.
const DEFINITION_FROM = `experiment_definitions d
     JOIN space_objects so ON so.id = d.object_id AND so.space_id = d.space_id`;
const DEFINITION_COLUMNS = `d.object_id AS id, d.space_id, d.project_id, so.title AS name, d.objective,
    d.primary_hypothesis_thread_id, d.status, d.baseline_run_id, d.best_run_id,
    so.created_by_user_id, so.created_at, so.updated_at`;

export class ExperimentDefinitionService {
  constructor(private readonly db: Queryable) {}

  async createDefinition(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const name = requiredString(body.name, "name");
    const threadId = optionalString(body.primary_hypothesis_thread_id);
    const now = new Date().toISOString();
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      if (threadId) await this.assertThreadInProject(db, identity.spaceId, projectId, threadId);
      const id = randomUUID();
      const object = buildSpaceObjectInsert({
        id,
        spaceId: identity.spaceId,
        objectType: "experiment",
        title: name,
        ownerUserId: identity.userId,
        primaryProjectId: projectId,
        createdByUserId: identity.userId,
        createdAt: now,
      });
      await db.query(object.sql, object.params);
      await db.query(
        `INSERT INTO experiment_definitions (
           object_id, space_id, project_id, objective, primary_hypothesis_thread_id, status
         ) VALUES ($1, $2, $3, $4, $5, 'draft')`,
        [id, identity.spaceId, projectId, optionalString(body.objective), threadId],
      );
      const row = await this.definitionRow(identity.spaceId, projectId, id, identity.userId, db);
      if (!row) throw new HttpError(500, "Failed to create Experiment Definition");
      return definitionToOut(row);
    });
  }

  async updateDefinition(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const current = await this.definitionRow(identity.spaceId, projectId, definitionId, identity.userId, db);
      if (!current) throw new HttpError(404, "Experiment Definition not found");
      const status = body.status === undefined ? current.status : (enumValue(body.status, DEFINITION_STATUSES) ?? current.status);
      const threadId = body.primary_hypothesis_thread_id === undefined ? current.primary_hypothesis_thread_id : optionalString(body.primary_hypothesis_thread_id);
      if (threadId && threadId !== current.primary_hypothesis_thread_id) {
        await this.assertThreadInProject(db, identity.spaceId, projectId, threadId);
      }
      if (threadId !== current.primary_hypothesis_thread_id) {
        const run = await db.query<{ id: string }>(
          `SELECT r.id FROM experiment_runs r
             JOIN experiment_versions v ON v.id=r.version_id AND v.space_id=r.space_id
            WHERE r.space_id=$1 AND v.definition_id=$2
            LIMIT 1`,
          [identity.spaceId, definitionId],
        );
        if (run.rows[0]) {
          throw new HttpError(409, "primary_hypothesis_thread_id is immutable after the first Experiment Run");
        }
      }
      const now = new Date().toISOString();
      await db.query(
        `UPDATE experiment_definitions SET status=$4, objective=$5, primary_hypothesis_thread_id=$6
          WHERE object_id=$1 AND space_id=$2 AND project_id=$3`,
        [definitionId, identity.spaceId, projectId, status,
          body.objective === undefined ? current.objective : optionalString(body.objective),
          threadId],
      );
      await db.query(
        `UPDATE space_objects SET updated_at=$1 WHERE id=$2 AND space_id=$3`,
        [now, definitionId, identity.spaceId],
      );
      const updated = await this.definitionRow(identity.spaceId, projectId, definitionId, identity.userId, db);
      if (!updated) throw new HttpError(500, "Failed to update Experiment Definition");
      return definitionToOut(updated);
    });
  }

  async listDefinitions(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<DefinitionRow>(
      // Same reason as Decision Cases: the root's visibility is what decides
      // who sees an Experiment now that it is an ontology object.
      `SELECT ${DEFINITION_COLUMNS} FROM ${DEFINITION_FROM}
        WHERE d.space_id=$1 AND d.project_id=$2
          AND ${contentReadSql("space_object", "so", "$3")}
        ORDER BY so.created_at DESC, d.object_id ASC`,
      [identity.spaceId, projectId, identity.userId],
    );
    return rows.rows.map(definitionToOut);
  }

  async getDefinition(identity: SpaceUserIdentity, projectId: string, definitionId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const row = await this.definitionRow(identity.spaceId, projectId, definitionId, identity.userId);
    if (!row) throw new HttpError(404, "Experiment Definition not found");
    const versions = await this.db.query<VersionRow>(
      `SELECT * FROM experiment_versions WHERE space_id=$1 AND definition_id=$2 ORDER BY version DESC`,
      [identity.spaceId, definitionId],
    );
    return { ...definitionToOut(row), versions: versions.rows.map(versionToOut) };
  }

  async createVersion(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const executorType = enumValue(body.executor_type, EXECUTOR_TYPES);
    if (!executorType) throw new HttpError(422, `executor_type must be one of ${[...EXECUTOR_TYPES].join(", ")}`);
    const config = normalizeExecutorConfig(executorType, objectValue(body.config));
    const requestedStatus = body.status === undefined ? "draft" : enumValue(body.status, VERSION_STATUSES, "status");
    if (requestedStatus !== "draft") {
      throw new HttpError(422, "New Experiment Versions start as draft and must be approved explicitly");
    }
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const definition = await this.definitionRow(identity.spaceId, projectId, definitionId, identity.userId, db);
      if (!definition) throw new HttpError(404, "Experiment Definition not found");
      if (definition.status === "completed" || definition.status === "archived") {
        throw new HttpError(409, `Cannot add a Version to a ${definition.status} Experiment`);
      }
      const projectFolderId = optionalString(config.project_folder_id);
      if (projectFolderId) {
        await assertProjectFolderInProject(db, identity.spaceId, projectId, projectFolderId);
      }
      const nextVersion = await db.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM experiment_versions WHERE space_id=$1 AND definition_id=$2`,
        [identity.spaceId, definitionId],
      );
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO experiment_versions (
           id, space_id, definition_id, version, executor_type, config_json, planned_summary, status, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $10)`,
        [id, identity.spaceId, definitionId, nextVersion.rows[0]!.next, executorType, JSON.stringify(config),
          optionalString(body.planned_summary), "draft", identity.userId, now],
      );
      const row = await db.query<VersionRow>(`SELECT * FROM experiment_versions WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
      return versionToOut(row.rows[0]!);
    });
  }

  async approveVersion(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    versionId: string,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const definition = await this.definitionRow(identity.spaceId, projectId, definitionId, identity.userId, db);
      if (!definition) throw new HttpError(404, "Experiment Definition not found");
      if (definition.status === "completed" || definition.status === "archived") {
        throw new HttpError(409, `Cannot approve a Version on a ${definition.status} Experiment`);
      }
      const current = await db.query<VersionRow>(
        `SELECT * FROM experiment_versions
          WHERE id=$1 AND space_id=$2 AND definition_id=$3
          FOR UPDATE`,
        [versionId, identity.spaceId, definitionId],
      );
      const version = current.rows[0];
      if (!version) throw new HttpError(404, "Experiment Version not found");
      if (version.status !== "draft") {
        throw new HttpError(409, `Experiment Version is already ${version.status}`);
      }
      const now = new Date().toISOString();
      const updated = await db.query<VersionRow>(
        `UPDATE experiment_versions SET status='approved', updated_at=$4
          WHERE id=$1 AND space_id=$2 AND definition_id=$3
          RETURNING *`,
        [versionId, identity.spaceId, definitionId, now],
      );
      return versionToOut(updated.rows[0]!);
    });
  }

  async listVersions(identity: SpaceUserIdentity, projectId: string, definitionId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await this.requireDefinition(identity.spaceId, projectId, definitionId, identity.userId);
    const rows = await this.db.query<VersionRow>(
      `SELECT * FROM experiment_versions WHERE space_id=$1 AND definition_id=$2 ORDER BY version DESC`,
      [identity.spaceId, definitionId],
    );
    return rows.rows.map(versionToOut);
  }

  /**
   * The single-Definition lookup. It applies the object read gate for the same
   * reason the list does: a visibility rule that holds for the list but not for
   * a direct fetch is not a rule.
   */
  private async definitionRow(
    spaceId: string,
    projectId: string,
    definitionId: string,
    viewerUserId: string,
    db: Queryable = this.db,
  ): Promise<DefinitionRow | null> {
    const result = await db.query<DefinitionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM ${DEFINITION_FROM}
        WHERE d.object_id=$1 AND d.space_id=$2 AND d.project_id=$3
          AND ${contentReadSql("space_object", "so", "$4")}`,
      [definitionId, spaceId, projectId, viewerUserId],
    );
    return result.rows[0] ?? null;
  }

  async requireDefinition(spaceId: string, projectId: string, definitionId: string, viewerUserId: string, db: Queryable = this.db): Promise<DefinitionRow> {
    const row = await this.definitionRow(spaceId, projectId, definitionId, viewerUserId, db);
    if (!row) throw new HttpError(404, "Experiment Definition not found");
    return row;
  }

  private async assertThreadInProject(db: Queryable, spaceId: string, projectId: string, threadId: string): Promise<void> {
    const thread = await db.query(
      `SELECT 1 FROM inquiry_threads
        WHERE object_id=$1 AND space_id=$2 AND project_id=$3 AND kind='hypothesis'`,
      [threadId, spaceId, projectId],
    );
    if (!thread.rows[0]) {
      throw new HttpError(422, "primary_hypothesis_thread_id must reference a Hypothesis Thread in this Project");
    }
  }
}
