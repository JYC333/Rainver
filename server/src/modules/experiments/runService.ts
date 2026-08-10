import { randomUUID } from "node:crypto";
import {
  HttpError,
  dateIso,
  numberValue,
  objectValue,
  optionalString,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { assertProjectReadable, assertProjectWriter, assertProjectFolderInProject, lockActiveProjectForMutation } from "../projects/access";
import { ExperimentDefinitionService } from "./definitionService";
import { enumValue, managedScopeViolation, stringArray } from "./common";
import { contentReadSql } from "../access/contentAccessSql";
import { PgRunRepository } from "../runs/repository";
import { PgJobQueueRepository } from "../jobs/repository";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const OBSERVATION_SOURCES = new Set(["manual", "parsed", "agent"]);

interface VersionRow {
  id: string; definition_id: string; executor_type: string; config_json: unknown; status: string;
}

interface RunRow {
  id: string; space_id: string; version_id: string; run_id: string | null;
  is_baseline: boolean; hypothesis: string | null; patch_summary: string | null; commit_ref: string | null;
  status: string; config_snapshot_json: unknown; artifact_ids_json: unknown;
  created_by_user_id: string | null; created_at: unknown; updated_at: unknown;
}

interface ObservationRow {
  id: string; run_id: string; metric_name: string; value_number: number | null; value_text: string | null;
  value_json: unknown; is_primary: boolean; source: string; recorded_by_user_id: string | null; created_at: unknown;
}

function runToOut(
  row: RunRow,
  visibleArtifactIds?: ReadonlySet<string>,
  visibleManagedRunIds?: ReadonlySet<string>,
): Record<string, unknown> {
  const artifactIds = Array.isArray(row.artifact_ids_json)
    ? row.artifact_ids_json.filter((id): id is string => typeof id === "string")
    : [];
  return {
    id: row.id,
    version_id: row.version_id,
    run_id: row.run_id && visibleManagedRunIds && !visibleManagedRunIds.has(row.run_id)
      ? null
      : row.run_id,
    is_baseline: row.is_baseline,
    hypothesis: row.hypothesis, patch_summary: row.patch_summary, commit_ref: row.commit_ref,
    status: row.status, config_snapshot: objectValue(row.config_snapshot_json),
    artifact_ids: visibleArtifactIds
      ? artifactIds.filter((id) => visibleArtifactIds.has(id))
      : artifactIds,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function observationToOut(row: ObservationRow): Record<string, unknown> {
  return {
    id: row.id, run_id: row.run_id, metric_name: row.metric_name,
    value_number: row.value_number, value_text: row.value_text, value_json: row.value_json,
    is_primary: row.is_primary, source: row.source, recorded_by_user_id: row.recorded_by_user_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Experiment Run (one execution attempt) + Observation (raw recorded data).
 * A manual-executor Run has no linked `runs` row — the human records
 * Observations directly; a managed_code_comparison Run's actual code
 * execution is launched through the normal Run/Job authority and linked here
 * via `run_id`; this service owns only the Experiment-side projection and
 * terminal reconciliation.
 */
export class ExperimentRunService {
  constructor(private readonly db: Queryable) {}

  async createRun(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    versionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const definition = await new ExperimentDefinitionService(db).requireDefinition(identity.spaceId, projectId, definitionId, identity.userId, db);
      if (definition.status === "completed" || definition.status === "archived") {
        throw new HttpError(409, `Cannot create a Run for a ${definition.status} Experiment`);
      }
      if (!definition.primary_hypothesis_thread_id) {
        throw new HttpError(409, "Link a primary Hypothesis Thread before creating the first Experiment Run");
      }
      const version = await this.versionRow(db, identity.spaceId, definitionId, versionId);
      if (!version) throw new HttpError(404, "Experiment Version not found");
      if (version.status !== "approved") {
        throw new HttpError(409, "Only an approved Experiment Version can create a Run");
      }
      const isBaseline = body.is_baseline === true;
      if (version.executor_type === "managed_code_comparison" && !isBaseline && !definition.baseline_run_id) {
        throw new HttpError(422, "A baseline Run must be created (and completed) before any other Run on this Experiment");
      }
      const config = objectValue(version.config_json);
      if (config.project_folder_id) await assertProjectFolderInProject(db, identity.spaceId, projectId, config.project_folder_id as string);
      const linkedRunId = optionalString(body.run_id);
      if (version.executor_type === "manual" && linkedRunId) {
        throw new HttpError(422, "A manual Experiment Run cannot link to a managed Run");
      }
      if (linkedRunId) {
        await this.assertManagedRunLink(
          db,
          identity.spaceId,
          identity.userId,
          projectId,
          linkedRunId,
          optionalString(config.project_folder_id),
        );
      }
      if (isBaseline) {
        const existingBaseline = await db.query<{ id: string }>(
          `SELECT r.id FROM experiment_runs r
             JOIN experiment_versions v ON v.id=r.version_id AND v.space_id=r.space_id
            WHERE r.space_id=$1 AND v.definition_id=$2 AND r.is_baseline=true
              AND r.status IN ('queued','running','completed')
            LIMIT 1`,
          [identity.spaceId, definitionId],
        );
        if (existingBaseline.rows[0]) {
          throw new HttpError(409, "This Experiment already has an active or completed baseline Run");
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO experiment_runs (
           id, space_id, version_id, run_id, is_baseline, hypothesis, patch_summary, commit_ref,
           status, config_snapshot_json, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9::jsonb, $10, $11, $11)`,
        [id, identity.spaceId, versionId, linkedRunId, isBaseline,
          optionalString(body.hypothesis), optionalString(body.patch_summary), optionalString(body.commit_ref),
          JSON.stringify(config), identity.userId, now],
      );
      const row = await this.runRow(db, identity.spaceId, id);
      if (!row) throw new HttpError(500, "Failed to create Experiment Run");
      return runToOut(row);
    });
  }

  async launchManagedRun(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    versionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const agentId = optionalString(body.agent_id);
    if (!agentId) throw new HttpError(422, "agent_id is required");
    return withQueryableTransaction(this.db, async db => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      const definition = await new ExperimentDefinitionService(db).requireDefinition(identity.spaceId, projectId, definitionId, identity.userId, db);
      if (definition.status === "completed" || definition.status === "archived") {
        throw new HttpError(409, `Cannot launch a Run for a ${definition.status} Experiment`);
      }
      if (!definition.primary_hypothesis_thread_id) {
        throw new HttpError(409, "Link a primary Hypothesis Thread before launching an Experiment Run");
      }
      const version = await this.versionRow(db, identity.spaceId, definitionId, versionId);
      if (!version) throw new HttpError(404, "Experiment Version not found");
      if (version.status !== "approved") throw new HttpError(409, "Only an approved Experiment Version can launch");
      if (version.executor_type !== "managed_code_comparison") {
        throw new HttpError(422, "Only managed_code_comparison Versions can launch governed Runs");
      }
      const isBaseline = body.is_baseline === true;
      if (!isBaseline && !definition.baseline_run_id) {
        throw new HttpError(422, "A completed baseline Run is required before a comparison Run");
      }
      const config = objectValue(version.config_json);
      const projectFolderId = optionalString(config.project_folder_id);
      if (!projectFolderId) throw new HttpError(422, "The Version has no managed Project Folder");
      if (!optionalString(config.run_command)) throw new HttpError(422, "The approved Version has no run_command");
      await assertProjectFolderInProject(db, identity.spaceId, projectId, projectFolderId);
      if (isBaseline) {
        const baseline = await db.query<{ id: string }>(
          `SELECT r.id FROM experiment_runs r JOIN experiment_versions v ON v.id=r.version_id AND v.space_id=r.space_id
            WHERE r.space_id=$1 AND v.definition_id=$2 AND r.is_baseline=true
              AND r.status IN ('queued','running','completed') LIMIT 1`,
          [identity.spaceId, definitionId],
        );
        if (baseline.rows[0]) throw new HttpError(409, "This Experiment already has a baseline Run");
      }
      const experimentRunId = randomUUID();
      const executionSnapshot = {
        ...config,
        agent_id: agentId,
        runtime_profile_id: optionalString(body.runtime_profile_id),
      };
      const managedRun = await new PgRunRepository(db).createQueuedRun({
        agent_id: agentId,
        space_id: identity.spaceId,
        user_id: identity.userId,
        mode: "live",
        run_type: "agent",
        trigger_origin: "manual",
        project_folder_id: projectFolderId,
        project_id: projectId,
        runtime_profile_id: optionalString(body.runtime_profile_id),
        runtime_profile_selection_source: optionalString(body.runtime_profile_id) ? "explicit" : "default",
        prompt: managedExperimentPrompt(executionSnapshot, optionalString(body.hypothesis)),
        instruction: "Execute the approved Experiment Version in the governed Run Sandbox and return structured metrics.",
        contract_snapshot: {
          source: { kind: "direct", id: experimentRunId },
          project_id: projectId,
          project_folder_id: projectFolderId,
          max_attempts: 3,
          max_duration_seconds: numberValue(config.timeout_seconds) ?? numberValue(config.time_budget_seconds),
          required_outputs_json: ["experiment_metrics"],
          workflow_input_json: {
            kind: "managed_experiment",
            experiment_run_id: experimentRunId,
            definition_id: definitionId,
            version_id: versionId,
            config: executionSnapshot,
          },
          policy_context_json: {
            editable_scope: config.editable_scope,
            protected_scope: config.protected_scope,
          },
        },
      });
      const now = new Date().toISOString();
      await db.query(
        `INSERT INTO experiment_runs (
           id,space_id,version_id,run_id,is_baseline,hypothesis,patch_summary,commit_ref,
           status,config_snapshot_json,created_by_user_id,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9::jsonb,$10,$11,$11)`,
        [
          experimentRunId, identity.spaceId, versionId, managedRun.id, isBaseline,
          optionalString(body.hypothesis), optionalString(body.patch_summary), optionalString(body.commit_ref),
          JSON.stringify(executionSnapshot), identity.userId, now,
        ],
      );
      await new PgJobQueueRepository(db).enqueue({
        job_type: "agent_run",
        space_id: identity.spaceId,
        user_id: identity.userId,
        agent_id: agentId,
        project_folder_id: projectFolderId,
        payload: { run_id: managedRun.id },
      });
      return runToOut((await this.runRow(db, identity.spaceId, experimentRunId))!);
    });
  }

  async reconcileManagedRun(spaceId: string, managedRunId: string): Promise<boolean> {
    return withQueryableTransaction(this.db, async db => {
      const result = await db.query<{
        experiment_run_id: string; definition_id: string; is_baseline: boolean; experiment_status: string;
        run_status: string; output_json: unknown; config_snapshot_json: unknown;
      }>(
        `SELECT er.id AS experiment_run_id,v.definition_id,er.is_baseline,er.status AS experiment_status,
                r.status AS run_status,r.output_json,er.config_snapshot_json
           FROM experiment_runs er
           JOIN experiment_versions v ON v.id=er.version_id AND v.space_id=er.space_id
           JOIN runs r ON r.id=er.run_id AND r.space_id=er.space_id
          WHERE er.space_id=$1 AND er.run_id=$2 FOR UPDATE OF er`,
        [spaceId, managedRunId],
      );
      const row = result.rows[0];
      if (!row || TERMINAL_RUN_STATUSES.has(row.experiment_status)) return false;
      if (!["succeeded", "failed", "degraded", "cancelled", "orphaned"].includes(row.run_status)) return false;
      let status = row.run_status === "succeeded"
        ? "completed"
        : row.run_status === "cancelled" ? "cancelled" : "failed";
      if (status === "completed") {
        const patches = await db.query<{ payload_json: unknown }>(
          `SELECT payload_json FROM proposals
            WHERE space_id=$1 AND created_by_run_id=$2 AND proposal_type='code_patch'`,
          [spaceId, managedRunId],
        );
        const changedPaths = patches.rows.flatMap(proposal => {
          const operations = objectValue(objectValue(proposal.payload_json).patch).operations;
          return Array.isArray(operations)
            ? operations.flatMap(operation => {
              const path = optionalString(objectValue(operation).path);
              return path ? [path] : [];
            })
            : [];
        });
        const config = objectValue(row.config_snapshot_json);
        const violation = managedScopeViolation(
          changedPaths,
          stringArray(config.editable_scope),
          stringArray(config.protected_scope),
        );
        if (violation) status = "failed";
      }
      const artifacts = await db.query<{ id: string }>(
        `SELECT id FROM artifacts WHERE space_id=$1 AND run_id=$2 ORDER BY created_at,id`,
        [spaceId, managedRunId],
      );
      const now = new Date().toISOString();
      await db.query(
        `UPDATE experiment_runs SET status=$3,artifact_ids_json=$4::jsonb,updated_at=$5
          WHERE id=$1 AND space_id=$2`,
        [row.experiment_run_id, spaceId, status, JSON.stringify(artifacts.rows.map(item => item.id)), now],
      );
      if (status === "completed") {
        const observations = parsedManagedObservations(row.output_json, objectValue(row.config_snapshot_json).metric_parser);
        for (const observation of observations) {
          await db.query(
            `INSERT INTO experiment_observations (
               id,space_id,run_id,metric_name,value_number,value_text,value_json,is_primary,source,created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'parsed',$9)`,
            [
              randomUUID(), spaceId, row.experiment_run_id, observation.metric_name,
              observation.value_number, observation.value_text,
              observation.value_json === null ? null : JSON.stringify(observation.value_json),
              observation.is_primary, now,
            ],
          );
        }
        if (row.is_baseline) {
          await db.query(
            `WITH d AS (
               UPDATE experiment_definitions SET baseline_run_id=$3
                WHERE object_id=$1 AND space_id=$2
             )
             UPDATE space_objects SET updated_at=$4 WHERE id=$1 AND space_id=$2`,
            [row.definition_id, spaceId, row.experiment_run_id, now],
          );
        }
      }
      return true;
    });
  }

  async listRuns(identity: SpaceUserIdentity, projectId: string, definitionId: string, versionId?: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await new ExperimentDefinitionService(this.db).requireDefinition(identity.spaceId, projectId, definitionId, identity.userId);
    const params: unknown[] = [identity.spaceId, definitionId];
    let clause = "";
    if (versionId) {
      params.push(versionId);
      clause = " AND r.version_id = $3";
    }
    const rows = await this.db.query<RunRow>(
      `SELECT r.* FROM experiment_runs r
         JOIN experiment_versions v ON v.id = r.version_id AND v.space_id = r.space_id
        WHERE r.space_id = $1 AND v.definition_id = $2${clause}
        ORDER BY r.created_at DESC, r.id ASC`,
      params,
    );
    const [visibleArtifactIds, visibleManagedRunIds] = await Promise.all([
      this.visibleArtifactIds(identity, rows.rows),
      this.visibleManagedRunIds(identity, rows.rows),
    ]);
    return rows.rows.map((row) =>
      runToOut(row, visibleArtifactIds, visibleManagedRunIds));
  }

  /**
   * Terminal update for a Run: final status, recorded Observations, and
   * optionally naming it the Experiment's baseline/best Run — the
   * `decideRun`-equivalent step, minus the "keep/discard/crash" vocabulary
   * (a Run's technical outcome and its interpreted verdict are no longer
   * conflated; see interpretationService.ts for the verdict).
   */
  async completeRun(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    runId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const status = enumValue(body.status, TERMINAL_RUN_STATUSES, "status");
    if (!status) throw new HttpError(422, `status must be one of ${[...TERMINAL_RUN_STATUSES].join(", ")}`);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await new ExperimentDefinitionService(db).requireDefinition(identity.spaceId, projectId, definitionId, identity.userId, db);
      const run = await this.runRowForDefinition(db, identity.spaceId, definitionId, runId);
      if (!run) throw new HttpError(404, "Experiment Run not found");
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new HttpError(409, `Experiment Run is already ${run.status}`);
      }
      const artifactIds = [...new Set(stringArray(body.artifact_ids))];
      await this.assertArtifactsBelongToRun(
        db,
        identity.spaceId,
        identity.userId,
        projectId,
        run.run_id,
        artifactIds,
      );
      const now = new Date().toISOString();
      await db.query(
        `UPDATE experiment_runs SET status=$3, artifact_ids_json=$4::jsonb, updated_at=$5 WHERE id=$1 AND space_id=$2`,
        [runId, identity.spaceId, status, JSON.stringify(artifactIds), now],
      );
      const observations = Array.isArray(body.observations) ? body.observations : [];
      for (const raw of observations) {
        await this.insertObservation(db, identity, runId, objectValue(raw));
      }
      if (status === "completed") {
        if (run.is_baseline) {
          await db.query(`WITH d AS (UPDATE experiment_definitions SET baseline_run_id=$3 WHERE object_id=$1 AND space_id=$2)
             UPDATE space_objects SET updated_at=$4 WHERE id=$1 AND space_id=$2`, [definitionId, identity.spaceId, runId, now]);
        }
        if (body.mark_as_best === true) {
          await db.query(`WITH d AS (UPDATE experiment_definitions SET best_run_id=$3 WHERE object_id=$1 AND space_id=$2)
             UPDATE space_objects SET updated_at=$4 WHERE id=$1 AND space_id=$2`, [definitionId, identity.spaceId, runId, now]);
        }
      }
      const updated = await this.runRow(db, identity.spaceId, runId);
      if (!updated) throw new HttpError(500, "Failed to complete Experiment Run");
      return { ...runToOut(updated), observations: (await this.observationsFor(db, identity.spaceId, runId)).map(observationToOut) };
    });
  }

  async recordObservation(
    identity: SpaceUserIdentity,
    projectId: string,
    definitionId: string,
    runId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    return withQueryableTransaction(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await new ExperimentDefinitionService(db).requireDefinition(identity.spaceId, projectId, definitionId, identity.userId, db);
      const run = await this.runRowForDefinition(db, identity.spaceId, definitionId, runId);
      if (!run) throw new HttpError(404, "Experiment Run not found");
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new HttpError(409, `Experiment Run is already ${run.status}`);
      }
      return observationToOut(await this.insertObservation(db, identity, runId, body));
    });
  }

  async listObservations(identity: SpaceUserIdentity, projectId: string, definitionId: string, runId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    await new ExperimentDefinitionService(this.db).requireDefinition(identity.spaceId, projectId, definitionId, identity.userId);
    const run = await this.runRowForDefinition(this.db, identity.spaceId, definitionId, runId);
    if (!run) throw new HttpError(404, "Experiment Run not found");
    return (await this.observationsFor(this.db, identity.spaceId, runId)).map(observationToOut);
  }

  private async insertObservation(db: Queryable, identity: SpaceUserIdentity, runId: string, body: Record<string, unknown>): Promise<ObservationRow> {
    const metricName = typeof body.metric_name === "string" && body.metric_name.trim() ? body.metric_name.trim() : null;
    if (!metricName) throw new HttpError(422, "metric_name is required");
    const valueNumber = numberValue(body.value_number);
    const valueText = optionalString(body.value_text);
    const valueJson = body.value_json !== undefined && body.value_json !== null ? body.value_json : null;
    if (valueNumber === null && valueText === null && valueJson === null) {
      throw new HttpError(422, "one of value_number, value_text, or value_json is required");
    }
    const source = enumValue(body.source, OBSERVATION_SOURCES, "source") ?? "manual";
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO experiment_observations (
         id, space_id, run_id, metric_name, value_number, value_text, value_json, is_primary, source, recorded_by_user_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      [id, identity.spaceId, runId, metricName, valueNumber, valueText, valueJson === null ? null : JSON.stringify(valueJson),
        body.is_primary === true, source, identity.userId, now],
    );
    const row = await db.query<ObservationRow>(`SELECT * FROM experiment_observations WHERE id=$1 AND space_id=$2`, [id, identity.spaceId]);
    return row.rows[0]!;
  }

  private async observationsFor(db: Queryable, spaceId: string, runId: string): Promise<ObservationRow[]> {
    const rows = await db.query<ObservationRow>(
      `SELECT * FROM experiment_observations WHERE space_id=$1 AND run_id=$2 ORDER BY created_at ASC`,
      [spaceId, runId],
    );
    return rows.rows;
  }

  private async versionRow(db: Queryable, spaceId: string, definitionId: string, versionId: string): Promise<VersionRow | null> {
    const result = await db.query<VersionRow>(
      `SELECT id, definition_id, executor_type, config_json, status FROM experiment_versions WHERE id=$1 AND space_id=$2 AND definition_id=$3`,
      [versionId, spaceId, definitionId],
    );
    return result.rows[0] ?? null;
  }

  private async runRow(db: Queryable, spaceId: string, runId: string): Promise<RunRow | null> {
    const result = await db.query<RunRow>(`SELECT * FROM experiment_runs WHERE id=$1 AND space_id=$2`, [runId, spaceId]);
    return result.rows[0] ?? null;
  }

  private async runRowForDefinition(db: Queryable, spaceId: string, definitionId: string, runId: string): Promise<RunRow | null> {
    const result = await db.query<RunRow>(
      `SELECT r.* FROM experiment_runs r
         JOIN experiment_versions v ON v.id = r.version_id AND v.space_id = r.space_id
        WHERE r.id=$1 AND r.space_id=$2 AND v.definition_id=$3`,
      [runId, spaceId, definitionId],
    );
    return result.rows[0] ?? null;
  }

  private async assertManagedRunLink(
    db: Queryable,
    spaceId: string,
    userId: string,
    projectId: string,
    runId: string,
    projectFolderId: string | null,
  ): Promise<void> {
    const result = await db.query<{ project_folder_id: string | null }>(
      `SELECT r.project_folder_id FROM runs r
        WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3
          AND ${contentReadSql("run", "r", "$4")}`,
      [runId, spaceId, projectId, userId],
    );
    const run = result.rows[0];
    if (!run) throw new HttpError(422, "run_id must reference a managed Run in this Project");
    if (projectFolderId && run.project_folder_id !== projectFolderId) {
      throw new HttpError(422, "run_id must reference a managed Run for the Experiment Version's Project Folder");
    }
  }

  private async assertArtifactsBelongToRun(
    db: Queryable,
    spaceId: string,
    userId: string,
    projectId: string,
    linkedRunId: string | null,
    artifactIds: string[],
  ): Promise<void> {
    if (artifactIds.length === 0) return;
    const result = await db.query<{ id: string }>(
      `SELECT a.id FROM artifacts a
        WHERE a.space_id=$1 AND a.project_id=$2 AND a.id=ANY($3::varchar[])
          AND ($4::varchar IS NULL OR a.run_id=$4)
          AND ${contentReadSql("artifact", "a", "$5")}`,
      [spaceId, projectId, artifactIds, linkedRunId, userId],
    );
    if (result.rows.length !== artifactIds.length) {
      throw new HttpError(
        422,
        linkedRunId
          ? "artifact_ids must reference artifacts produced by the linked managed Run in this Project"
          : "artifact_ids must reference artifacts in this Project",
      );
    }
  }

  private async visibleArtifactIds(
    identity: SpaceUserIdentity,
    runs: RunRow[],
  ): Promise<Set<string>> {
    const artifactIds = [...new Set(
      runs.flatMap((run) =>
        Array.isArray(run.artifact_ids_json)
          ? run.artifact_ids_json.filter((id): id is string => typeof id === "string")
          : []),
    )];
    if (artifactIds.length === 0) return new Set();
    const result = await this.db.query<{ id: string }>(
      `SELECT a.id FROM artifacts a
        WHERE a.space_id=$1 AND a.id=ANY($2::varchar[])
          AND ${contentReadSql("artifact", "a", "$3")}`,
      [identity.spaceId, artifactIds, identity.userId],
    );
    return new Set(result.rows.map((row) => row.id));
  }

  private async visibleManagedRunIds(
    identity: SpaceUserIdentity,
    experimentRuns: RunRow[],
  ): Promise<Set<string>> {
    const runIds = [...new Set(
      experimentRuns
        .map((run) => run.run_id)
        .filter((id): id is string => typeof id === "string"),
    )];
    if (runIds.length === 0) return new Set();
    const result = await this.db.query<{ id: string }>(
      `SELECT r.id FROM runs r
        WHERE r.space_id=$1 AND r.id=ANY($2::varchar[])
          AND ${contentReadSql("run", "r", "$3")}`,
      [identity.spaceId, runIds, identity.userId],
    );
    return new Set(result.rows.map((row) => row.id));
  }
}

function managedExperimentPrompt(config: Record<string, unknown>, hypothesis: string | null): string {
  return [
    "Run one approved managed code comparison.",
    `Hypothesis: ${hypothesis ?? "baseline measurement"}`,
    `Editable scope: ${JSON.stringify(config.editable_scope ?? [])}`,
    `Protected scope: ${JSON.stringify(config.protected_scope ?? [])}`,
    `Setup commands: ${JSON.stringify(config.setup_commands ?? [])}`,
    `Run command: ${String(config.run_command ?? "")}`,
    "Respect the Run Sandbox and credential policy. Return experiment_metrics as JSON.",
  ].join("\n");
}

function parsedManagedObservations(
  output: unknown,
  parserValue: unknown,
): Array<{ metric_name: string; value_number: number | null; value_text: string | null; value_json: unknown; is_primary: boolean }> {
  const parser = objectValue(parserValue);
  const configuredName = optionalString(parser.metric_name);
  const outputValue = objectValue(output);
  const metrics = objectValue(outputValue.experiment_metrics);
  const rows: Array<{ metric_name: string; value_number: number | null; value_text: string | null; value_json: unknown; is_primary: boolean }> = [];
  for (const [name, value] of Object.entries(metrics)) {
    rows.push({
      metric_name: name,
      value_number: typeof value === "number" && Number.isFinite(value) ? value : null,
      value_text: typeof value === "string" ? value : null,
      value_json: typeof value === "number" || typeof value === "string" ? null : value,
      is_primary: configuredName ? name === configuredName : rows.length === 0,
    });
  }
  return rows;
}
