import { randomUUID } from "node:crypto";
import {
  RuntimeProfileConfigJsonSchema,
  RuntimeProfilePolicyJsonSchema,
  stripSecretFieldsFromRecord,
} from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { hostInstallationIds } from "../hosts/capabilities.js";
import { getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import {
  getAgentRuntimeDefinition,
  supportsRuntimeBackendMode,
} from "../runtimeAdapters/runtimeDefinitions.js";

/**
 * Admission for `agent_runtime_profiles`: the one place a Profile's deployment
 * selection is normalized, validated and written.
 *
 * It lives beside `repository.ts` rather than inside it because the same rules
 * used to exist three times there — inlined in Agent creation, again in the
 * shared normalizer, and a third time on the Space provisioning template — and
 * two near-identical 16-parameter `UPDATE`s wrote the result. The repository
 * keeps its public API and owns the Agent/AgentVersion rows; the Profile row's
 * admission and writes are owned here.
 *
 * Nothing in this module reads a Space provisioning template or an existing
 * Run: a Profile is deployment authority, and the template is a provisioning
 * input the caller has already resolved.
 */

export const RUNTIME_PROFILE_COLUMNS = `
  arp.id, arp.space_id, arp.agent_id, arp.name,
  arp.runtime_key,
  arp.backend_mode,
  arp.execution_host_id, arp.workspace_location_id, arp.runtime_installation,
  arp.workspace_mode,
  arp.model_provider_id, arp.model_name,
  arp.runtime_config_json, arp.runtime_policy_json, arp.enabled, arp.is_default,
  arp.created_at, arp.updated_at,
  mp.name AS provider_name, mp.provider_type AS provider_type
`;

export type AgentRuntimeBackendMode = "runtime_native" | "model_provider";
export type RuntimeWorkspaceMode = "location" | "managed";

export interface AgentRuntimeProfileRecord {
  id: string;
  space_id: string;
  agent_id: string;
  name: string;
  runtime_key: string;
  backend_mode: AgentRuntimeBackendMode;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: RuntimeWorkspaceMode | null;
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

export interface AgentRuntimeProfileOut {
  id: string;
  space_id: string;
  agent_id: string;
  name: string;
  runtime_key: string;
  backend_mode: AgentRuntimeBackendMode;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: RuntimeWorkspaceMode | null;
  runtime_installation: string | null;
  model: {
    provider_id: string | null;
    provider_name: string | null;
    provider_type: string | null;
    model: string | null;
  } | null;
  provider_binding: {
    state: "unbound" | "bound";
    provider_id: string | null;
    model: string | null;
  };
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  created_at: unknown;
  updated_at: unknown;
}

export interface HostRuntimeProfileTarget {
  spaceId: string;
  agentId: string;
  actorUserId: string;
  executionHostId: string;
  workspaceLocationId: string | null;
  workspaceMode: RuntimeWorkspaceMode;
  runtimeKey: string;
  runtimeInstallation: string;
}

export interface RuntimeProfileAdmissionInput {
  agentId?: string;
  name: string;
  runtimeKey: string;
  modelProviderId?: string | null;
  modelName?: string | null;
  executionHostId?: string | null;
  workspaceLocationId?: string | null;
  workspaceMode?: RuntimeWorkspaceMode | null;
  runtimeInstallation?: string | null;
  runtimeConfigJson?: Record<string, unknown> | null;
  runtimePolicyJson?: Record<string, unknown> | null;
  backendMode?: AgentRuntimeBackendMode;
  enabled?: boolean;
  isDefault?: boolean;
  /** Internal control-plane provisioning may bind a Server copy before its first health report. */
  allowPendingServerInstallation?: boolean;
  actorUserId?: string;
  /**
   * The Agent's Project and acting user, when the caller already holds them.
   * Provisioning knows both for the row it just inserted; re-reading it would
   * be a round trip for facts the caller supplied.
   */
  agentContext?: { projectId: string | null; actorUserId: string | null };
}

export interface NormalizedRuntimeProfile {
  name: string;
  runtimeKey: string;
  backendMode: AgentRuntimeBackendMode;
  modelProviderId: string | null;
  modelName: string | null;
  executionHostId: string | null;
  workspaceLocationId: string | null;
  workspaceMode: RuntimeWorkspaceMode | null;
  runtimeInstallation: string | null;
  runtimeConfigJson: Record<string, unknown>;
  runtimePolicyJson: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
}

/**
 * The one admission rule for a Profile option bag.
 *
 * `@rainver/protocol` owns it: the schema refuses credential-bearing keys at
 * any depth, refuses a nested key that would shadow runtime identity or an
 * immutable AgentVersion constraint, and refuses a key the *other* bag
 * authors. The server used to re-walk the same key sets beside the schema;
 * one rule, parsed at both the route boundary and here, is what keeps the two
 * answers from drifting.
 */
export function runtimeConfigRecord(value: unknown): Record<string, unknown> {
  return parseOptionBag(RuntimeProfileConfigJsonSchema, value, "runtime_config_json");
}

export function runtimePolicyRecord(value: unknown): Record<string, unknown> {
  return parseOptionBag(RuntimeProfilePolicyJsonSchema, value, "runtime_policy_json");
}

function parseOptionBag(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } } },
  value: unknown,
  field: string,
): Record<string, unknown> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpError(
      422,
      `${field} contains a forbidden or invalid JSON field: ${result.error?.issues[0]?.message ?? "invalid value"}`,
    );
  }
  return result.data as Record<string, unknown>;
}

/**
 * The secret-free projection of a stored option bag, through the canonical
 * protocol implementation. The column is `jsonb NOT NULL DEFAULT '{}'`, so a
 * non-object never reaches here and the local coercion that used to sit in
 * front of it only hid a schema violation from one reader while another threw.
 */
export function strippedOptionBag(value: unknown): Record<string, unknown> {
  return stripSecretFieldsFromRecord(value) as Record<string, unknown>;
}

export function runtimeProfileOut(row: AgentRuntimeProfileRecord): AgentRuntimeProfileOut {
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
    runtime_key: row.runtime_key,
    backend_mode: row.backend_mode,
    execution_host_id: row.execution_host_id,
    workspace_location_id: row.workspace_location_id,
    workspace_mode: row.workspace_mode,
    runtime_installation: row.runtime_installation,
    model: hasModel
      ? {
          provider_id: row.model_provider_id,
          provider_name: row.provider_name ?? null,
          provider_type: row.provider_type ?? null,
          model: row.model_name,
        }
      : null,
    provider_binding: row.backend_mode === "model_provider"
      ? { state: "bound", provider_id: row.model_provider_id, model: row.model_name }
      : { state: "unbound", provider_id: null, model: null },
    runtime_config_json: strippedOptionBag(row.runtime_config_json),
    runtime_policy_json: strippedOptionBag(row.runtime_policy_json),
    enabled: row.enabled,
    is_default: row.is_default,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function hostRuntimeProfileName(input: HostRuntimeProfileTarget): string {
  const workspace = input.workspaceMode === "managed"
    ? "managed"
    : `Location ${input.workspaceLocationId?.slice(0, 8) ?? "unknown"}`;
  const descriptive = `${input.runtimeKey} · ${input.runtimeInstallation} · ${workspace}`;
  return `${descriptive.slice(0, 112)} · ${randomUUID().slice(0, 8)}`;
}

export async function getRuntimeProfileRecord(
  db: Queryable,
  spaceId: string,
  agentId: string,
  profileId: string,
  lockForUpdate = false,
): Promise<AgentRuntimeProfileRecord | null> {
  const result = await db.query<AgentRuntimeProfileRecord>(
    `SELECT ${RUNTIME_PROFILE_COLUMNS}
       FROM agent_runtime_profiles arp
       LEFT JOIN model_providers mp ON mp.id = arp.model_provider_id
      WHERE arp.space_id = $1 AND arp.agent_id = $2 AND arp.id = $3
      LIMIT 1${lockForUpdate ? " FOR UPDATE OF arp" : ""}`,
    [spaceId, agentId, profileId],
  );
  return result.rows[0] ?? null;
}

/**
 * Take the Agent row's lock before touching its Profiles.
 *
 * Every default flip is serialized on this row: `uq_agent_runtime_profiles_
 * default_per_agent` is a partial unique index, so two concurrent creates that
 * both claim the default would otherwise collide as a raw constraint error
 * rather than an ordered hand-off.
 */
export async function lockAgentForRuntimeProfileWrite(
  db: Queryable,
  spaceId: string,
  agentId: string,
  options: { requireActive?: boolean } = {},
): Promise<void> {
  const locked = await db.query<{ id: string }>(
    `SELECT id FROM agents
      WHERE space_id = $1 AND id = $2${options.requireActive ? " AND status = 'active'" : ""}
      FOR UPDATE`,
    [spaceId, agentId],
  );
  if (!locked.rows[0]) throw new HttpError(404, "Agent not found");
}

export async function clearDefaultRuntimeProfile(
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

export async function insertRuntimeProfile(
  db: Queryable,
  input: NormalizedRuntimeProfile & { spaceId: string; agentId: string },
): Promise<AgentRuntimeProfileRecord> {
  const runtimeConfigJson = runtimeConfigRecord(input.runtimeConfigJson);
  const runtimePolicyJson = runtimePolicyRecord(input.runtimePolicyJson);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, runtime_key, backend_mode, model_provider_id,
       model_name, execution_host_id, workspace_location_id, workspace_mode, runtime_installation,
       runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13::jsonb, $14::jsonb, $15, $16, $17, $17
     )`,
    [
      id,
      input.spaceId,
      input.agentId,
      input.name,
      input.runtimeKey,
      input.backendMode,
      input.modelProviderId,
      input.modelName,
      input.executionHostId,
      input.workspaceLocationId,
      input.workspaceMode,
      input.runtimeInstallation,
      JSON.stringify(runtimeConfigJson),
      JSON.stringify(runtimePolicyJson),
      input.enabled,
      input.isDefault,
      now,
    ],
  );
  const created = await getRuntimeProfileRecord(db, input.spaceId, input.agentId, id);
  if (!created) throw new Error("Runtime profile insert returned no row");
  return created;
}

/**
 * The one writer for an existing Profile row. Both update paths — the explicit
 * PATCH and the idempotent provisioning upsert — went through their own
 * 16-parameter `UPDATE` with the same column list; a second copy is a second
 * place for a new column to be forgotten.
 */
export async function updateRuntimeProfileRow(
  db: Queryable,
  input: NormalizedRuntimeProfile & { spaceId: string; agentId: string; profileId: string },
): Promise<AgentRuntimeProfileRecord> {
  const result = await db.query<{ id: string }>(
    `UPDATE agent_runtime_profiles
        SET name = $4,
            runtime_key = $5,
            backend_mode = $6,
            model_provider_id = $7,
            model_name = $8,
            execution_host_id = $9,
            workspace_location_id = $10,
            workspace_mode = $11,
            runtime_installation = $12,
            runtime_config_json = $13::jsonb,
            runtime_policy_json = $14::jsonb,
            enabled = $15,
            is_default = $16,
            updated_at = $17
      WHERE space_id = $1 AND agent_id = $2 AND id = $3
      RETURNING id`,
    [
      input.spaceId,
      input.agentId,
      input.profileId,
      input.name,
      input.runtimeKey,
      input.backendMode,
      input.modelProviderId,
      input.modelName,
      input.executionHostId,
      input.workspaceLocationId,
      input.workspaceMode,
      input.runtimeInstallation,
      JSON.stringify(runtimeConfigRecord(input.runtimeConfigJson)),
      JSON.stringify(runtimePolicyRecord(input.runtimePolicyJson)),
      input.enabled,
      input.isDefault,
      new Date().toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Runtime profile not found");
  const updated = await getRuntimeProfileRecord(db, input.spaceId, input.agentId, row.id);
  if (!updated) throw new HttpError(404, "Runtime profile not found");
  return updated;
}

async function loadAgentContext(
  db: Queryable,
  spaceId: string,
  agentId: string,
): Promise<{ projectId: string | null; actorUserId: string | null }> {
  const agent = await db.query<{ project_id: string | null; owner_user_id: string | null }>(
    `SELECT project_id, owner_user_id FROM agents WHERE space_id = $1 AND id = $2 LIMIT 1`,
    [spaceId, agentId],
  );
  const row = agent.rows[0];
  if (!row) throw new HttpError(404, "Agent not found");
  return { projectId: row.project_id, actorUserId: row.owner_user_id };
}

export async function normalizeRuntimeProfileInput(
  db: Queryable,
  spaceId: string,
  input: RuntimeProfileAdmissionInput,
): Promise<NormalizedRuntimeProfile> {
  const name = input.name.trim();
  if (!name) throw new HttpError(422, "name is required");
  const runtimeKey = input.runtimeKey.trim();
  if (!getAgentRuntimeDefinition(runtimeKey)) {
    throw new HttpError(422, `Runtime '${runtimeKey}' is not a registered ACP runtime`);
  }
  const modelProviderId = input.modelProviderId ?? null;
  const modelName = input.modelName ?? null;
  const backendMode = input.backendMode
    ?? (modelProviderId || modelName ? "model_provider" : "runtime_native");
  assertBackendModeBinding(runtimeKey, backendMode, modelProviderId, modelName);

  // A caller that names a Location has named the mode: 'location' was the
  // only shape before managed workspaces existed, so it stays the default
  // for that input. 'managed' must always be explicit.
  const workspaceMode = input.workspaceMode ?? (input.workspaceLocationId != null ? "location" : null);
  const hostBound = input.executionHostId != null
    || input.workspaceLocationId != null
    || workspaceMode != null
    || input.runtimeInstallation != null;
  if (hostBound) {
    if (workspaceMode !== "location" && workspaceMode !== "managed") {
      throw new HttpError(422, "Host-bound runtime profiles require workspace_mode to be 'location' or 'managed'");
    }
    const context = input.agentContext ?? await loadAgentContext(db, spaceId, input.agentId ?? "");
    await validateHostExecutionBinding(db, {
      spaceId,
      projectId: context.projectId,
      actorUserId: input.actorUserId ?? context.actorUserId,
      executionHostId: input.executionHostId ?? null,
      workspaceLocationId: input.workspaceLocationId ?? null,
      workspaceMode,
      runtimeInstallation: input.runtimeInstallation ?? null,
      runtimeKey,
      allowPendingServerInstallation: input.allowPendingServerInstallation,
    });
  }
  assertProviderExecutionTarget(backendMode, hostBound);
  await validateRuntimeProfileSelection(db, { spaceId, runtimeKey, providerId: modelProviderId });
  const enabled = input.enabled ?? true;
  const isDefault = input.isDefault ?? false;
  if (isDefault && !enabled) {
    throw new HttpError(422, "A default runtime profile must be enabled");
  }
  return {
    name,
    runtimeKey,
    backendMode,
    modelProviderId,
    modelName,
    executionHostId: input.executionHostId ?? null,
    workspaceLocationId: input.workspaceLocationId ?? null,
    workspaceMode,
    runtimeInstallation: input.runtimeInstallation ?? null,
    runtimeConfigJson: runtimeConfigRecord(input.runtimeConfigJson),
    runtimePolicyJson: runtimePolicyRecord(input.runtimePolicyJson),
    enabled,
    isDefault,
  };
}

/**
 * The two backend modes, stated once.
 *
 * `runtime_native` carries no ModelProvider binding; `model_provider` carries
 * both a Provider and an explicit model. The Space provisioning template
 * answers the same question about the Profile it will create, so it admits
 * through this function rather than repeating the three checks.
 */
export function assertBackendModeBinding(
  runtimeKey: string,
  backendMode: AgentRuntimeBackendMode,
  modelProviderId: string | null,
  modelName: string | null,
): void {
  if (!supportsRuntimeBackendMode(runtimeKey, backendMode)) {
    throw new HttpError(422, `Runtime '${runtimeKey}' does not support ${backendMode} mode`);
  }
  if (backendMode === "runtime_native" && (modelProviderId !== null || modelName !== null)) {
    throw new HttpError(422, "runtime_native profiles cannot bind a ModelProvider or model");
  }
  if (backendMode === "model_provider" && (!modelProviderId || !modelName?.trim())) {
    throw new HttpError(422, "model_provider profiles require a same-Space ModelProvider and explicit model");
  }
}

/**
 * A Provider-backed Profile names an execution target.
 *
 * Both Host kinds qualify. The server hands the launching daemon a
 * short-lived proxy lease URL rather than a key, and
 * `hostProviderProxyBaseUrl` derives that address for a paired Host as well as
 * for the built-in one; the daemon's bound-run environment filter
 * (`filterAmbientEnv`) exists precisely so a paired machine's own vendor keys
 * cannot displace the binding. What the mode must not be is *unbound*: with no
 * Host and no installation there is nothing to hand the lease to.
 */
export function assertProviderExecutionTarget(
  backendMode: AgentRuntimeBackendMode,
  hostBound: boolean,
): void {
  if (backendMode === "model_provider" && !hostBound) {
    throw new HttpError(
      422,
      "ModelProvider-backed runtime profiles must name an execution Host, workspace mode and installation",
    );
  }
}

export async function validateHostExecutionBinding(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string | null;
    actorUserId: string | null;
    executionHostId: string | null;
    workspaceLocationId: string | null;
    workspaceMode: RuntimeWorkspaceMode | null;
    runtimeInstallation: string | null;
    runtimeKey: string;
    allowPendingServerInstallation?: boolean;
  },
): Promise<"server" | "remote"> {
  if (!input.executionHostId || !input.runtimeInstallation || !input.workspaceMode) {
    throw new HttpError(422, "Host-bound runtime profiles require execution_host_id, workspace_mode, and runtime_installation");
  }
  if (input.workspaceMode === "location" && !input.workspaceLocationId) {
    throw new HttpError(422, "Location-mode runtime profiles require workspace_location_id");
  }
  if (input.workspaceMode === "managed" && input.workspaceLocationId) {
    throw new HttpError(422, "Managed-mode runtime profiles cannot select a Workspace Location");
  }
  if (input.workspaceMode === "location" && !input.projectId) {
    throw new HttpError(422, "A Location-mode host-bound Agent must belong to a Project");
  }
  if (!input.actorUserId) throw new HttpError(403, "Host-bound execution requires an owning user");
  const target = input.workspaceMode === "managed"
    ? await db.query<{
        host_owner_user_id: string | null;
        host_kind: string;
        host_status: string;
        capabilities_json: unknown;
        location_host_id: string | null;
        location_space_id: string | null;
        location_status: string | null;
        folder_space_id: string | null;
        folder_project_id: string | null;
      }>(
        `SELECT owner_user_id AS host_owner_user_id, kind AS host_kind,
                status AS host_status, capabilities_json,
                NULL::varchar AS location_host_id, NULL::varchar AS location_space_id,
                NULL::varchar AS location_status, NULL::varchar AS folder_space_id,
                NULL::varchar AS folder_project_id
           FROM hosts WHERE id = $1 LIMIT 1`,
        [input.executionHostId],
      )
    : await db.query<{
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
  // Two safety models (ADR 0016 §3, B63). A paired host is its owner's, so
  // binding an Agent to one requires being that owner. The built-in host has
  // no owner and serves every Space — the per-Run namespace is what makes it
  // safe — so there is no ownership to check, and refusing it here was what
  // made the host the execution-target picker offers impossible to select.
  if (row.host_owner_user_id !== null && row.host_owner_user_id !== input.actorUserId) {
    throw new HttpError(403, "The execution host must belong to the caller");
  }
  if ((row.host_kind !== "remote" && row.host_kind !== "server") || row.host_status === "revoked") {
    throw new HttpError(422, "Host-bound Agents require a live execution host");
  }
  if (input.workspaceMode === "location") {
    if (row.location_space_id !== input.spaceId || row.folder_space_id !== input.spaceId) {
      throw new HttpError(404, "Host or Workspace Location not found");
    }
    if (row.location_host_id !== input.executionHostId || row.location_status !== "active") {
      throw new HttpError(422, "Workspace Location is not active on the selected host");
    }
    if (row.folder_project_id !== input.projectId) {
      throw new HttpError(422, "Workspace Location must belong to the Agent's Project");
    }
  }
  const spec = getLocalCliRuntimeAdapterSpec(input.runtimeKey);
  if (!spec || spec.implementation_status !== "implemented" || spec.invocation.protocol !== "acp") {
    throw new HttpError(422, `Runtime '${input.runtimeKey}' is not supported on a paired host`);
  }
  if (!hostInstallationIds(row.capabilities_json, input.runtimeKey).includes(input.runtimeInstallation)
    && !(input.allowPendingServerInstallation === true
      && row.host_kind === "server"
      && input.runtimeInstallation === "managed:pending")) {
    throw new HttpError(422, `Host does not report installation '${input.runtimeInstallation}' of '${input.runtimeKey}'`);
  }
  return row.host_kind;
}

/**
 * Whether this Space may select this Provider for this runtime.
 *
 * Cross-Space Provider use is guaranteed by exactly one mechanism: an enabled
 * `model_provider_space_grants` row for the Space, joined to an enabled
 * Provider. A Provider owned elsewhere and never granted here is not
 * selectable, on a Profile or on the Space provisioning template, whatever
 * else the caller knows about it.
 */
export async function validateRuntimeProfileSelection(
  db: Queryable,
  input: {
    spaceId: string;
    runtimeKey: string;
    providerId: string | null;
  },
): Promise<void> {
  const { spaceId, runtimeKey, providerId } = input;
  if (!getAgentRuntimeDefinition(runtimeKey)) {
    throw new HttpError(422, `Runtime '${runtimeKey}' is not a registered ACP runtime`);
  }
  // Provider/model pairing is `assertBackendModeBinding`'s answer and every
  // caller asks it first, so by here a provider is present exactly when the
  // mode is `model_provider`. This function decides one thing: whether this
  // Space may select that Provider.
  if (!providerId) return;
  const provider = await db.query<{ id: string }>(
    `SELECT p.id
       FROM model_provider_space_grants g
       JOIN model_providers p ON p.id = g.provider_id
      WHERE g.space_id = $1
        AND g.provider_id = $2
        AND g.enabled = true
        AND p.enabled = true`,
    [spaceId, providerId],
  );
  if (!provider.rows[0]) {
    throw new HttpError(400, "Model provider is not selectable in this space");
  }
}
