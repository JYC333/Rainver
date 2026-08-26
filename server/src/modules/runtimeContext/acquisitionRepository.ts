import type { Pool } from "../../db/pool.js";
import * as protocol from "@agent-space/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../memory/repository.js";
import { HttpError } from "../routeUtils/common.js";
import { canAccessProject } from "../memory/projectAccess.js";
import type { ExecutionControlSnapshot } from "@agent-space/protocol";
import {
  resolveExplicitReferences,
  resolveWorkContextScopeBindings,
} from "../runtimeContext/workContextService.js";

interface PersonalGrantRow {
  id: string;
  granting_user_id: string;
  personal_space_id: string;
  target_space_id: string;
  access_mode: string;
  memory_filter_json: unknown;
  status: "active" | "used";
}

interface PersonalMemorySummaryRow {
  memory_type: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface PersonalGrantAcquisition {
  summary: string;
  metadata: {
    grant_id: string;
    granting_user_id: string;
    personal_space_id: string;
    target_space_id: string;
    access_mode: "summary_only";
    memory_count: number;
    raw_private_memory_included: false;
    personal_summary_persisted: false;
    grant_status: "active" | "used";
  };
}

export interface RunContextRecord {
  id: string;
  space_id: string;
  agent_id: string | null;
  agent_version_id: string | null;
  prompt: string | null;
  instruction: string | null;
  error_json: unknown;
  run_group_id: string | null;
  agent_name: string | null;
  project_folder_id: string | null;
  project_id: string | null;
  session_id: string | null;
  root_run_id: string | null;
  workflow_execution_id: string | null;
  instructed_by_user_id: string | null;
  owner_user_id: string | null;
  capability_id: string | null;
  trigger_origin: string | null;
  adapter_type?: string | null;
  data_exposure_level: string | null;
  trust_level: string | null;
  visibility: string;
  has_context_taint: boolean;
  context_taint_json: unknown;
  contract_snapshot_json?: unknown;
  system_prompt: string | null;
  capabilities_json: unknown;
  memory_policy_json: unknown;
  model_config_json: unknown;
  model_override_json?: unknown;
}

/**
 * Read-side acquisition for canonical Runtime Context planning.
 */
export class PgRuntimeContextAcquisitionRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgRuntimeContextAcquisitionRepository {
    if (!config.databaseUrl) {
      throw new Error("Run context repository requires SERVER_DATABASE_URL");
    }
    return new PgRuntimeContextAcquisitionRepository(getDbPool(config.databaseUrl));
  }

  static poolFromConfig(config: ServerConfig): Pool {
    if (!config.databaseUrl) {
      throw new Error("Run context repository requires SERVER_DATABASE_URL");
    }
    return getDbPool(config.databaseUrl);
  }

  async loadRun(spaceId: string, runId: string): Promise<RunContextRecord | null> {
    const result = await this.db.query<RunContextRecord>(
      `SELECT r.id, r.space_id, r.agent_id, r.agent_version_id,
              r.prompt, r.instruction, r.error_json,
              r.run_group_id, agent.name AS agent_name,
              r.project_folder_id, r.project_id, r.session_id, r.root_run_id,
              (SELECT execution.id
                 FROM workflow_executions execution
                WHERE execution.space_id = r.space_id
                  AND execution.root_run_id = COALESCE(r.root_run_id, r.id)
                ORDER BY execution.created_at DESC, execution.id DESC
                LIMIT 1) AS workflow_execution_id,
              r.instructed_by_user_id, r.owner_user_id, r.capability_id, r.trigger_origin, r.adapter_type,
              r.data_exposure_level, r.trust_level, r.visibility,
              r.has_context_taint, r.context_taint_json,
              r.contract_snapshot_json,
              av.system_prompt,
              COALESCE(NULLIF(r.capabilities_json, '[]'::jsonb), av.capabilities_json) AS capabilities_json,
              av.memory_policy_json, av.model_config_json, r.model_override_json
         FROM runs r
         LEFT JOIN agent_versions av
           ON av.id = r.agent_version_id
          AND av.space_id = r.space_id
          AND av.agent_id = r.agent_id
         LEFT JOIN agents agent
           ON agent.id = r.agent_id
          AND agent.space_id = r.space_id
        WHERE r.space_id = $1 AND r.id = $2
        LIMIT 1`,
      [spaceId, runId],
    );
    return result.rows[0] ?? null;
  }

  async loadExecutionControlSnapshot(
    spaceId: string,
    runId: string,
  ): Promise<ExecutionControlSnapshot | null> {
    const result = await this.db.query<{ snapshot_json: unknown }>(
      `SELECT snapshot_json
         FROM execution_control_snapshots
        WHERE space_id=$1 AND run_id=$2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [spaceId, runId],
    );
    const snapshot = result.rows[0]?.snapshot_json;
    if (!snapshot || typeof snapshot !== "object") return null;
    return protocol.ExecutionControlSnapshotSchema.parse(snapshot);
  }

  /**
   * Resolve the aggregate-only grant projection without consuming it. The
   * Delivery authorizer performs the active -> consuming -> used transition in
   * the same transaction that persists the Invocation Delivery.
   */
  async loadPersonalGrantForRun(run: RunContextRecord): Promise<PersonalGrantAcquisition | null> {
    if (!run.instructed_by_user_id) return null;
    const now = new Date().toISOString();
    const result = await this.db.query<PersonalGrantRow>(
      `SELECT id,granting_user_id,personal_space_id,target_space_id,
              access_mode,memory_filter_json,status
         FROM personal_memory_grants
        WHERE target_run_id=$1 AND granting_user_id=$2 AND target_space_id=$3
          AND grant_scope='run' AND access_mode='summary_only'
          AND target_agent_id IS NULL
          AND (status='used' OR (status='active' AND read_expires_at > $4))
        ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1`,
      [run.id, run.instructed_by_user_id, run.space_id, now],
    );
    const grant = result.rows[0];
    if (!grant) return null;
    const memories = await this.retrieveEligiblePersonalMemorySummary(grant);
    return {
      summary: generatePersonalSummary(memories),
      metadata: {
        grant_id: grant.id,
        granting_user_id: grant.granting_user_id,
        personal_space_id: grant.personal_space_id,
        target_space_id: grant.target_space_id,
        access_mode: "summary_only",
        memory_count: memories.length,
        raw_private_memory_included: false,
        personal_summary_persisted: false,
        grant_status: grant.status,
      },
    };
  }

  private async retrieveEligiblePersonalMemorySummary(
    grant: PersonalGrantRow,
  ): Promise<PersonalMemorySummaryRow[]> {
    const filter = recordValue(grant.memory_filter_json);
    const params: unknown[] = [
      grant.personal_space_id,
      grant.granting_user_id,
      ["normal", "sensitive"],
    ];
    const where = [
      "space_id=$1",
      "owner_user_id=$2",
      "visibility='private'",
      "sensitivity_level=ANY($3)",
      "status='active'",
      "deleted_at IS NULL",
    ];
    addArrayFilter(where, params, "memory_layer", filter.memory_layers);
    addArrayFilter(where, params, "memory_type", filter.memory_types);
    addArrayFilter(where, params, "namespace", filter.namespaces);
    const result = await this.db.query<PersonalMemorySummaryRow>(
      `SELECT memory_type,created_at,updated_at
         FROM memory_entries
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC,created_at DESC
        LIMIT ${clampMaxItems(filter.max_items)}`,
      params,
    );
    return result.rows;
  }

  async loadPublishedProjectContext(
    spaceId: string,
    projectId: string | null,
    workContextScopeId: string | null = null,
    userId: string | null = null,
    setupRef: { type: string; id: string; version?: string | null } | null,
    projectRefs: {
      brief: { type: string; id: string; version?: string | null } | null;
      instruction: { type: string; id: string; version?: string | null } | null;
      instructionEnabled?: boolean;
    },
  ): Promise<{
    brief: Record<string, unknown> | null;
    instruction: Record<string, unknown> | null;
    pinnedReferences: Array<{ type: "project_brief_version" | "project_instruction_version"; value: Record<string, unknown> }>;
    excludedReferences: Array<{ type: string; id: string }>;
    retrievalPreferences: { enabled?: boolean; max_candidates?: number };
  }> {
    const setup = workContextScopeId && userId && setupRef
      ? (await this.db.query<{
          scope_kind: "direct_session" | "room_recipient" | "root_task" | "workflow_execution";
          project_id: string | null;
          project_folder_id: string | null;
          agent_id: string | null;
          project_brief_version_id: string | null;
          project_instruction_version_id: string | null;
          project_instruction_enabled: boolean;
          pinned_refs_json: unknown;
          excluded_refs_json: unknown;
          retrieval_preferences_json: unknown;
        }>(
          `SELECT scope_kind, project_id, project_folder_id, agent_id, project_brief_version_id,
                  project_instruction_version_id, project_instruction_enabled, pinned_refs_json,
                  excluded_refs_json, retrieval_preferences_json
             FROM work_context_setups
            WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3
              AND id=$4 AND version=$5
            LIMIT 1`,
          [
            spaceId,
            workContextScopeId,
            userId,
            setupRef.type === "work_context_setup" ? setupRef.id : "",
            setupRef.type === "work_context_setup" && setupRef.version
              ? Number(setupRef.version)
              : 0,
          ],
        )).rows[0]
      : undefined;
    if (setupRef && !setup) {
      throw new HttpError(409, "Execution Work Context Setup is no longer available");
    }
    const excludedReferences = setup && Array.isArray(setup.excluded_refs_json)
      ? setup.excluded_refs_json.filter(
          (ref): ref is { type: string; id: string } => Boolean(
            ref && typeof ref === "object"
            && typeof (ref as { type?: unknown }).type === "string"
            && typeof (ref as { id?: unknown }).id === "string",
          ),
        )
      : [];
    const retrievalPreferences = setup?.retrieval_preferences_json
      && typeof setup.retrieval_preferences_json === "object"
      && !Array.isArray(setup.retrieval_preferences_json)
      ? setup.retrieval_preferences_json as { enabled?: boolean; max_candidates?: number }
      : {};
    const excludedKeys = new Set(excludedReferences.map((ref) => `${ref.type}:${ref.id}`));
    let pinnedReferences: Array<{ type: "project_brief_version" | "project_instruction_version"; value: Record<string, unknown> }> = [];
    if (setup && userId) {
      const scopeBindings = await resolveWorkContextScopeBindings(
        this.db,
        { spaceId, userId },
        setup.scope_kind,
        workContextScopeId!,
      );
      if ((scopeBindings.project_id !== null && setup.project_id !== scopeBindings.project_id)
        || (scopeBindings.project_folder_id !== null && setup.project_folder_id !== scopeBindings.project_folder_id)
        || (scopeBindings.agent_id !== null && setup.agent_id !== scopeBindings.agent_id)) {
        throw new HttpError(409, "Work Context Setup no longer matches its work scope");
      }
      const refs = Array.isArray(setup.pinned_refs_json)
        ? setup.pinned_refs_json.filter(
            (ref): ref is { type: "project_brief_version" | "project_instruction_version"; id: string } =>
              Boolean(ref && typeof ref === "object"
                && ((ref as { type?: unknown }).type === "project_brief_version"
                  || (ref as { type?: unknown }).type === "project_instruction_version")
                && typeof (ref as { id?: unknown }).id === "string"),
          )
        : [];
      const resolved = await resolveExplicitReferences(this.db, { spaceId, userId }, refs, setup.project_id);
      pinnedReferences = refs
        .map((ref, index) => ({ type: ref.type, value: resolved[index]! }))
        .filter((pinned) => !excludedKeys.has(`${pinned.type}:${String(pinned.value.id)}`));
    }
    const resolvedProjectId = setup?.project_id ?? projectId;
    if (!resolvedProjectId) return {
      brief: null, instruction: null, pinnedReferences, excludedReferences, retrievalPreferences,
    };
    if (userId && !(await canAccessProject(this.db, spaceId, resolvedProjectId, userId))) {
      throw new HttpError(404, "Project not found");
    }
    if (setup || projectRefs.instructionEnabled) {
      const activeInstruction = await this.db.query<{ active_instruction_version_id: string | null }>(
        `SELECT active_instruction_version_id FROM projects
          WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL`,
        [resolvedProjectId, spaceId],
      );
      if (setup?.project_instruction_enabled
        && activeInstruction.rows[0]?.active_instruction_version_id !== setup.project_instruction_version_id) {
        throw new HttpError(409, "Work Context Setup is stale because the active Project Instruction changed");
      }
      if (!setup
        && activeInstruction.rows[0]?.active_instruction_version_id !== projectRefs.instruction?.id) {
        throw new HttpError(409, "Execution snapshot is stale because the active Project Instruction changed");
      }
      // Brief is reference data, not delegated authority. The immutable Setup
      // intentionally keeps its once-published Brief version until the user
      // creates a new Setup; only an Instruction change invalidates authority.
    }
    const result = await this.db.query<{ brief: unknown; instruction: unknown }>(
      `SELECT CASE WHEN bv.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', bv.id, 'space_id', bv.space_id, 'project_id', bv.project_id,
          'version', bv.version, 'goal', bv.goal,
          'scope_included', bv.scope_included, 'scope_excluded', bv.scope_excluded,
          'success_definition', bv.success_definition, 'constraints', bv.constraints,
          'assumptions', bv.assumptions, 'project_status', bv.project_status,
          'current_focus', bv.current_focus,
          'confirmed_decisions', bv.confirmed_decisions_json,
          'primary_mode', bv.primary_mode,
          'workspace_identity', bv.workspace_identity_json,
          'workspace_boundary', bv.workspace_boundary_json,
          'source_refs', bv.source_refs_json, 'status', bv.status,
          'reviewed_by_user_id', bv.reviewed_by_user_id,
          'reviewed_at', bv.reviewed_at,
          'published_by_user_id', bv.published_by_user_id,
          'published_at', bv.published_at,
          'created_by_user_id', bv.created_by_user_id,
          'created_at', bv.created_at) END AS brief,
        CASE WHEN iv.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', iv.id, 'version', iv.version, 'title', iv.title,
          'instruction_text', iv.instruction_text) END AS instruction
       FROM projects p
       LEFT JOIN project_brief_versions bv
         ON bv.id=CASE WHEN $5::boolean THEN $3 ELSE p.active_brief_version_id END
        AND bv.project_id=p.id AND bv.space_id=p.space_id
        AND bv.status IN ('published', 'archived') AND bv.published_at IS NOT NULL
       LEFT JOIN project_instruction_versions iv
         ON iv.id=CASE WHEN $5::boolean THEN $4 ELSE p.active_instruction_version_id END
        AND iv.project_id=p.id AND iv.space_id=p.space_id
        AND iv.status='published' AND iv.published_at IS NOT NULL
       WHERE p.id=$1 AND p.space_id=$2 AND p.deleted_at IS NULL`,
      [
        resolvedProjectId,
        spaceId,
        setup?.project_brief_version_id ?? projectRefs.brief?.id ?? null,
        setup?.project_instruction_version_id ?? projectRefs.instruction?.id ?? null,
        true,
      ],
    );
    const row = result.rows[0];
    return {
      brief: row?.brief && typeof row.brief === "object"
        && !excludedKeys.has(`project_brief_version:${String((row.brief as Record<string, unknown>).id)}`)
        ? row.brief as Record<string, unknown> : null,
      // Project Instruction is delegated authority. A user-authored Setup
      // exclusion cannot suppress the approved instruction selected above.
      instruction: row?.instruction && typeof row.instruction === "object"
        ? row.instruction as Record<string, unknown> : null,
      pinnedReferences,
      excludedReferences,
      retrievalPreferences,
    };
  }

}

function addArrayFilter(where: string[], params: unknown[], column: string, value: unknown): void {
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (items.length === 0) return;
  params.push(items);
  where.push(`${column}=ANY($${params.length})`);
}

function clampMaxItems(value: unknown): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Math.floor(Number(value)) : 10;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20) : 10;
}

function generatePersonalSummary(memories: readonly PersonalMemorySummaryRow[]): string {
  if (memories.length === 0) return "No personal memory entries are available for this context.";
  const kinds = [...new Set(memories.flatMap((memory) => memory.memory_type ? [memory.memory_type] : []))].sort();
  const timestamps = memories
    .flatMap((memory) => isoTime(memory.updated_at) ?? isoTime(memory.created_at) ?? [])
    .sort();
  const parts = [
    `The user has ${memories.length} relevant personal memory ${memories.length === 1 ? "entry" : "entries"} available for this context.`,
  ];
  if (kinds.length) parts.push(`Categories: ${kinds.join(", ")}.`);
  if (timestamps.length) parts.push(`Most recently updated: ${timestamps.at(-1)!.slice(0, 10)}.`);
  parts.push("Raw memory content is not included in this summary; only aggregate metadata is provided.");
  return parts.join(" ");
}

function isoTime(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
