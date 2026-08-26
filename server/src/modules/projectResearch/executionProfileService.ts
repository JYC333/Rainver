import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, optionalString } from "../routeUtils/common.js";
import { PgAgentRepository } from "../agents/repository.js";
import { providerSupportsStructuredOutput } from "../providers/structuredOutputCapabilities.js";

const RESEARCH_AGENT_KIND = "system_research";
const RESEARCH_AGENT_NAME = "Auto Research";
const RESEARCH_ADAPTER = "model_api" as const;
// Every research.* capability a stage of this workflow can require at
// routing time (screening/synthesis use the first five; ad-hoc notebook
// analysis and incremental monitoring comparison need the other two). Keep
// this the single list new stages draw from — a capability missing here
// fails routing with "No runtime candidate passed routing hard filters" for
// every existing space's agent, since capabilities_json is otherwise fixed
// at first provisioning.
const RESEARCH_AGENT_CAPABILITY_IDS = [
  "research.source_collect",
  "research.source_summarize",
  "research.evidence_extract",
  "research.brief_synthesize",
  "research.idea_generate",
  "research.adhoc_analyze",
  "research.ask",
  "research.monitor_compare",
];
export interface ResearchExecutionSelection {
  modelProviderId?: string | null;
  modelName?: string | null;
}

export interface ResolvedResearchExecution {
  agentId: string;
  runtimeProfileId: string;
  adapterType: typeof RESEARCH_ADAPTER;
  modelProviderId: string;
  modelName: string | null;
}

/**
 * Project Research owns a managed execution profile. Users choose the model
 * provider and optional model; they do not choose a runtime implementation or
 * a CLI credential profile for this workflow.
 */
export class ProjectResearchExecutionProfileService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  async resolve(
    identity: SpaceUserIdentity,
    selection: ResearchExecutionSelection,
  ): Promise<ResolvedResearchExecution> {
    const provider = selection.modelProviderId
      ? await this.getProvider(identity.spaceId, selection.modelProviderId)
      : await this.getDefaultProvider(identity.spaceId);
    if (!provider) {
      throw new HttpError(422, "Select a model provider or configure a space default provider for Auto Research");
    }
    if (!providerSupportsStructuredOutput(provider.provider_type)) {
      throw new HttpError(422, `Model provider type '${provider.provider_type}' does not support Auto Research structured output`);
    }
    const modelName = optionalString(selection.modelName)
      ?? provider.default_model
      ?? firstModel(provider.capabilities_json);
    const managedAgent = await this.ensureManagedAgent(identity, provider.id, modelName);
    return this.ensureProfile(identity, managedAgent.id, provider.id, modelName);
  }

  private async ensureManagedAgent(
    identity: SpaceUserIdentity,
    modelProviderId: string,
    modelName: string | null,
  ): Promise<{ id: string }> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM agents
        WHERE space_id=$1 AND agent_kind=$2 AND status='active'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [identity.spaceId, RESEARCH_AGENT_KIND],
    );
    if (existing.rows[0]) {
      await this.ensureManagedAgentCapabilities(identity.spaceId, existing.rows[0].id);
      return existing.rows[0];
    }

    try {
      const agent = await PgAgentRepository.fromConfig(this.config).create({
        spaceId: identity.spaceId,
        userId: identity.userId,
        ownerUserId: null,
        name: RESEARCH_AGENT_NAME,
        description: "System-managed execution agent for Project Research workflows.",
        visibility: "space_shared",
        roleInstruction: "Execute bounded Project Research stages and preserve source/evidence references.",
        systemPrompt: "You are the Project Research execution agent. Work only on the supplied research corpus and preserve source and evidence references in every research output.",
        defaultModelProviderId: modelProviderId,
        defaultModel: modelName,
        adapterType: RESEARCH_ADAPTER,
        runtimeConfigJson: { purpose: "project_research" },
        agentKind: RESEARCH_AGENT_KIND,
        capabilitiesJson: RESEARCH_AGENT_CAPABILITY_IDS,
        outputSchemaJson: {
          required_artifact_schemas: [
            "research_report.archive.v1",
          ],
        },
      });
      return { id: agent.id };
    } catch (error) {
      const raced = await this.db.query<{ id: string }>(
        `SELECT id FROM agents
          WHERE space_id=$1 AND agent_kind=$2 AND status='active'
          ORDER BY created_at ASC, id ASC LIMIT 1`,
        [identity.spaceId, RESEARCH_AGENT_KIND],
      );
      if (raced.rows[0]) return raced.rows[0];
      throw error;
    }
  }

  /**
   * The agent's capabilities snapshot is fixed on its current agent_versions
   * row at creation time, with no versioned-edit path for this
   * system-managed agent. Backfill it in place when a stage adds a new
   * required capability, so spaces provisioned before that stage existed
   * don't fail routing forever.
   */
  private async ensureManagedAgentCapabilities(spaceId: string, agentId: string): Promise<void> {
    const current = await this.db.query<{ version_id: string; capabilities_json: unknown }>(
      `SELECT av.id AS version_id, av.capabilities_json
         FROM agents a
         JOIN agent_versions av ON av.id = a.current_version_id AND av.space_id = a.space_id
        WHERE a.space_id=$1 AND a.id=$2`,
      [spaceId, agentId],
    );
    const row = current.rows[0];
    if (!row) return;
    const existingCapabilities = Array.isArray(row.capabilities_json)
      ? row.capabilities_json.filter((value): value is string => typeof value === "string")
      : [];
    const missing = RESEARCH_AGENT_CAPABILITY_IDS.filter((id) => !existingCapabilities.includes(id));
    if (missing.length === 0) return;
    await this.db.query(
      `UPDATE agent_versions SET capabilities_json=$3::jsonb WHERE id=$1 AND space_id=$2`,
      [row.version_id, spaceId, JSON.stringify([...existingCapabilities, ...missing])],
    );
  }

  private async ensureProfile(
    identity: SpaceUserIdentity,
    agentId: string,
    modelProviderId: string,
    modelName: string | null,
  ): Promise<ResolvedResearchExecution> {
    const profiles = await this.db.query<{
      id: string;
      model_provider_id: string | null;
      model_name: string | null;
    }>(
      `SELECT id, model_provider_id, model_name
        FROM agent_runtime_profiles
        WHERE space_id=$1 AND agent_id=$2 AND adapter_type=$3
          AND model_provider_id=$4 AND enabled=true
        ORDER BY is_default DESC, created_at ASC, id ASC`,
      [identity.spaceId, agentId, RESEARCH_ADAPTER, modelProviderId],
    );
    const exact = profiles.rows.find((profile) => profile.model_name === modelName);
    if (exact) {
      return {
        agentId,
        runtimeProfileId: exact.id,
        adapterType: RESEARCH_ADAPTER,
        modelProviderId,
        modelName,
      };
    }

    const created = await PgAgentRepository.fromConfig(this.config).createRuntimeProfile(
      identity.spaceId,
      agentId,
      {
        name: "Research · Managed API",
        adapterType: RESEARCH_ADAPTER,
        modelProviderId,
        modelName,
        runtimeConfigJson: { purpose: "project_research" },
        isDefault: false,
      },
    );
    return {
      agentId,
      runtimeProfileId: created.id,
      adapterType: RESEARCH_ADAPTER,
      modelProviderId,
      modelName,
    };
  }

  private async getProvider(spaceId: string, providerId: string): Promise<ProviderRow | null> {
    const result = await this.db.query<ProviderRow>(
      `SELECT p.id, p.provider_type, p.default_model, p.capabilities_json
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id=g.provider_id
        WHERE g.space_id=$1 AND g.provider_id=$2 AND g.enabled=true AND p.enabled=true LIMIT 1`,
      [spaceId, providerId],
    );
    if (!result.rows[0]) throw new HttpError(422, "Model provider is not selectable in this space");
    return result.rows[0];
  }

  private async getDefaultProvider(spaceId: string): Promise<ProviderRow | null> {
    const result = await this.db.query<ProviderRow>(
      `SELECT p.id, p.provider_type, p.default_model, p.capabilities_json
         FROM model_provider_space_grants g
         JOIN model_providers p ON p.id=g.provider_id
        WHERE g.space_id=$1 AND g.enabled=true AND p.enabled=true
        ORDER BY g.is_default DESC, p.updated_at DESC, p.id ASC
        LIMIT 1`,
      [spaceId],
    );
    return result.rows[0] ?? null;
  }
}

interface ProviderRow {
  id: string;
  provider_type: string;
  default_model: string | null;
  capabilities_json: unknown;
}

function firstModel(value: unknown): string | null {
  const models = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as Record<string, unknown>).models ?? (value as Record<string, unknown>).available_models
      : null;
  if (!Array.isArray(models)) return null;
  return models.find((model): model is string => typeof model === "string" && model.trim().length > 0) ?? null;
}
