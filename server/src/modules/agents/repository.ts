import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { HttpError } from "../routeUtils/common.js";
import { RuntimeToolRegistry } from "../runtimeTools/index.js";
import {
  isCliRuntimeTool,
  resolveRuntimeToolVersionForSpace,
} from "../runtimeTools/policies.js";
import {
  ScopedSettingsStore,
  SETTINGS_KEYS,
  defineScopedSetting,
  settingsRecord,
  type ScopedSettingsRead,
} from "../settings/index.js";
import {
  BUILTIN_RUNTIME_ADAPTER_SPECS,
  type RuntimeAdapterType,
} from "../runtimeAdapters/specs.js";
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import { hostInstallationIds } from "../hosts/capabilities.js";
import type { PromptProvenance } from "../prompts/provenance.js";
import {
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityParamFilterSql,
} from "../access/contentAccessSql.js";
import { isContentVisibility } from "../access/contentAccessTypes.js";
import { contentOwnerFromDb } from "../access/contentAccessQuery.js";
import {
  DEFAULT_MEMORY_POLICY,
  defaultModelConfigFor,
  DEFAULT_RUNTIME_CONFIG,
  agentOut,
  buildRuntimePolicy,
  normalizeAdapterType,
  recordValue,
  stringOrNull,
  stringValue,
} from "./agentRepositoryHelpers.js";
import { stableJsonStringify } from "../evolution/hash.js";

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface AgentRecord {
  id: string;
  space_id: string;
  project_id: string | null;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  role_instruction: string | null;
  status: string;
  agent_kind: string;
  current_version_id: string | null;
  visibility: string;
  access_level: string;
  created_at: unknown;
  updated_at: unknown;
  model_provider_id?: string | null;
  provider_name?: string | null;
  provider_type?: string | null;
  model_name?: string | null;
  system_prompt?: string | null;
  prompt_provenance_json?: unknown;
  runtime_adapter_type?: string | null;
  runtime_policy_json?: unknown;
}

export interface AgentRuntimeProfileRecord {
  id: string;
  space_id: string;
  agent_id: string;
  name: string;
  adapter_type: string;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  runtime_installation: string | null;
  model_provider_id: string | null;
  provider_name?: string | null;
  provider_type?: string | null;
  model_name: string | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  created_at: unknown;
  updated_at: unknown;
}

export interface AgentVersionRecord {
  id: string;
  agent_id: string;
  space_id: string;
  version_label: string;
  model_provider_id: string | null;
  model_name: string | null;
  system_prompt: string | null;
  prompt_provenance_json: PromptProvenance | null;
  model_config_json: Record<string, unknown>;
  runtime_config_json: Record<string, unknown>;
  context_policy_json: Record<string, unknown>;
  memory_policy_json: Record<string, unknown>;
  capabilities_json: unknown[];
  tool_permissions_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  tool_policy_json: Record<string, unknown>;
  output_policy_json: Record<string, unknown>;
  schedule_config_json: Record<string, unknown>;
  output_schema_json: Record<string, unknown>;
  source_proposal_id: string | null;
  source_activity_id: string | null;
  /** Non-null: this version materializes that managed seed and should be
   * re-materialized when it changes. Null: detached, leave it alone. */
  follows_seed_key: string | null;
  created_at: unknown;
  published_at: unknown | null;
  archived_at: unknown | null;
}

export interface AgentOut {
  id: string;
  space_id: string;
  project_id: string | null;
  created_by_user_id: string | null;
  name: string;
  description: string | null;
  visibility: string;
  access_level: string;
  role_instruction: string | null;
  status: string;
  agent_kind: string;
  current_version_id: string | null;
  model: {
    provider_id: string | null;
    provider_name: string | null;
    provider_type: string | null;
    model: string | null;
  } | null;
  adapter_type: string | null;
  requires_model_provider: boolean;
  system_prompt: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface AssistantSettingsRecord {
  id: string;
  space_id: string;
  assistant_agent_id: string | null;
  response_style: string | null;
  verbosity: string | null;
  default_context_toggles_json: Record<string, boolean>;
  default_project_id: string | null;
  proposal_style: string | null;
  model_preferences_json: Record<string, unknown>;
  created_at: unknown;
  updated_at: unknown;
}

export interface AgentRuntimeProfileOut {
  id: string;
  space_id: string;
  agent_id: string;
  name: string;
  adapter_type: string;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  runtime_installation: string | null;
  model: {
    provider_id: string | null;
    provider_name: string | null;
    provider_type: string | null;
    model: string | null;
  } | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  created_at: unknown;
  updated_at: unknown;
}

export interface AgentCreateInput {
  spaceId: string;
  projectId?: string | null;
  userId: string;
  name: string;
  description?: string | null;
  visibility?: string | null;
  roleInstruction?: string | null;
  systemPrompt?: string | null;
  promptProvenanceJson?: PromptProvenance | null;
  defaultModelProviderId?: string | null;
  defaultModel?: string | null;
  adapterType?: string | null;
  modelConfigJson?: Record<string, unknown> | null;
  runtimeConfigJson?: Record<string, unknown> | null;
  /** Pre-resolved by the caller outside the transaction for CLI profiles. */
  runtimeToolVersion?: string | null;
  contextPolicyJson?: Record<string, unknown> | null;
  memoryPolicyJson?: Record<string, unknown> | null;
  capabilitiesJson?: unknown[] | null;
  toolPermissionsJson?: Record<string, unknown> | null;
  runtimePolicyJson?: Record<string, unknown> | null;
  toolPolicyJson?: Record<string, unknown> | null;
  outputPolicyJson?: Record<string, unknown> | null;
  scheduleConfigJson?: Record<string, unknown> | null;
  outputSchemaJson?: Record<string, unknown> | null;
  agentKind?: string | null;
  ownerUserId?: string | null;
  executionHostId?: string | null;
  workspaceLocationId?: string | null;
  runtimeInstallation?: string | null;
}

const AGENT_COLUMNS = `
  a.id, a.space_id, a.project_id, a.owner_user_id, a.name, a.description, a.role_instruction,
  a.status, a.agent_kind,
  a.current_version_id, a.visibility, a.access_level, a.created_at, a.updated_at,
  COALESCE(arp.model_provider_id, av.model_provider_id) AS model_provider_id,
  COALESCE(arp.model_name, av.model_name) AS model_name,
  av.system_prompt,
  COALESCE(arp.adapter_type, av.runtime_policy_json->>'default_adapter_type') AS runtime_adapter_type,
  COALESCE(arp.runtime_policy_json, av.runtime_policy_json) AS runtime_policy_json,
  mp.name AS provider_name, mp.provider_type AS provider_type
`;

const RUNTIME_PROFILE_COLUMNS = `
  arp.id, arp.space_id, arp.agent_id, arp.name, arp.adapter_type,
  arp.execution_host_id, arp.workspace_location_id, arp.runtime_installation,
  arp.model_provider_id, arp.model_name,
  arp.runtime_config_json, arp.runtime_policy_json, arp.enabled, arp.is_default,
  arp.created_at, arp.updated_at,
  mp.name AS provider_name, mp.provider_type AS provider_type
`;

const DEFAULT_RUNTIME_PROFILE_JOIN = `
         LEFT JOIN LATERAL (
           SELECT runtime_profile_candidate.*
             FROM agent_runtime_profiles runtime_profile_candidate
            WHERE runtime_profile_candidate.space_id = a.space_id
              AND runtime_profile_candidate.agent_id = a.id
              AND runtime_profile_candidate.enabled = true
            ORDER BY runtime_profile_candidate.is_default DESC,
                     runtime_profile_candidate.created_at ASC,
                     runtime_profile_candidate.id ASC
            LIMIT 1
         ) arp ON true`;

const VERSION_COLUMN_NAMES = [
  "id",
  "agent_id",
  "space_id",
  "version_label",
  "model_provider_id",
  "model_name",
  "system_prompt",
  "model_config_json",
  "runtime_config_json",
  "context_policy_json",
  "memory_policy_json",
  "capabilities_json",
  "tool_permissions_json",
  "runtime_policy_json",
  "tool_policy_json",
  "output_policy_json",
  "schedule_config_json",
  "output_schema_json",
  "prompt_provenance_json",
  "source_proposal_id",
  "source_activity_id",
  "follows_seed_key",
  "created_at",
  "published_at",
  "archived_at",
] as const;

const VERSION_COLUMNS = VERSION_COLUMN_NAMES.join(", ");

function versionColumns(alias: string): string {
  return VERSION_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");
}

const ASSISTANT_SETTINGS_KEY = SETTINGS_KEYS.assistantDefault;

const ASSISTANT_RESPONSE_STYLES = new Set(["neutral", "friendly", "direct", "formal"]);
const ASSISTANT_VERBOSITY_OPTIONS = new Set(["concise", "balanced", "detailed"]);
const ASSISTANT_PROPOSAL_STYLES = new Set(["proactive", "balanced", "conservative"]);

interface AssistantSettingsValue {
  assistant_agent_id: string | null;
  response_style: string | null;
  verbosity: string | null;
  default_context_toggles_json: Record<string, boolean>;
  default_project_id: string | null;
  proposal_style: string | null;
  model_preferences_json: Record<string, unknown>;
}

const ASSISTANT_SETTINGS_DEFAULTS: AssistantSettingsValue = {
  assistant_agent_id: null,
  response_style: null,
  verbosity: null,
  default_context_toggles_json: {},
  default_project_id: null,
  proposal_style: null,
  model_preferences_json: {},
};

const ASSISTANT_SETTINGS_DEFINITION = defineScopedSetting<AssistantSettingsValue>({
  key: ASSISTANT_SETTINGS_KEY,
  scopeType: "space",
  defaults: ASSISTANT_SETTINGS_DEFAULTS,
  parse: parseAssistantSettings,
  serialize: assistantSettingsJson,
});

function enumStringOrNull(value: unknown, allowed: ReadonlySet<string>, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  if (allowed.has(value)) return value;
  throw new HttpError(422, `Invalid assistant ${field}`);
}

function parseAssistantSettings(value: unknown): AssistantSettingsValue {
  const settings = settingsRecord(value);
  return {
    assistant_agent_id: stringOrNull(settings.assistant_agent_id),
    response_style: enumStringOrNull(settings.response_style, ASSISTANT_RESPONSE_STYLES, "response_style"),
    verbosity: enumStringOrNull(settings.verbosity, ASSISTANT_VERBOSITY_OPTIONS, "verbosity"),
    default_context_toggles_json: booleanRecord(settings.default_context_toggles_json),
    default_project_id: stringOrNull(settings.default_project_id),
    proposal_style: enumStringOrNull(settings.proposal_style, ASSISTANT_PROPOSAL_STYLES, "proposal_style"),
    model_preferences_json: recordValue(settings.model_preferences_json) ?? {},
  };
}

function assistantSettingsJson(value: AssistantSettingsValue): Record<string, unknown> {
  return {
    assistant_agent_id: value.assistant_agent_id,
    response_style: value.response_style,
    verbosity: value.verbosity,
    default_context_toggles_json: value.default_context_toggles_json,
    default_project_id: value.default_project_id,
    proposal_style: value.proposal_style,
    model_preferences_json: value.model_preferences_json,
  };
}

function booleanRecord(value: unknown): Record<string, boolean> {
  const record = recordValue(value) ?? {};
  const output: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "boolean") output[key] = item;
  }
  return output;
}

function assistantSettingsRecordFromRead(
  spaceId: string,
  read: ScopedSettingsRead<AssistantSettingsValue>,
): AssistantSettingsRecord {
  if (!read.row) throw new Error("assistant settings row was not created");
  return {
    id: read.row.id,
    space_id: spaceId,
    assistant_agent_id: read.value.assistant_agent_id,
    response_style: read.value.response_style,
    verbosity: read.value.verbosity,
    default_context_toggles_json: read.value.default_context_toggles_json,
    default_project_id: read.value.default_project_id,
    proposal_style: read.value.proposal_style,
    model_preferences_json: read.value.model_preferences_json,
    created_at: read.row.created_at,
    updated_at: read.row.updated_at,
  };
}

export interface AgentChatRecord {
  id: string;
  space_id: string;
  name: string | null;
  current_version_id: string | null;
  tool_permissions_json?:Record<string,unknown>;
}

export class PgAgentChatRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgAgentChatRepository {
    if (!config.databaseUrl) {
      throw new Error("Agent chat repository requires SERVER_DATABASE_URL");
    }
    return new PgAgentChatRepository(getDbPool(config.databaseUrl));
  }

  async getAgentForChat(
    spaceId: string,
    userId: string,
    agentId: string,
  ): Promise<AgentChatRecord | null> {
    const result: QueryResult<AgentChatRecord> = await this.db.query<AgentChatRecord>(
      `SELECT a.id, a.space_id, a.name, a.current_version_id, COALESCE(av.tool_permissions_json,'{}'::jsonb) AS tool_permissions_json
         FROM agents a
         LEFT JOIN agent_versions av ON av.id=a.current_version_id AND av.agent_id=a.id AND av.space_id=a.space_id
        WHERE a.space_id = $1
          AND a.id = $2
          AND a.status = 'active'
          AND a.agent_kind <> 'system_assistant'
          AND ${contentReadSql("agent", "a", "$3")}
        LIMIT 1`,
      [spaceId, agentId, userId],
    );
    return result.rows[0] ?? null;
  }
}

export class PgAgentRepository {
  constructor(
    private readonly pool: Pool,
    private readonly config?: ServerConfig,
  ) {}

  static fromConfig(config: ServerConfig): PgAgentRepository {
    if (!config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    return new PgAgentRepository(getDbPool(config.databaseUrl), config);
  }

  async list(
    spaceId: string,
    userId: string,
    filters: {
      createdByUserId?: string | null;
      visibility?: string | null;
      status?: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<AgentOut[]> {
    const params: unknown[] = [spaceId, userId];
    const clauses = [
      "a.space_id = $1",
      "a.agent_kind <> 'system_assistant'",
      contentReadSql("agent", "a", "$2"),
    ];
    if (filters.createdByUserId) {
      params.push(filters.createdByUserId);
      clauses.push(contentOwnerFilterSql("agent", "a", `$${params.length}`));
    }
    if (filters.visibility) {
      params.push(filters.visibility);
      clauses.push(contentVisibilityParamFilterSql("a", `$${params.length}`));
    }
    if (filters.status) {
      const statuses = filters.status.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        params.push(statuses[0]);
        clauses.push(`a.status = $${params.length}`);
      } else if (statuses.length > 1) {
        params.push(statuses);
        clauses.push(`a.status = ANY($${params.length}::text[])`);
      }
    }
    params.push(filters.limit, filters.offset);
    const result = await this.pool.query<AgentRecord>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = COALESCE(arp.model_provider_id, av.model_provider_id)
        WHERE ${clauses.join(" AND ")}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map(agentOut);
  }

  async get(spaceId: string, agentId: string): Promise<AgentOut | null> {
    const result = await this.pool.query<AgentRecord>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = COALESCE(arp.model_provider_id, av.model_provider_id)
        WHERE a.space_id = $1 AND a.id = $2
          AND a.agent_kind <> 'system_assistant'
        LIMIT 1`,
      [spaceId, agentId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }

  /**
   * The managed Assistant for one scope.
   *
   * `projectId` null means the Space's own instance — the one `/home` chat and
   * the Assistant settings pointer anchor to. A Project id means that
   * Project's instance. The two are separate rows with separate partial unique
   * indexes, so this must always say which it wants: a query that took
   * whichever was created first would hand the Space's chat a Project's
   * Assistant as soon as a second one existed.
   */
  async getSystemAssistantInTransaction(
    db: Queryable,
    spaceId: string,
    projectId: string | null = null,
  ): Promise<AgentOut | null> {
    const result = await db.query<AgentRecord>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = COALESCE(arp.model_provider_id, av.model_provider_id)
        WHERE a.space_id = $1
          AND a.agent_kind = 'system_assistant'
          AND a.status = 'active'
          AND ($2::varchar IS NULL AND a.project_id IS NULL
               OR a.project_id = $2::varchar)
        ORDER BY a.created_at ASC, a.id ASC
        LIMIT 1`,
      [spaceId, projectId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }

  /**
   * Mark the instance's current version as a materialization of a seed.
   *
   * Creation goes through the ordinary `create` path, which knows nothing
   * about seeds; this is the provisioner saying "that first version was mine".
   * It never clears the mark and never touches a version that already carries
   * a different one, so it cannot re-attach an instance somebody has since
   * given a version of its own.
   */
  async markCurrentVersionFollowsSeedInTransaction(
    db: Queryable,
    spaceId: string,
    agentId: string,
    seedKey: string,
  ): Promise<void> {
    await db.query(
      `UPDATE agent_versions v
          SET follows_seed_key = $3
         FROM agents a
        WHERE a.space_id = $1 AND a.id = $2
          AND v.id = a.current_version_id
          AND v.follows_seed_key IS NULL`,
      [spaceId, agentId, seedKey],
    );
  }

  async ensureAssistantSettingsPointerInTransaction(
    db: Queryable,
    spaceId: string,
    assistantAgentId: string,
  ): Promise<void> {
    const store = new ScopedSettingsStore(db);
    await store.update(ASSISTANT_SETTINGS_DEFINITION, spaceId, (current) => ({
      ...current,
      // The managed identity is authoritative. Preserve the user-owned
      // preference fields, but never retain a deleted, archived, or ordinary
      // Agent pointer after Room provisioning reconciles the Space assistant.
      assistant_agent_id: assistantAgentId,
    }));
  }

  async ensureSystemAssistantActorInTransaction(
    db: Queryable,
    spaceId: string,
    agentId: string,
    displayName: string,
  ): Promise<void> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO actors (
         id, space_id, actor_type, user_id, agent_id, service_name,
         display_name, status, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, 'agent', NULL, $1, NULL, $3, 'active', '{}'::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         space_id = EXCLUDED.space_id,
         actor_type = 'agent',
         user_id = NULL,
         agent_id = EXCLUDED.agent_id,
         service_name = NULL,
         display_name = EXCLUDED.display_name,
         status = 'active',
         metadata_json = '{}'::jsonb,
         updated_at = now()
       WHERE actors.agent_id IS NOT DISTINCT FROM EXCLUDED.agent_id
       RETURNING id`,
      [agentId, spaceId, displayName],
    );
    if (!result.rows[0]) {
      throw new HttpError(409, "Managed Assistant actor identity is unavailable");
    }
  }

  async getVisible(spaceId: string, userId: string, agentId: string): Promise<AgentOut | null> {
    const result = await this.pool.query<AgentRecord>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = COALESCE(arp.model_provider_id, av.model_provider_id)
        WHERE a.space_id = $1 AND a.id = $2
          AND a.agent_kind <> 'system_assistant'
          AND ${contentReadSql("agent", "a", "$3")}
        LIMIT 1`,
      [spaceId, agentId, userId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }

  async listRuntimeProfiles(
    spaceId: string,
    agentId: string,
  ): Promise<AgentRuntimeProfileOut[]> {
    await this.requireAgent(spaceId, agentId);
    const result = await this.pool.query<AgentRuntimeProfileRecord>(
      `SELECT ${RUNTIME_PROFILE_COLUMNS}
         FROM agent_runtime_profiles arp
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE arp.space_id = $1 AND arp.agent_id = $2
        ORDER BY arp.is_default DESC, arp.enabled DESC, arp.created_at ASC, arp.id ASC`,
      [spaceId, agentId],
    );
    return result.rows.map(runtimeProfileOut);
  }

  async createRuntimeProfile(
    spaceId: string,
    agentId: string,
    input: {
      name: string;
      adapterType: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      enabled?: boolean;
      isDefault?: boolean;
      actorUserId?: string;
    },
  ): Promise<AgentRuntimeProfileOut> {
    await this.requireAgent(spaceId, agentId);
    const normalized = await this.normalizeRuntimeProfileInput(spaceId, { ...input, agentId });
    return withTransaction(this.pool, async (client) => {
      if (normalized.isDefault) {
        await this.clearDefaultRuntimeProfile(client, spaceId, agentId);
      }
      const created = await this.insertRuntimeProfile(client, {
        ...normalized,
        spaceId,
        agentId,
      });
      return runtimeProfileOut(created);
    });
  }

  async updateRuntimeProfile(
    spaceId: string,
    agentId: string,
    profileId: string,
    patch: {
      name?: string;
      adapterType?: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      enabled?: boolean;
      isDefault?: boolean;
      actorUserId?: string;
    },
  ): Promise<AgentRuntimeProfileOut> {
    const existing = await this.getRuntimeProfile(spaceId, agentId, profileId);
    if (!existing) throw new HttpError(404, "Runtime profile not found");
    const normalized = await this.normalizeRuntimeProfileInput(spaceId, {
      agentId,
      name: patch.name ?? existing.name,
      adapterType: patch.adapterType ?? existing.adapter_type,
      modelProviderId: Object.hasOwn(patch, "modelProviderId")
        ? patch.modelProviderId ?? null
        : existing.model_provider_id,
      modelName: Object.hasOwn(patch, "modelName")
        ? patch.modelName ?? null
        : existing.model_name,
      executionHostId: Object.hasOwn(patch, "executionHostId")
        ? patch.executionHostId ?? null
        : existing.execution_host_id,
      workspaceLocationId: Object.hasOwn(patch, "workspaceLocationId")
        ? patch.workspaceLocationId ?? null
        : existing.workspace_location_id,
      runtimeInstallation: Object.hasOwn(patch, "runtimeInstallation")
        ? patch.runtimeInstallation ?? null
        : existing.runtime_installation,
      runtimeConfigJson: patch.runtimeConfigJson
        ? { ...recordValue(existing.runtime_config_json), ...patch.runtimeConfigJson }
        : recordValue(existing.runtime_config_json),
      runtimePolicyJson: patch.runtimePolicyJson
        ? { ...recordValue(existing.runtime_policy_json), ...patch.runtimePolicyJson }
        : recordValue(existing.runtime_policy_json),
      enabled: Object.hasOwn(patch, "enabled") ? patch.enabled : existing.enabled,
      isDefault: Object.hasOwn(patch, "isDefault") ? patch.isDefault : existing.is_default,
      actorUserId: patch.actorUserId,
    });
    return withTransaction(this.pool, async (client) => {
      if (normalized.isDefault) {
        await this.clearDefaultRuntimeProfile(client, spaceId, agentId);
      }
      const now = new Date().toISOString();
      const result = await client.query<{ id: string }>(
        `UPDATE agent_runtime_profiles
            SET name = $4,
                adapter_type = $5,
                model_provider_id = $6,
                model_name = $7,
                execution_host_id = $8,
                workspace_location_id = $9,
                runtime_installation = $10,
                runtime_config_json = $11::jsonb,
                runtime_policy_json = $12::jsonb,
                enabled = $13,
                is_default = $14,
                updated_at = $15
          WHERE space_id = $1 AND agent_id = $2 AND id = $3
          RETURNING id`,
        [
          spaceId,
          agentId,
          profileId,
          normalized.name,
          normalized.adapterType,
          normalized.modelProviderId,
          normalized.modelName,
          normalized.executionHostId,
          normalized.workspaceLocationId,
          normalized.runtimeInstallation,
          JSON.stringify(normalized.runtimeConfigJson),
          JSON.stringify(normalized.runtimePolicyJson),
          normalized.enabled,
          normalized.isDefault,
          now,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "Runtime profile not found");
      const updated = await this.getRuntimeProfileWithClient(client, spaceId, agentId, row.id);
      if (!updated) throw new HttpError(404, "Runtime profile not found");
      return runtimeProfileOut(updated);
    });
  }

  async create(input: AgentCreateInput): Promise<AgentOut> {
    return withTransaction(this.pool, (client) => this.createInTransaction(client, input));
  }

  async createInTransaction(client: PoolClient, input: AgentCreateInput): Promise<AgentOut> {
    if (input.visibility && !isContentVisibility(input.visibility)) {
      throw new HttpError(422, "Invalid visibility");
    }
    const adapterType = normalizeAdapterType(input.adapterType);
    const providerId = input.defaultModelProviderId ?? null;
    const modelName = input.defaultModel ?? null;
    const hostBound = input.executionHostId != null
      || input.workspaceLocationId != null
      || input.runtimeInstallation != null;
    if (hostBound) {
      if (providerId !== null || modelName !== null) {
        throw new HttpError(422, "Host-bound runtime profiles cannot use a server ModelProvider or model selection");
      }
      await this.validateHostExecutionBinding(client, {
        spaceId: input.spaceId,
        projectId: input.projectId ?? null,
        actorUserId: input.userId,
        executionHostId: input.executionHostId ?? null,
        workspaceLocationId: input.workspaceLocationId ?? null,
        runtimeInstallation: input.runtimeInstallation ?? null,
        adapterType,
      });
    }
    await this.validateModelSelection(client, input.spaceId, adapterType, providerId, modelName, hostBound);
    const runtimeConfigJson = await this.resolveRuntimeConfig(
      client,
      input.spaceId,
      adapterType,
      input.runtimeConfigJson ?? DEFAULT_RUNTIME_CONFIG,
      input.runtimeToolVersion,
      hostBound,
    );
    return this.createAgentWithVersion(client, {
      spaceId: input.spaceId,
      projectId: input.projectId ?? null,
      ownerUserId: input.ownerUserId === undefined ? input.userId : input.ownerUserId,
      name: input.name,
      description: input.description ?? null,
      visibility: input.visibility ?? "private",
      roleInstruction: input.roleInstruction ?? null,
      status: "active",
      agentKind: input.agentKind ?? "standard",
      systemPrompt: input.systemPrompt ?? null,
      promptProvenanceJson: input.promptProvenanceJson ?? null,
      modelProviderId: providerId,
      modelName,
      modelConfigJson: input.modelConfigJson ?? defaultModelConfigFor(modelName),
      runtimeConfigJson,
      contextPolicyJson: input.contextPolicyJson ?? {},
      memoryPolicyJson: input.memoryPolicyJson ?? DEFAULT_MEMORY_POLICY,
      capabilitiesJson: input.capabilitiesJson ?? [],
      toolPermissionsJson: input.toolPermissionsJson ?? {},
      runtimePolicyJson: buildRuntimePolicy(adapterType, input.runtimePolicyJson),
      toolPolicyJson: input.toolPolicyJson ?? {},
      outputPolicyJson: input.outputPolicyJson ?? {},
      scheduleConfigJson: input.scheduleConfigJson ?? {},
      outputSchemaJson: input.outputSchemaJson ?? {},
      executionHostId: input.executionHostId ?? null,
      workspaceLocationId: input.workspaceLocationId ?? null,
      runtimeInstallation: input.runtimeInstallation ?? null,
    });
  }

  async ensureRuntimeProfileInTransaction(
    client: PoolClient,
    spaceId: string,
    agentId: string,
    input: {
      agentId?: string;
      name: string;
      adapterType: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      isDefault?: boolean;
      /** Pre-resolved by the caller outside the transaction for CLI profiles. */
      runtimeToolVersion?: string | null;
      actorUserId?: string;
    },
  ): Promise<AgentRuntimeProfileOut> {
    const existing = await client.query<AgentRuntimeProfileRecord>(
      `SELECT ${RUNTIME_PROFILE_COLUMNS}
         FROM agent_runtime_profiles arp
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE arp.space_id = $1
          AND arp.agent_id = $2
          AND arp.adapter_type = $3
          AND arp.model_provider_id IS NOT DISTINCT FROM $4
          AND arp.execution_host_id IS NOT DISTINCT FROM $5
          AND arp.workspace_location_id IS NOT DISTINCT FROM $6
          AND arp.runtime_installation IS NOT DISTINCT FROM $7
        ORDER BY arp.enabled DESC, arp.is_default DESC, arp.created_at ASC, arp.id ASC
        LIMIT 1`,
      [
        spaceId,
        agentId,
        normalizeAdapterType(input.adapterType),
        input.modelProviderId ?? null,
        input.executionHostId ?? null,
        input.workspaceLocationId ?? null,
        input.runtimeInstallation ?? null,
      ],
    );
    const normalized = await this.normalizeRuntimeProfileInput(spaceId, {
      name: input.name,
      adapterType: input.adapterType,
      modelProviderId: input.modelProviderId,
      modelName: input.modelName,
      executionHostId: input.executionHostId,
      workspaceLocationId: input.workspaceLocationId,
      runtimeInstallation: input.runtimeInstallation,
      runtimeConfigJson: input.runtimeConfigJson,
      runtimePolicyJson: input.runtimePolicyJson,
      enabled: true,
      isDefault: input.isDefault ?? false,
      runtimeToolVersion: input.runtimeToolVersion,
      agentId,
      actorUserId: input.actorUserId,
    }, client);
    if (existing.rows[0]) {
      if (normalized.isDefault) await this.clearDefaultRuntimeProfile(client, spaceId, agentId);
      const updated = await client.query<{ id: string }>(
        `UPDATE agent_runtime_profiles
            SET name = $4,
                model_name = $5,
                execution_host_id = $6,
                workspace_location_id = $7,
                runtime_installation = $8,
                runtime_config_json = $9::jsonb,
                runtime_policy_json = $10::jsonb,
                enabled = true,
                is_default = $11,
                updated_at = now()
          WHERE space_id = $1 AND agent_id = $2 AND id = $3
          RETURNING id`,
        [
          spaceId,
          agentId,
          existing.rows[0].id,
          normalized.name,
          normalized.modelName,
          normalized.executionHostId,
          normalized.workspaceLocationId,
          normalized.runtimeInstallation,
          JSON.stringify(normalized.runtimeConfigJson),
          JSON.stringify(normalized.runtimePolicyJson),
          normalized.isDefault,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new HttpError(404, "Runtime profile not found");
      const refreshed = await this.getRuntimeProfileWithClient(client, spaceId, agentId, row.id);
      if (!refreshed) throw new HttpError(404, "Runtime profile not found");
      return runtimeProfileOut(refreshed);
    }
    if (normalized.isDefault) await this.clearDefaultRuntimeProfile(client, spaceId, agentId);
    return runtimeProfileOut(await this.insertRuntimeProfile(client, {
      ...normalized,
      spaceId,
      agentId,
    }));
  }

  async update(
    spaceId: string,
    userId: string,
    agentId: string,
    patch: {
      name?: string;
      description?: string | null;
      roleInstruction?: string | null;
      status?: string;
    },
  ): Promise<AgentOut> {
    if (!(await contentOwnerFromDb(this.pool, { spaceId, userId }, "agent", agentId))) {
      throw new HttpError(404, "Agent not found");
    }
    const now = new Date().toISOString();
    const result = await this.pool.query<AgentRecord>(
      `UPDATE agents
          SET name = COALESCE($3, name),
              description = CASE WHEN $4::boolean THEN $5 ELSE description END,
              role_instruction = CASE WHEN $6::boolean THEN $7 ELSE role_instruction END,
              status = COALESCE($8, status),
              updated_at = $9
        WHERE space_id = $1 AND id = $2
        RETURNING id`,
      [
        spaceId,
        agentId,
        patch.name ?? null,
        Object.hasOwn(patch, "description"),
        patch.description ?? null,
        Object.hasOwn(patch, "roleInstruction"),
        patch.roleInstruction ?? null,
        patch.status ?? null,
        now,
      ],
    );
    if (!result.rows[0]) throw new HttpError(404, "Agent not found");
    const updated = await this.get(spaceId, agentId);
    if (!updated) throw new HttpError(404, "Agent not found");
    return updated;
  }

  async updateConfig(
    spaceId: string,
    agentId: string,
    patch: {
      userId: string;
      name?: string | null;
      description?: string | null;
      systemPrompt?: string | null;
      modelProviderId?: string | null;
      modelName?: string | null;
      modelConfigJson?: Record<string, unknown> | null;
      contextPolicyJson?: Record<string, unknown> | null;
      memoryPolicyJson?: Record<string, unknown> | null;
      outputPolicyJson?: Record<string, unknown> | null;
      scheduleConfigJson?: Record<string, unknown> | null;
      outputSchemaJson?: Record<string, unknown> | null;
      runtimeConfigJson?: Record<string, unknown> | null;
    },
  ): Promise<AgentOut> {
    await this.requireAgent(spaceId, agentId);
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockCurrentVersion(client, spaceId, agentId);
      if (!current) throw new HttpError(404, "Agent has no current version");
      const modelProviderId = Object.hasOwn(patch, "modelProviderId")
        ? patch.modelProviderId ?? null
        : current.model_provider_id;
      const modelName = Object.hasOwn(patch, "modelName")
        ? patch.modelName ?? null
        : current.model_name;
      if (modelProviderId || modelName) {
        const adapterType = normalizeAdapterType(
          stringValue(current.runtime_policy_json?.default_adapter_type),
        );
        await this.validateModelSelection(client, spaceId, adapterType, modelProviderId, modelName);
      }
      const now = new Date().toISOString();
      if (Object.hasOwn(patch, "name") || Object.hasOwn(patch, "description")) {
        await client.query(
          `UPDATE agents
              SET name = COALESCE($3, name),
                  description = CASE WHEN $4::boolean THEN $5 ELSE description END,
                  updated_at = $6
            WHERE space_id = $1 AND id = $2`,
          [
            spaceId,
            agentId,
            patch.name ?? null,
            Object.hasOwn(patch, "description"),
            patch.description ?? null,
            now,
          ],
        );
      }
      const versionPatch: Partial<AgentVersionRecord> = {
        system_prompt: Object.hasOwn(patch, "systemPrompt") ? patch.systemPrompt ?? null : current.system_prompt,
        prompt_provenance_json: Object.hasOwn(patch, "systemPrompt") ? null : current.prompt_provenance_json,
        model_provider_id: modelProviderId,
        model_name: modelName,
        model_config_json: patch.modelConfigJson
          ? { ...current.model_config_json, ...patch.modelConfigJson }
          : current.model_config_json,
        context_policy_json: patch.contextPolicyJson ?? current.context_policy_json,
        memory_policy_json: patch.memoryPolicyJson ?? current.memory_policy_json,
        output_policy_json: patch.outputPolicyJson ?? current.output_policy_json,
        schedule_config_json: patch.scheduleConfigJson ?? current.schedule_config_json,
        output_schema_json: patch.outputSchemaJson ?? current.output_schema_json,
        runtime_config_json: patch.runtimeConfigJson
          ? { ...current.runtime_config_json, ...patch.runtimeConfigJson }
          : current.runtime_config_json,
      };
      const currentAdapterType = normalizeAdapterType(
        stringValue(versionPatch.runtime_config_json?.adapter_type) ||
        stringValue(current.runtime_policy_json?.default_adapter_type),
      );
      const runtimeConfigJson = await this.resolveRuntimeConfig(
        client,
        spaceId,
        currentAdapterType,
        versionPatch.runtime_config_json ?? current.runtime_config_json,
      );
      const newVersion = await this.insertVersion(client, {
        agentId,
        spaceId,
        versionLabel: await this.nextVersionLabel(client, spaceId, agentId),
        modelProviderId: versionPatch.model_provider_id ?? null,
        modelName: versionPatch.model_name ?? null,
        systemPrompt: versionPatch.system_prompt ?? null,
        promptProvenanceJson: versionPatch.prompt_provenance_json ?? null,
        modelConfigJson: versionPatch.model_config_json ?? defaultModelConfigFor(versionPatch.model_name),
        runtimeConfigJson,
        contextPolicyJson: versionPatch.context_policy_json ?? {},
        memoryPolicyJson: versionPatch.memory_policy_json ?? DEFAULT_MEMORY_POLICY,
        capabilitiesJson: current.capabilities_json,
        toolPermissionsJson: current.tool_permissions_json,
        runtimePolicyJson: current.runtime_policy_json,
        toolPolicyJson: current.tool_policy_json,
        outputPolicyJson: versionPatch.output_policy_json ?? {},
        scheduleConfigJson: versionPatch.schedule_config_json ?? {},
        outputSchemaJson: versionPatch.output_schema_json ?? {},
      });
      await client.query(
        `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
        [spaceId, agentId, newVersion.id, now],
      );
      const updated = await this.getAgentWithClient(client, spaceId, agentId);
      if (!updated) throw new HttpError(404, "Agent not found");
      return updated;
    });
  }

  async getCurrentVersion(spaceId: string, agentId: string): Promise<AgentVersionRecord | null> {
    await this.requireAgent(spaceId, agentId);
    const result = await this.pool.query<AgentVersionRecord>(
      `SELECT ${versionColumns("av")}
         FROM agents a
         JOIN agent_versions av ON av.id = a.current_version_id
        WHERE a.space_id = $1 AND a.id = $2
        LIMIT 1`,
      [spaceId, agentId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Replaces the current version of a system-managed Agent without mutating
   * historical AgentVersion rows. The Agent row is locked so concurrent
   * refreshes either observe the newly-published version or serialize behind
   * the publisher instead of allocating the same version label.
   */
  async publishSystemManagedPrompt(input: {
    spaceId: string;
    agentId: string;
    agentKind: "system_source_post_processor" | "system_source_annotator" | "system_research";
    systemPrompt: string;
    promptProvenanceJson?: PromptProvenance | null;
  }): Promise<{ changed: boolean; versionId: string }> {
    return withTransaction(this.pool, async (client) => {
      // The managed Assistant is materialized from a seed and reconciled
      // through `reconcileSystemManagedAgentInTransaction`, which tracks
      // `follows_seed_key`. Publishing an unmarked version here would detach
      // the instance from its seed as a side effect, and nothing would say so.
      if ((input.agentKind as string) === "system_assistant") {
        throw new HttpError(422, "Use the Assistant provisioner to publish a system_assistant prompt");
      }
      const current = await this.lockCurrentVersion(
        client,
        input.spaceId,
        input.agentId,
        input.agentKind,
      );
      if (!current) throw new HttpError(404, "Active system-managed Agent not found");
      const promptProvenanceJson = input.promptProvenanceJson ?? null;
      if (
        current.system_prompt === input.systemPrompt
        && JSON.stringify(current.prompt_provenance_json) === JSON.stringify(promptProvenanceJson)
      ) {
        return { changed: false, versionId: current.id };
      }

      const version = await this.insertVersion(client, {
        agentId: input.agentId,
        spaceId: input.spaceId,
        versionLabel: await this.nextVersionLabel(client, input.spaceId, input.agentId),
        modelProviderId: current.model_provider_id,
        modelName: current.model_name,
        systemPrompt: input.systemPrompt,
        promptProvenanceJson,
        modelConfigJson: current.model_config_json,
        runtimeConfigJson: current.runtime_config_json,
        contextPolicyJson: current.context_policy_json,
        memoryPolicyJson: current.memory_policy_json,
        capabilitiesJson: current.capabilities_json,
        toolPermissionsJson: current.tool_permissions_json,
        runtimePolicyJson: current.runtime_policy_json,
        toolPolicyJson: current.tool_policy_json,
        outputPolicyJson: current.output_policy_json,
        scheduleConfigJson: current.schedule_config_json,
        outputSchemaJson: current.output_schema_json,
      });
      await client.query(
        `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
        [input.spaceId, input.agentId, version.id, new Date().toISOString()],
      );
      return { changed: true, versionId: version.id };
    });
  }

  async reconcileSystemManagedAgentInTransaction(
    client: PoolClient,
    input: {
      spaceId: string;
      agentId: string;
      name: string;
      description: string | null;
      systemPrompt: string;
      promptProvenanceJson: PromptProvenance | null;
      modelProviderId: string | null;
      modelName: string | null;
      modelConfigJson: Record<string, unknown>;
      runtimeConfigJson: Record<string, unknown>;
      contextPolicyJson: Record<string, unknown>;
      memoryPolicyJson: Record<string, unknown>;
      capabilitiesJson: unknown[];
      toolPermissionsJson: Record<string, unknown>;
      runtimePolicyJson: Record<string, unknown>;
      toolPolicyJson: Record<string, unknown>;
      outputPolicyJson: Record<string, unknown>;
      scheduleConfigJson: Record<string, unknown>;
      outputSchemaJson: Record<string, unknown>;
      /** Which scope this instance belongs to. Null is the Space's own. */
      projectId?: string | null;
      /** The seed being materialized. A version carrying it is re-materialized
       * when the seed changes; one that does not has been given a version of
       * its own and is left alone. */
      followsSeedKey?: string | null;
    },
  ): Promise<AgentOut> {
    const agent = await client.query<{ id: string }>(
      `SELECT id
         FROM agents
        WHERE space_id = $1
          AND id = $2
          AND agent_kind = 'system_assistant'
        FOR UPDATE`,
      [input.spaceId, input.agentId],
    );
    if (!agent.rows[0]) throw new HttpError(404, "Active system-managed Agent not found");

    const now = new Date().toISOString();
    await client.query(
      `UPDATE agents
          SET project_id = $6,
              owner_user_id = NULL,
              name = $3,
              description = $4,
              role_instruction = NULL,
              status = 'active',
              visibility = 'space_shared',
              access_level = 'full',
              updated_at = $5
        WHERE space_id = $1 AND id = $2`,
      [input.spaceId, input.agentId, input.name, input.description, now, input.projectId ?? null],
    );

    const current = await this.lockCurrentVersion(client, input.spaceId, input.agentId, "system_assistant");
    const equal = current
      && current.model_provider_id === input.modelProviderId
      && current.model_name === input.modelName
      && current.system_prompt === input.systemPrompt
      && stableJsonStringify(current.prompt_provenance_json) === stableJsonStringify(input.promptProvenanceJson)
      && stableJsonStringify(current.model_config_json) === stableJsonStringify(input.modelConfigJson)
      && stableJsonStringify(current.runtime_config_json) === stableJsonStringify(input.runtimeConfigJson)
      && stableJsonStringify(current.context_policy_json) === stableJsonStringify(input.contextPolicyJson)
      && stableJsonStringify(current.memory_policy_json) === stableJsonStringify(input.memoryPolicyJson)
      && stableJsonStringify(current.capabilities_json) === stableJsonStringify(input.capabilitiesJson)
      && stableJsonStringify(current.tool_permissions_json) === stableJsonStringify(input.toolPermissionsJson)
      && stableJsonStringify(current.runtime_policy_json) === stableJsonStringify(input.runtimePolicyJson)
      && stableJsonStringify(current.tool_policy_json) === stableJsonStringify(input.toolPolicyJson)
      && stableJsonStringify(current.output_policy_json) === stableJsonStringify(input.outputPolicyJson)
      && stableJsonStringify(current.schedule_config_json) === stableJsonStringify(input.scheduleConfigJson)
      && stableJsonStringify(current.output_schema_json) === stableJsonStringify(input.outputSchemaJson);

    // A version somebody else authored is not the seed's to overwrite. The
    // instance keeps its identity fields in step and stops there.
    //
    // An unmarked version that is nevertheless identical to what the seed
    // produces is adopted rather than treated as divergence: it predates the
    // mark and provably nobody has changed it. Where an unmarked version
    // *differs*, a legacy drift and a person's edit are indistinguishable, and
    // declining to overwrite is the safe direction.
    if (current && input.followsSeedKey && current.follows_seed_key !== input.followsSeedKey) {
      if (equal && current.follows_seed_key === null) {
        // Adopt only an *unmarked* version. One already carrying a different
        // seed belongs to that seed, and claiming it because the content
        // happens to match would silently move it between managed lineages.
        await client.query(
          `UPDATE agent_versions
              SET follows_seed_key = $3
            WHERE id = $1 AND space_id = $2 AND follows_seed_key IS NULL`,
          [current.id, input.spaceId, input.followsSeedKey],
        );
      }
      // Detachment needs no separate note: `follows_seed_key IS NULL` on a
      // system-managed Agent's current version *is* the record, and it is the
      // column this branch reads. A second copy in agent metadata would add a
      // timestamp nobody reads and a way for the two to disagree.
      const settled = await this.getAgentWithClient(client, input.spaceId, input.agentId);
      if (!settled) throw new HttpError(404, "Active system-managed Agent not found");
      return settled;
    }

    if (!equal) {
      const version = await this.insertVersion(client, {
        agentId: input.agentId,
        spaceId: input.spaceId,
        versionLabel: await this.nextVersionLabel(client, input.spaceId, input.agentId),
        modelProviderId: input.modelProviderId,
        modelName: input.modelName,
        systemPrompt: input.systemPrompt,
        promptProvenanceJson: input.promptProvenanceJson,
        followsSeedKey: input.followsSeedKey ?? null,
        modelConfigJson: input.modelConfigJson,
        runtimeConfigJson: input.runtimeConfigJson,
        contextPolicyJson: input.contextPolicyJson,
        memoryPolicyJson: input.memoryPolicyJson,
        capabilitiesJson: input.capabilitiesJson,
        toolPermissionsJson: input.toolPermissionsJson,
        runtimePolicyJson: input.runtimePolicyJson,
        toolPolicyJson: input.toolPolicyJson,
        outputPolicyJson: input.outputPolicyJson,
        scheduleConfigJson: input.scheduleConfigJson,
        outputSchemaJson: input.outputSchemaJson,
      });
      await client.query(
        `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
        [input.spaceId, input.agentId, version.id, now],
      );
    }

    const reconciled = await this.getAgentWithClient(client, input.spaceId, input.agentId);
    if (!reconciled) throw new HttpError(404, "Active system-managed Agent not found");
    return reconciled;
  }

  async listVersions(spaceId: string, agentId: string): Promise<AgentVersionRecord[]> {
    await this.requireAgent(spaceId, agentId);
    const result = await this.pool.query<AgentVersionRecord>(
      `SELECT ${VERSION_COLUMNS}
         FROM agent_versions
        WHERE space_id = $1 AND agent_id = $2
        ORDER BY created_at DESC, id DESC`,
      [spaceId, agentId],
    );
    return result.rows;
  }

  async getVersion(
    spaceId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> {
    await this.requireAgent(spaceId, agentId);
    const result = await this.pool.query<AgentVersionRecord>(
      `SELECT ${VERSION_COLUMNS}
         FROM agent_versions
        WHERE space_id = $1 AND agent_id = $2 AND id = $3
        LIMIT 1`,
      [spaceId, agentId, versionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "AgentVersion not found for this agent in this space");
    return row;
  }

  async restoreVersion(
    spaceId: string,
    agentId: string,
    versionId: string,
    userId: string,
  ): Promise<AgentOut> {
    const source = await this.getVersion(spaceId, agentId, versionId);
    return withTransaction(this.pool, async (client) => {
      if (!(await this.lockCurrentVersion(client, spaceId, agentId))) {
        throw new HttpError(404, "Agent has no current version");
      }
      const version = await this.insertVersion(client, {
        agentId,
        spaceId,
        versionLabel: await this.nextVersionLabel(client, spaceId, agentId),
        modelProviderId: source.model_provider_id,
        modelName: source.model_name,
        systemPrompt: source.system_prompt,
        promptProvenanceJson: source.prompt_provenance_json,
        modelConfigJson: source.model_config_json,
        runtimeConfigJson: source.runtime_config_json,
        contextPolicyJson: source.context_policy_json,
        memoryPolicyJson: source.memory_policy_json,
        capabilitiesJson: source.capabilities_json,
        toolPermissionsJson: source.tool_permissions_json,
        runtimePolicyJson: source.runtime_policy_json,
        toolPolicyJson: source.tool_policy_json,
        outputPolicyJson: source.output_policy_json,
        scheduleConfigJson: source.schedule_config_json,
        outputSchemaJson: source.output_schema_json,
      });
      await client.query(
        `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
        [spaceId, agentId, version.id, new Date().toISOString()],
      );
      const updated = await this.getAgentWithClient(client, spaceId, agentId);
      if (!updated) throw new HttpError(404, "Agent not found");
      return updated;
    });
  }

  /** The Space's own Assistant, never a Project's — this backs the Space-level
   * Assistant settings, which are personal preferences and not per-Project. */
  async getDefaultAssistant(spaceId: string): Promise<AgentOut | null> {
    const result = await this.pool.query<AgentRecord>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = COALESCE(arp.model_provider_id, av.model_provider_id)
        WHERE a.space_id = $1
          AND a.agent_kind = 'system_assistant'
          AND a.status = 'active'
          AND a.project_id IS NULL
        ORDER BY a.created_at ASC
        LIMIT 1`,
      [spaceId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }

  async getAssistantSettings(spaceId: string): Promise<AssistantSettingsRecord> {
    const store = new ScopedSettingsStore(this.pool);
    const existing = await store.get(ASSISTANT_SETTINGS_DEFINITION, spaceId);
    if (existing.row) return assistantSettingsRecordFromRead(spaceId, existing);
    const assistant = await this.getDefaultAssistant(spaceId);
    const created = await store.createIfMissing(ASSISTANT_SETTINGS_DEFINITION, spaceId, {
      ...ASSISTANT_SETTINGS_DEFAULTS,
      assistant_agent_id: assistant?.id ?? null,
    });
    return assistantSettingsRecordFromRead(spaceId, created);
  }

  async updateAssistantSettings(
    spaceId: string,
    patch: Record<string, unknown>,
    options: { actorUserId?: string | null } = {},
  ): Promise<AssistantSettingsRecord> {
    const existing = await this.getAssistantSettings(spaceId);
    const assistant = existing.assistant_agent_id ? null : await this.getDefaultAssistant(spaceId);
    const next: AssistantSettingsValue = {
      assistant_agent_id: existing.assistant_agent_id ?? assistant?.id ?? null,
      response_style: Object.hasOwn(patch, "response_style")
        ? enumStringOrNull(patch.response_style, ASSISTANT_RESPONSE_STYLES, "response_style")
        : existing.response_style,
      verbosity: Object.hasOwn(patch, "verbosity")
        ? enumStringOrNull(patch.verbosity, ASSISTANT_VERBOSITY_OPTIONS, "verbosity")
        : existing.verbosity,
      default_context_toggles_json: Object.hasOwn(patch, "default_context_toggles_json")
        ? booleanRecord(patch.default_context_toggles_json)
        : booleanRecord(existing.default_context_toggles_json),
      default_project_id: Object.hasOwn(patch, "default_project_id")
        ? stringOrNull(patch.default_project_id)
        : existing.default_project_id,
      proposal_style: Object.hasOwn(patch, "proposal_style")
        ? enumStringOrNull(patch.proposal_style, ASSISTANT_PROPOSAL_STYLES, "proposal_style")
        : existing.proposal_style,
      model_preferences_json: Object.hasOwn(patch, "model_preferences_json")
        ? recordValue(patch.model_preferences_json) ?? {}
        : recordValue(existing.model_preferences_json) ?? {},
    };
    const result = await new ScopedSettingsStore(this.pool).upsert(
      ASSISTANT_SETTINGS_DEFINITION,
      spaceId,
      next,
      { updatedByUserId: options.actorUserId ?? null },
    );
    return assistantSettingsRecordFromRead(spaceId, result);
  }

  private async validateModelSelection(
    db: Queryable,
    spaceId: string,
    adapterType: string,
    providerId: string | null,
    modelName: string | null,
    hostBound = false,
  ): Promise<void> {
    const spec = BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType];
    if (!spec) throw new HttpError(400, `Unknown adapter_type ${JSON.stringify(adapterType)}`);
    if (modelName && !providerId && !hostBound) {
      throw new HttpError(400, "default_model_provider_id is required when default_model is set");
    }
    if (spec.model.model_provider_mode === "required" && !providerId && !hostBound) {
      throw new HttpError(
        400,
        `adapter_type ${JSON.stringify(adapterType)} requires a model provider; set default_model_provider_id.`,
      );
    }
    if (providerId) {
      const provider = await db.query<{ id: string; config_json: unknown }>(
        `SELECT p.id, p.config_json
           FROM model_provider_space_grants g
           JOIN model_providers p ON p.id = g.provider_id
          WHERE g.space_id = $1
            AND g.provider_id = $2
            AND g.enabled = true
            AND p.enabled = true`,
        [spaceId, providerId],
      );
      const row = provider.rows[0];
      if (!row) {
        throw new HttpError(400, "Model provider is not selectable in this space");
      }
      if (adapterType === "claude_code") {
        const cfg = recordValue(row.config_json) ?? {};
        const claudeUrl = cfg.claude_compatible_base_url;
        if (typeof claudeUrl !== "string" || !claudeUrl.trim()) {
          throw new HttpError(
            400,
            "Claude Code provider selection requires claude_compatible_base_url",
          );
        }
      }
      if (adapterType === "codex_cli") {
        const cfg = recordValue(row.config_json) ?? {};
        const openAiUrl = cfg.openai_compatible_base_url;
        if (typeof openAiUrl !== "string" || !openAiUrl.trim()) {
          throw new HttpError(
            400,
            "Codex CLI provider selection requires openai_compatible_base_url",
          );
        }
      }
    }
  }

  private async validateHostExecutionBinding(
    db: Queryable,
    input: {
      spaceId: string;
      projectId: string | null;
      actorUserId: string | null;
      executionHostId: string | null;
      workspaceLocationId: string | null;
      runtimeInstallation: string | null;
      adapterType: string;
    },
  ): Promise<void> {
    if (!input.executionHostId || !input.workspaceLocationId || !input.runtimeInstallation) {
      throw new HttpError(422, "Host-bound runtime profiles require execution_host_id, workspace_location_id, and runtime_installation");
    }
    if (!input.projectId) throw new HttpError(422, "A host-bound Agent must belong to a Project");
    if (!input.actorUserId) throw new HttpError(403, "Host-bound execution requires an owning user");
    const target = await db.query<{
      host_owner_user_id: string | null;
      host_kind: string;
      host_status: string;
      capabilities_json: unknown;
      location_host_id: string;
      location_space_id: string;
      location_status: string;
      folder_space_id: string;
      folder_project_id: string | null;
    }>(
      `SELECT host.owner_user_id AS host_owner_user_id, host.kind AS host_kind,
              host.status AS host_status, host.capabilities_json,
              location.execution_host_id AS location_host_id,
              location.space_id AS location_space_id, location.status AS location_status,
              folder.space_id AS folder_space_id, folder.project_id AS folder_project_id
         FROM hosts host
         JOIN workspace_locations location ON location.execution_host_id = host.id
         JOIN project_folders folder ON folder.id = location.project_folder_id
        WHERE host.id = $1 AND location.id = $2
        LIMIT 1`,
      [input.executionHostId, input.workspaceLocationId],
    );
    const row = target.rows[0];
    if (!row) throw new HttpError(404, "Host or Workspace Location not found");
    if (row.location_space_id !== input.spaceId
      || row.folder_space_id !== input.spaceId) {
      throw new HttpError(404, "Host or Workspace Location not found");
    }
    if (row.host_owner_user_id !== input.actorUserId) {
      throw new HttpError(403, "The execution host must belong to the caller");
    }
    if (row.host_kind !== "remote" || row.host_status === "revoked") {
      throw new HttpError(422, "Host-bound Agents require a paired remote execution host");
    }
    if (row.location_host_id !== input.executionHostId || row.location_status !== "active") {
      throw new HttpError(422, "Workspace Location is not active on the selected host");
    }
    if (row.folder_project_id !== input.projectId) {
      throw new HttpError(422, "Workspace Location must belong to the Agent's Project");
    }
    const spec = getLocalCliRuntimeAdapterSpec(input.adapterType);
    if (!spec || spec.implementation_status !== "implemented" || spec.invocation.protocol !== "acp") {
      throw new HttpError(422, `Runtime adapter '${input.adapterType}' is not supported on a paired host`);
    }
    if (!hostInstallationIds(row.capabilities_json, input.adapterType).includes(input.runtimeInstallation)) {
      throw new HttpError(422, `Host does not report installation '${input.runtimeInstallation}' of '${input.adapterType}'`);
    }
  }

  private async resolveRuntimeConfig(
    db: Queryable,
    spaceId: string,
    adapterType: string,
    input: Record<string, unknown>,
    preparedRuntimeToolVersion?: string | null,
    hostBound = false,
  ): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = { ...input, adapter_type: adapterType };
    if (!isCliRuntimeTool(adapterType)) return config;
    if (hostBound) return config;
    if (preparedRuntimeToolVersion) {
      const requestedVersion = stringValue(config["runtime_tool_version"]);
      if (requestedVersion && requestedVersion !== preparedRuntimeToolVersion) {
        throw new HttpError(
          409,
          `Prepared runtime tool version '${preparedRuntimeToolVersion}' does not match requested version '${requestedVersion}'`,
        );
      }
      return { ...config, runtime_tool_version: preparedRuntimeToolVersion };
    }
    if (!this.config) {
      throw new HttpError(500, "Server config is required to resolve CLI runtime tool versions");
    }
    const requestedVersion = stringValue(config["runtime_tool_version"]);
    const version = await resolveRuntimeToolVersionForSpace(
      db,
      new RuntimeToolRegistry(this.config),
      spaceId,
      adapterType,
      requestedVersion,
    );
    return { ...config, runtime_tool_version: version };
  }

  private async requireAgent(spaceId: string, agentId: string): Promise<void> {
    const found = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM agents
        WHERE space_id = $1
          AND id = $2
          AND agent_kind <> 'system_assistant'
        LIMIT 1`,
      [spaceId, agentId],
    );
    if (!found.rows[0]) throw new HttpError(404, "Agent not found");
  }

  private async lockCurrentVersion(
    db: Queryable,
    spaceId: string,
    agentId: string,
    agentKind?: "system_assistant" | "system_source_post_processor" | "system_source_annotator" | "system_research",
  ): Promise<AgentVersionRecord | null> {
    const agent = await db.query<{ current_version_id: string | null }>(
      `SELECT current_version_id
         FROM agents
        WHERE space_id = $1
          AND id = $2
          AND ($3::varchar IS NULL OR (agent_kind = $3 AND status = 'active'))
        FOR UPDATE`,
      [spaceId, agentId, agentKind ?? null],
    );
    const versionId = agent.rows[0]?.current_version_id;
    if (!versionId) return null;
    const version = await db.query<AgentVersionRecord>(
      `SELECT ${VERSION_COLUMNS}
         FROM agent_versions
        WHERE id = $1 AND agent_id = $2 AND space_id = $3`,
      [versionId, agentId, spaceId],
    );
    return version.rows[0] ?? null;
  }

  private async createAgentWithVersion(
    client: PoolClient,
    input: {
      spaceId: string;
      projectId: string | null;
      ownerUserId: string | null;
      name: string;
      description: string | null;
      visibility: string;
      roleInstruction: string | null;
      status: string;
      agentKind: string;
      systemPrompt: string | null;
      promptProvenanceJson: PromptProvenance | null;
      modelProviderId: string | null;
      modelName: string | null;
      modelConfigJson: Record<string, unknown>;
      runtimeConfigJson: Record<string, unknown>;
      contextPolicyJson: Record<string, unknown>;
      memoryPolicyJson: Record<string, unknown>;
      capabilitiesJson: unknown[];
      toolPermissionsJson: Record<string, unknown>;
      runtimePolicyJson: Record<string, unknown>;
      toolPolicyJson: Record<string, unknown>;
      outputPolicyJson: Record<string, unknown>;
      scheduleConfigJson: Record<string, unknown>;
      outputSchemaJson: Record<string, unknown>;
      executionHostId: string | null;
      workspaceLocationId: string | null;
      runtimeInstallation: string | null;
    },
  ): Promise<AgentOut> {
    const agentId = randomUUID();
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO agents (
         id, space_id, project_id, owner_user_id, name, description, role_instruction,
         status, agent_kind, visibility, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        agentId,
        input.spaceId,
        input.projectId,
        input.ownerUserId,
        input.name,
        input.description,
        input.roleInstruction,
        input.status,
        input.agentKind,
        input.visibility,
        now,
      ],
    );
    const version = await this.insertVersion(client, {
      agentId,
      spaceId: input.spaceId,
      versionLabel: "v1",
      modelProviderId: input.modelProviderId,
      modelName: input.modelName,
      systemPrompt: input.systemPrompt,
      promptProvenanceJson: input.promptProvenanceJson,
      modelConfigJson: input.modelConfigJson,
      runtimeConfigJson: input.runtimeConfigJson,
      contextPolicyJson: input.contextPolicyJson,
      memoryPolicyJson: input.memoryPolicyJson,
      capabilitiesJson: input.capabilitiesJson,
      toolPermissionsJson: input.toolPermissionsJson,
      runtimePolicyJson: input.runtimePolicyJson,
      toolPolicyJson: input.toolPolicyJson,
      outputPolicyJson: input.outputPolicyJson,
      scheduleConfigJson: input.scheduleConfigJson,
      outputSchemaJson: input.outputSchemaJson,
    });
    await client.query(
      `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
      [input.spaceId, agentId, version.id, now],
    );
    await this.insertRuntimeProfile(client, {
      spaceId: input.spaceId,
      agentId,
      name: "Default",
      adapterType: normalizeAdapterType(input.runtimePolicyJson.default_adapter_type),
      modelProviderId: input.modelProviderId,
      modelName: input.modelName,
      runtimeConfigJson: input.runtimeConfigJson,
      runtimePolicyJson: input.runtimePolicyJson,
      executionHostId: input.executionHostId,
      workspaceLocationId: input.workspaceLocationId,
      runtimeInstallation: input.runtimeInstallation,
      enabled: true,
      isDefault: true,
    });
    const created = await this.getAgentWithClient(client, input.spaceId, agentId);
    if (!created) throw new Error("Agent insert returned no row");
    return created;
  }

  private async getRuntimeProfile(
    spaceId: string,
    agentId: string,
    profileId: string,
  ): Promise<AgentRuntimeProfileRecord | null> {
    await this.requireAgent(spaceId, agentId);
    return this.getRuntimeProfileWithClient(this.pool, spaceId, agentId, profileId);
  }

  private async getRuntimeProfileWithClient(
    db: Queryable,
    spaceId: string,
    agentId: string,
    profileId: string,
  ): Promise<AgentRuntimeProfileRecord | null> {
    const result = await db.query<AgentRuntimeProfileRecord>(
      `SELECT ${RUNTIME_PROFILE_COLUMNS}
         FROM agent_runtime_profiles arp
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE arp.space_id = $1 AND arp.agent_id = $2 AND arp.id = $3
        LIMIT 1`,
      [spaceId, agentId, profileId],
    );
    return result.rows[0] ?? null;
  }

  private async clearDefaultRuntimeProfile(
    db: Queryable,
    spaceId: string,
    agentId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE agent_runtime_profiles
          SET is_default = false,
              updated_at = $3
        WHERE space_id = $1 AND agent_id = $2 AND is_default = true`,
      [spaceId, agentId, new Date().toISOString()],
    );
  }

  private async insertRuntimeProfile(
    db: Queryable,
    input: {
      spaceId: string;
      agentId: string;
      name: string;
      adapterType: string;
      modelProviderId: string | null;
      modelName: string | null;
      executionHostId: string | null;
      workspaceLocationId: string | null;
      runtimeInstallation: string | null;
      runtimeConfigJson: Record<string, unknown>;
      runtimePolicyJson: Record<string, unknown>;
      enabled: boolean;
      isDefault: boolean;
    },
  ): Promise<AgentRuntimeProfileRecord> {
    if (Object.hasOwn(input.runtimeConfigJson, "credential_profile_id")) {
      throw new HttpError(
        422,
        "CLI credentials are selected per user and conversation, not on Agent runtime profiles",
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const runtimeConfigJson = normalizedRuntimeConfig(input.runtimeConfigJson, input.adapterType);
    await db.query(
      `INSERT INTO agent_runtime_profiles (
         id, space_id, agent_id, name, adapter_type, model_provider_id,
         model_name, execution_host_id, workspace_location_id, runtime_installation,
         runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11::jsonb, $12::jsonb, $13, $14, $15, $15
       )`,
      [
        id,
        input.spaceId,
        input.agentId,
        input.name,
        input.adapterType,
        input.modelProviderId,
        input.modelName,
        input.executionHostId,
        input.workspaceLocationId,
        input.runtimeInstallation,
        JSON.stringify(runtimeConfigJson),
        JSON.stringify(input.runtimePolicyJson),
        input.enabled,
        input.isDefault,
        now,
      ],
    );
    const created = await this.getRuntimeProfileWithClient(db, input.spaceId, input.agentId, id);
    if (!created) throw new Error("Runtime profile insert returned no row");
    return created;
  }

  private async normalizeRuntimeProfileInput(
    spaceId: string,
    input: {
      agentId?: string;
      name: string;
      adapterType: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      enabled?: boolean;
      isDefault?: boolean;
      runtimeToolVersion?: string | null;
      actorUserId?: string;
    },
    db: Queryable = this.pool,
  ): Promise<{
    name: string;
    adapterType: string;
    modelProviderId: string | null;
    modelName: string | null;
    executionHostId: string | null;
    workspaceLocationId: string | null;
    runtimeInstallation: string | null;
    runtimeConfigJson: Record<string, unknown>;
    runtimePolicyJson: Record<string, unknown>;
    enabled: boolean;
    isDefault: boolean;
  }> {
    const name = input.name.trim();
    if (!name) throw new HttpError(422, "name is required");
    const adapterType = normalizeAdapterType(input.adapterType);
    const modelProviderId = input.modelProviderId ?? null;
    const modelName = input.modelName ?? null;
    const hostBound = input.executionHostId != null
      || input.workspaceLocationId != null
      || input.runtimeInstallation != null;
    if (hostBound) {
      if (modelProviderId !== null || modelName !== null) {
        throw new HttpError(422, "Host-bound runtime profiles cannot use a server ModelProvider or model selection");
      }
      const agent = await db.query<{ project_id: string | null; owner_user_id: string | null }>(
        `SELECT project_id, owner_user_id FROM agents WHERE space_id = $1 AND id = $2 LIMIT 1`,
        [spaceId, input.agentId ?? ""],
      );
      const agentRow = agent.rows[0];
      if (!agentRow) throw new HttpError(404, "Agent not found");
      await this.validateHostExecutionBinding(db, {
        spaceId,
        projectId: agentRow.project_id,
        actorUserId: input.actorUserId ?? agentRow.owner_user_id,
        executionHostId: input.executionHostId ?? null,
        workspaceLocationId: input.workspaceLocationId ?? null,
        runtimeInstallation: input.runtimeInstallation ?? null,
        adapterType,
      });
    }
    await this.validateRuntimeProfileSelection(spaceId, adapterType, modelProviderId, modelName, db, hostBound);
    const runtimeConfigJson = await this.resolveRuntimeConfig(
      db,
      spaceId,
      adapterType,
      normalizedRuntimeConfig(input.runtimeConfigJson ?? {}, adapterType),
      input.runtimeToolVersion,
      hostBound,
    );
    return {
      name,
      adapterType,
      modelProviderId,
      modelName,
      executionHostId: input.executionHostId ?? null,
      workspaceLocationId: input.workspaceLocationId ?? null,
      runtimeInstallation: input.runtimeInstallation ?? null,
      runtimeConfigJson,
      runtimePolicyJson: buildRuntimePolicy(adapterType, input.runtimePolicyJson),
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false,
    };
  }

  private async validateRuntimeProfileSelection(
    spaceId: string,
    adapterType: string,
    providerId: string | null,
    modelName: string | null,
    db: Queryable = this.pool,
    hostBound = false,
  ): Promise<void> {
    const spec = BUILTIN_RUNTIME_ADAPTER_SPECS[adapterType as RuntimeAdapterType];
    if (!spec) throw new HttpError(400, `Unknown adapter_type ${JSON.stringify(adapterType)}`);
    if (modelName && !providerId && !hostBound) {
      throw new HttpError(400, "model_provider_id is required when model_name is set");
    }
    if (providerId) {
      const provider = await db.query<{ id: string; config_json: unknown }>(
        `SELECT p.id, p.config_json
           FROM model_provider_space_grants g
           JOIN model_providers p ON p.id = g.provider_id
          WHERE g.space_id = $1
            AND g.provider_id = $2
            AND g.enabled = true
            AND p.enabled = true`,
        [spaceId, providerId],
      );
      const row = provider.rows[0];
      if (!row) {
        throw new HttpError(400, "Model provider is not selectable in this space");
      }
      if (adapterType === "claude_code") {
        const cfg = recordValue(row.config_json) ?? {};
        const claudeUrl = cfg.claude_compatible_base_url;
        if (typeof claudeUrl !== "string" || !claudeUrl.trim()) {
          throw new HttpError(
            400,
            "Claude Code provider selection requires claude_compatible_base_url",
          );
        }
      }
      if (adapterType === "codex_cli") {
        const cfg = recordValue(row.config_json) ?? {};
        const openAiUrl = cfg.openai_compatible_base_url;
        if (typeof openAiUrl !== "string" || !openAiUrl.trim()) {
          throw new HttpError(
            400,
            "Codex CLI provider selection requires openai_compatible_base_url",
          );
        }
      }
    }
  }

  private async insertVersion(
    db: Queryable,
    input: {
      agentId: string;
      spaceId: string;
      versionLabel: string;
      modelProviderId: string | null;
      modelName: string | null;
      systemPrompt: string | null;
      promptProvenanceJson?: PromptProvenance | null;
      followsSeedKey?: string | null;
      modelConfigJson: Record<string, unknown>;
      runtimeConfigJson: Record<string, unknown>;
      contextPolicyJson: Record<string, unknown>;
      memoryPolicyJson: Record<string, unknown>;
      capabilitiesJson: unknown[];
      toolPermissionsJson: Record<string, unknown>;
      runtimePolicyJson: Record<string, unknown>;
      toolPolicyJson: Record<string, unknown>;
      outputPolicyJson: Record<string, unknown>;
      scheduleConfigJson: Record<string, unknown>;
      outputSchemaJson: Record<string, unknown>;
    },
  ): Promise<{ id: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await db.query<{ id: string }>(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, model_provider_id, model_name,
         system_prompt, model_config_json, runtime_config_json,
         context_policy_json, memory_policy_json, capabilities_json,
         tool_permissions_json, runtime_policy_json, tool_policy_json,
         output_policy_json, schedule_config_json, output_schema_json,
         prompt_provenance_json, follows_seed_key, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8::jsonb, $9::jsonb,
         $10::jsonb, $11::jsonb, $12::jsonb,
         $13::jsonb, $14::jsonb, $15::jsonb,
         $16::jsonb, $17::jsonb, $18::jsonb,
         $19::jsonb, $20, $21
       )
       RETURNING id`,
      [
        id,
        input.agentId,
        input.spaceId,
        input.versionLabel,
        input.modelProviderId,
        input.modelName,
        input.systemPrompt,
        JSON.stringify(input.modelConfigJson),
        JSON.stringify(input.runtimeConfigJson),
        JSON.stringify(input.contextPolicyJson),
        JSON.stringify(input.memoryPolicyJson),
        JSON.stringify(input.capabilitiesJson),
        JSON.stringify(input.toolPermissionsJson),
        JSON.stringify(input.runtimePolicyJson),
        JSON.stringify(input.toolPolicyJson),
        JSON.stringify(input.outputPolicyJson),
        JSON.stringify(input.scheduleConfigJson),
        JSON.stringify(input.outputSchemaJson),
        input.promptProvenanceJson ? JSON.stringify(input.promptProvenanceJson) : null,
        // Null unless the caller says otherwise: a version authored by a person
        // or an evolution proposal detaches the instance from the seed, and
        // every caller but the provisioner is one of those.
        input.followsSeedKey ?? null,
        now,
      ],
    );
    return result.rows[0] ?? { id };
  }

  private async nextVersionLabel(db: Queryable, spaceId: string, agentId: string): Promise<string> {
    const result = await db.query<{ version_label: string }>(
      `SELECT version_label
         FROM agent_versions
        WHERE space_id = $1 AND agent_id = $2
        ORDER BY created_at DESC`,
      [spaceId, agentId],
    );
    let max = 0;
    for (const row of result.rows) {
      if (row.version_label.startsWith("v")) {
        const n = Number(row.version_label.slice(1));
        if (Number.isInteger(n) && n > max) max = n;
      }
    }
    return `v${max + 1}`;
  }

  private async getAgentWithClient(
    client: Queryable,
    spaceId: string,
    agentId: string,
  ): Promise<AgentOut | null> {
    const result = await client.query<AgentRecord>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = COALESCE(arp.model_provider_id, av.model_provider_id)
        WHERE a.space_id = $1 AND a.id = $2
        LIMIT 1`,
      [spaceId, agentId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }
}

function runtimeProfileOut(row: AgentRuntimeProfileRecord): AgentRuntimeProfileOut {
  const hasModel =
    row.model_provider_id !== null ||
    row.provider_name !== null ||
    row.provider_type !== null ||
    row.model_name !== null;
  return {
    id: row.id,
    space_id: row.space_id,
    agent_id: row.agent_id,
    name: row.name,
    adapter_type: row.adapter_type,
    execution_host_id: row.execution_host_id,
    workspace_location_id: row.workspace_location_id,
    runtime_installation: row.runtime_installation,
    model: hasModel
      ? {
          provider_id: row.model_provider_id,
          provider_name: row.provider_name ?? null,
          provider_type: row.provider_type ?? null,
          model: row.model_name,
        }
      : null,
    runtime_config_json: recordValue(row.runtime_config_json) ?? {},
    runtime_policy_json: recordValue(row.runtime_policy_json) ?? {},
    enabled: row.enabled,
    is_default: row.is_default,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizedRuntimeConfig(
  input: Record<string, unknown>,
  adapterType: string,
): Record<string, unknown> {
  return { ...input, adapter_type: adapterType };
}
