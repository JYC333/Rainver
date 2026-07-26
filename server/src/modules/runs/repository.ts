import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { withDedicatedSessionAdvisoryLock } from "../../db/advisoryLock";
import {
  redactEvidenceText,
  sanitizeErrorJson,
  sanitizeEvidenceJson,
} from "./evidenceRedaction";
import { assertProjectInSpace } from "../projects/access";
import { contentReadSql, projectReadAccessSql } from "../access/contentAccessSql";
import { contentDecisionFromDb } from "../access/contentAccessQuery";
import {
  addOptionalFilter,
  extractErrorMessage,
  recordValue,
  validateRunCreateInput,
} from "./runRepositoryHelpers";
import {
  type ArtifactSummaryRecord,
  type ContextSnapshotRecord,
  type ModelProviderSummaryRecord,
  type ProposalSummaryRecord,
  type Queryable,
  type DelegatedChildRunCreateInput,
  RunCreateValidationError,
  type RunChatResultRecord,
  type RunCreateInput,
  type RunEvaluationRecord,
  type RunEventDetailRecord,
  type RunEventInput,
  type RunEventPage,
  type RunEventPageFilters,
  type RunEventRecord,
  type RunFinalizationRecord,
  type RunListFilters,
  type RunRecord,
  type RunAttemptRecord,
  type RuntimeProfileSelectionSource,
  type RunStepDetailRecord,
  type RunStepInput,
  type RunStepRecord,
  type RunTerminalUpdate,
  type ConversationRuntimeTerminalSync,
} from "./runRepositoryTypes";
import {
  taskChecklistFromRunEvaluation,
  taskConfidenceForOutcome,
  taskKnownIssuesFromRunEvaluation,
  taskRecommendationForOutcome,
  taskScoreForOutcome,
  taskSummaryFromRunEvaluation,
} from "./taskEvaluationProjection";
import {
  createRunContractSnapshot,
  type RunContractSnapshotInput,
} from "./contractSnapshot";
import { assertBudgetSourcesAvailable, checkRunBudget } from "./budgetEnforcement";
import { withQueryableTransaction } from "../routeUtils/common";
import type { VerificationResultRecord } from "./verification/types";
import { PgUsageRepository } from "../usage/repository";
import { buildRunToolGrants } from "../systemActions/runToolGrants";

export {
  RunCreateValidationError,
  type ArtifactSummaryRecord,
  type ContextSnapshotRecord,
  type ModelProviderSummaryRecord,
  type ProposalSummaryRecord,
  type QueryResult,
  type Queryable,
  type DelegatedChildRunCreateInput,
  type RunChatResultRecord,
  type RunCreateInput,
  type RunEvaluationRecord,
  type RunEventDetailRecord,
  type RunEventInput,
  type RunEventPage,
  type RunEventPageFilters,
  type RunEventRecord,
  type RunFinalizationRecord,
  type RunListFilters,
  type RunRecord,
  type RunAttemptRecord,
  type RunStepDetailRecord,
  type RunStepInput,
  type RunStepRecord,
  type RunTerminalUpdate,
  type ConversationRuntimeTerminalSync,
} from "./runRepositoryTypes";

export type { VerificationResultRecord } from "./verification/types";

interface RuntimeProfileForRun {
  id: string;
  space_id: string;
  agent_id: string;
  name: string;
  adapter_type: string;
  model_provider_id: string | null;
  model_name: string | null;
  runtime_config_json: unknown;
  runtime_policy_json: unknown;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export class PgRunRepository {
  private readonly usageRepository: PgUsageRepository;

  constructor(private readonly db: Queryable) {
    this.usageRepository = new PgUsageRepository(db);
  }

  private async withRunUsage(run: RunRecord): Promise<RunRecord> {
    return {
      ...run,
      usage: await this.usageRepository.summarizeRunUsage(run.space_id, run.project_id, [run.id]),
    };
  }

  private async withRunsUsage(runs: RunRecord[]): Promise<RunRecord[]> {
    const summaries = await this.usageRepository.summarizeRunUsageByRunIds(
      runs[0]?.space_id ?? "",
      runs.map((run) => run.id),
    );
    return runs.map((run) => ({ ...run, usage: summaries.get(run.id) ?? null }));
  }

  static fromConfig(config: ServerConfig): PgRunRepository {
    if (!config.databaseUrl) {
      throw new Error("Run repository requires SERVER_DATABASE_URL");
    }
    return new PgRunRepository(getDbPool(config.databaseUrl));
  }

  async recoverStaleRuns(staleAfterSeconds = 3600, now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - Math.max(1, staleAfterSeconds) * 1000,
    ).toISOString();
    const completedAt = now.toISOString();
    const errorMessage = "Run became orphaned after the server lost its execution registry";
    const errorJson = sanitizeErrorJson({
      error_code: "orphaned",
      error_text: "Run was still running after the server lost its execution registry",
    });
    const result = await this.db.query<{ id: string }>(
      `WITH orphaned_runs AS (
         UPDATE runs
            SET status = 'orphaned',
              error_message = $3,
              error_json = $4::jsonb,
              ended_at = $2,
              updated_at = $2
          WHERE status IN ('running', 'cancelling')
          AND started_at IS NOT NULL
          AND started_at < $1
          RETURNING id, space_id
       ), updated_attempts AS (
         UPDATE run_attempts a
            SET status = 'orphaned',
                error_code = 'orphaned',
                error_json = $4::jsonb,
                ended_at = $2,
                last_activity_at = $2,
                updated_at = $2
           FROM orphaned_runs r
          WHERE a.space_id = r.space_id
            AND a.run_id = r.id
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = r.space_id AND candidate.run_id = r.id
            )
       ), rejected_run_proposals AS (
         UPDATE proposals proposal
            SET status = 'rejected',
                updated_at = $2
           FROM orphaned_runs run
          WHERE proposal.space_id = run.space_id
            AND proposal.created_by_run_id = run.id
            AND proposal.status IN ('staged', 'pending')
       ), released_execution_locks AS (
         DELETE FROM run_execution_locks execution_lock
          USING orphaned_runs run
          WHERE execution_lock.run_id = run.id
       )
       SELECT id FROM orphaned_runs`,
      [
        cutoff,
        completedAt,
        redactEvidenceText(errorMessage),
        JSON.stringify(errorJson),
      ],
    );
    return result.rowCount ?? result.rows.length;
  }

  async listOrphanedRunIds(limit = 100): Promise<Array<{ id: string; space_id: string }>> {
    const result = await this.db.query<{ id: string; space_id: string }>(
      `SELECT id, space_id
         FROM runs
        WHERE status = 'orphaned'
          AND error_json->>'error_code' = 'orphaned'
        ORDER BY updated_at ASC, id ASC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows;
  }

  async listTerminalChatRunsAwaitingCompletion(
    limit = 100,
  ): Promise<Array<{ id: string; space_id: string }>> {
    const result = await this.db.query<{ id: string; space_id: string }>(
      `SELECT r.id, r.space_id
         FROM runs r
        WHERE r.status IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
          AND r.model_override_json->'chat_turn'->>'schema_version' = 'chat_turn.v1'
          AND NOT EXISTS (
            SELECT 1
              FROM run_events event
             WHERE event.space_id = r.space_id
               AND event.run_id = r.id
               AND event.event_type = 'chat_completed'
          )
        ORDER BY r.updated_at ASC, r.id ASC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows;
  }

  async createQueuedRun(input: RunCreateInput): Promise<RunRecord> {
    validateRunCreateInput(input);
    return this.createQueuedRunInternal(input);
  }

  async createCoordinatorRun(input: RunCreateInput): Promise<RunRecord> {
    validateRunCreateInput(input);
    return this.createQueuedRunInternal(input, { run_role: "coordinator" });
  }

  /**
   * Public admission path for callers that create a logical Run directly.
   * The budget lock, source validation, context snapshot, Run row, and first
   * attempt are committed as one unit so a rejected admission cannot return a
   * queued Run that will only fail later in dispatch.
   */
  async createQueuedRunWithBudgetAdmission(input: RunCreateInput): Promise<RunRecord> {
    validateRunCreateInput(input);
    return withQueryableTransaction(this.db, async (db) => {
      const contractSnapshot = createRunContractSnapshot(
        input.contract_snapshot,
        new Date().toISOString(),
      );
      await assertBudgetSourcesAvailable(db, input.space_id, contractSnapshot.budget_sources);
      return new PgRunRepository(db).createQueuedRun(input);
    });
  }

  async createDelegatedChildRun(input: DelegatedChildRunCreateInput): Promise<RunRecord> {
    if (!input.parent_run_id || !input.root_run_id || !input.run_group_id || !input.delegation_id) {
      throw new RunCreateValidationError("Delegated child runs require parent, root, group, and delegation ids");
    }
    if (!input.instructed_by_agent_id) {
      throw new RunCreateValidationError("Delegated child runs require instructed_by_agent_id");
    }
    return this.createQueuedRunInternal(
      {
        agent_id: input.agent_id,
        space_id: input.space_id,
        user_id: input.user_id,
        mode: "live",
        run_type: "agent",
        trigger_origin: "delegation",
        session_id: input.session_id ?? null,
        project_folder_id: input.project_folder_id ?? null,
        project_id: input.project_id ?? null,
        prompt: input.prompt ?? null,
        instruction: input.instruction ?? null,
        scheduled_at: input.scheduled_at ?? null,
        parent_run_id: input.parent_run_id,
        runtime_profile_id: input.runtime_profile_id ?? null,
        runtime_profile_selection_source: input.runtime_profile_selection_source ?? "default",
        capability_id: input.capability_id ?? null,
        capabilities_json: input.capabilities_json ?? null,
        model_override_json: input.model_override_json ?? null,
        context_artifact_ids: input.context_artifact_ids ?? null,
        visibility: input.visibility,
        grantee_user_ids: input.grantee_user_ids,
      },
      {
        root_run_id: input.root_run_id,
        run_group_id: input.run_group_id,
        delegation_id: input.delegation_id,
        instructed_by_agent_id: input.instructed_by_agent_id,
        budget_json: input.budget_json ?? null,
        context_policy_json: input.context_policy_json ?? null,
      },
    );
  }

  async createGroupedAgentRun(input: {
    agent_id: string;
    space_id: string;
    user_id: string;
    parent_run_id: string;
    root_run_id: string;
    run_group_id: string;
    project_folder_id?: string | null;
    session_id?: string | null;
    project_id?: string | null;
    prompt: string;
    instruction?: string | null;
    runtime_profile_id?: string | null;
    model_override_json?: Record<string, unknown> | null;
    contract_snapshot?: RunContractSnapshotInput;
    budget_json?: Record<string, unknown> | null;
    context_policy_json?: Record<string, unknown> | null;
    visibility?: "private" | "space_shared" | "selected_users";
    grantee_user_ids?: string[];
  }): Promise<RunRecord> {
    if (!input.parent_run_id || !input.root_run_id || !input.run_group_id) {
      throw new RunCreateValidationError("Grouped agent runs require parent, root, and group ids");
    }
    return this.createQueuedRunInternal(
      {
        agent_id: input.agent_id,
        space_id: input.space_id,
        user_id: input.user_id,
        mode: "live",
        run_type: "agent",
        trigger_origin: "manual",
        session_id: input.session_id ?? null,
        project_folder_id: input.project_folder_id ?? null,
        project_id: input.project_id ?? null,
        prompt: input.prompt,
        instruction: input.instruction ?? null,
        parent_run_id: input.parent_run_id,
        runtime_profile_id: input.runtime_profile_id ?? null,
        model_override_json: input.model_override_json ?? null,
        contract_snapshot: input.contract_snapshot,
        visibility: input.visibility,
        grantee_user_ids: input.grantee_user_ids,
      },
      {
        root_run_id: input.root_run_id,
        run_group_id: input.run_group_id,
        budget_json: input.budget_json ?? null,
        context_policy_json: input.context_policy_json ?? null,
      },
    );
  }

  async linkRunToGroupRoot(input: {
    space_id: string;
    run_id: string;
    run_group_id: string;
    updated_at?: string;
  }): Promise<RunRecord | null> {
    const now = input.updated_at ?? new Date().toISOString();
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
       UPDATE runs
          SET root_run_id = id,
              run_group_id = $3,
              updated_at = $4::timestamptz
        WHERE space_id = $1 AND id = $2
        RETURNING id, space_id, agent_id, agent_version_id, runtime_profile_id,
                  context_snapshot_id, run_type, status, mode, prompt, instruction,
                  project_folder_id, session_id, parent_run_id, root_run_id, run_group_id,
                  delegation_id, project_id, scheduled_at, adapter_type, capability_id,
                  capabilities_json, model_provider_id, model_override_json,
                  runtime_profile_snapshot_json, required_sandbox_level, contract_snapshot_json, workflow_version_id, trigger_origin,
                  instructed_by_user_id, instructed_by_agent_id, error_message, error_json,
                  output_json, started_at, ended_at, created_at, updated_at,
                  visibility
     )
     SELECT * FROM updated`,
      [input.space_id, input.run_id, input.run_group_id, now],
    );
    return result.rows[0] ?? null;
  }

  private async createQueuedRunInternal(
    input: RunCreateInput,
    links: {
      root_run_id?: string | null;
      run_group_id?: string | null;
      delegation_id?: string | null;
      instructed_by_agent_id?: string | null;
      budget_json?: Record<string, unknown> | null;
      context_policy_json?: Record<string, unknown> | null;
      run_role?: "execution" | "coordinator";
    } = {},
  ): Promise<RunRecord> {
    const isCoordinator = links.run_role === "coordinator";
    const agent = await this.getAgentForRun(input.space_id, input.agent_id);
    if (!agent) {
      throw new RunCreateValidationError(
        `Agent '${input.agent_id}' not found in this space`,
        404,
      );
    }
    if (agent.status !== "active") {
      throw new RunCreateValidationError(
        `Agent '${input.agent_id}' is not active`,
        409,
      );
    }
    if (!agent.current_version_id) {
      throw new RunCreateValidationError(
        `Agent '${input.agent_id}' has no current version. Create an AgentVersion first.`,
        400,
      );
    }
    const agentVersion = await this.getAgentVersionForRun(
      input.space_id,
      input.agent_id,
      agent.current_version_id,
    );
    if (!agentVersion) {
      throw new RunCreateValidationError(
        `AgentVersion '${agent.current_version_id}' does not belong to Agent '${input.agent_id}'`,
        400,
      );
    }
    await this.assertOptionalSpaceRef("project_folders", input.project_folder_id, input.space_id, "Project Folder");
    await this.assertOptionalSpaceRef("sessions", input.session_id, input.space_id, "Session");
    await this.assertOptionalSpaceRef("projects", input.project_id, input.space_id, "Project");
    if (input.parent_run_id) {
      const parent = await this.getRun(input.space_id, input.parent_run_id);
      if (!parent) {
        throw new RunCreateValidationError(
          `Parent run '${input.parent_run_id}' not found`,
          404,
        );
      }
    }
    const requestedRuntimeProfile = input.runtime_profile_id
      ? await this.requireRuntimeProfileForRun(
          input.space_id,
          input.agent_id,
          input.runtime_profile_id,
        )
      : null;
    const runtimeProfileSelectionSource: RuntimeProfileSelectionSource =
      input.runtime_profile_selection_source
      ?? (input.runtime_profile_id ? "explicit" : "default");
    // Requested route state is immutable. The router is the sole authority
    // that stamps selected runtime, adapter, provider, and route decision.
    const resolved = { adapterType: null, modelProviderId: null, modelName: null, source: "unrouted" };
    const requiredSandboxLevel = "none";

    const now = new Date().toISOString();
    const contractSnapshot = createRunContractSnapshot(input.contract_snapshot, now);
    const contextSnapshotId = randomUUID();
    const capabilitiesJson = normalizeRunCapabilitiesJson(input.capabilities_json);
    const toolGrants = await buildRunToolGrants(
      capabilitiesJson,
      agentVersion.tool_permissions_json,
    );
    const permissionSnapshotJson = JSON.stringify({ tool_grants: toolGrants });
    const contextArtifactIds = normalizeContextArtifactIds(input.context_artifact_ids);
    await this.db.query(
      `INSERT INTO context_snapshots (
          id, space_id, source_refs_json, compiled_summary, token_estimate,
          agent_id, session_id, request_json, created_at
       )
       VALUES ($1, $2, '[]'::jsonb, NULL, NULL, $3, $4, $5::jsonb, $6)`,
      [
        contextSnapshotId,
        input.space_id,
        input.agent_id,
        input.session_id ?? null,
        JSON.stringify({
          space_id: input.space_id,
          user_id: input.user_id,
          agent_version_id: agent.current_version_id,
          runtime_profile_id: requestedRuntimeProfile?.id ?? null,
          session_id: input.session_id ?? null,
          project_folder_id: input.project_folder_id ?? null,
          project_id: input.project_id ?? null,
          root_run_id: links.root_run_id ?? input.root_run_id ?? null,
          run_group_id: links.run_group_id ?? null,
          delegation_id: links.delegation_id ?? null,
          instructed_by_agent_id: links.instructed_by_agent_id ?? null,
          budget_json: links.budget_json ?? null,
          context_policy_json: links.context_policy_json ?? null,
          user_message: input.prompt ?? input.instruction ?? null,
          manual_context: [],
          context_artifact_ids: contextArtifactIds,
          capabilities_json: capabilitiesJson,
        }),
        now,
      ],
    );

    const runId = randomUUID();
    const modelOverride = {
      ...(input.model_override_json ?? {}),
      ...(resolved.modelName || resolved.modelProviderId
        ? { model: resolved.modelName, source: resolved.source }
        : {}),
    };
    const modelOverrideJson = Object.keys(modelOverride).length > 0
      ? JSON.stringify(modelOverride)
      : null;
    const runtimeProfileSnapshotJson = null;
    const result = await this.db.query<RunRecord>(
      `INSERT INTO runs (
          id, space_id, agent_id, agent_version_id, run_role,
          requested_runtime_profile_id, runtime_profile_id,
          context_snapshot_id,
          project_folder_id, session_id, parent_run_id, root_run_id, run_group_id,
          delegation_id, instructed_by_user_id, instructed_by_agent_id,
          run_type, trigger_origin, status, mode, prompt, instruction,
          scheduled_at, created_at, updated_at, adapter_type, capability_id,
                  capabilities_json, model_provider_id, model_override_json, runtime_profile_snapshot_json,
                  required_sandbox_level, owner_user_id, visibility, access_level, project_id,
                  contract_snapshot_json, workflow_version_id, source, runtime_profile_selection_source,
                  permission_snapshot_json
       )
       VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, 'queued', $19, $20, $21, $22, $23, $23,
          $24, $25, $26::jsonb, $27, $28::jsonb, $29::jsonb, $30,
          $15, $31, $32, $33, $34::jsonb, $35, 'managed', $36,
          $37::jsonb
       )
       RETURNING id, space_id, agent_id, agent_version_id, run_role,
                 requested_runtime_profile_id, runtime_profile_id,
                 context_snapshot_id,
                 run_type, status, mode, prompt, instruction, project_folder_id,
                 session_id, parent_run_id, root_run_id, run_group_id,
                 delegation_id, project_id, scheduled_at,
                 adapter_type, capability_id, capabilities_json, model_provider_id,
                 model_override_json, runtime_profile_snapshot_json,
                 required_sandbox_level, trigger_origin,
                 instructed_by_user_id, instructed_by_agent_id, error_message,
                 error_json, output_json,
                 started_at, ended_at, created_at, updated_at,
                 owner_user_id, visibility, access_level, contract_snapshot_json,
                 workflow_version_id, route_decision_id, runtime_profile_selection_source,
                 permission_snapshot_json`,
      [
        runId,
        input.space_id,
        input.agent_id,
        agent.current_version_id,
        links.run_role ?? "execution",
        input.runtime_profile_id ?? null,
        null,
        contextSnapshotId,
        input.project_folder_id ?? null,
        input.session_id ?? null,
        input.parent_run_id ?? null,
        links.root_run_id ?? input.root_run_id ?? null,
        links.run_group_id ?? null,
        links.delegation_id ?? null,
        input.user_id,
        links.instructed_by_agent_id ?? null,
        input.run_type,
        input.trigger_origin,
        input.mode,
        input.prompt ?? null,
        input.instruction ?? null,
        input.scheduled_at ?? null,
        now,
        resolved.adapterType,
        input.capability_id ?? null,
        JSON.stringify(capabilitiesJson),
        resolved.modelProviderId,
        modelOverrideJson,
        runtimeProfileSnapshotJson,
        requiredSandboxLevel,
        input.visibility
          ?? (agent.visibility === "space_shared" ? "space_shared" : "private"),
        agent.access_level,
        input.project_id ?? null,
        JSON.stringify(contractSnapshot),
        input.workflow_version_id ?? null,
        runtimeProfileSelectionSource,
        permissionSnapshotJson,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Run insert returned no row");
    if (input.visibility === "selected_users") {
      const granteeUserIds = [...new Set(input.grantee_user_ids ?? [])];
      if (granteeUserIds.length === 0) {
        throw new RunCreateValidationError(
          "selected_users Run visibility requires at least one grantee",
        );
      }
      await this.db.query(
        `INSERT INTO content_access_grants (
           id, space_id, resource_type, resource_id, grantee_user_id,
           granted_by_user_id, access_level, created_at, updated_at,
           revoked_at, revoked_by_user_id
         )
         SELECT gen_random_uuid()::varchar, $1, 'run', $2, grantee.user_id,
                $3, 'full', $5, $5, NULL, NULL
           FROM unnest($4::varchar[]) AS grantee(user_id)
           JOIN space_memberships membership
             ON membership.space_id = $1
            AND membership.user_id = grantee.user_id
            AND membership.status = 'active'
         ON CONFLICT (space_id, resource_type, resource_id, grantee_user_id)
         DO NOTHING`,
        [input.space_id, row.id, input.user_id, granteeUserIds, now],
      );
    }
    if (!isCoordinator) {
      await this.db.query(
        `INSERT INTO run_attempts (
           id, space_id, run_id, attempt_number, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, 1, 'queued', $4, $4)
         ON CONFLICT (space_id, run_id, attempt_number) DO NOTHING`,
        [randomUUID(), input.space_id, row.id, now],
      );
    }
    await this.db.query(
      `UPDATE context_snapshots SET run_id = $3 WHERE space_id = $1 AND id = $2`,
      [input.space_id, contextSnapshotId, row.id],
    );
    return row;
  }

  async createRunningSystemRun(input: {
    space_id: string;
    user_id: string;
    agent_id: string;
    project_folder_id?: string | null;
    project_id?: string | null;
    prompt?: string | null;
    instruction?: string | null;
    trigger_origin: "automation" | "job" | "system";
    capability_id?: string | null;
    capabilities_json?: unknown[] | null;
    contract_snapshot?: RunContractSnapshotInput;
    workflow_version_id?: string | null;
    source?: "managed" | "scheduled" | "webhook" | "manual_import" | "remote_import" | "ide_assist" | null;
    started_at?: string | null;
  }): Promise<RunRecord> {
    validateRunCreateInput({
      agent_id: input.agent_id,
      space_id: input.space_id,
      user_id: input.user_id,
      mode: "live",
      run_type: "system",
      trigger_origin: input.trigger_origin,
    });
    const agent = await this.getAgentForRun(input.space_id, input.agent_id);
    if (!agent) {
      throw new RunCreateValidationError(
        `Agent '${input.agent_id}' not found in this space`,
        404,
      );
    }
    if (agent.status !== "active") {
      throw new RunCreateValidationError(
        `Agent '${input.agent_id}' is not active`,
        409,
      );
    }
    if (!agent.current_version_id) {
      throw new RunCreateValidationError(
        `Agent '${input.agent_id}' has no current version. Create an AgentVersion first.`,
        400,
      );
    }
    const agentVersion = await this.getAgentVersionForRun(
      input.space_id,
      input.agent_id,
      agent.current_version_id,
    );
    if (!agentVersion) {
      throw new RunCreateValidationError(
        `AgentVersion '${agent.current_version_id}' does not belong to Agent '${input.agent_id}'`,
        400,
      );
    }
    await this.assertOptionalSpaceRef("project_folders", input.project_folder_id, input.space_id, "Project Folder");
    await this.assertOptionalSpaceRef("projects", input.project_id, input.space_id, "Project");

    const now = input.started_at ?? new Date().toISOString();
    const contractSnapshot = createRunContractSnapshot(input.contract_snapshot, now);
    const contextSnapshotId = randomUUID();
    const capabilitiesJson = normalizeRunCapabilitiesJson(input.capabilities_json);
    await this.db.query(
      `INSERT INTO context_snapshots (
          id, space_id, source_refs_json, compiled_summary, token_estimate,
          agent_id, session_id, request_json, created_at
       )
       VALUES ($1, $2, '[]'::jsonb, NULL, NULL, $3, NULL, $4::jsonb, $5)`,
      [
        contextSnapshotId,
        input.space_id,
        input.agent_id,
        JSON.stringify({
          space_id: input.space_id,
          user_id: input.user_id,
          agent_version_id: agent.current_version_id,
          runtime_profile_id: null,
          session_id: null,
          project_folder_id: input.project_folder_id ?? null,
          project_id: input.project_id ?? null,
          user_message: input.prompt ?? input.instruction ?? null,
          manual_context: [],
          capabilities_json: capabilitiesJson,
          system_run: true,
        }),
        now,
      ],
    );

    const runId = randomUUID();
    const modelOverrideJson = JSON.stringify({
      source: "system_run",
      native_capability_executor: false,
    });
    const result = await this.db.query<RunRecord>(
      `INSERT INTO runs (
          id, space_id, agent_id, agent_version_id, runtime_profile_id,
          context_snapshot_id,
          project_folder_id, session_id, parent_run_id, instructed_by_user_id,
          run_type, trigger_origin, status, mode, prompt, instruction,
          scheduled_at, started_at, created_at, updated_at, adapter_type,
          capability_id, capabilities_json, model_provider_id, model_override_json,
          runtime_profile_snapshot_json, required_sandbox_level,
          owner_user_id, visibility, access_level, project_id, contract_snapshot_json, workflow_version_id, source
       )
       VALUES (
          $1, $2, $3, $4, NULL, $5, $6, NULL, NULL, $7,
          'system', $8, 'running', 'live', $9, $10,
          NULL, $11, $11, $11, NULL,
          $12, $13::jsonb, NULL, $14::jsonb,
          NULL, 'none',
          $7, 'space_shared', 'full', $15, $16::jsonb, $17, $18
       )
       RETURNING id, space_id, agent_id, agent_version_id, runtime_profile_id,
                 context_snapshot_id,
                 run_type, status, mode, prompt, instruction, project_folder_id,
                 session_id, parent_run_id, root_run_id, run_group_id,
                 delegation_id, project_id, scheduled_at,
                 adapter_type, capability_id, capabilities_json, model_provider_id,
                 model_override_json, runtime_profile_snapshot_json,
                 required_sandbox_level, trigger_origin,
                 instructed_by_user_id, instructed_by_agent_id, error_message,
                 error_json, output_json,
                 started_at, ended_at, created_at, updated_at,
                 owner_user_id, visibility, access_level, contract_snapshot_json, workflow_version_id`,
      [
        runId,
        input.space_id,
        input.agent_id,
        agent.current_version_id,
        contextSnapshotId,
        input.project_folder_id ?? null,
        input.user_id,
        input.trigger_origin,
        input.prompt ?? null,
        input.instruction ?? null,
        now,
        input.capability_id ?? null,
        JSON.stringify(capabilitiesJson),
        modelOverrideJson,
        input.project_id ?? null,
        JSON.stringify(contractSnapshot),
        input.workflow_version_id ?? null,
        input.source ?? "managed",
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Run insert returned no row");
    await this.db.query(
      `INSERT INTO run_attempts (
         id, space_id, run_id, attempt_number, status,
         started_at, last_activity_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 1, 'running', $4, $4, $4, $4)
       ON CONFLICT (space_id, run_id, attempt_number) DO NOTHING`,
      [randomUUID(), input.space_id, row.id, now],
    );
    await this.db.query(
      `UPDATE context_snapshots SET run_id = $3 WHERE space_id = $1 AND id = $2`,
      [input.space_id, contextSnapshotId, row.id],
    );
    return row;
  }

  private async getAgentForRun(
    spaceId: string,
    agentId: string,
  ): Promise<{ id: string; status: string; current_version_id: string | null; visibility: string; access_level: string } | null> {
    const result = await this.db.query<{
      id: string;
      status: string;
      current_version_id: string | null;
      visibility: string;
      access_level: string;
    }>(
      `SELECT id, status, current_version_id, visibility, access_level
         FROM agents
        WHERE space_id = $1 AND id = $2`,
      [spaceId, agentId],
    );
    return result.rows[0] ?? null;
  }

  private async requireRuntimeProfileForRun(
    spaceId: string,
    agentId: string,
    runtimeProfileId: string,
  ): Promise<RuntimeProfileForRun> {
    const profile = await this.getRuntimeProfileForRun(spaceId, agentId, runtimeProfileId);
    if (!profile) {
      throw new RunCreateValidationError(
        `Runtime profile '${runtimeProfileId}' not found for Agent '${agentId}' in this space`,
        404,
      );
    }
    if (!profile.enabled) {
      throw new RunCreateValidationError(
        `Runtime profile '${runtimeProfileId}' is disabled`,
        409,
      );
    }
    return profile;
  }

  private async getRuntimeProfileForRun(
    spaceId: string,
    agentId: string,
    runtimeProfileId: string,
  ): Promise<RuntimeProfileForRun | null> {
    const result = await this.db.query<RuntimeProfileForRun>(
      `SELECT id, space_id, agent_id, name, adapter_type, model_provider_id,
              model_name, runtime_config_json,
              runtime_policy_json, enabled, is_default, created_at, updated_at
         FROM agent_runtime_profiles
        WHERE space_id = $1 AND agent_id = $2 AND id = $3
        LIMIT 1`,
      [spaceId, agentId, runtimeProfileId],
    );
    return result.rows[0] ?? null;
  }

  private async getAgentVersionForRun(
    spaceId: string,
    agentId: string,
    versionId: string,
  ): Promise<{ id: string; tool_permissions_json: unknown } | null> {
    const result = await this.db.query<{
      id: string;
      tool_permissions_json: unknown;
    }>(
      `SELECT id, tool_permissions_json
         FROM agent_versions
        WHERE space_id = $1 AND agent_id = $2 AND id = $3`,
      [spaceId, agentId, versionId],
    );
    return result.rows[0] ?? null;
  }

  private async assertOptionalSpaceRef(
    table: "project_folders" | "sessions" | "projects",
    id: string | null | undefined,
    spaceId: string,
    label: string,
  ): Promise<void> {
    if (!id) return;
    const deletedPredicate = table === "projects" ? " AND deleted_at IS NULL" : "";
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE space_id = $1 AND id = $2${deletedPredicate}`,
      [spaceId, id],
    );
    if (result.rows.length === 0) {
      throw new RunCreateValidationError(
        `${label} '${id}' not found in this space`,
        400,
      );
    }
  }

  async getRun(spaceId: string, runId: string): Promise<RunRecord | null> {
    const result = await this.db.query<RunRecord>(
      `SELECT r.id, r.space_id, r.agent_id, r.agent_version_id,
              a.name AS agent_name,
              r.run_role, r.requested_runtime_profile_id,
              r.runtime_profile_id, r.runtime_profile_selection_source,
              av.system_prompt AS system_prompt,
              r.context_snapshot_id, r.run_type, r.status, r.mode, r.prompt,
              r.instruction, r.project_folder_id, r.session_id, r.parent_run_id,
              r.root_run_id, r.run_group_id, r.delegation_id,
              r.project_id, r.scheduled_at, r.adapter_type, r.capability_id,
              r.capabilities_json, r.model_provider_id, r.model_override_json, r.required_sandbox_level,
              r.runtime_profile_snapshot_json, r.permission_snapshot_json,
              COALESCE(r.runtime_profile_snapshot_json->'runtime_config_json', '{}'::jsonb) AS runtime_config_json,
              r.contract_snapshot_json, r.workflow_version_id, r.route_decision_id,
              r.trigger_origin, r.instructed_by_user_id, r.instructed_by_agent_id, r.error_message,
              r.error_json, r.output_json, r.started_at,
              r.ended_at, r.created_at, r.updated_at, r.owner_user_id, r.visibility, r.access_level
         FROM runs r
         LEFT JOIN agent_versions av
           ON av.id = r.agent_version_id
          AND av.space_id = r.space_id
          AND av.agent_id = r.agent_id
         LEFT JOIN agents a
           ON a.id = r.agent_id
          AND a.space_id = r.space_id
        WHERE r.space_id = $1 AND r.id = $2`,
      [spaceId, runId],
    );
    return result.rows[0] ? this.withRunUsage(result.rows[0]) : null;
  }

  async getVisibleRun(spaceId: string, userId: string, runId: string): Promise<RunRecord | null> {
    const decision = await contentDecisionFromDb(
      this.db,
      { spaceId, userId },
      "run",
      runId,
    );
    return decision === "deny" ? null : this.getRun(spaceId, runId);
  }

  async listRuns(filters: RunListFilters): Promise<RunRecord[]> {
    await assertProjectInSpace(this.db, filters.space_id, filters.project_id);
    const clauses = [
      "space_id = $1",
      contentReadSql("run", "runs", "$2"),
    ];
    const params: unknown[] = [filters.space_id, filters.user_id];
    addOptionalFilter(clauses, params, "status", filters.status);
    addOptionalFilter(clauses, params, "mode", filters.mode);
    addOptionalFilter(clauses, params, "agent_id", filters.agent_id);
    addOptionalFilter(clauses, params, "project_folder_id", filters.project_folder_id);
    addOptionalFilter(clauses, params, "project_id", filters.project_id);
    addOptionalFilter(clauses, params, "workflow_version_id", filters.workflow_version_id);
    addOptionalFilter(clauses, params, "capability_id", filters.capability_id);
    if (filters.run_role) addOptionalFilter(clauses, params, "run_role", filters.run_role);
    else clauses.push("run_role = 'execution'");
    params.push(filters.limit, filters.offset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;
    const result = await this.db.query<RunRecord>(
      `SELECT id, space_id, agent_id, agent_version_id, run_role,
              requested_runtime_profile_id, runtime_profile_id, runtime_profile_selection_source,
              context_snapshot_id,
              run_type, status, mode, prompt, instruction, project_folder_id,
              session_id, parent_run_id, root_run_id, run_group_id, delegation_id,
              project_id, scheduled_at, adapter_type,
              capability_id, capabilities_json, model_provider_id, model_override_json,
              runtime_profile_snapshot_json,
              required_sandbox_level, contract_snapshot_json, workflow_version_id, route_decision_id, trigger_origin, instructed_by_user_id,
              instructed_by_agent_id,
              error_message, error_json, output_json, started_at,
              ended_at, created_at, updated_at, owner_user_id, visibility, access_level
         FROM runs
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return this.withRunsUsage(result.rows);
  }

  async getModelProviderSummary(
    spaceId: string,
    providerId: string | null | undefined,
  ): Promise<ModelProviderSummaryRecord | null> {
    if (!providerId) return null;
    const result = await this.db.query<ModelProviderSummaryRecord>(
      `SELECT p.id, p.name, p.provider_type, p.default_model, p.enabled, p.credential_id
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id = g.provider_id
        WHERE g.space_id = $1
          AND g.provider_id = $2
          AND g.enabled = TRUE`,
      [spaceId, providerId],
    );
    return result.rows[0] ?? null;
  }

  async getChatRunResult(
    spaceId: string,
    runId: string,
  ): Promise<RunChatResultRecord | null> {
    const result = await this.db.query<RunChatResultRecord>(
      `SELECT id, space_id, status, output_json, error_json
         FROM runs
        WHERE space_id = $1 AND id = $2`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  async listRunSteps(spaceId: string, runId: string): Promise<RunStepDetailRecord[]> {
    const result = await this.db.query<RunStepDetailRecord>(
      `SELECT id, space_id, run_id, attempt_number, parent_step_id, actor_id, step_index,
              step_type, status, title, project_folder_id, session_id, task_id,
              artifact_id, proposal_id, started_at, ended_at, input_summary,
              output_summary, error_type, error_message, metadata_json,
              created_at, updated_at
         FROM run_steps
        WHERE space_id = $1 AND run_id = $2
        ORDER BY step_index ASC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async listRunEvents(spaceId: string, runId: string): Promise<RunEventDetailRecord[]> {
    const result = await this.db.query<RunEventDetailRecord>(
      `SELECT id, space_id, run_id, attempt_number, step_id, actor_id, event_index, event_type,
              status, summary, error_code, error_message, project_folder_id,
              artifact_id, proposal_id, data_exposure_level, trust_level,
              metadata_json, created_at
         FROM run_events
        WHERE space_id = $1 AND run_id = $2
        ORDER BY event_index ASC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async listRunEventsPage(
    spaceId: string,
    runId: string,
    filters: RunEventPageFilters,
  ): Promise<RunEventPage> {
    const params: unknown[] = [spaceId, runId, filters.from_event_index];
    const clauses = [
      "space_id = $1",
      "run_id = $2",
      "event_index >= $3",
    ];
    addOptionalFilter(clauses, params, "event_type", filters.event_type);
    addOptionalFilter(clauses, params, "status", filters.status);
    const limitParam = params.length + 1;
    const rows = await this.db.query<RunEventDetailRecord>(
      `SELECT id, space_id, run_id, attempt_number, step_id, actor_id, event_index, event_type,
              status, summary, error_code, error_message, project_folder_id,
              artifact_id, proposal_id, data_exposure_level, trust_level,
              metadata_json, created_at
         FROM run_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY event_index ASC, id ASC
        LIMIT $${limitParam}`,
      [...params, filters.limit],
    );

    const totalParams: unknown[] = [spaceId, runId];
    const totalClauses = ["space_id = $1", "run_id = $2"];
    addOptionalFilter(totalClauses, totalParams, "event_type", filters.event_type);
    addOptionalFilter(totalClauses, totalParams, "status", filters.status);
    const total = await this.db.query<{ total: string | number }>(
      `SELECT COALESCE(MAX(event_index) + 1, 0)::text AS total
         FROM run_events
        WHERE ${totalClauses.join(" AND ")}`,
      totalParams,
    );

    return {
      items: rows.rows,
      total: Number(total.rows[0]?.total ?? 0),
      limit: filters.limit,
      offset: filters.from_event_index,
    };
  }

  async listArtifactSummaries(
    spaceId: string,
    runId: string,
  ): Promise<ArtifactSummaryRecord[]> {
    const result = await this.db.query<ArtifactSummaryRecord>(
      `SELECT id, space_id, run_id, proposal_id, artifact_type, title,
              mime_type, visibility, created_at
         FROM artifacts
        WHERE space_id = $1 AND run_id = $2
        ORDER BY created_at ASC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async listProposalSummaries(
    spaceId: string,
    runId: string,
  ): Promise<ProposalSummaryRecord[]> {
    const result = await this.db.query<ProposalSummaryRecord>(
      `SELECT proposal.id, proposal.space_id, proposal.proposal_type,
              proposal.status, proposal.title, proposal.visibility,
              proposal.created_at, proposal.preview, proposal.urgency,
              proposal.review_deadline, proposal.expires_at,
              proposal.created_by_run_id
         FROM proposals proposal
         JOIN runs run
           ON run.id = proposal.created_by_run_id
          AND run.space_id = proposal.space_id
        WHERE proposal.space_id = $1
          AND proposal.created_by_run_id = $2
          AND proposal.status <> 'staged'
          AND run.status IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
        ORDER BY proposal.created_at ASC, proposal.id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async listChildRuns(spaceId: string, runId: string): Promise<RunRecord[]> {
    const result = await this.db.query<RunRecord>(
      `SELECT id, space_id, agent_id, agent_version_id, parent_run_id,
              root_run_id, run_group_id, delegation_id, status,
              run_type, trigger_origin, mode, created_at, started_at, ended_at,
              prompt, instruction, project_folder_id, session_id, project_id,
              runtime_profile_id, runtime_profile_selection_source,
              adapter_type, model_provider_id, required_sandbox_level, contract_snapshot_json, workflow_version_id,
              instructed_by_user_id, instructed_by_agent_id, error_message, visibility
         FROM runs
        WHERE space_id = $1 AND parent_run_id = $2
        ORDER BY created_at ASC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async getContextSnapshot(
    spaceId: string,
    snapshotId: string | null | undefined,
  ): Promise<ContextSnapshotRecord | null> {
    if (!snapshotId) return null;
    const result = await this.db.query<ContextSnapshotRecord>(
      `SELECT id, space_id, run_id, agent_id, session_id, source_refs_json,
              compiled_summary, token_estimate, relevant_period_start,
              relevant_period_end, compiled_prefix_text, compiled_tail_text,
              compiled_prefix_ref, compiled_tail_ref, prefix_hash, tail_hash,
              compiler_version, retrieval_trace_json, token_budget_json,
              policy_bundle_version, memory_digest_version, project_folder_digest_version,
              included_memory_refs_json, included_evidence_refs_json,
              included_file_refs_json, included_doc_refs_json, redactions_json,
              data_exposure_level, rendered_context_uri, rendered_context_text,
              request_json, created_at
         FROM context_snapshots
        WHERE space_id = $1 AND id = $2
        LIMIT 1`,
      [spaceId, snapshotId],
    );
    return result.rows[0] ?? null;
  }

  async getLatestRunEvaluation(
    spaceId: string,
    runId: string,
  ): Promise<RunEvaluationRecord | null> {
    const result = await this.db.query<RunEvaluationRecord>(
      `SELECT id, space_id, run_id, evaluator_type, evaluator_version,
              outcome_status, failure_layer, failure_reason_code,
              trajectory_status, evidence_json, rule_trace_json, notes,
              evaluated_at
         FROM run_evaluations
        WHERE space_id = $1 AND run_id = $2
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  async listRunEvaluations(
    spaceId: string,
    runId: string,
  ): Promise<RunEvaluationRecord[]> {
    const result = await this.db.query<RunEvaluationRecord>(
      `SELECT id, space_id, run_id, evaluator_type, evaluator_version,
              outcome_status, failure_layer, failure_reason_code,
              trajectory_status, evidence_json, rule_trace_json, notes,
              evaluated_at
         FROM run_evaluations
        WHERE space_id = $1 AND run_id = $2
        ORDER BY evaluated_at DESC, id DESC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  /**
   * Returns the current attempt's verification results. Rows are persisted
   * per attempt; evaluation and the run detail read model must never treat a
   * prior attempt's checks as evidence for the attempt being finalized, so a
   * retry that failed before verification yields an empty (incomplete) set
   * instead of borrowing the previous attempt's rows.
   */
  async listVerificationResults(
    spaceId: string,
    runId: string,
  ): Promise<VerificationResultRecord[]> {
    const result = await this.db.query<VerificationResultRecord>(
      `SELECT id, space_id, run_id, attempt_number, verifier_type, verifier_version, status,
              summary, evidence_refs_json, details_json, started_at, completed_at, created_at
         FROM verification_results
        WHERE space_id = $1 AND run_id = $2
          AND attempt_number = COALESCE((SELECT max(attempt_number)
                                           FROM run_attempts
                                          WHERE space_id = $1 AND run_id = $2), 1)
        ORDER BY created_at ASC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async bridgeTaskEvaluationForRunEvaluation(
    spaceId: string,
    runEvaluation: RunEvaluationRecord,
  ): Promise<{ taskEvaluationId: string | null; skippedReason: string | null }> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id
         FROM task_evaluations
        WHERE space_id = $1 AND run_evaluation_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [spaceId, runEvaluation.id],
    );
    if (existing.rows[0]) {
      return { taskEvaluationId: existing.rows[0].id, skippedReason: null };
    }

    const link = await this.db.query<{ task_id: string; run_id: string }>(
      `SELECT task_id, run_id
         FROM task_runs
        WHERE space_id = $1 AND run_id = $2
        ORDER BY (role = 'primary') DESC, created_at ASC, id ASC
        LIMIT 1`,
      [spaceId, runEvaluation.run_id],
    );
    const taskRun = link.rows[0];
    if (!taskRun) {
      return { taskEvaluationId: null, skippedReason: "no_task_run_link" };
    }

    const task = await this.db.query<{ id: string }>(
      `SELECT id
         FROM tasks
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [spaceId, taskRun.task_id],
    );
    if (!task.rows[0]) {
      return { taskEvaluationId: null, skippedReason: "no_task_run_link" };
    }

    const artifacts = await this.db.query<{ id: string }>(
      `SELECT id
         FROM artifacts
        WHERE space_id = $1 AND run_id = $2
        ORDER BY created_at DESC, id DESC`,
      [spaceId, runEvaluation.run_id],
    );
    const outcome = runEvaluation.outcome_status;
    const now = new Date().toISOString();
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO task_evaluations (
         id, space_id, task_id, run_id, run_evaluation_id, evaluator_type,
         score, confidence, summary, checklist_json, known_issues_json,
         evidence_artifact_ids, recommendation, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'run_evaluation_bridge',
         $6::float, $7::float, $8, $9::jsonb, $10::jsonb,
         $11::jsonb, $12, $13
       )
       RETURNING id`,
      [
        randomUUID(),
        spaceId,
        taskRun.task_id,
        runEvaluation.run_id,
        runEvaluation.id,
        taskScoreForOutcome(outcome),
        taskConfidenceForOutcome(outcome),
        taskSummaryFromRunEvaluation(runEvaluation),
        JSON.stringify(taskChecklistFromRunEvaluation(runEvaluation)),
        JSON.stringify(taskKnownIssuesFromRunEvaluation(runEvaluation)),
        JSON.stringify(artifacts.rows.map((row) => row.id)),
        taskRecommendationForOutcome(outcome),
        now,
      ],
    );
    return { taskEvaluationId: inserted.rows[0]?.id ?? null, skippedReason: null };
  }

  async getLatestRunFinalization(
    spaceId: string,
    runId: string,
  ): Promise<RunFinalizationRecord | null> {
    const result = await this.db.query<RunFinalizationRecord>(
      `SELECT id, space_id, run_id, attempt_number, finalizer_version, status,
              run_evaluation_id, task_evaluation_id, outcome_status,
              failure_layer, failure_reason_code, trajectory_status,
              skipped_reasons_json, error_json, metadata_json, finalized_at,
              created_at
         FROM run_finalizations
        WHERE space_id = $1 AND run_id = $2
        ORDER BY finalized_at DESC, id DESC
        LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  async withRunFinalizationLock<T>(
    spaceId: string,
    runId: string,
    attemptNumber: number,
    finalizerVersion: string,
    fn: (repository: PgRunRepository) => Promise<T>,
  ): Promise<T> {
    const lockKey = [
      "run_finalization",
      spaceId,
      runId,
      attemptNumber,
      finalizerVersion,
    ].join(":");
    return withDedicatedSessionAdvisoryLock(this.db, lockKey, (lockedDb) =>
      fn(lockedDb === this.db ? this : new PgRunRepository(lockedDb)));
  }

  async markRunFinalizationGateCommitted(
    spaceId: string,
    finalizationId: string,
    committedAt: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE run_finalizations
          SET metadata_json = COALESCE(metadata_json, '{}'::jsonb)
                || jsonb_build_object(
                  'completion_gate_committed', true,
                  'completion_gate_committed_at', $3::text
                )
        WHERE space_id = $1
          AND id = $2
          AND status = 'completed'`,
      [spaceId, finalizationId, committedAt],
    );
  }

  async getRunFinalizationByVersion(
    spaceId: string,
    runId: string,
    attemptNumber: number,
    finalizerVersion: string,
  ): Promise<RunFinalizationRecord | null> {
    const result = await this.db.query<RunFinalizationRecord>(
      `SELECT id, space_id, run_id, attempt_number, finalizer_version, status,
              run_evaluation_id, task_evaluation_id, outcome_status,
              failure_layer, failure_reason_code, trajectory_status,
              skipped_reasons_json, error_json, metadata_json, finalized_at,
              created_at
         FROM run_finalizations
        WHERE space_id = $1 AND run_id = $2 AND attempt_number = $3 AND finalizer_version = $4
        LIMIT 1`,
      [spaceId, runId, attemptNumber, finalizerVersion],
    );
    return result.rows[0] ?? null;
  }

  async listRunFinalizations(
    spaceId: string,
    runId: string,
  ): Promise<RunFinalizationRecord[]> {
    const result = await this.db.query<RunFinalizationRecord>(
      `SELECT id, space_id, run_id, attempt_number, finalizer_version, status,
              run_evaluation_id, task_evaluation_id, outcome_status,
              failure_layer, failure_reason_code, trajectory_status,
              skipped_reasons_json, error_json, metadata_json, finalized_at,
              created_at
         FROM run_finalizations
        WHERE space_id = $1 AND run_id = $2
        ORDER BY finalized_at DESC, id DESC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async insertRunEvaluation(input: {
    space_id: string;
    run_id: string;
    outcome_status: string;
    failure_layer?: string | null;
    failure_reason_code?: string | null;
    trajectory_status: string;
    evidence_json?: unknown;
    rule_trace_json?: unknown;
    notes?: string | null;
    evaluated_at: string;
    evaluator_type?: string;
    evaluator_version?: string;
  }): Promise<RunEvaluationRecord> {
    const result = await this.db.query<RunEvaluationRecord>(
      `INSERT INTO run_evaluations (
          id, space_id, run_id, evaluator_type, evaluator_version,
          outcome_status, failure_layer, failure_reason_code,
          trajectory_status, evidence_json, rule_trace_json, notes, evaluated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
       RETURNING id, space_id, run_id, evaluator_type, evaluator_version,
                 outcome_status, failure_layer, failure_reason_code,
                 trajectory_status, evidence_json, rule_trace_json, notes,
                 evaluated_at`,
      [
        randomUUID(),
        input.space_id,
        input.run_id,
        input.evaluator_type ?? "deterministic_harness",
        input.evaluator_version ?? "harness_eval.v1",
        input.outcome_status,
        input.failure_layer ?? null,
        input.failure_reason_code ?? null,
        input.trajectory_status,
        JSON.stringify(sanitizeEvidenceJson(input.evidence_json ?? {})),
        JSON.stringify(sanitizeEvidenceJson(input.rule_trace_json ?? [])),
        redactEvidenceText(input.notes),
        input.evaluated_at,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("RunEvaluation insert returned no row");
    return row;
  }

  async insertRunFinalization(input: {
    space_id: string;
    run_id: string;
    attempt_number: number;
    finalizer_version: string;
    status: "completed" | "failed";
    run_evaluation_id?: string | null;
    task_evaluation_id?: string | null;
    outcome_status?: string | null;
    failure_layer?: string | null;
    failure_reason_code?: string | null;
    trajectory_status?: string | null;
    skipped_reasons_json?: unknown;
    error_json?: unknown;
    metadata_json?: unknown;
    finalized_at: string;
    created_at: string;
  }): Promise<RunFinalizationRecord> {
    const result = await this.db.query<RunFinalizationRecord>(
      `INSERT INTO run_finalizations (
          id, space_id, run_id, attempt_number, finalizer_version, status,
          run_evaluation_id, task_evaluation_id, outcome_status,
          failure_layer, failure_reason_code, trajectory_status,
          skipped_reasons_json, error_json, metadata_json, finalized_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15::jsonb, $16, $17)
       RETURNING id, space_id, run_id, attempt_number, finalizer_version, status,
                 run_evaluation_id, task_evaluation_id, outcome_status,
                 failure_layer, failure_reason_code, trajectory_status,
                 skipped_reasons_json, error_json, metadata_json, finalized_at,
                 created_at`,
      [
        randomUUID(),
        input.space_id,
        input.run_id,
        input.attempt_number,
        input.finalizer_version,
        input.status,
        input.run_evaluation_id ?? null,
        input.task_evaluation_id ?? null,
        input.outcome_status ?? null,
        input.failure_layer ?? null,
        input.failure_reason_code ?? null,
        input.trajectory_status ?? null,
        JSON.stringify(sanitizeEvidenceJson(input.skipped_reasons_json ?? null)),
        JSON.stringify(sanitizeErrorJson(input.error_json ?? null)),
        JSON.stringify(sanitizeEvidenceJson(input.metadata_json ?? {})),
        input.finalized_at,
        input.created_at,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("RunFinalization insert returned no row");
    return row;
  }

  /**
   * Resolve the Actor row for run evidence, creating it when absent — the
   * Resolve actor precedence: instructing user actor first, then the
   * `agent_run` job actor for job dispatch, otherwise the
   * `run_execution` system actor. `run_steps.actor_id` is a non-null Actor FK,
   * so worker/request identifiers must never be written there directly.
   */
  async resolveRunActorId(
    run: Pick<RunRecord, "space_id" | "instructed_by_user_id">,
    commandSource: string,
  ): Promise<string> {
    if (run.instructed_by_user_id) {
      const existing = await this.db.query<{ id: string }>(
        `SELECT id FROM actors
          WHERE actor_type = 'user' AND user_id = $1 AND space_id = $2
            AND status = 'active'
          LIMIT 1`,
        [run.instructed_by_user_id, run.space_id],
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const created = await this.db.query<{ id: string }>(
        `INSERT INTO actors (
            id, space_id, actor_type, user_id, agent_id, service_name,
            display_name, status, metadata_json, created_at, updated_at
         )
         VALUES ($1, $2, 'user', $3, NULL, NULL, NULL, 'active', '{}'::jsonb, $4, $4)
         RETURNING id`,
        [
          randomUUID(),
          run.space_id,
          run.instructed_by_user_id,
          new Date().toISOString(),
        ],
      );
      const row = created.rows[0];
      if (!row) throw new Error("user actor insert returned no row");
      return row.id;
    }

    const actorType = commandSource === "job" ? "job" : "system";
    const serviceName = commandSource === "job" ? "agent_run" : "run_execution";
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM actors
        WHERE actor_type = $1 AND service_name = $2 AND space_id = $3
          AND status = 'active'
        LIMIT 1`,
      [actorType, serviceName, run.space_id],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await this.db.query<{ id: string }>(
      `INSERT INTO actors (
          id, space_id, actor_type, user_id, agent_id, service_name,
          display_name, status, metadata_json, created_at, updated_at
       )
       VALUES ($1, $2, $3, NULL, NULL, $4, NULL, 'active', '{}'::jsonb, $5, $5)
       RETURNING id`,
      [randomUUID(), run.space_id, actorType, serviceName, new Date().toISOString()],
    );
    const row = created.rows[0];
    if (!row) throw new Error(`${actorType} actor insert returned no row`);
    return row.id;
  }

  async markRunRunning(input: {
    run_id: string;
    space_id: string;
    started_at: string;
    required_sandbox_level?: string | null;
  }): Promise<RunRecord | null> {
    const attemptId = randomUUID();
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
         UPDATE runs
            SET status = 'running',
                started_at = $3,
                updated_at = $3,
                required_sandbox_level = COALESCE($4, required_sandbox_level)
          WHERE space_id = $1 AND id = $2 AND status = 'queued'
          RETURNING id, space_id, agent_id, agent_version_id, runtime_profile_id,
                    runtime_profile_snapshot_json, run_type, status, mode,
                    prompt, instruction, project_folder_id, session_id, project_id,
                    parent_run_id, root_run_id, run_group_id, delegation_id,
                    adapter_type, capability_id, capabilities_json, model_provider_id,
                    model_override_json, permission_snapshot_json,
                    required_sandbox_level, contract_snapshot_json, workflow_version_id, trigger_origin, instructed_by_user_id,
                    instructed_by_agent_id, error_message,
                    started_at, ended_at
       )
       , updated_attempt AS (
         UPDATE run_attempts a
            SET status = 'running',
                started_at = $3,
                last_activity_at = $3,
                updated_at = $3
           FROM updated u
          WHERE a.space_id = u.space_id
            AND a.run_id = u.id
            AND a.status = 'queued'
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id
            )
         RETURNING a.id
       ), inserted_attempt AS (
         INSERT INTO run_attempts (
           id, space_id, run_id, attempt_number, status,
           started_at, last_activity_at, error_json, created_at, updated_at
         )
         SELECT $5, u.space_id, u.id,
                COALESCE((SELECT max(a.attempt_number)
                            FROM run_attempts a
                           WHERE a.space_id = u.space_id AND a.run_id = u.id), 0) + 1,
                'running', $3, $3,
                jsonb_build_object('error_code', 'attempt_backfilled_on_dispatch'),
                $3, $3
           FROM updated u
          WHERE NOT EXISTS (SELECT 1 FROM updated_attempt)
         ON CONFLICT (space_id, run_id, attempt_number) DO NOTHING
         RETURNING id
       )
       SELECT u.*,
              a.name AS agent_name,
              av.system_prompt AS system_prompt,
              COALESCE(u.runtime_profile_snapshot_json->'runtime_config_json', '{}'::jsonb) AS runtime_config_json
         FROM updated u
         LEFT JOIN agent_versions av
           ON av.id = u.agent_version_id
          AND av.space_id = u.space_id
          AND av.agent_id = u.agent_id
         LEFT JOIN agents a
           ON a.id = u.agent_id
          AND a.space_id = u.space_id`,
      [
        input.space_id,
        input.run_id,
        input.started_at,
        input.required_sandbox_level ?? null,
        attemptId,
      ],
    );
    return result.rows[0] ?? null;
  }

  async checkRunDispatchContract(
    run: Pick<RunRecord, "space_id" | "id" | "root_run_id" | "contract_snapshot_json">,
  ): Promise<{ allowed: boolean; error_code?: string; error_message?: string }> {
    return checkRunBudget(this.db, run);
  }

  async checkRunExecutionAuthorization(
    run: Pick<
      RunRecord,
      | "space_id"
      | "instructed_by_user_id"
      | "project_id"
      | "project_folder_id"
      | "run_group_id"
    >,
  ): Promise<{ allowed: boolean; error_code?: string; error_message?: string }> {
    if (!run.instructed_by_user_id) return { allowed: true };
    const result = await this.db.query<{ allowed: boolean }>(
      `SELECT (
          EXISTS (
            SELECT 1
              FROM space_memberships membership
             WHERE membership.space_id = $1
               AND membership.user_id = $2
               AND membership.status = 'active'
          )
          AND (
            $3::varchar IS NULL
            OR ${projectReadAccessSql("$1", "$3", "$2")}
          )
          AND (
            $4::varchar IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM agent_run_groups candidate_group
               WHERE candidate_group.id = $4
                 AND candidate_group.space_id = $1
                 AND candidate_group.room_id IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
                FROM agent_run_groups room_group
                JOIN room_user_members room_member
                  ON room_member.room_id = room_group.room_id
                 AND room_member.space_id = room_group.space_id
                 AND room_member.user_id = $2
                 AND room_member.status = 'active'
               WHERE room_group.id = $4
                 AND room_group.space_id = $1
            )
          )
          AND (
            $5::varchar IS NULL
            OR EXISTS (
              SELECT 1
                FROM project_folders execution_folder
               WHERE execution_folder.id = $5
                 AND execution_folder.space_id = $1
                 AND execution_folder.project_id = $3
                 AND execution_folder.status = 'active'
                 AND execution_folder.execution_enabled = TRUE
            )
          )
        ) AS allowed`,
      [
        run.space_id,
        run.instructed_by_user_id,
        run.project_id,
        run.run_group_id,
        run.project_folder_id,
      ],
    );
    return result.rows[0]?.allowed
      ? { allowed: true }
      : {
          allowed: false,
          error_code: "run_execution_authorization_revoked",
          error_message: "Run execution authorization is no longer active.",
        };
  }

  async updateRunSandboxLevel(input: {
    run_id: string;
    space_id: string;
    required_sandbox_level: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE runs
          SET required_sandbox_level = $3, updated_at = now()
        WHERE space_id = $1 AND id = $2 AND status = 'running'`,
      [input.space_id, input.run_id, input.required_sandbox_level],
    );
  }

  async markRunTerminal(input: RunTerminalUpdate): Promise<RunRecord | null> {
    return this.markRunTerminalInternal(input, null, false);
  }

  async markRunTerminalWithConversationSession(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null> {
    return this.markRunTerminalInternal(input, conversation, false);
  }

  async publishRunTerminal(input: RunTerminalUpdate): Promise<RunRecord | null> {
    return this.markRunTerminalInternal(input, null, true);
  }

  async publishRunTerminalWithConversationSession(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null> {
    return this.markRunTerminalInternal(input, conversation, true);
  }

  private async markRunTerminalInternal(
    input: RunTerminalUpdate,
    conversation: ConversationRuntimeTerminalSync | null,
    executionOwner: boolean,
  ): Promise<RunRecord | null> {
    const outputJson = sanitizeEvidenceJson(recordValue(input.output_json));
    const errorJson = sanitizeErrorJson(input.error_json ?? {});
    const terminalErrorCode = typeof recordValue(errorJson).error_code === "string"
      ? recordValue(errorJson).error_code as string
      : null;
    const replacementStateKey = randomUUID();
    const result = await this.db.query<RunRecord>(
      `WITH candidate AS (
         SELECT id
           FROM runs
          WHERE space_id = $1
            AND id = $2
            AND status NOT IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')
            AND ($18::boolean OR NOT EXISTS (
              SELECT 1 FROM run_execution_locks active_lock
               WHERE active_lock.run_id = runs.id
            ))
            AND (NOT $18::boolean OR $3 = 'cancelled' OR status <> 'cancelling')
          FOR UPDATE
       ), synchronized_session AS (
         UPDATE session_conversation_backends
            SET runtime_state_key = CASE WHEN $11::boolean
                  THEN runtime_state_key ELSE $16 END,
                runtime_session_id = CASE WHEN $11::boolean
                  THEN $14 ELSE NULL END,
                runtime_context_fingerprint = CASE WHEN $11::boolean
                  THEN $15 ELSE NULL END,
                runtime_message_cursor_id = CASE WHEN $11::boolean
                  THEN $17 ELSE NULL END,
                runtime_session_updated_at = CASE WHEN $11::boolean
                  THEN $7::timestamptz ELSE NULL END,
                updated_at = $7
          WHERE $10::boolean
            AND id = $12
            AND runtime_state_key = $13
            AND EXISTS (SELECT 1 FROM candidate)
          RETURNING runtime_state_key
       ), updated AS (
         UPDATE runs run_row
          SET status = $3,
              output_json = $4::jsonb,
              error_json = $5::jsonb,
              exit_code = $6,
              ended_at = $7,
              updated_at = $7,
              error_message = $8,
              model_override_json = CASE
                WHEN $10::boolean
                 AND NOT $11::boolean
                 AND EXISTS (SELECT 1 FROM synchronized_session)
                THEN jsonb_set(
                  jsonb_set(
                    run_row.model_override_json,
                    '{conversation_runtime,runtime_state_key}',
                    to_jsonb((
                      SELECT runtime_state_key
                        FROM synchronized_session
                       LIMIT 1
                    ))
                  ),
                  '{conversation_runtime,runtime_session_id}',
                  'null'::jsonb
                )
                ELSE run_row.model_override_json
              END
          FROM candidate
         WHERE run_row.id = candidate.id
        RETURNING run_row.id, run_row.space_id, run_row.agent_id,
                  run_row.agent_version_id, run_row.run_type, run_row.status,
                  run_row.mode, run_row.prompt, run_row.instruction,
                  run_row.project_folder_id, run_row.session_id, run_row.project_id,
                  run_row.parent_run_id, run_row.root_run_id, run_row.run_group_id,
                  run_row.delegation_id, run_row.adapter_type,
                  run_row.model_provider_id, run_row.required_sandbox_level,
                  run_row.trigger_origin, run_row.instructed_by_user_id,
                  run_row.instructed_by_agent_id, run_row.error_message,
                  run_row.output_json, run_row.error_json, run_row.started_at,
                  run_row.ended_at
       ), resolved_proposals AS (
         UPDATE proposals proposal
            SET status = CASE
                  WHEN $3 IN ('succeeded', 'degraded') THEN 'pending'
                  ELSE 'rejected'
                END,
                updated_at = $7
           FROM updated u
          WHERE proposal.space_id = u.space_id
            AND proposal.created_by_run_id = u.id
            AND proposal.status = 'staged'
       ), released_lock AS (
         DELETE FROM run_execution_locks execution_lock
          USING updated u
          WHERE $18::boolean
            AND execution_lock.run_id = u.id
       ), updated_attempt AS (
         UPDATE run_attempts a
            SET status = $3,
                error_code = NULLIF($9::text, ''),
                error_json = $5::jsonb,
                exit_code = $6,
                ended_at = $7,
                last_activity_at = $7,
                cancel_confirmed_at = CASE WHEN $3 = 'cancelled' THEN $7 ELSE cancel_confirmed_at END,
                updated_at = $7
           FROM updated u
          WHERE a.space_id = u.space_id
            AND a.run_id = u.id
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id
            )
       )
       SELECT * FROM updated`,
      [
        input.space_id,
        input.run_id,
        input.status,
        JSON.stringify(outputJson),
        JSON.stringify(errorJson),
        input.exit_code ?? null,
        input.completed_at,
        redactEvidenceText(extractErrorMessage(errorJson)),
        terminalErrorCode,
        conversation !== null,
        conversation?.keep_session ?? false,
        conversation?.binding_id ?? null,
        conversation?.runtime_state_key ?? null,
        conversation?.runtime_session_id ?? null,
        conversation?.context_fingerprint ?? null,
        replacementStateKey,
        conversation?.message_cursor_id ?? null,
        executionOwner,
      ],
    );
    return result.rows[0] ?? null;
  }

  async getLatestRunAttempt(spaceId: string, runId: string): Promise<RunAttemptRecord | null> {
    const result = await this.db.query<RunAttemptRecord>(
      `SELECT id, space_id, run_id, attempt_number, status,
              started_at, ended_at, last_activity_at,
              cancel_requested_at, cancel_confirmed_at, exit_code,
              error_code, error_json, created_at, updated_at
         FROM run_attempts
        WHERE space_id = $1 AND run_id = $2
        ORDER BY attempt_number DESC
        LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  async listRunAttempts(spaceId: string, runId: string): Promise<RunAttemptRecord[]> {
    const result = await this.db.query<RunAttemptRecord>(
      `SELECT id, space_id, run_id, attempt_number, status,
              started_at, ended_at, last_activity_at,
              cancel_requested_at, cancel_confirmed_at, exit_code,
              error_code, error_json, created_at, updated_at
         FROM run_attempts
        WHERE space_id = $1 AND run_id = $2
        ORDER BY attempt_number DESC, id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async listRunSupervisorDecisions(spaceId: string, runId: string): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT decision.id, decision.space_id, decision.run_id,
              decision.attempt_id, decision.decision, decision.reason_code,
              next_attempt_number, total_estimated_cost_usd, max_cost_usd,
              decision.metadata_json, decision.created_at
         FROM run_supervisor_decisions decision
         JOIN run_attempts attempt
           ON attempt.id = decision.attempt_id
          AND attempt.space_id = decision.space_id
        WHERE decision.space_id = $1 AND decision.run_id = $2
        ORDER BY attempt.attempt_number DESC, decision.id ASC`,
      [spaceId, runId],
    );
    return result.rows;
  }

  async markRunCancelling(input: {
    run_id: string;
    space_id: string;
    requested_at: string;
    reason?: string | null;
    requested_by_user_id?: string | null;
  }): Promise<RunRecord | null> {
    const errorJson = sanitizeErrorJson({
      error_code: "run_cancel_requested",
      error_text: input.reason ?? "Run cancellation requested.",
      requested_by_user_id: input.requested_by_user_id ?? null,
    });
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
         UPDATE runs
            SET status = 'cancelling',
                error_json = $3::jsonb,
                error_message = $4,
                updated_at = $5
          WHERE space_id = $1
            AND id = $2
            AND status IN ('queued', 'running', 'waiting_for_review', 'waiting_for_dependency', 'cancelling')
          RETURNING id, space_id, agent_id, agent_version_id, run_type, status, mode,
                    prompt, instruction, project_folder_id, session_id, project_id,
                    parent_run_id, root_run_id, run_group_id, delegation_id,
                    adapter_type, model_provider_id, required_sandbox_level,
                    trigger_origin, instructed_by_user_id, instructed_by_agent_id,
                    error_message, started_at, ended_at
       ), updated_attempt AS (
         UPDATE run_attempts a
            SET status = 'cancelling',
                cancel_requested_at = $5,
                error_code = 'run_cancel_requested',
                error_json = $3::jsonb,
                updated_at = $5
           FROM updated u
          WHERE a.space_id = u.space_id
            AND a.run_id = u.id
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id
            )
       )
       SELECT * FROM updated`,
      [
        input.space_id,
        input.run_id,
        JSON.stringify(errorJson),
        redactEvidenceText(input.reason ?? "Run cancellation requested."),
        input.requested_at,
      ],
    );
    return result.rows[0] ?? null;
  }

  async requeueRunForRetry(input: {
    run_id: string;
    space_id: string;
    updated_at: string;
    reason_code: string;
    attempt_number: number;
  }): Promise<RunRecord | null> {
    const attemptId = randomUUID();
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
         UPDATE runs
            SET status = 'queued',
                started_at = NULL,
                ended_at = NULL,
                error_json = jsonb_build_object(
                  'error_code', 'supervisor_retry_scheduled',
                  'reason_code', $4::text,
                  'attempt_number', $5::int
                ),
                error_message = $4,
                updated_at = $3
          WHERE space_id = $1
            AND id = $2
            AND status IN ('failed', 'degraded', 'orphaned')
            AND NOT EXISTS (
              SELECT 1 FROM run_execution_locks execution_lock
               WHERE execution_lock.run_id = runs.id
            )
          RETURNING id, space_id, agent_id, agent_version_id, runtime_profile_id,
                    run_type, status, mode, prompt, instruction, project_folder_id,
                    session_id, project_id, parent_run_id, root_run_id,
                    run_group_id, delegation_id, adapter_type, model_provider_id,
                    required_sandbox_level, trigger_origin, instructed_by_user_id,
                    instructed_by_agent_id, error_message, error_json,
                    started_at, ended_at, owner_user_id, visibility, access_level,
                    contract_snapshot_json, workflow_version_id
       ), inserted_attempt AS (
         INSERT INTO run_attempts (
           id, space_id, run_id, attempt_number, status,
           created_at, updated_at
         )
         SELECT $6, space_id, id, $5, 'queued', $3, $3
           FROM updated
         ON CONFLICT (space_id, run_id, attempt_number) DO NOTHING
       )
       SELECT * FROM updated`,
      [input.space_id, input.run_id, input.updated_at, input.reason_code, input.attempt_number, attemptId],
    );
    return result.rows[0] ?? null;
  }

  async holdRunForSupervisorReview(input: {
    run_id: string;
    space_id: string;
    updated_at: string;
    reason_code: string;
    message: string;
  }): Promise<RunRecord | null> {
    const errorJson = sanitizeErrorJson({
      error_code: input.reason_code,
      error_text: input.message,
      supervisor_review: true,
    });
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
         UPDATE runs
            SET status = 'waiting_for_review',
                error_json = $3::jsonb,
                error_message = $4,
                updated_at = $5
          WHERE space_id = $1
            AND id = $2
            AND status IN ('failed', 'degraded', 'orphaned')
          RETURNING id, space_id, agent_id, agent_version_id, run_type, status,
                    mode, prompt, instruction, project_folder_id, session_id,
                    project_id, parent_run_id, root_run_id, run_group_id,
                    delegation_id, adapter_type, model_provider_id,
                    required_sandbox_level, trigger_origin, instructed_by_user_id,
                    instructed_by_agent_id, error_message, error_json,
                    started_at, ended_at, owner_user_id, visibility, access_level,
                    contract_snapshot_json, workflow_version_id
       ), updated_attempt AS (
         UPDATE run_attempts a
            SET status = 'waiting_for_review',
                error_code = $6,
                error_json = $3::jsonb,
                last_activity_at = $5,
                updated_at = $5
           FROM updated u
          WHERE a.space_id = u.space_id
            AND a.run_id = u.id
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id
            )
       )
       SELECT * FROM updated`,
      [
        input.space_id,
        input.run_id,
        JSON.stringify(errorJson),
        redactEvidenceText(input.message),
        input.updated_at,
        input.reason_code,
      ],
    );
    return result.rows[0] ?? null;
  }

  async markRunWaitingForReview(input: {
    run_id: string;
    space_id: string;
    approval_code: string;
    message: string;
    paused_at: string;
  }): Promise<RunRecord | null> {
    const errorJson = sanitizeErrorJson({
      error_code: input.approval_code,
      error_text: input.message,
    });
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
       UPDATE runs
          SET status = 'waiting_for_review',
              error_json = $3::jsonb,
              error_message = $4,
              updated_at = $5
        WHERE space_id = $1
          AND id = $2
          AND status = 'running'
        RETURNING id, space_id, agent_id, agent_version_id, run_type, status, mode,
                  prompt, instruction, project_folder_id, session_id, project_id,
                  parent_run_id, root_run_id, run_group_id, delegation_id,
                  adapter_type, model_provider_id,
                  required_sandbox_level, trigger_origin, instructed_by_user_id,
                  instructed_by_agent_id, error_message, started_at, ended_at
       ), updated_attempt AS (
         UPDATE run_attempts a
            SET status = 'waiting_for_review',
                error_code = $6,
                error_json = $3::jsonb,
                last_activity_at = $5,
                updated_at = $5
           FROM updated u
          WHERE a.space_id = u.space_id
            AND a.run_id = u.id
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id
            )
       )
       SELECT * FROM updated`,
      [
        input.space_id,
        input.run_id,
        JSON.stringify(errorJson),
        redactEvidenceText(input.message),
        input.paused_at,
        input.approval_code,
      ],
    );
    return result.rows[0] ?? null;
  }

  async markRunWaitingForDependency(input: {
    run_id: string;
    space_id: string;
    output_json: unknown;
    paused_at: string;
  }): Promise<RunRecord | null> {
    const outputJson = sanitizeEvidenceJson(input.output_json ?? {});
    const result = await this.db.query<RunRecord>(
      `UPDATE runs
          SET status = 'waiting_for_dependency',
              output_json = $3::jsonb,
              error_json = '{}'::jsonb,
              error_message = NULL,
              updated_at = $4
        WHERE space_id = $1
          AND id = $2
          AND status = 'running'
        RETURNING id, space_id, agent_id, agent_version_id, run_type, status, mode,
                  prompt, instruction, project_folder_id, session_id, project_id,
                  parent_run_id, root_run_id, run_group_id, delegation_id,
                  adapter_type, model_provider_id,
                  required_sandbox_level, trigger_origin, instructed_by_user_id,
                  instructed_by_agent_id, error_message, output_json, error_json,
                  started_at, ended_at`,
      [
        input.space_id,
        input.run_id,
        JSON.stringify(outputJson),
        input.paused_at,
      ],
    );
    return result.rows[0] ?? null;
  }

  async markRunWaitingForDependencyWithConversationSession(
    input: {
      run_id: string;
      space_id: string;
      output_json: unknown;
      paused_at: string;
    },
    conversation: ConversationRuntimeTerminalSync,
  ): Promise<RunRecord | null> {
    const outputJson = sanitizeEvidenceJson(input.output_json ?? {});
    const result = await this.db.query<RunRecord>(
      `WITH candidate AS (
         SELECT id
           FROM runs
          WHERE space_id = $1
            AND id = $2
            AND status = 'running'
          FOR UPDATE
       ), synchronized_session AS (
         UPDATE session_conversation_backends
            SET runtime_session_id = $7,
                runtime_context_fingerprint = $8,
                runtime_message_cursor_id = $9,
                runtime_session_updated_at = $4::timestamptz,
                updated_at = $4
          WHERE id = $5
            AND runtime_state_key = $6
            AND $7::varchar IS NOT NULL
            AND EXISTS (SELECT 1 FROM candidate)
          RETURNING id
       )
       UPDATE runs run_row
          SET status = 'waiting_for_dependency',
              output_json = $3::jsonb,
              error_json = '{}'::jsonb,
              error_message = NULL,
              model_override_json = CASE
                WHEN EXISTS (SELECT 1 FROM synchronized_session)
                THEN jsonb_set(
                  run_row.model_override_json,
                  '{conversation_runtime,runtime_session_id}',
                  to_jsonb($7::varchar)
                )
                ELSE run_row.model_override_json
              END,
              updated_at = $4
         FROM candidate
        WHERE run_row.id = candidate.id
        RETURNING run_row.id, run_row.space_id, run_row.agent_id,
                  run_row.agent_version_id, run_row.run_type, run_row.status,
                  run_row.mode, run_row.prompt, run_row.instruction,
                  run_row.project_folder_id, run_row.session_id, run_row.project_id,
                  run_row.parent_run_id, run_row.root_run_id, run_row.run_group_id,
                  run_row.delegation_id, run_row.adapter_type,
                  run_row.model_provider_id, run_row.required_sandbox_level,
                  run_row.trigger_origin, run_row.instructed_by_user_id,
                  run_row.instructed_by_agent_id, run_row.error_message,
                  run_row.output_json, run_row.error_json, run_row.started_at,
                  run_row.ended_at`,
      [
        input.space_id,
        input.run_id,
        JSON.stringify(outputJson),
        input.paused_at,
        conversation.binding_id,
        conversation.runtime_state_key,
        conversation.runtime_session_id,
        conversation.context_fingerprint,
        conversation.message_cursor_id ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  async requeueWaitingDependencyRun(input: {
    run_id: string;
    space_id: string;
    prompt: string;
    resumed_at: string;
  }): Promise<RunRecord | null> {
    const resumeJson = sanitizeEvidenceJson({
      waiting_for_results_resume: {
        resumed_at: input.resumed_at,
      },
    });
    const result = await this.db.query<RunRecord>(
      `UPDATE runs
          SET status = 'queued',
              prompt = $3,
              model_override_json = CASE
                WHEN model_override_json->'conversation_runtime'->>'schema_version'
                     = 'conversation_runtime.v1'
                THEN jsonb_set(
                  model_override_json,
                  '{conversation_runtime,replay_prompt}',
                  to_jsonb($3::text)
                )
                ELSE model_override_json
              END,
              output_json = COALESCE(output_json, '{}'::jsonb) || $4::jsonb,
              error_json = COALESCE(error_json, '{}'::jsonb),
              error_message = NULL,
              updated_at = $5
        WHERE space_id = $1
          AND id = $2
          AND status = 'waiting_for_dependency'
          AND NOT EXISTS (
            SELECT 1
              FROM run_execution_locks execution_lock
             WHERE execution_lock.run_id = runs.id
          )
        RETURNING id, space_id, agent_id, agent_version_id, run_type, status, mode,
                  prompt, instruction, project_folder_id, session_id, project_id,
                  parent_run_id, root_run_id, run_group_id, delegation_id,
                  adapter_type, model_provider_id,
                  required_sandbox_level, trigger_origin, instructed_by_user_id,
                  instructed_by_agent_id, error_message, output_json, error_json,
                  started_at, ended_at`,
      [
        input.space_id,
        input.run_id,
        input.prompt,
        JSON.stringify(resumeJson),
        input.resumed_at,
      ],
    );
    return result.rows[0] ?? null;
  }

  async listWaitingDependencyRunsForRun(input: {
    space_id: string;
    run_group_id: string;
    dependency_run_id: string;
  }): Promise<RunRecord[]> {
    const result = await this.db.query<RunRecord>(
      `SELECT r.id, r.space_id, r.agent_id, r.agent_version_id,
              a.name AS agent_name,
              r.runtime_profile_id,
              av.system_prompt AS system_prompt,
              r.context_snapshot_id, r.run_type, r.status, r.mode, r.prompt,
              r.instruction, r.project_folder_id, r.session_id, r.parent_run_id,
              r.root_run_id, r.run_group_id, r.delegation_id,
              r.project_id, r.scheduled_at, r.adapter_type, r.capability_id,
              r.capabilities_json, r.model_provider_id, r.model_override_json, r.required_sandbox_level,
              r.runtime_profile_snapshot_json,
              COALESCE(r.runtime_profile_snapshot_json->'runtime_config_json', '{}'::jsonb) AS runtime_config_json,
              r.trigger_origin, r.instructed_by_user_id, r.instructed_by_agent_id, r.error_message,
              r.error_json, r.output_json, r.started_at,
              r.ended_at, r.created_at, r.updated_at, r.visibility
         FROM runs r
         LEFT JOIN agent_versions av
           ON av.id = r.agent_version_id
          AND av.space_id = r.space_id
          AND av.agent_id = r.agent_id
         LEFT JOIN agents a
           ON a.id = r.agent_id
          AND a.space_id = r.space_id
        WHERE r.space_id = $1
          AND r.run_group_id = $2
          AND r.status = 'waiting_for_dependency'
          AND r.output_json->'waiting_for_results'->'depends_on_run_ids' ? $3::text
        ORDER BY r.updated_at ASC, r.id ASC`,
      [input.space_id, input.run_group_id, input.dependency_run_id],
    );
    return result.rows;
  }

  async grantRunApprovalAndRequeue(input: {
    run_id: string;
    space_id: string;
    granted_by_user_id: string;
    granted_at: string;
  }): Promise<RunRecord | null> {
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
       UPDATE runs
          SET status = 'queued',
              permission_snapshot_json = jsonb_set(
                COALESCE(permission_snapshot_json, '{}'),
                '{policy_grants}',
                COALESCE(permission_snapshot_json->'policy_grants', '[]') ||
                  jsonb_build_array(jsonb_build_object(
                    'approval_code', error_json->>'error_code',
                    'granted_by_user_id', $3::text,
                    'granted_at', $4::text
                  ))
              ),
              error_json = NULL,
              error_message = NULL,
              updated_at = $4::timestamptz
        WHERE space_id = $1
          AND id = $2
          AND status = 'waiting_for_review'
        RETURNING id, space_id, agent_id, agent_version_id, run_type, status, mode,
                  prompt, instruction, project_folder_id, session_id, project_id,
                  parent_run_id, root_run_id, run_group_id, delegation_id,
                  adapter_type, model_provider_id, permission_snapshot_json,
                  required_sandbox_level, trigger_origin, instructed_by_user_id,
                  instructed_by_agent_id, error_message, started_at, ended_at
       ), updated_attempt AS (
         UPDATE run_attempts a
            SET status = 'queued',
                error_json = COALESCE(a.error_json, '{}'::jsonb) || jsonb_build_object(
                  'approval_granted_by_user_id', $3::text,
                  'approval_granted_at', $4::text
                ),
                updated_at = $4::timestamptz
           FROM updated u
          WHERE a.space_id = u.space_id
            AND a.run_id = u.id
            AND a.status = 'waiting_for_review'
            AND a.attempt_number = (
              SELECT max(candidate.attempt_number)
                FROM run_attempts candidate
               WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id
            )
       )
       SELECT * FROM updated`,
      [input.space_id, input.run_id, input.granted_by_user_id, input.granted_at],
    );
    return result.rows[0] ?? null;
  }

  async requeueApprovedAuthorizationRequest(input: {
    run_id: string;
    space_id: string;
    authorization_request_id: string;
    resumed_at: string;
  }): Promise<RunRecord | null> {
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
         UPDATE runs
            SET status = 'queued',
                error_json = NULL,
                error_message = NULL,
                updated_at = $4
          WHERE id = $1
            AND space_id = $2
            AND status = 'waiting_for_review'
            AND error_json->>'authorization_request_id' = $3
            AND NOT EXISTS (
              SELECT 1 FROM run_execution_locks execution_lock
               WHERE execution_lock.run_id = runs.id
            )
            AND EXISTS (
              SELECT 1 FROM authorization_requests authorization_request
               WHERE authorization_request.id = $3
                 AND authorization_request.space_id = $2
                 AND authorization_request.run_id = $1
                 AND authorization_request.status = 'approved'
            )
          RETURNING *
       ), updated_attempt AS (
         UPDATE run_attempts attempt
            SET status = 'queued',
                error_code = NULL,
                error_json = COALESCE(attempt.error_json, '{}'::jsonb)
                  || jsonb_build_object(
                    'authorization_request_id', $3::text,
                    'authorization_resumed_at', $4::text
                  ),
                updated_at = $4
           FROM updated
          WHERE attempt.run_id = updated.id
            AND attempt.space_id = updated.space_id
            AND attempt.status = 'waiting_for_review'
       )
       SELECT * FROM updated`,
      [
        input.run_id,
        input.space_id,
        input.authorization_request_id,
        input.resumed_at,
      ],
    );
    return result.rows[0] ?? null;
  }

  async resumeRunAfterSupervisorReview(input: {
    run_id: string;
    space_id: string;
    resumed_by_user_id: string;
    resumed_at: string;
  }): Promise<RunRecord | null> {
    const attemptId = randomUUID();
    const result = await this.db.query<RunRecord>(
      `WITH updated AS (
         UPDATE runs
            SET status = 'queued',
                error_json = NULL,
                error_message = NULL,
                updated_at = $4::timestamptz
          WHERE space_id = $1
            AND id = $2
            AND status = 'waiting_for_review'
            AND COALESCE(error_json->>'supervisor_review', 'false') = 'true'
          RETURNING id, space_id, agent_id, agent_version_id, run_type, status,
                    mode, prompt, instruction, project_folder_id, session_id, project_id,
                    parent_run_id, root_run_id, run_group_id, delegation_id,
                    adapter_type, model_provider_id, required_sandbox_level,
                    trigger_origin, instructed_by_user_id, instructed_by_agent_id,
                    error_message, error_json, started_at, ended_at,
                    owner_user_id, visibility, access_level,
                    contract_snapshot_json, workflow_version_id
       ), inserted_attempt AS (
         INSERT INTO run_attempts (
           id, space_id, run_id, attempt_number, status,
           error_json, created_at, updated_at
         )
         SELECT $5, u.space_id, u.id,
                COALESCE((SELECT max(candidate.attempt_number)
                            FROM run_attempts candidate
                           WHERE candidate.space_id = u.space_id AND candidate.run_id = u.id), 0) + 1,
                'queued',
                jsonb_build_object(
                  'error_code', 'supervisor_review_resumed',
                  'resumed_by_user_id', $3::text,
                  'resumed_at', $4::timestamptz
                ),
                $4::timestamptz, $4::timestamptz
           FROM updated u
       )
       SELECT * FROM updated`,
      [input.space_id, input.run_id, input.resumed_by_user_id, input.resumed_at, attemptId],
    );
    return result.rows[0] ?? null;
  }

  async markRunDegraded(input: {
    run_id: string;
    space_id: string;
    completed_at: string;
    error_code: string;
    error_message: string;
    diagnostics?: unknown;
  }): Promise<RunRecord | null> {
    const errorJson = sanitizeErrorJson({
      error_code: input.error_code,
      error_text: input.error_message,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
    const result = await this.db.query<RunRecord>(
      `UPDATE runs
          SET status = 'degraded',
              error_json = COALESCE(error_json, '{}'::jsonb) || $3::jsonb,
              updated_at = $4,
              error_message = $5
        WHERE space_id = $1
          AND id = $2
          AND status = 'succeeded'
        RETURNING id, space_id, agent_id, agent_version_id, run_type, status, mode,
                  prompt, instruction, project_folder_id, session_id, project_id,
                  parent_run_id, root_run_id, run_group_id, delegation_id,
                  adapter_type, model_provider_id,
                  required_sandbox_level, trigger_origin, instructed_by_user_id,
                  instructed_by_agent_id, error_message, started_at, ended_at`,
      [
        input.space_id,
        input.run_id,
        JSON.stringify(errorJson),
        input.completed_at,
        redactEvidenceText(input.error_message),
      ],
    );
    return result.rows[0] ?? null;
  }

  async appendRunEvent(input: RunEventInput): Promise<RunEventRecord> {
    // $1/$2 appear both as inserted values (deduced as the varchar column
    // type) and in the scalar subquery comparison (deduced as text via the
    // text equality operator). Without the explicit ::varchar casts PostgreSQL
    // fails with "inconsistent types deduced for parameter".
    const result = await this.db.query<RunEventRecord>(
      `INSERT INTO run_events (
          id, space_id, run_id, attempt_number, event_index, step_id, actor_id, event_type,
          status, summary, error_code, error_message, project_folder_id,
          artifact_id, proposal_id, data_exposure_level,
          trust_level, metadata_json, created_at
       )
       VALUES ($3, $1, $2,
               (SELECT MAX(attempt_number)
                  FROM run_attempts
                 WHERE space_id = $1::varchar AND run_id = $2::varchar),
               (SELECT COALESCE(MAX(event_index) + 1, 0)
                  FROM run_events
                 WHERE space_id = $1::varchar AND run_id = $2::varchar),
               $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16::jsonb, $17)
       ON CONFLICT (space_id, run_id)
         WHERE event_type = 'chat_completed'
       DO NOTHING
       RETURNING id, space_id, run_id, event_index, event_type, status`,
      [
        input.space_id,
        input.run_id,
        randomUUID(),
        input.step_id ?? null,
        input.actor_id ?? null,
        input.event_type,
        input.status,
        redactEvidenceText(input.summary),
        input.error_code ?? null,
        redactEvidenceText(input.error_message),
        input.project_folder_id ?? null,
        input.artifact_id ?? null,
        input.proposal_id ?? null,
        input.data_exposure_level ?? null,
        input.trust_level ?? null,
        JSON.stringify(sanitizeEvidenceJson(input.metadata_json ?? {})),
        new Date().toISOString(),
      ],
    );
    const row = result.rows[0];
    if (row) return row;
    if (input.event_type === "chat_completed") {
      const existing = await this.db.query<RunEventRecord>(
        `SELECT id, space_id, run_id, event_index, event_type, status
           FROM run_events
          WHERE space_id = $1
            AND run_id = $2
            AND event_type = 'chat_completed'
          LIMIT 1`,
        [input.space_id, input.run_id],
      );
      if (existing.rows[0]) return existing.rows[0];
    }
    throw new Error("RunEvent append returned no row");
  }

  async createRunStep(input: RunStepInput): Promise<RunStepRecord> {
    // Same ::varchar casts as appendRunEvent — see the comment there.
    const result = await this.db.query<RunStepRecord>(
      `INSERT INTO run_steps (
          id, space_id, run_id, attempt_number, parent_step_id, actor_id, step_index,
          step_type, status, title, project_folder_id, session_id, task_id,
          artifact_id, proposal_id, started_at, ended_at,
          input_summary, output_summary, error_type, error_message,
          metadata_json, created_at, updated_at
       )
       VALUES ($3, $1, $2,
               (SELECT MAX(attempt_number)
                  FROM run_attempts
                 WHERE space_id = $1::varchar AND run_id = $2::varchar),
               $4, $5,
               (SELECT COALESCE(MAX(step_index) + 1, 0)
                  FROM run_steps
                 WHERE space_id = $1::varchar AND run_id = $2::varchar),
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20::jsonb, $21, $21)
       RETURNING id, space_id, run_id, step_index, step_type, status`,
      [
        input.space_id,
        input.run_id,
        randomUUID(),
        input.parent_step_id ?? null,
        input.actor_id,
        input.step_type,
        input.status,
        input.title ?? null,
        input.project_folder_id ?? null,
        input.session_id ?? null,
        input.task_id ?? null,
        input.artifact_id ?? null,
        input.proposal_id ?? null,
        input.started_at ?? null,
        input.ended_at ?? null,
        redactEvidenceText(input.input_summary),
        redactEvidenceText(input.output_summary),
        input.error_type ?? null,
        redactEvidenceText(input.error_message),
        JSON.stringify(sanitizeEvidenceJson(input.metadata_json ?? {})),
        new Date().toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("RunStep insert returned no row");
    return row;
  }

  async updateRunStepStatus(input: {
    step_id: string;
    run_id: string;
    space_id: string;
    status: "succeeded" | "failed" | "skipped" | "cancelled";
    ended_at: string;
    output_summary?: string | null;
    error_type?: string | null;
    error_message?: string | null;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE run_steps
          SET status = $4,
              ended_at = $5,
              output_summary = COALESCE($6, output_summary),
              error_type = COALESCE($7, error_type),
              error_message = COALESCE($8, error_message),
              updated_at = $5
        WHERE id = $1 AND run_id = $2 AND space_id = $3`,
      [
        input.step_id,
        input.run_id,
        input.space_id,
        input.status,
        input.ended_at,
        redactEvidenceText(input.output_summary),
        input.error_type ?? null,
        redactEvidenceText(input.error_message),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async tryAcquireExecutionLock(input: {
    run_id: string;
    worker_id: string;
    job_id?: string | null;
  }): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO run_execution_locks (run_id, locked_at, worker_id, job_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id) DO NOTHING`,
      [input.run_id, new Date().toISOString(), input.worker_id, input.job_id ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseExecutionLock(runId: string): Promise<void> {
    await this.db.query("DELETE FROM run_execution_locks WHERE run_id = $1", [runId]);
  }
}

function normalizeContextArtifactIds(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeRunCapabilitiesJson(value: unknown[] | null | undefined): string[] {
  if (value === undefined || value === null) return [];
  const result = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (result.length !== value.length) {
    throw new RunCreateValidationError("capabilities_json must contain non-empty strings");
  }
  return [...new Set(result)];
}
