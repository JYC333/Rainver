import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import type { Pool } from "../../db/pool.js";
import type {
  ExecutionControlSnapshot,
  RuntimeContextResolvedPolicy,
} from "@agent-space/protocol";
import type { RunRecord } from "../runs/repository.js";
import { assembleRunInputEnvelope } from "../runs/runInputEnvelope.js";
import { runtimeProviderEgressDestination } from "../retrieval/egress/egressPolicy.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";

export interface ExecutionControlSnapshotInputs {
  cliCredentialProfileId?: string | null;
  policyDecisionRecordIds?: readonly string[];
  /** A remote run's provider is resolved at execution, not predicted here. */
  executesRemotely?: boolean;
}

export interface EffectiveRunContextBindings {
  workContextScopeId: string;
  workContextSetupRef: { type: "work_context_setup"; id: string; version: string } | null;
  runtimeProfileId: string | null;
  projectBriefRef: { type: "project_brief_version"; id: string; version: string } | null;
  projectInstructionRef: { type: "project_instruction_version"; id: string; version: string } | null;
  projectId: string | null;
  projectFolderId: string | null;
  agentId: string | null;
}

export class ExecutionControlSnapshotRepository {
  constructor(private readonly db: Pool) {}

  async createForRun(
    run: RunRecord,
    resolvedPolicy: RuntimeContextResolvedPolicy,
    inputs: ExecutionControlSnapshotInputs = {},
    effectiveBindings?: EffectiveRunContextBindings,
  ): Promise<ExecutionControlSnapshot> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const providerRequired = run.adapter_type === "model_api" || run.adapter_type === "ts_agent_host";
    // For a run that executes on a remote host, `runs.model_provider_id` at
    // this point is the router's *prediction*: the remote path resolves its
    // own binding later, from the dispatch message or the Host default, and
    // writes back what it actually used. Treating the prediction as this
    // run's destination would deny egress for, or fail preflight on, a
    // provider the run never touches — and would record a destination that is
    // not the one traffic went to.
    const providerId = inputs.executesRemotely ? null : run.model_provider_id;
    const providerDestination = providerId !== null;
    const localCliDestination = !providerDestination
      && (run.adapter_type === "claude_code" || run.adapter_type === "codex_cli" || run.adapter_type === "opencode");
    if (providerRequired && !providerId) {
      throw new Error("Execution preflight requires a resolved model provider");
    }
    const constraints = resolvedPolicy.policy.constraints;
    const permissionSnapshot = recordValue(run.permission_snapshot_json);
    const automationId = run.trigger_origin === "automation" || run.root_run_id
      ? await this.automationIdForRun(run.space_id, run.id, run.root_run_id ?? null)
      : null;
    const runOutputContract = assembleRunInputEnvelope(run).output_contract;
    const hasOutputContract = runOutputContract.structured_output !== null
      || runOutputContract.required_outputs.length > 0;
    const modelOverride = recordValue(run.model_override_json);
    const bindings = effectiveBindings ?? await this.resolveEffectiveBindingsForRun(run);
    const projectContextRefs = await this.resolveProjectContextRefs(run.space_id, bindings, resolvedPolicy);
    const egress = providerId
      ? await this.providerEgress(run.space_id, providerId, run.adapter_type)
      : null;
    if (providerId && !egress!.allowed) {
      throw new Error("Execution preflight denied external model egress for this Space");
    }
    const localCliEgressAllowed = localCliDestination
      ? (await readSpaceRetrievalSettings(this.db, run.space_id)).externalEgressEnabled
      : false;
    if (localCliDestination && !localCliEgressAllowed) {
      throw new Error("Execution preflight denied external CLI egress for this Space");
    }
    const unrestrictedSourceCategories = [
      ...(constraints.explicit_reference_types === undefined ? ["explicit_reference" as const] : []),
      ...(constraints.pinned_reference_types === undefined ? ["pinned_reference" as const] : []),
      ...(constraints.memory_layers === undefined ? ["memory" as const] : []),
      ...(constraints.retrieval_domains === undefined ? ["retrieval" as const] : []),
    ];
    const allowedSourceTypes = [
      ...(constraints.explicit_reference_types ?? []),
      ...(constraints.memory_layers ?? []).map((layer) => `memory:${layer}`),
      ...(constraints.retrieval_domains ?? []).map((domain) => `retrieval:${domain}`),
      ...(constraints.allow_project_brief === false
        || resolvedPolicy.policy.preferences.include_project_brief === false ? [] : ["project_brief"]),
      ...(constraints.allow_project_instructions === false
        || resolvedPolicy.policy.preferences.include_project_instructions === false ? [] : ["project_instruction"]),
    ];
    const snapshot = protocol.ExecutionControlSnapshotSchema.parse({
      id,
      version: 2,
      space_id: run.space_id,
      actor: automationId
        ? {
            type: "automation",
            automation_id: automationId,
            instructed_by_user_id: run.instructed_by_user_id ?? run.owner_user_id ?? null,
          }
        : run.instructed_by_agent_id
        ? {
            type: "agent",
            agent_id: run.instructed_by_agent_id,
            instructed_by_user_id: run.instructed_by_user_id ?? run.owner_user_id ?? null,
          }
        : run.trigger_origin === "system"
          ? {
              type: "system",
              service_name: "run_orchestration",
              instructed_by_user_id: run.instructed_by_user_id ?? run.owner_user_id ?? null,
            }
        : run.trigger_origin === "job" || run.trigger_origin === "autonomous"
          ? {
              type: "service",
              service_name: run.trigger_origin === "job" ? "job_worker" : "autonomous_scheduler",
              instructed_by_user_id: run.instructed_by_user_id ?? run.owner_user_id ?? null,
            }
        : run.instructed_by_user_id || run.owner_user_id
          ? { type: "user", user_id: run.instructed_by_user_id ?? run.owner_user_id }
        : { type: "agent", agent_id: run.agent_id, instructed_by_user_id: null },
      project_id: bindings.projectId,
      project_folder_id: bindings.projectFolderId,
      agent_id: bindings.agentId,
      work_context_scope_id: bindings.workContextScopeId,
      work_context_setup_ref: bindings.workContextSetupRef,
      project_brief_ref: projectContextRefs.brief,
      project_instruction_ref: projectContextRefs.instruction,
      readable_scope: {
        space_id: run.space_id,
        allowed_source_types: [...new Set(allowedSourceTypes)].sort(),
        unrestricted_source_categories: unrestrictedSourceCategories,
        explicit_reference_types: [...new Set(constraints.explicit_reference_types ?? [])].sort(),
        explicit_reference_max: constraints.explicit_reference_max ?? null,
        pinned_reference_types: [...new Set(constraints.pinned_reference_types ?? [])].sort(),
        pinned_reference_max: constraints.pinned_reference_max ?? null,
        retrieval_enabled: resolvedPolicy.policy.preferences.retrieval_enabled !== false,
        retrieval_max_candidates: constraints.retrieval_max_candidates ?? null,
        explicit_reference_sensitivity_ceiling:
          constraints.explicit_reference_sensitivity_ceiling ?? null,
        allowed_source_ids: [],
        excluded_source_ids: [],
        sensitivity_ceiling: "highly_restricted",
      },
      egress: providerDestination
        ? {
            destination_type: "model_provider",
            destination_id: providerId,
            sensitivity_ceiling: "highly_restricted",
            external_egress_allowed: egress!.external,
            allowed_provider_ids: egress!.allowed ? [providerId] : [],
          }
        : localCliDestination
          ? {
              destination_type: "local_cli",
              destination_id: run.adapter_type,
              sensitivity_ceiling: "highly_restricted",
              external_egress_allowed: true,
              allowed_provider_ids: [],
            }
          : {
            destination_type: "local_runtime",
            destination_id: run.adapter_type ?? "local_runtime",
            sensitivity_ceiling: "highly_restricted",
            external_egress_allowed: false,
            allowed_provider_ids: [],
            },
      tool_grant_refs: refsFromRecords(permissionSnapshot.tool_grants, "tool_grant", "action_id"),
      credential_channel_ref: providerId
        ? { type: "provider_credential_channel", id: providerId }
        : inputs.cliCredentialProfileId
          ? { type: "cli_credential_profile", id: inputs.cliCredentialProfileId }
          : null,
      sandbox_profile_ref: run.required_sandbox_level
        ? { type: "sandbox_profile", id: run.required_sandbox_level }
        : null,
      approval_refs: refsFromRecords(permissionSnapshot.policy_grants, "policy_approval", "approval_code"),
      persistence: {
        event_capture_allowed: true,
        checkpoint_allowed: (constraints.continuity_modes ?? ["checkpoint"]).includes("checkpoint"),
        memory_proposals_allowed: false,
        sealed_payload_retention_seconds: constraints.allow_sealed_payload === false
          ? 0
          : constraints.sealed_payload_retention_seconds ?? 0,
      },
      output_contract: {
        schema_ref: hasOutputContract
          ? {
              type: "run_output_contract",
              id: run.id,
              version: runOutputContract.schema_version,
            }
          : null,
        unstructured_output_allowed: runOutputContract.structured_output === null,
        max_output_tokens: nonnegativeInteger(modelOverride.max_output_tokens)
          ?? nonnegativeInteger(modelOverride.max_tokens),
      },
      governing_policy_version_refs: resolvedPolicy.contributing_versions,
      policy_decision_refs: [...new Set(inputs.policyDecisionRecordIds ?? [])]
        .sort()
        .map((decisionId) => ({ type: "policy_decision_record", id: decisionId })),
      created_at: createdAt,
    });
    await this.db.query(
      `INSERT INTO execution_control_snapshots (id, space_id, run_id, snapshot_json, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [id, run.space_id, run.id, JSON.stringify(snapshot), createdAt],
    );
    return snapshot;
  }

  private async automationIdForRun(
    spaceId: string,
    runId: string,
    rootRunId: string | null,
  ): Promise<string | null> {
    const result = await this.db.query<{ automation_id: string }>(
      `SELECT automation_run.automation_id
         FROM automation_runs automation_run
         JOIN automations automation
           ON automation.id = automation_run.automation_id
          AND automation.space_id = $2
        WHERE automation_run.run_id = $1
           OR ($3::varchar IS NOT NULL AND automation_run.run_id = $3)
        ORDER BY CASE WHEN automation_run.run_id = $1 THEN 0 ELSE 1 END,
                 automation_run.created_at DESC
        LIMIT 1`,
      [runId, spaceId, rootRunId],
    );
    return result.rows[0]?.automation_id ?? null;
  }

  async resolveEffectiveBindingsForRun(
    run: RunRecord,
    requiredSetupRef?: { type: "work_context_setup"; id: string; version: string } | null,
  ): Promise<EffectiveRunContextBindings> {
    const workContextScopeId = await this.workContextScopeId(run);
    const userId = run.instructed_by_user_id ?? run.owner_user_id ?? null;
    const setup = userId
      ? (await this.db.query<{
          id: string;
          version: number | string;
          project_id: string | null;
          project_folder_id: string | null;
          agent_id: string | null;
          runtime_ref_json: unknown;
          project_brief_version_id: string | null;
          project_instruction_version_id: string | null;
          project_brief_version: string | null;
          project_instruction_version: string | null;
        }>(
          `SELECT id, version, project_id, project_folder_id, agent_id, runtime_ref_json,
                  project_brief_version_id, project_instruction_version_id,
                  (SELECT version FROM project_brief_versions WHERE id=project_brief_version_id) AS project_brief_version,
                  (SELECT version FROM project_instruction_versions WHERE id=project_instruction_version_id) AS project_instruction_version
             FROM work_context_setups
            WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3
              AND ($4::varchar IS NULL OR id=$4)
              AND ($5::integer IS NULL OR version=$5)
            ORDER BY version DESC
            LIMIT 1`,
          [
            run.space_id,
            workContextScopeId,
            userId,
            requiredSetupRef?.id ?? null,
            requiredSetupRef ? Number(requiredSetupRef.version) : null,
          ],
        )).rows[0]
      : undefined;
    if (requiredSetupRef && (!setup || setup.id !== requiredSetupRef.id
      || String(setup.version) !== requiredSetupRef.version)) {
      throw new Error("Required Work Context Setup version is unavailable for this Run");
    }
    return {
      workContextScopeId,
      workContextSetupRef: setup
        ? { type: "work_context_setup", id: setup.id, version: String(setup.version) }
        : null,
      projectId: setup?.project_id ?? run.project_id,
      projectFolderId: setup?.project_folder_id ?? run.project_folder_id,
      agentId: setup?.agent_id ?? run.agent_id,
      runtimeProfileId: runtimeProfileId(setup?.runtime_ref_json),
      projectBriefRef: setup?.project_brief_version_id
        ? { type: "project_brief_version", id: setup.project_brief_version_id, version: setup.project_brief_version! }
        : null,
      projectInstructionRef: setup?.project_instruction_version_id
        ? { type: "project_instruction_version", id: setup.project_instruction_version_id, version: setup.project_instruction_version! }
        : null,
    };
  }

  private async resolveProjectContextRefs(
    spaceId: string,
    bindings: EffectiveRunContextBindings,
    resolvedPolicy: RuntimeContextResolvedPolicy,
  ): Promise<{
    brief: { type: "project_brief_version"; id: string; version: string } | null;
    instruction: { type: "project_instruction_version"; id: string; version: string } | null;
  }> {
    if (bindings.workContextSetupRef || !bindings.projectId) {
      return { brief: bindings.projectBriefRef, instruction: bindings.projectInstructionRef };
    }
    const result = await this.db.query<{
      brief_id: string | null;
      brief_version: string | null;
      instruction_id: string | null;
      instruction_version: string | null;
    }>(
      `SELECT brief.id AS brief_id, brief.version AS brief_version,
              instruction.id AS instruction_id, instruction.version AS instruction_version
         FROM projects project
         LEFT JOIN project_brief_versions brief
           ON brief.id=project.active_brief_version_id AND brief.status='published'
         LEFT JOIN project_instruction_versions instruction
           ON instruction.id=project.active_instruction_version_id AND instruction.status='published'
        WHERE project.id=$1 AND project.space_id=$2 AND project.deleted_at IS NULL`,
      [bindings.projectId, spaceId],
    );
    const row = result.rows[0];
    const briefAllowed = resolvedPolicy.policy.constraints.allow_project_brief !== false
      && resolvedPolicy.policy.preferences.include_project_brief !== false;
    const instructionAllowed = resolvedPolicy.policy.constraints.allow_project_instructions !== false
      && resolvedPolicy.policy.preferences.include_project_instructions !== false;
    return {
      brief: briefAllowed && row?.brief_id && row.brief_version
        ? { type: "project_brief_version", id: row.brief_id, version: row.brief_version }
        : null,
      instruction: instructionAllowed && row?.instruction_id && row.instruction_version
        ? { type: "project_instruction_version", id: row.instruction_id, version: row.instruction_version }
        : null,
    };
  }

  private async workContextScopeId(run: RunRecord): Promise<string> {
    if (run.session_id) {
      const roomRecipient = await this.db.query<{ id: string }>(
        `SELECT recipient.id
           FROM sessions session
           JOIN room_agent_members recipient
             ON recipient.room_id=session.room_id
            AND recipient.space_id=session.space_id
            AND recipient.agent_id=$3
            AND recipient.status='active'
          WHERE session.id=$1 AND session.space_id=$2 AND session.room_id IS NOT NULL
          LIMIT 1`,
        [run.session_id, run.space_id, run.agent_id],
      );
      if (roomRecipient.rows[0]) return roomRecipient.rows[0].id;
    }
    const rootRunId = run.root_run_id ?? run.id;
    const result = await this.db.query<{ id: string }>(
      `SELECT id
         FROM workflow_executions
        WHERE space_id=$1 AND root_run_id=$2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [run.space_id, rootRunId],
    );
    return result.rows[0]?.id ?? run.session_id ?? rootRunId;
  }

  private async providerEgress(
    spaceId: string,
    providerId: string,
    adapterType: string | null,
  ): Promise<{ external: boolean; allowed: boolean }> {
    const result = await this.db.query<{
      provider_type: string;
      base_url: string | null;
      config_json: unknown;
    }>(
      `SELECT provider.provider_type, provider.base_url, provider.config_json
         FROM model_provider_space_grants provider_grant
         JOIN model_providers provider
           ON provider.id = provider_grant.provider_id
          AND provider.enabled = TRUE
        WHERE provider_grant.space_id = $1
          AND provider_grant.provider_id = $2
          AND provider_grant.enabled = TRUE`,
      [spaceId, providerId],
    );
    const provider = result.rows[0];
    if (!provider) throw new Error("Execution preflight requires an enabled provider grant");
    const destination = runtimeProviderEgressDestination(adapterType, provider);
    if (destination === "local_provider") return { external: false, allowed: true };
    const settings = await readSpaceRetrievalSettings(this.db, spaceId);
    return { external: settings.externalEgressEnabled, allowed: settings.externalEgressEnabled };
  }
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function runtimeProfileId(value: unknown): string | null {
  const ref = recordValue(value);
  return ref.type === "runtime_profile" && typeof ref.id === "string" ? ref.id : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function refsFromRecords(
  value: unknown,
  type: string,
  idKey: string,
): Array<{ type: string; id: string }> {
  if (!Array.isArray(value)) return [];
  const ids = value.flatMap((item) => {
    const id = recordValue(item)[idKey];
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
  return [...new Set(ids)].sort().map((id) => ({ type, id }));
}
