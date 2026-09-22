import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { HttpError } from "../routeUtils/common.js";
import {
  ScopedSettingsStore,
  SETTINGS_KEYS,
  defineScopedSetting,
  settingsRecord,
  type ScopedSettingsRead,
} from "../settings/index.js";
import { getAgentRuntimeDefinition } from "../runtimeAdapters/runtimeDefinitions.js";
import { PgHostRepository } from "../hosts/repository.js";
import { PgRuntimeProvisioningRepository } from "../hosts/runtimeProvisioningRepository.js";
import type { PromptProvenance } from "../prompts/provenance.js";
import {
  contentAccessLevelSql,
  contentOwnerFilterSql,
  contentReadSql,
  contentVisibilityParamFilterSql,
} from "../access/contentAccessSql.js";
import {
  bodyWithheld,
  isContentVisibility,
  type ContentAccessLevel,
  type WithAccessLevel,
} from "../access/contentAccessTypes.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { assertAgentOwner, canChangeAgent } from "./agentAccess.js";
import { canReadProject, canWriteProject } from "../projects/access.js";
import {
  DEFAULT_MEMORY_POLICY,
  DEFAULT_AGENT_MAX_RUN_TIME_SECONDS,
  DEFAULT_AGENT_RISK_LEVEL,
  DEFAULT_RUNTIME_CONFIG,
  agentOut,
  recordValue,
  stringOrNull,
} from "./agentRepositoryHelpers.js";
import {
  RUNTIME_PROFILE_COLUMNS,
  assertBackendModeBinding,
  clearDefaultRuntimeProfile,
  getRuntimeProfileRecord,
  hostRuntimeProfileName,
  insertRuntimeProfile,
  lockAgentForRuntimeProfileWrite,
  normalizeRuntimeProfileInput,
  runtimeConfigRecord,
  runtimeProfileOut,
  strippedOptionBag,
  updateRuntimeProfileRow,
  validateRuntimeProfileSelection,
  type AgentRuntimeProfileOut,
  type AgentRuntimeProfileRecord,
  type HostRuntimeProfileTarget,
} from "./runtimeProfileAdmission.js";
export type {
  AgentRuntimeProfileOut,
  AgentRuntimeProfileRecord,
  HostRuntimeProfileTarget,
} from "./runtimeProfileAdmission.js";
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
  runtime_key?: string | null;
}

export interface AgentVersionRecord {
  id: string;
  agent_id: string;
  space_id: string;
  version_label: string;
  system_prompt: string | null;
  prompt_provenance_json: PromptProvenance | null;
  risk_level: "low" | "medium" | "high" | "critical";
  max_run_time_seconds: number;
  context_policy_json: Record<string, unknown>;
  memory_policy_json: Record<string, unknown>;
  capabilities_json: unknown[];
  tool_permissions_json: Record<string, unknown>;
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
  runtime_key: string | null;
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

export interface SpaceAgentRuntimeDefaultRecord {
  space_id: string;
  runtime_key: string;
  backend_mode: "runtime_native" | "model_provider";
  model_provider_id: string | null;
  model_name: string | null;
  runtime_config_json: Record<string, unknown>;
  /** Derived, not stored: whether this template can still provision an Agent. */
  state: "ready" | "needs_repair";
  state_reason: string | null;
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
  riskLevel?: "low" | "medium" | "high" | "critical";
  maxRunTimeSeconds?: number;
  /** Pre-resolved by the caller outside the transaction for CLI profiles. */
  contextPolicyJson?: Record<string, unknown> | null;
  memoryPolicyJson?: Record<string, unknown> | null;
  capabilitiesJson?: unknown[] | null;
  toolPermissionsJson?: Record<string, unknown> | null;
  toolPolicyJson?: Record<string, unknown> | null;
  outputPolicyJson?: Record<string, unknown> | null;
  scheduleConfigJson?: Record<string, unknown> | null;
  outputSchemaJson?: Record<string, unknown> | null;
  agentKind?: string | null;
  ownerUserId?: string | null;
}

const AGENT_COLUMNS = `
  a.id, a.space_id, a.project_id, a.owner_user_id, a.name, a.description, a.role_instruction,
  a.status, a.agent_kind,
  a.current_version_id, a.visibility, a.access_level, a.created_at, a.updated_at,
  arp.model_provider_id, arp.model_name,
  av.system_prompt,
  arp.runtime_key,
  mp.name AS provider_name, mp.provider_type AS provider_type
`;

const DEFAULT_RUNTIME_PROFILE_JOIN = `
         LEFT JOIN LATERAL (
           SELECT runtime_profile_candidate.*
             FROM agent_runtime_profiles runtime_profile_candidate
            WHERE runtime_profile_candidate.space_id = a.space_id
              AND runtime_profile_candidate.agent_id = a.id
              AND runtime_profile_candidate.enabled = true
              AND runtime_profile_candidate.is_default = true
            LIMIT 1
         ) arp ON true`;

const VERSION_COLUMN_NAMES = [
  "id",
  "agent_id",
  "space_id",
  "version_label",
  "system_prompt",
  "context_policy_json",
  "memory_policy_json",
  "capabilities_json",
  "tool_permissions_json",
  "tool_policy_json",
  "output_policy_json",
  "schedule_config_json",
  "output_schema_json",
  "prompt_provenance_json",
  "risk_level",
  "max_run_time_seconds",
  "source_proposal_id",
  "source_activity_id",
  "follows_seed_key",
  "created_at",
  "published_at",
  "archived_at",
] as const;

const VERSION_COLUMNS = VERSION_COLUMN_NAMES.join(", ");
const AGENT_ACCESS = contentResourceDefinition("agent")!;

function versionColumns(alias: string): string {
  return VERSION_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");
}

function agentSelectColumns(userExpr: string): string {
  return `${AGENT_COLUMNS},
    ${contentAccessLevelSql({ definition: AGENT_ACCESS, alias: "a", userExpr })} AS effective_access_level`;
}

function versionForAccess(
  row: AgentVersionRecord,
  level: ContentAccessLevel,
): AgentVersionRecord {
  if (!bodyWithheld(level)) return row;
  return { ...row, system_prompt: null };
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
  constructor(private readonly pool: Pool) {}

  static fromConfig(config: ServerConfig): PgAgentRepository {
    if (!config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    return new PgAgentRepository(getDbPool(config.databaseUrl));
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
    const result = await this.pool.query<WithAccessLevel<AgentRecord>>(
      `SELECT ${agentSelectColumns("$2")}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map(agentOut);
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
    projectId: string | null,
    viewerUserId: string | null,
  ): Promise<AgentOut | null> {
    const result = await db.query<WithAccessLevel<AgentRecord>>(
      `SELECT ${agentSelectColumns("$3")}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE a.space_id = $1
          AND a.agent_kind = 'system_assistant'
          AND a.status = 'active'
          AND ($2::varchar IS NULL AND a.project_id IS NULL
               OR a.project_id = $2::varchar)
        ORDER BY a.created_at ASC, a.id ASC
        LIMIT 1`,
      [spaceId, projectId, viewerUserId],
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
    const result = await this.pool.query<WithAccessLevel<AgentRecord>>(
      `SELECT ${agentSelectColumns("$3")}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE a.space_id = $1 AND a.id = $2
          AND a.agent_kind <> 'system_assistant'
          AND ${contentReadSql("agent", "a", "$3")}
        LIMIT 1`,
      [spaceId, agentId, userId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }

  /**
   * Runtime profiles expose execution targets, so system-managed Agents use
   * their owning Project's read boundary rather than the generic Agent list
   * (which intentionally excludes system assistants).
   */
  async canReadRuntimeProfiles(spaceId: string, userId: string, agentId: string): Promise<boolean> {
    const result = await this.pool.query<{ agent_kind: string; project_id: string | null }>(
      `SELECT agent_kind, project_id
         FROM agents
        WHERE space_id = $1 AND id = $2 AND status = 'active'
        LIMIT 1`,
      [spaceId, agentId],
    );
    const agent = result.rows[0];
    if (!agent) return false;
    if (agent.agent_kind === "system_assistant") {
      return agent.project_id ? canReadProject(this.pool, spaceId, agent.project_id, userId) : false;
    }
    return Boolean(await this.getVisible(spaceId, userId, agentId));
  }

  async canWriteRuntimeProfiles(spaceId: string, userId: string, agentId: string): Promise<boolean> {
    const result = await this.pool.query<{ agent_kind: string; project_id: string | null }>(
      `SELECT agent_kind, project_id
         FROM agents
        WHERE space_id = $1 AND id = $2 AND status = 'active'
        LIMIT 1`,
      [spaceId, agentId],
    );
    const agent = result.rows[0];
    if (!agent) return false;
    if (agent.agent_kind === "system_assistant") {
      return agent.project_id ? canWriteProject(this.pool, spaceId, agent.project_id, userId) : false;
    }
    // Profiles decide where the Agent runs and on whose host: changing them
    // is changing the Agent.
    return canChangeAgent(this.pool, { spaceId, userId }, agentId);
  }

  async listRuntimeProfiles(
    spaceId: string,
    agentId: string,
  ): Promise<AgentRuntimeProfileOut[]> {
    await this.requireAgent(spaceId, agentId, { allowSystemAssistant: true });
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
      runtimeKey: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      workspaceMode?: "location" | "managed" | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      backendMode?: "runtime_native" | "model_provider";
      enabled?: boolean;
      isDefault?: boolean;
      actorUserId?: string;
      /** Internal control-plane provisioning may bind a Server copy before its first health report. */
      allowPendingServerInstallation?: boolean;
    },
  ): Promise<AgentRuntimeProfileOut> {
    await this.requireAgent(spaceId, agentId, { allowSystemAssistant: true });
    return withTransaction(this.pool, async (client) => {
      // Lock first, validate second. Two concurrent creates that both claim
      // the default would otherwise race the partial unique index and surface
      // as a raw constraint error, and input resolved outside the transaction
      // can be stale by the time it is written.
      await lockAgentForRuntimeProfileWrite(client, spaceId, agentId);
      const normalized = await normalizeRuntimeProfileInput(client, spaceId, { ...input, agentId });
      if (normalized.isDefault) {
        await clearDefaultRuntimeProfile(client, spaceId, agentId);
      }
      const created = await insertRuntimeProfile(client, {
        ...normalized,
        spaceId,
        agentId,
      });
      return runtimeProfileOut(created);
    });
  }

  /**
   * Canonical Host/CLI/Workspace resolver used by every setup surface.
   * A Host installation is the user's choice; an Agent runtime profile is
   * the reusable persisted representation, not a separate prerequisite.
   */
  async ensureHostRuntimeProfile(input: HostRuntimeProfileTarget): Promise<AgentRuntimeProfileOut> {
    return withTransaction(this.pool, (client) => this.ensureHostRuntimeProfileInTransaction(client, input));
  }

  async ensureHostRuntimeProfileInTransaction(
    db: Queryable,
    input: HostRuntimeProfileTarget,
  ): Promise<AgentRuntimeProfileOut> {
    await lockAgentForRuntimeProfileWrite(db, input.spaceId, input.agentId, { requireActive: true });

    const normalized = await normalizeRuntimeProfileInput(db, input.spaceId, {
      agentId: input.agentId,
      name: hostRuntimeProfileName(input),
      runtimeKey: input.runtimeKey,
      executionHostId: input.executionHostId,
      workspaceLocationId: input.workspaceLocationId,
      workspaceMode: input.workspaceMode,
      runtimeInstallation: input.runtimeInstallation,
      actorUserId: input.actorUserId,
      enabled: true,
      isDefault: false,
    });
    const existing = await db.query<AgentRuntimeProfileRecord>(
      `SELECT ${RUNTIME_PROFILE_COLUMNS}
         FROM agent_runtime_profiles arp
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE arp.space_id = $1
          AND arp.agent_id = $2
          AND arp.execution_host_id = $3
          AND arp.workspace_mode = $4
          AND arp.workspace_location_id IS NOT DISTINCT FROM $5
          AND arp.runtime_key = $6
          AND arp.runtime_installation = $7
          AND arp.enabled = true
        ORDER BY arp.is_default DESC, arp.created_at ASC, arp.id ASC
        LIMIT 1`,
      [
        input.spaceId,
        input.agentId,
        normalized.executionHostId,
        normalized.workspaceMode,
        normalized.workspaceLocationId,
        normalized.runtimeKey,
        normalized.runtimeInstallation,
      ],
    );
    if (existing.rows[0]) return runtimeProfileOut(existing.rows[0]);

    const created = await insertRuntimeProfile(db, {
      ...normalized,
      spaceId: input.spaceId,
      agentId: input.agentId,
    });
    return runtimeProfileOut(created);
  }

  async updateRuntimeProfile(
    spaceId: string,
    agentId: string,
    profileId: string,
    patch: {
      name?: string;
      runtimeKey?: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      workspaceMode?: "location" | "managed" | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      backendMode?: "runtime_native" | "model_provider";
      enabled?: boolean;
      isDefault?: boolean;
      actorUserId?: string;
    },
  ): Promise<AgentRuntimeProfileOut> {
    const runtimeConfigPatch = patch.runtimeConfigJson ?? null;
    const runtimePolicyPatch = patch.runtimePolicyJson ?? null;
    return withTransaction(this.pool, async (client) => {
      await lockAgentForRuntimeProfileWrite(client, spaceId, agentId);
      const existing = await getRuntimeProfileRecord(client, spaceId, agentId, profileId, true);
      if (!existing) throw new HttpError(404, "Runtime profile not found");

      const existingRuntimeConfig = strippedOptionBag(existing.runtime_config_json);
      const existingRuntimePolicy = strippedOptionBag(existing.runtime_policy_json);
      // Resolve omitted fields from the row locked in this transaction. If we
      // read them before taking the Agent lock, a concurrent default switch
      // could be undone by a stale name/config-only update.
      const normalized = await normalizeRuntimeProfileInput(client, spaceId, {
        agentId,
        name: patch.name ?? existing.name,
        runtimeKey: patch.runtimeKey ?? existing.runtime_key,
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
        workspaceMode: Object.hasOwn(patch, "workspaceMode")
          ? patch.workspaceMode ?? null
          : existing.workspace_mode,
        runtimeInstallation: Object.hasOwn(patch, "runtimeInstallation")
          ? patch.runtimeInstallation ?? null
          : existing.runtime_installation,
        runtimeConfigJson: runtimeConfigPatch
          ? { ...existingRuntimeConfig, ...runtimeConfigPatch }
          : existingRuntimeConfig,
        runtimePolicyJson: runtimePolicyPatch
          ? { ...existingRuntimePolicy, ...runtimePolicyPatch }
          : existingRuntimePolicy,
        backendMode: patch.backendMode ?? existing.backend_mode,
        enabled: Object.hasOwn(patch, "enabled") ? patch.enabled : existing.enabled,
        isDefault: Object.hasOwn(patch, "isDefault") ? patch.isDefault : existing.is_default,
        allowPendingServerInstallation: existing.runtime_installation === "managed:pending",
        actorUserId: patch.actorUserId,
      });
      if (normalized.isDefault && !normalized.enabled) {
        throw new HttpError(422, "A default runtime profile must be enabled");
      }
      if (existing.is_default && (!normalized.isDefault || !normalized.enabled)) {
        throw new HttpError(409, "Choose another enabled default runtime profile before disabling or unsetting this profile");
      }
      if (normalized.isDefault) {
        await clearDefaultRuntimeProfile(client, spaceId, agentId);
      }
      return runtimeProfileOut(await updateRuntimeProfileRow(client, {
        ...normalized,
        spaceId,
        agentId,
        profileId,
      }));
    });
  }

  async create(input: AgentCreateInput): Promise<AgentOut> {
    return withTransaction(this.pool, (client) => this.createInTransaction(client, input));
  }

  /**
   * The Space provisioning template, with whether it can still provision.
   *
   * Disabling or ungranting the Provider a template names does not rewrite
   * the template and does not touch an existing Profile — it makes future
   * provisioning fail, which the plan requires to be a *visible* repair. The
   * state is derived from the same grant join Profile admission uses, so the
   * page and the failing create agree about why.
   */
  async getSpaceAgentRuntimeDefault(spaceId: string): Promise<SpaceAgentRuntimeDefaultRecord | null> {
    const result = await this.pool.query<Omit<SpaceAgentRuntimeDefaultRecord, "state" | "state_reason">
      & { provider_selectable: boolean }>(
      `SELECT d.space_id, d.runtime_key, d.backend_mode, d.model_provider_id, d.model_name,
              d.runtime_config_json, d.created_at, d.updated_at,
              (p.id IS NOT NULL) AS provider_selectable
         FROM space_agent_runtime_defaults d
         LEFT JOIN model_provider_space_grants g
           ON g.space_id = d.space_id
          AND g.provider_id = d.model_provider_id
          AND g.enabled = true
         LEFT JOIN model_providers p ON p.id = g.provider_id AND p.enabled = true
        WHERE d.space_id = $1
        LIMIT 1`,
      [spaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const { provider_selectable, ...record } = row;
    const needsRepair = record.backend_mode === "model_provider" && !provider_selectable;
    return {
      ...record,
      state: needsRepair ? "needs_repair" : "ready",
      state_reason: needsRepair
        ? "The selected ModelProvider is no longer enabled or granted to this Space"
        : null,
    };
  }

  /**
   * Writes only the future-provisioning template. Existing Profiles and Runs
   * are deliberately not queried or rewritten by this operation.
   */
  async setSpaceAgentRuntimeDefault(
    spaceId: string,
    input: {
      runtimeKey: string;
      backendMode: "runtime_native" | "model_provider";
      modelProviderId?: string | null;
      modelName?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
    },
  ): Promise<SpaceAgentRuntimeDefaultRecord> {
    const definition = getAgentRuntimeDefinition(input.runtimeKey);
    if (!definition) throw new HttpError(422, `Unknown or non-ACP runtime_key ${JSON.stringify(input.runtimeKey)}`);
    const modelProviderId = input.modelProviderId ?? null;
    const modelName = input.modelName?.trim() || null;
    // The template answers the same question as the Profile it will create,
    // so it admits through the Profile's rules rather than a second copy.
    assertBackendModeBinding(input.runtimeKey, input.backendMode, modelProviderId, modelName);
    const runtimeConfigJson = runtimeConfigRecord(input.runtimeConfigJson);
    return withTransaction(this.pool, async (client) => {
      await validateRuntimeProfileSelection(client, {
        spaceId,
        runtimeKey: input.runtimeKey,
        providerId: modelProviderId,
      });
      const result = await client.query<Omit<SpaceAgentRuntimeDefaultRecord, "state" | "state_reason">>(
        `INSERT INTO space_agent_runtime_defaults (
           id, space_id, runtime_key, backend_mode, model_provider_id, model_name,
           runtime_config_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
         ON CONFLICT (space_id) DO UPDATE SET
           runtime_key = EXCLUDED.runtime_key,
           backend_mode = EXCLUDED.backend_mode,
           model_provider_id = EXCLUDED.model_provider_id,
           model_name = EXCLUDED.model_name,
           runtime_config_json = EXCLUDED.runtime_config_json,
           updated_at = EXCLUDED.updated_at
         RETURNING space_id, runtime_key, backend_mode, model_provider_id, model_name,
                   runtime_config_json, created_at, updated_at`,
        [
          randomUUID(),
          spaceId,
          input.runtimeKey,
          input.backendMode,
          modelProviderId,
          modelName,
          JSON.stringify(runtimeConfigJson),
          new Date().toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Space runtime default upsert returned no row");
      // Written through the Provider grant check above, so a row this call
      // produced is always usable.
      return { ...row, state: "ready", state_reason: null };
    });
  }

  async createInTransaction(client: PoolClient, input: AgentCreateInput): Promise<AgentOut> {
    if (input.visibility && !isContentVisibility(input.visibility)) {
      throw new HttpError(422, "Invalid visibility");
    }
    const template = await client.query<{
      runtime_key: string;
      backend_mode: "runtime_native" | "model_provider";
      model_provider_id: string | null;
      model_name: string | null;
      runtime_config_json: unknown;
    }>(
      `SELECT runtime_key, backend_mode, model_provider_id, model_name, runtime_config_json
         FROM space_agent_runtime_defaults
        WHERE space_id = $1
        LIMIT 1`,
      [input.spaceId],
    );
    const templateRow = template.rows[0] ?? null;
    const runtimeKey = templateRow?.runtime_key ?? "opencode";
    const runtimeDefinition = getAgentRuntimeDefinition(runtimeKey);
    if (!runtimeDefinition) {
      throw new HttpError(422, `Runtime '${runtimeKey}' is not a registered ACP runtime`);
    }
    const providerId = templateRow?.model_provider_id ?? null;
    const modelName = templateRow?.model_name ?? null;
    const backendMode = templateRow?.backend_mode
      ?? (providerId || modelName ? "model_provider" : "runtime_native");
    const executionHostId = await new PgHostRepository(client).ensureServerHostId();
    const workspaceMode = "managed" as const;
    const readyProvisioning = await new PgRuntimeProvisioningRepository(client).get(executionHostId, runtimeKey);
    const runtimeInstallation = readyProvisioning?.state === "ready" && readyProvisioning.installed_version === readyProvisioning.desired_version
        ? `managed:${readyProvisioning.installed_version}`
        : "managed:pending";
    const runtimeConfigJson = recordValue(templateRow?.runtime_config_json)
      ?? DEFAULT_RUNTIME_CONFIG;
    const riskLevel = input.riskLevel ?? DEFAULT_AGENT_RISK_LEVEL;
    const maxRunTimeSeconds = input.maxRunTimeSeconds ?? DEFAULT_AGENT_MAX_RUN_TIME_SECONDS;
    if (!Number.isInteger(maxRunTimeSeconds) || maxRunTimeSeconds < 1 || maxRunTimeSeconds > 3600) {
      throw new HttpError(422, "max_run_time_seconds must be an integer from 1 to 3600");
    }
    // Provisioning admission runs on the template *before* an Agent row
    // exists, so that an unusable template fails as itself rather than as an
    // opaque Profile error the person cannot act on.
    if (templateRow) {
      await this.assertSpaceRuntimeTemplateUsable(client, input.spaceId, {
        runtimeKey,
        backendMode,
        providerId,
        modelName,
      });
    }
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
      riskLevel,
      maxRunTimeSeconds,
      modelProviderId: providerId,
      modelName,
      runtimeConfigJson,
      actorUserId: input.userId,
      contextPolicyJson: input.contextPolicyJson ?? {},
      memoryPolicyJson: input.memoryPolicyJson ?? DEFAULT_MEMORY_POLICY,
      capabilitiesJson: input.capabilitiesJson ?? [],
      toolPermissionsJson: input.toolPermissionsJson ?? {},
      toolPolicyJson: input.toolPolicyJson ?? {},
      outputPolicyJson: input.outputPolicyJson ?? {},
      scheduleConfigJson: input.scheduleConfigJson ?? {},
      outputSchemaJson: input.outputSchemaJson ?? {},
      runtimeKey,
      backendMode,
      executionHostId,
      workspaceLocationId: null,
      workspaceMode,
      runtimeInstallation,
    });
  }

  async ensureRuntimeProfileInTransaction(
    client: PoolClient,
    spaceId: string,
    agentId: string,
    input: {
      agentId?: string;
      name: string;
      runtimeKey: string;
      modelProviderId?: string | null;
      modelName?: string | null;
      executionHostId?: string | null;
      workspaceLocationId?: string | null;
      workspaceMode?: "location" | "managed" | null;
      runtimeInstallation?: string | null;
      runtimeConfigJson?: Record<string, unknown> | null;
      runtimePolicyJson?: Record<string, unknown> | null;
      backendMode?: "runtime_native" | "model_provider";
      isDefault?: boolean;
      /** Pre-resolved by the caller outside the transaction for CLI profiles. */
      actorUserId?: string;
    },
  ): Promise<AgentRuntimeProfileOut> {
    await lockAgentForRuntimeProfileWrite(client, spaceId, agentId);
    const existing = await client.query<AgentRuntimeProfileRecord>(
      `SELECT ${RUNTIME_PROFILE_COLUMNS}
         FROM agent_runtime_profiles arp
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE arp.space_id = $1
          AND arp.agent_id = $2
          AND arp.runtime_key = $3
          AND arp.model_provider_id IS NOT DISTINCT FROM $4
          AND arp.execution_host_id IS NOT DISTINCT FROM $5
          AND arp.workspace_location_id IS NOT DISTINCT FROM $6
          AND arp.workspace_mode IS NOT DISTINCT FROM $7
          AND arp.runtime_installation IS NOT DISTINCT FROM $8
        ORDER BY arp.enabled DESC, arp.is_default DESC, arp.created_at ASC, arp.id ASC
        LIMIT 1`,
      [
        spaceId,
        agentId,
        input.runtimeKey,
        input.modelProviderId ?? null,
        input.executionHostId ?? null,
        input.workspaceLocationId ?? null,
        input.workspaceMode ?? null,
        input.runtimeInstallation ?? null,
      ],
    );
    const normalized = await normalizeRuntimeProfileInput(client, spaceId, {
      name: input.name,
      runtimeKey: input.runtimeKey,
      modelProviderId: input.modelProviderId,
      modelName: input.modelName,
      executionHostId: input.executionHostId,
      workspaceLocationId: input.workspaceLocationId,
      workspaceMode: input.workspaceMode,
      runtimeInstallation: input.runtimeInstallation,
      runtimeConfigJson: input.runtimeConfigJson,
      runtimePolicyJson: input.runtimePolicyJson,
      backendMode: input.backendMode,
      enabled: true,
      isDefault: input.isDefault ?? existing.rows[0]?.is_default ?? false,
      agentId,
      actorUserId: input.actorUserId,
    });
    if (normalized.isDefault) await clearDefaultRuntimeProfile(client, spaceId, agentId);
    if (existing.rows[0]) {
      return runtimeProfileOut(await updateRuntimeProfileRow(client, {
        ...normalized,
        spaceId,
        agentId,
        profileId: existing.rows[0].id,
      }));
    }
    return runtimeProfileOut(await insertRuntimeProfile(client, {
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
    await assertAgentOwner(this.pool, { spaceId, userId }, agentId);
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
    const updated = await this.getAgentWithClient(this.pool, spaceId, agentId, userId);
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
      contextPolicyJson?: Record<string, unknown> | null;
      memoryPolicyJson?: Record<string, unknown> | null;
      toolPolicyJson?: Record<string, unknown> | null;
      outputPolicyJson?: Record<string, unknown> | null;
      scheduleConfigJson?: Record<string, unknown> | null;
      outputSchemaJson?: Record<string, unknown> | null;
      riskLevel?: "low" | "medium" | "high" | "critical";
      maxRunTimeSeconds?: number;
    },
  ): Promise<AgentOut> {
    await assertAgentOwner(this.pool, { spaceId, userId: patch.userId }, agentId);
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockCurrentVersion(client, spaceId, agentId);
      if (!current) throw new HttpError(404, "Agent has no current version");
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
        context_policy_json: patch.contextPolicyJson ?? current.context_policy_json,
        memory_policy_json: patch.memoryPolicyJson ?? current.memory_policy_json,
        tool_policy_json: patch.toolPolicyJson ?? current.tool_policy_json,
        output_policy_json: patch.outputPolicyJson ?? current.output_policy_json,
        schedule_config_json: patch.scheduleConfigJson ?? current.schedule_config_json,
        output_schema_json: patch.outputSchemaJson ?? current.output_schema_json,
        risk_level: patch.riskLevel ?? current.risk_level,
        max_run_time_seconds: patch.maxRunTimeSeconds ?? current.max_run_time_seconds,
      };
      const newVersion = await this.insertVersion(client, {
        agentId,
        spaceId,
        versionLabel: await this.nextVersionLabel(client, spaceId, agentId),
        systemPrompt: versionPatch.system_prompt ?? null,
        promptProvenanceJson: versionPatch.prompt_provenance_json ?? null,
        riskLevel: versionPatch.risk_level ?? DEFAULT_AGENT_RISK_LEVEL,
        maxRunTimeSeconds: versionPatch.max_run_time_seconds ?? DEFAULT_AGENT_MAX_RUN_TIME_SECONDS,
        contextPolicyJson: versionPatch.context_policy_json ?? {},
        memoryPolicyJson: versionPatch.memory_policy_json ?? DEFAULT_MEMORY_POLICY,
        capabilitiesJson: current.capabilities_json,
        toolPermissionsJson: current.tool_permissions_json,
        toolPolicyJson: versionPatch.tool_policy_json ?? {},
        outputPolicyJson: versionPatch.output_policy_json ?? {},
        scheduleConfigJson: versionPatch.schedule_config_json ?? {},
        outputSchemaJson: versionPatch.output_schema_json ?? {},
      });
      await client.query(
        `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
        [spaceId, agentId, newVersion.id, now],
      );
      const updated = await this.getAgentWithClient(client, spaceId, agentId, patch.userId);
      if (!updated) throw new HttpError(404, "Agent not found");
      return updated;
    });
  }

  async getCurrentVersion(
    spaceId: string,
    userId: string,
    agentId: string,
  ): Promise<AgentVersionRecord | null> {
    const decision = await this.requireReadableAgent(spaceId, userId, agentId);
    const result = await this.pool.query<AgentVersionRecord>(
      `SELECT ${versionColumns("av")}
         FROM agents a
         JOIN agent_versions av ON av.id = a.current_version_id
        WHERE a.space_id = $1 AND a.id = $2
        LIMIT 1`,
      [spaceId, agentId],
    );
    const row = result.rows[0];
    return row ? versionForAccess(row, decision) : null;
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
        systemPrompt: input.systemPrompt,
        promptProvenanceJson,
        riskLevel: current.risk_level,
        maxRunTimeSeconds: current.max_run_time_seconds,
        contextPolicyJson: current.context_policy_json,
        memoryPolicyJson: current.memory_policy_json,
        capabilitiesJson: current.capabilities_json,
        toolPermissionsJson: current.tool_permissions_json,
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
      riskLevel: "low" | "medium" | "high" | "critical";
      maxRunTimeSeconds: number;
      contextPolicyJson: Record<string, unknown>;
      memoryPolicyJson: Record<string, unknown>;
      capabilitiesJson: unknown[];
      toolPermissionsJson: Record<string, unknown>;
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
      && current.system_prompt === input.systemPrompt
      && current.risk_level === input.riskLevel
      && current.max_run_time_seconds === input.maxRunTimeSeconds
      && stableJsonStringify(current.prompt_provenance_json) === stableJsonStringify(input.promptProvenanceJson)
      && stableJsonStringify(current.context_policy_json) === stableJsonStringify(input.contextPolicyJson)
      && stableJsonStringify(current.memory_policy_json) === stableJsonStringify(input.memoryPolicyJson)
      && stableJsonStringify(current.capabilities_json) === stableJsonStringify(input.capabilitiesJson)
      && stableJsonStringify(current.tool_permissions_json) === stableJsonStringify(input.toolPermissionsJson)
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
      const settled = await this.getAgentWithClient(client, input.spaceId, input.agentId, null);
      if (!settled) throw new HttpError(404, "Active system-managed Agent not found");
      return settled;
    }

    if (!equal) {
      const version = await this.insertVersion(client, {
        agentId: input.agentId,
        spaceId: input.spaceId,
        versionLabel: await this.nextVersionLabel(client, input.spaceId, input.agentId),
        systemPrompt: input.systemPrompt,
        promptProvenanceJson: input.promptProvenanceJson,
        riskLevel: input.riskLevel,
        maxRunTimeSeconds: input.maxRunTimeSeconds,
        followsSeedKey: input.followsSeedKey ?? null,
        contextPolicyJson: input.contextPolicyJson,
        memoryPolicyJson: input.memoryPolicyJson,
        capabilitiesJson: input.capabilitiesJson,
        toolPermissionsJson: input.toolPermissionsJson,
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

    const reconciled = await this.getAgentWithClient(client, input.spaceId, input.agentId, null);
    if (!reconciled) throw new HttpError(404, "Active system-managed Agent not found");
    return reconciled;
  }

  async listVersions(
    spaceId: string,
    userId: string,
    agentId: string,
  ): Promise<AgentVersionRecord[]> {
    const decision = await this.requireReadableAgent(spaceId, userId, agentId);
    const result = await this.pool.query<AgentVersionRecord>(
      `SELECT ${VERSION_COLUMNS}
         FROM agent_versions
        WHERE space_id = $1 AND agent_id = $2
        ORDER BY created_at DESC, id DESC`,
      [spaceId, agentId],
    );
    return result.rows.map((row) => versionForAccess(row, decision));
  }

  async getVersion(
    spaceId: string,
    userId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> {
    const decision = await this.requireReadableAgent(spaceId, userId, agentId);
    const row = await this.loadVersionRow(spaceId, agentId, versionId);
    return versionForAccess(row, decision);
  }

  async restoreVersion(
    spaceId: string,
    agentId: string,
    versionId: string,
    userId: string,
  ): Promise<AgentOut> {
    await assertAgentOwner(this.pool, { spaceId, userId }, agentId);
    const source = await this.loadVersionRow(spaceId, agentId, versionId);
    return withTransaction(this.pool, async (client) => {
      if (!(await this.lockCurrentVersion(client, spaceId, agentId))) {
        throw new HttpError(404, "Agent has no current version");
      }
      const version = await this.insertVersion(client, {
        agentId,
        spaceId,
        versionLabel: await this.nextVersionLabel(client, spaceId, agentId),
        systemPrompt: source.system_prompt,
        promptProvenanceJson: source.prompt_provenance_json,
        riskLevel: source.risk_level,
        maxRunTimeSeconds: source.max_run_time_seconds,
        contextPolicyJson: source.context_policy_json,
        memoryPolicyJson: source.memory_policy_json,
        capabilitiesJson: source.capabilities_json,
        toolPermissionsJson: source.tool_permissions_json,
        toolPolicyJson: source.tool_policy_json,
        outputPolicyJson: source.output_policy_json,
        scheduleConfigJson: source.schedule_config_json,
        outputSchemaJson: source.output_schema_json,
      });
      await client.query(
        `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
        [spaceId, agentId, version.id, new Date().toISOString()],
      );
      const updated = await this.getAgentWithClient(client, spaceId, agentId, userId);
      if (!updated) throw new HttpError(404, "Agent not found");
      return updated;
    });
  }

  /** The Space's own Assistant, never a Project's — this backs the Space-level
   * Assistant settings, which are personal preferences and not per-Project. */
  async defaultAssistantId(spaceId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT a.id
         FROM agents a
        WHERE a.space_id = $1
          AND a.agent_kind = 'system_assistant'
          AND a.status = 'active'
          AND a.project_id IS NULL
        ORDER BY a.created_at ASC
        LIMIT 1`,
      [spaceId],
    );
    return result.rows[0]?.id ?? null;
  }

  async getAssistantSettings(spaceId: string): Promise<AssistantSettingsRecord> {
    const store = new ScopedSettingsStore(this.pool);
    const existing = await store.get(ASSISTANT_SETTINGS_DEFINITION, spaceId);
    if (existing.row) return assistantSettingsRecordFromRead(spaceId, existing);
    const created = await store.createIfMissing(ASSISTANT_SETTINGS_DEFINITION, spaceId, {
      ...ASSISTANT_SETTINGS_DEFAULTS,
      assistant_agent_id: await this.defaultAssistantId(spaceId),
    });
    return assistantSettingsRecordFromRead(spaceId, created);
  }

  async updateAssistantSettings(
    spaceId: string,
    patch: Record<string, unknown>,
    options: { actorUserId?: string | null } = {},
  ): Promise<AssistantSettingsRecord> {
    const existing = await this.getAssistantSettings(spaceId);
    const next: AssistantSettingsValue = {
      assistant_agent_id: existing.assistant_agent_id ?? await this.defaultAssistantId(spaceId),
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

  /**
   * Why this Space's provisioning template cannot provision, in its own terms.
   *
   * Without this, disabling the Provider a template names failed every Agent
   * creation in the Space — including the managed Space/Project Assistant a
   * Room mints on its first message — with the Profile-level
   * "Model provider is not selectable in this space", which names nothing the
   * person can act on. The template is deliberately *not* rewritten to native
   * mode: the plan requires a visible repair, not a silent downgrade.
   */
  private async assertSpaceRuntimeTemplateUsable(
    db: Queryable,
    spaceId: string,
    template: {
      runtimeKey: string;
      backendMode: "runtime_native" | "model_provider";
      providerId: string | null;
      modelName: string | null;
    },
  ): Promise<void> {
    try {
      assertBackendModeBinding(
        template.runtimeKey,
        template.backendMode,
        template.providerId,
        template.modelName,
      );
      await validateRuntimeProfileSelection(db, {
        spaceId,
        runtimeKey: template.runtimeKey,
        providerId: template.providerId,
      });
    } catch (error) {
      const reason = error instanceof HttpError ? error.message : "the template is no longer valid";
      const selection = template.backendMode === "model_provider"
        ? `${template.runtimeKey} · ${template.modelName ?? "no model"}`
        : `${template.runtimeKey} · runtime_native`;
      throw new HttpError(
        409,
        `This Space's runtime default for new Agents (${selection}) cannot provision a Profile: ${reason}. A Space owner or admin must repair it under Model Providers → "OpenCode backend for new Agents", or set it back to the OpenCode native account. Existing Agents are unaffected.`,
        {
          code: "space_runtime_default_needs_repair",
          detail: `This Space's runtime default for new Agents (${selection}) cannot provision a Profile: ${reason}. A Space owner or admin must repair it under Model Providers → "OpenCode backend for new Agents", or set it back to the OpenCode native account. Existing Agents are unaffected.`,
          runtime_key: template.runtimeKey,
          backend_mode: template.backendMode,
          model_provider_id: template.providerId,
        },
      );
    }
  }

  private async requireAgent(
    spaceId: string,
    agentId: string,
    options: { allowSystemAssistant?: boolean } = {},
  ): Promise<void> {
    const found = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM agents
        WHERE space_id = $1
          AND id = $2
          ${options.allowSystemAssistant ? "" : "AND agent_kind <> 'system_assistant'"}
        LIMIT 1`,
      [spaceId, agentId],
    );
    if (!found.rows[0]) throw new HttpError(404, "Agent not found");
  }

  private async requireReadableAgent(
    spaceId: string,
    userId: string,
    agentId: string,
  ): Promise<ContentAccessLevel> {
    await this.requireAgent(spaceId, agentId);
    const decision = await contentDecisionFromDb(
      this.pool,
      { spaceId, userId },
      "agent",
      agentId,
    );
    if (decision === "deny") throw new HttpError(404, "Agent not found");
    return decision;
  }

  private async loadVersionRow(
    spaceId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> {
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
      riskLevel: "low" | "medium" | "high" | "critical";
      maxRunTimeSeconds: number;
      modelProviderId: string | null;
      modelName: string | null;
      runtimeConfigJson: Record<string, unknown>;
      contextPolicyJson: Record<string, unknown>;
      memoryPolicyJson: Record<string, unknown>;
      capabilitiesJson: unknown[];
      toolPermissionsJson: Record<string, unknown>;
      toolPolicyJson: Record<string, unknown>;
      outputPolicyJson: Record<string, unknown>;
      scheduleConfigJson: Record<string, unknown>;
      outputSchemaJson: Record<string, unknown>;
      runtimeKey: string;
      backendMode: "runtime_native" | "model_provider";
      executionHostId: string | null;
      workspaceLocationId: string | null;
      workspaceMode: "location" | "managed" | null;
      runtimeInstallation: string | null;
      /** Who is provisioning; a system Agent has no owner to fall back on. */
      actorUserId: string;
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
      systemPrompt: input.systemPrompt,
      promptProvenanceJson: input.promptProvenanceJson,
      riskLevel: input.riskLevel,
      maxRunTimeSeconds: input.maxRunTimeSeconds,
      contextPolicyJson: input.contextPolicyJson,
      memoryPolicyJson: input.memoryPolicyJson,
      capabilitiesJson: input.capabilitiesJson,
      toolPermissionsJson: input.toolPermissionsJson,
      toolPolicyJson: input.toolPolicyJson,
      outputPolicyJson: input.outputPolicyJson,
      scheduleConfigJson: input.scheduleConfigJson,
      outputSchemaJson: input.outputSchemaJson,
    });
    await client.query(
      `UPDATE agents SET current_version_id = $3, updated_at = $4 WHERE space_id = $1 AND id = $2`,
      [input.spaceId, agentId, version.id, now],
    );
    // The default Profile is admitted by the same normalizer every other
    // Profile write uses. Inlining a second copy of these rules here is what
    // let Agent creation and the Profile API disagree about what is valid.
    const normalized = await normalizeRuntimeProfileInput(client, input.spaceId, {
      agentId,
      name: "Default",
      runtimeKey: input.runtimeKey,
      backendMode: input.backendMode,
      modelProviderId: input.modelProviderId,
      modelName: input.modelName,
      runtimeConfigJson: input.runtimeConfigJson,
      runtimePolicyJson: {},
      executionHostId: input.executionHostId,
      workspaceLocationId: input.workspaceLocationId,
      workspaceMode: input.workspaceMode,
      runtimeInstallation: input.runtimeInstallation,
      allowPendingServerInstallation: true,
      actorUserId: input.actorUserId,
      agentContext: { projectId: input.projectId, actorUserId: input.actorUserId },
      enabled: true,
      isDefault: true,
    });
    await insertRuntimeProfile(client, { ...normalized, spaceId: input.spaceId, agentId });
    const created = await this.getAgentWithClient(client, input.spaceId, agentId, input.ownerUserId);
    if (!created) throw new Error("Agent insert returned no row");
    return created;
  }

  private async insertVersion(
    db: Queryable,
    input: {
      agentId: string;
      spaceId: string;
      versionLabel: string;
      systemPrompt: string | null;
      promptProvenanceJson?: PromptProvenance | null;
      riskLevel: "low" | "medium" | "high" | "critical";
      maxRunTimeSeconds: number;
      followsSeedKey?: string | null;
      contextPolicyJson: Record<string, unknown>;
      memoryPolicyJson: Record<string, unknown>;
      capabilitiesJson: unknown[];
      toolPermissionsJson: Record<string, unknown>;
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
         id, agent_id, space_id, version_label, system_prompt,
         context_policy_json, memory_policy_json, capabilities_json,
         tool_permissions_json, tool_policy_json,
         output_policy_json, schedule_config_json, output_schema_json,
         prompt_provenance_json, risk_level, max_run_time_seconds,
         follows_seed_key, created_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8::jsonb,
         $9::jsonb, $10::jsonb,
         $11::jsonb, $12::jsonb, $13::jsonb,
         $14::jsonb, $15, $16, $17, $18
       )
       RETURNING id`,
      [
        id,
        input.agentId,
        input.spaceId,
        input.versionLabel,
        input.systemPrompt,
        JSON.stringify(input.contextPolicyJson),
        JSON.stringify(input.memoryPolicyJson),
        JSON.stringify(input.capabilitiesJson),
        JSON.stringify(input.toolPermissionsJson),
        JSON.stringify(input.toolPolicyJson),
        JSON.stringify(input.outputPolicyJson),
        JSON.stringify(input.scheduleConfigJson),
        JSON.stringify(input.outputSchemaJson),
        input.promptProvenanceJson ? JSON.stringify(input.promptProvenanceJson) : null,
        input.riskLevel,
        input.maxRunTimeSeconds,
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

  /**
   * The Agent as the person who just wrote it sees it: the level is computed
   * for `viewerUserId`, so a response never carries a prompt its reader could
   * not otherwise read, and never withholds one from its owner.
   */
  private async getAgentWithClient(
    client: Queryable,
    spaceId: string,
    agentId: string,
    viewerUserId: string | null,
  ): Promise<AgentOut | null> {
    const result = await client.query<WithAccessLevel<AgentRecord>>(
      `SELECT ${agentSelectColumns("$3")}
         FROM agents a
         LEFT JOIN agent_versions av ON av.id = a.current_version_id
${DEFAULT_RUNTIME_PROFILE_JOIN}
         LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
        WHERE a.space_id = $1 AND a.id = $2
        LIMIT 1`,
      [spaceId, agentId, viewerUserId],
    );
    return result.rows[0] ? agentOut(result.rows[0]) : null;
  }
}
