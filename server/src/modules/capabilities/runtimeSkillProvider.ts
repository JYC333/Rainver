import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { objectValue, optionalString, type Queryable } from "../routeUtils/common.js";
import { getBuiltInCapabilityDefinition } from "./registry.js";
import { renderClaudeSkill, renderCodexSkill, renderGenericPromptSkill } from "./runtimeRenderers.js";
import type {
  CapabilityDefinition,
  NormalizedSkill,
  RuntimeRenderedSkill,
  SkillRiskLevel,
} from "./types.js";

export interface RuntimeSkillRunContext {
  space_id: string;
  run_id: string;
  adapter_type: string | null;
  capability_id?: string | null;
  agent_id: string | null;
  project_id: string | null;
  instructed_by_user_id: string | null;
  capabilities_json?: unknown;
}

export interface RuntimeSkillCandidate {
  binding_id: string;
  capability_id: string;
  capability_version_id: string | null;
  capability_enablement_id: string | null;
  runtime_adapter_type: string;
  render_mode: string;
  binding_json: Record<string, unknown>;
  enablement_config_json: Record<string, unknown>;
  capability: CapabilityDefinition;
  normalized_skill: NormalizedSkill | null;
  risk_level: SkillRiskLevel | null;
}

export interface RenderedRuntimeSkill extends RuntimeSkillCandidate {
  rendered: RuntimeRenderedSkill;
}

export interface RuntimeSkillProvider {
  loadCandidatesForRun(run: RuntimeSkillRunContext): Promise<RuntimeSkillCandidate[]>;
}

interface RuntimeSkillCandidateRow {
  binding_id: string;
  capability_key: string;
  capability_version_id: string | null;
  capability_enablement_id: string | null;
  runtime_adapter_type: string;
  render_mode: string;
  binding_json: unknown;
  enablement_config_json: unknown;
  metadata_json: unknown;
}

interface RuntimeSkillEnablementRow {
  capability_enablement_id: string;
  capability_key: string;
  capability_version_id: string | null;
  enabled: boolean;
  config_json: unknown;
}

export class PgRuntimeSkillProvider implements RuntimeSkillProvider {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgRuntimeSkillProvider | null {
    if (!config.databaseUrl) return null;
    return new PgRuntimeSkillProvider(getDbPool(config.databaseUrl));
  }

  async loadCandidatesForRun(run: RuntimeSkillRunContext): Promise<RuntimeSkillCandidate[]> {
    const adapterType = optionalString(run.adapter_type);
    if (!adapterType) return [];
    const requestedCapabilityIds = capabilityIdsForRun(run);
    if (requestedCapabilityIds.length === 0) return [];

    const rows = await this.db.query<RuntimeSkillCandidateRow>(
      `WITH scoped_enablements AS (
         SELECT ce.*,
                CASE
                  WHEN ce.project_id IS NOT NULL THEN 1
                  WHEN ce.agent_id IS NOT NULL THEN 2
                  WHEN ce.user_id IS NOT NULL THEN 3
                  ELSE 4
                END AS scope_rank
           FROM capability_enablements ce
          WHERE ce.space_id = $1
            AND ce.capability_key = ANY($6::text[])
            AND (
              ce.project_id = $2
              OR ce.agent_id = $3
              OR ce.user_id = $4
              OR (ce.project_id IS NULL AND ce.agent_id IS NULL AND ce.user_id IS NULL)
            )
       ),
       selected_enablements AS (
         SELECT DISTINCT ON (capability_key)
                id, capability_key, capability_version_id, enabled, config_json
           FROM scoped_enablements
          ORDER BY capability_key, scope_rank ASC, updated_at DESC, id DESC
       )
       SELECT b.id AS binding_id,
              b.capability_key,
              b.capability_version_id,
              se.id AS capability_enablement_id,
              b.runtime_adapter_type,
              b.render_mode,
              b.binding_json,
              se.config_json AS enablement_config_json,
              cv.metadata_json
         FROM selected_enablements se
         JOIN capability_runtime_bindings b
           ON b.space_id = $1
          AND b.capability_key = se.capability_key
          AND b.runtime_adapter_type = $5
          AND b.enabled = TRUE
          AND se.capability_version_id IS NOT NULL
          AND se.capability_version_id = b.capability_version_id
         JOIN capability_versions cv
           ON cv.id = b.capability_version_id
          AND cv.space_id = $1
          AND cv.status = 'available'
        WHERE se.enabled = TRUE
        ORDER BY b.capability_key ASC, b.runtime_adapter_type ASC, b.render_mode ASC`,
      [
        run.space_id,
        run.project_id,
        run.agent_id,
        run.instructed_by_user_id,
        adapterType,
        requestedCapabilityIds,
      ],
    );

    const dbCandidates = rows.rows
      .map(candidateFromRow)
      .filter((candidate): candidate is RuntimeSkillCandidate => candidate !== null);
    const enablements = await this.loadSelectedEnabledEnablements(run, requestedCapabilityIds);
    const candidates = [...dbCandidates];
    const existingBindings = new Set(candidates.map(candidateIdentity));
    for (const row of enablements) {
      const capability = getBuiltInCapabilityDefinition(row.capability_key);
      if (!capability || row.capability_version_id !== null) continue;
      for (const binding of capability.default_runtime_bindings) {
        if (!binding.enabled) continue;
        if (binding.runtime_adapter_type !== adapterType) continue;
        if (binding.render_mode !== "render_skill" && binding.render_mode !== "inline_prompt") continue;
        const candidate: RuntimeSkillCandidate = {
          binding_id: binding.id,
          capability_id: capability.id,
          capability_version_id: null,
          capability_enablement_id: row.capability_enablement_id,
          runtime_adapter_type: binding.runtime_adapter_type,
          render_mode: binding.render_mode,
          binding_json: binding.binding_json,
          enablement_config_json: objectValue(row.config_json),
          capability,
          normalized_skill: null,
          risk_level: riskLevelFromCapability(capability, null),
        };
        const identity = candidateIdentity(candidate);
        if (existingBindings.has(identity)) continue;
        existingBindings.add(identity);
        candidates.push(candidate);
      }
    }
    return candidates.sort((a, b) => candidateIdentity(a).localeCompare(candidateIdentity(b)));
  }

  private async loadSelectedEnabledEnablements(
    run: RuntimeSkillRunContext,
    capabilityIds: string[],
  ): Promise<RuntimeSkillEnablementRow[]> {
    const rows = await this.db.query<RuntimeSkillEnablementRow>(
      `WITH scoped_enablements AS (
         SELECT ce.*,
                CASE
                  WHEN ce.project_id IS NOT NULL THEN 1
                  WHEN ce.agent_id IS NOT NULL THEN 2
                  WHEN ce.user_id IS NOT NULL THEN 3
                  ELSE 4
                END AS scope_rank
           FROM capability_enablements ce
          WHERE ce.space_id = $1
            AND ce.capability_key = ANY($5::text[])
            AND (
              ce.project_id = $2
              OR ce.agent_id = $3
              OR ce.user_id = $4
              OR (ce.project_id IS NULL AND ce.agent_id IS NULL AND ce.user_id IS NULL)
            )
       ),
       selected_enablements AS (
         SELECT DISTINCT ON (capability_key)
                id AS capability_enablement_id,
                capability_key,
                capability_version_id,
                enabled,
                config_json
           FROM scoped_enablements
          ORDER BY capability_key, scope_rank ASC, updated_at DESC, id DESC
       )
       SELECT capability_enablement_id,
              capability_key,
              capability_version_id,
              enabled,
              config_json
         FROM selected_enablements
        WHERE enabled = TRUE
        ORDER BY capability_key ASC`,
      [
        run.space_id,
        run.project_id,
        run.agent_id,
        run.instructed_by_user_id,
        capabilityIds,
      ],
    );
    return rows.rows;
  }
}

export function renderRuntimeSkillCandidate(candidate: RuntimeSkillCandidate): RenderedRuntimeSkill | null {
  if (candidate.runtime_adapter_type === "claude_code" && candidate.render_mode === "render_skill") {
    return {
      ...candidate,
      rendered: renderClaudeSkill({
        capability: candidate.capability,
        normalizedSkill: candidate.normalized_skill,
        profile: candidate.enablement_config_json,
      }),
    };
  }
  if (candidate.runtime_adapter_type === "codex_cli" && candidate.render_mode === "render_skill") {
    return {
      ...candidate,
      rendered: renderCodexSkill({
        capability: candidate.capability,
        normalizedSkill: candidate.normalized_skill,
        profile: candidate.enablement_config_json,
      }),
    };
  }
  if (candidate.runtime_adapter_type === "model_api" && candidate.render_mode === "inline_prompt") {
    return {
      ...candidate,
      rendered: renderGenericPromptSkill({
        capability: candidate.capability,
        normalizedSkill: candidate.normalized_skill,
        profile: candidate.enablement_config_json,
      }),
    };
  }
  return null;
}

function candidateFromRow(row: RuntimeSkillCandidateRow): RuntimeSkillCandidate | null {
  const metadata = objectValue(row.metadata_json);
  const capability = capabilityDefinitionFromValue(metadata.capability_definition);
  if (!capability) return null;
  const normalizedSkill = normalizedSkillFromValue(metadata.normalized_skill);
  return {
    binding_id: row.binding_id,
    capability_id: row.capability_key,
    capability_version_id: row.capability_version_id,
    capability_enablement_id: row.capability_enablement_id,
    runtime_adapter_type: row.runtime_adapter_type,
    render_mode: row.render_mode,
    binding_json: objectValue(row.binding_json),
    enablement_config_json: objectValue(row.enablement_config_json),
    capability,
    normalized_skill: normalizedSkill,
    risk_level: riskLevelFromCapability(capability, normalizedSkill),
  };
}

function candidateIdentity(candidate: RuntimeSkillCandidate): string {
  return [
    candidate.capability_id,
    candidate.capability_version_id ?? "builtin",
    candidate.binding_id,
    candidate.runtime_adapter_type,
    candidate.render_mode,
  ].join("\u0000");
}

function capabilityIdsForRun(run: RuntimeSkillRunContext): string[] {
  const ids = new Set<string>();
  if (optionalString(run.capability_id)) ids.add(optionalString(run.capability_id)!);
  const capabilities = run.capabilities_json;
  if (Array.isArray(capabilities)) {
    for (const item of capabilities) {
      if (typeof item === "string" && item.trim()) ids.add(item.trim());
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function capabilityDefinitionFromValue(value: unknown): CapabilityDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = optionalString(record.id);
  const namespace = optionalString(record.namespace);
  const name = optionalString(record.name);
  const description = optionalString(record.description);
  const version = optionalString(record.version);
  if (!id || !namespace || !name || !description || !version) return null;
  return {
    id,
    namespace,
    name,
    description,
    version,
    source_kind: record.source_kind === "imported_skill" ? "imported_skill" : "generated",
    input_schema_json: objectValue(record.input_schema_json),
    output_artifact_types: Array.isArray(record.output_artifact_types)
      ? record.output_artifact_types.filter((item): item is string => typeof item === "string")
      : [],
    permissions: objectValue(record.permissions),
    supported_execution_modes: Array.isArray(record.supported_execution_modes)
      ? record.supported_execution_modes.filter((item): item is string => typeof item === "string")
      : [],
    default_runtime_bindings: [],
    status: optionalString(record.status) === "available" ? "available" : "draft",
  };
}

function normalizedSkillFromValue(value: unknown): NormalizedSkill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = optionalString(record.name);
  const description = optionalString(record.description);
  const version = optionalString(record.version);
  if (!name || !description || !version) return null;
  return {
    name,
    description,
    version,
    license: optionalString(record.license),
    instructions_markdown: optionalString(record.instructions_markdown) ?? "",
    resources: Array.isArray(record.resources)
      ? record.resources.filter((item): item is NormalizedSkill["resources"][number] =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
      : [],
    requested_permissions: Array.isArray(record.requested_permissions)
      ? record.requested_permissions.filter((item): item is string => typeof item === "string")
      : [],
    execution_profile: objectValue(record.execution_profile),
    vendor_extensions: objectValue(record.vendor_extensions),
    trust_analysis: objectValue(record.trust_analysis),
  };
}

function riskLevelFromCapability(
  capability: CapabilityDefinition,
  normalizedSkill: NormalizedSkill | null,
): SkillRiskLevel | null {
  const fromCapability = optionalString(capability.permissions.risk_level);
  if (isRiskLevel(fromCapability)) return fromCapability;
  const fromSkill = optionalString(normalizedSkill?.trust_analysis.risk_level);
  return isRiskLevel(fromSkill) ? fromSkill : null;
}

function isRiskLevel(value: string | null): value is SkillRiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}
