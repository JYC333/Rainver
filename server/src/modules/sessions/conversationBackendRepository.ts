import { randomUUID } from "node:crypto";
import type {
  ConversationBackendBinding,
  ConversationBackendOption,
  ConversationGitSnapshot,
  RuntimeSessionConfigOption,
  RuntimePromptCapabilities,
} from "@rainver/protocol";
import type { RunGitSnapshot } from "../runs/contractSnapshot.js";
import { getRuntimeAdapterSpec, isAcpRuntimeAdapter, isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
} from "../providers/eligibility.js";
import { isStale } from "../hosts/repository.js";
import { hostInstallationIds, hostInstallationOptions, hostInstallationPromptCapabilities } from "../hosts/capabilities.js";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { loadRuntimeProfileSnapshot, projectRuntimeProfileSnapshot } from "./runtimeProfileSnapshot.js";

interface BackendRow {
  agent_kind: string;
  runtime_profile_id: string;
  name: string;
  runtime_key: string;
  model_name: string | null;
  model_provider_id: string | null;
  provider_type: string | null;
  provider_enabled: boolean | null;
  provider_grant_enabled: boolean | null;
  provider_owner_user_id: string | null;
  provider_credential_type: string | null;
  provider_has_eligible_credential: boolean | null;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  location_project_folder_id: string | null;
  workspace_mode?: "location" | "managed" | null;
  runtime_installation: string | null;
  agent_project_id: string | null;
  host_kind: "server" | "remote" | null;
  host_name: string | null;
  host_owner_user_id: string | null;
  host_status: string | null;
  host_last_heartbeat_at: string | null;
  host_capabilities_json: unknown;
  provider_capabilities_json: unknown;
  location_status: string | null;
  location_project_id: string | null;
  location_execution_ready: boolean | null;
  location_branch: string | null;
  location_git_head: string | null;
  location_dirty: boolean | null;
  is_default: boolean;
}

interface BindingRow {
  agent_kind: string;
  binding_id: string;
  runtime_profile_id: string;
  runtime_key: string;
  backend_mode: "runtime_native" | "model_provider";
  runtime_state_key: string;
  runtime_session_id: string | null;
  runtime_context_fingerprint: string | null;
  runtime_message_cursor_id?: string | null;
  model_name: string | null;
  model_provider_id: string | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode: "location" | "managed" | null;
  runtime_installation: string | null;
}

export interface ResolvedConversationBackend extends ConversationBackendBinding {
  /** Present on persisted bindings; optional for legacy test/adaptor ports. */
  agent_kind?: string;
  binding_id: string;
  runtime_state_key: string;
  runtime_session_id: string | null;
  runtime_context_fingerprint: string | null;
  runtime_message_cursor_id?: string | null;
  model_name: string | null;
  model_provider_id: string | null;
  runtime_config_json: Record<string, unknown>;
  runtime_policy_json: Record<string, unknown>;
  execution_host_id: string | null;
  workspace_location_id: string | null;
  workspace_mode?: "location" | "managed" | null;
  runtime_installation: string | null;
  retired_runtime_state_key: string | null;
  session_config_options?: RuntimeSessionConfigOption[];
  prompt_capabilities?: RuntimePromptCapabilities | null;
  /** Git snapshot captured with the backend's current execution target. */
  git_snapshot?: RunGitSnapshot | null;
}

function effectivePromptCapabilities(profile: BackendRow): RuntimePromptCapabilities | null {
  const hostBound = Boolean(profile.execution_host_id && profile.workspace_mode && profile.runtime_installation);
  const runtime = hostBound
    ? hostInstallationPromptCapabilities(profile.host_capabilities_json, profile.runtime_key, profile.runtime_installation!)
    : null;
  return {
    image: effectiveImageCapability(profile, hostBound, runtime),
    embedded_context: runtime?.embedded_context ?? null,
    // ACP's v1 baseline includes ResourceLink. Keep it explicit in the
    // normalized read model so admission can distinguish an old/unknown host
    // report from a runtime that actively rejects links.
    resource_link: runtime?.resource_link ?? null,
  };
}

function effectiveImageCapability(
  profile: BackendRow,
  hostBound: boolean,
  runtime: RuntimePromptCapabilities | null,
): boolean | null {
  const hostOwnsAcpModel = hostBound
    && isAcpRuntimeAdapter(profile.runtime_key)
    && profile.model_provider_id === null;
  if (hostOwnsAcpModel) {
    // An unbound ACP installation owns both the login and the model selected
    // through its session config. There is intentionally no server Provider
    // catalog to intersect with this capability; ACP is the authority here.
    return runtime?.image ?? null;
  }
  return combineCapability(
    runtime?.image ?? null,
    explicitModelImageCapability(profile.provider_capabilities_json, profile.model_name),
  );
}

function explicitModelImageCapability(value: unknown, model: string | null): boolean | null {
  if (!model || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const modelCapabilities = source.model_capabilities;
  if (modelCapabilities && typeof modelCapabilities === "object" && !Array.isArray(modelCapabilities)) {
    const candidate = (modelCapabilities as Record<string, unknown>)[model];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (typeof record.image_input === "boolean") return record.image_input;
      if (typeof record.image === "boolean") return record.image;
    }
  }
  const listed = source.image_input_models;
  if (Array.isArray(listed) && listed.every((item) => typeof item === "string")) {
    return listed.includes(model);
  }
  const modelList = source.models;
  if (Array.isArray(modelList)) {
    const entry = modelList.find((item) => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).id === model);
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (typeof record.image_input === "boolean") return record.image_input;
      if (typeof record.image === "boolean") return record.image;
    }
  }
  return null;
}

function combineCapability(left: boolean | null, right: boolean | null): boolean | null {
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return null;
}

export class ConversationBackendError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ConversationBackendError";
  }
}

export class PgConversationBackendRepository {
  constructor(private readonly db: Queryable) {}

  async listOptions(
    spaceId: string,
    userId: string,
    agentId: string,
  ): Promise<ConversationBackendOption[]> {
    const profiles = await this.db.query<BackendRow>(
        `SELECT agent.agent_kind,
                profile.id AS runtime_profile_id, profile.name,
                profile.runtime_key, profile.model_name,
                profile.model_provider_id,
                provider.provider_type,
                provider.enabled AS provider_enabled,
                provider_grant.enabled AS provider_grant_enabled,
                provider.owner_user_id AS provider_owner_user_id,
                provider_credential.credential_type AS provider_credential_type,
                ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")}
                  AS provider_has_eligible_credential,
                profile.execution_host_id,
                profile.workspace_location_id,
                profile.workspace_mode,
                profile.runtime_installation,
                agent.project_id AS agent_project_id,
                host.kind AS host_kind,
                host.name AS host_name,
                host.owner_user_id AS host_owner_user_id,
                host.status AS host_status,
                host.last_heartbeat_at AS host_last_heartbeat_at,
                host.capabilities_json AS host_capabilities_json,
                provider.capabilities_json AS provider_capabilities_json,
                location.status AS location_status,
                location.project_folder_id AS location_project_folder_id,
                location_folder.project_id AS location_project_id,
                location.execution_ready AS location_execution_ready,
                location.branch AS location_branch,
                location.git_head AS location_git_head,
                location.dirty AS location_dirty,
                profile.is_default
           FROM agent_runtime_profiles profile
           JOIN agents agent
             ON agent.id = profile.agent_id
            AND agent.space_id = profile.space_id
           LEFT JOIN model_providers provider
             ON provider.id = profile.model_provider_id
           LEFT JOIN model_provider_space_grants provider_grant
            ON provider_grant.provider_id = profile.model_provider_id
            AND provider_grant.space_id = profile.space_id
           LEFT JOIN credentials provider_credential
             ON provider_credential.id = provider.credential_id
           LEFT JOIN hosts host
             ON host.id = profile.execution_host_id
           LEFT JOIN workspace_locations location
             ON location.id = profile.workspace_location_id
            AND location.execution_host_id = profile.execution_host_id
           LEFT JOIN project_folders location_folder
             ON location_folder.id = location.project_folder_id
          WHERE profile.space_id = $1
            AND profile.agent_id = $2
            AND profile.enabled = true
          ORDER BY CASE WHEN agent.agent_kind = 'system_assistant'
                        THEN COALESCE(provider_grant.is_default, false)
                        ELSE false END DESC,
                   profile.is_default DESC,
                   profile.created_at ASC, profile.id ASC`,
      [spaceId, agentId],
    );

    return profiles.rows.flatMap((profile) => {
      const spec = getRuntimeAdapterSpec(profile.runtime_key);
      if (!spec || spec.implementation_status !== "implemented") return [];
      const hostBound = Boolean(
        profile.execution_host_id && profile.workspace_mode && profile.runtime_installation,
      );
      // A CLI profile that names no execution host runs nowhere: since ADR
      // 0016 there is no server-side copy of a vendor CLI to fall back to.
      if (!hostBound && isLocalCliRuntimeAdapter(profile.runtime_key)) return [];
      const providerAvailable =
        profile.model_provider_id !== null &&
        isProviderEligibleForUser(profile, userId);
      if (
        !hostBound &&
        spec.credentials.credential_mode === "cli_profile_or_model_provider" &&
        !providerAvailable
      ) {
        return [];
      }
      // The built-in host is a daemon like any other: it can be stopped, and
      // its container can be down while the control plane is up. Waiving the
      // liveness check for it showed "Server" as usable with nothing running,
      // and the person found out at send time from the one gate that is
      // honest. Ownership is the only thing that does not apply to it — there
      // is no owner to be (ADR 0016 §3).
      const hostOnline = hostBound
        && profile.host_status === "online"
        && !isStale(profile.host_last_heartbeat_at);
      const hostOwnerIsMe = hostBound && (
        profile.host_kind === "server" || profile.host_owner_user_id === userId
      );
      const locationMatchesAgentProject = hostBound && profile.workspace_mode === "location"
        && profile.location_project_id === profile.agent_project_id;
      const installationAvailable = hostBound
        && hostInstallationIds(profile.host_capabilities_json, profile.runtime_key).includes(
          profile.runtime_installation!,
        );
      let usable = true;
      let reason: string | null = null;
      if (hostBound && !hostOwnerIsMe) {
        usable = false;
        reason = "Only the Host owner can trigger this Agent from a Room.";
      } else if (hostBound && !hostOnline) {
        usable = false;
        reason = "The execution Host is offline.";
      } else if (hostBound && profile.workspace_mode === "location" && profile.location_status !== "active") {
        usable = false;
        reason = "The bound Workspace Location is unavailable.";
      } else if (hostBound && profile.workspace_mode === "location" && !locationMatchesAgentProject) {
        usable = false;
        reason = "The bound Workspace Location belongs to a different Project.";
      } else if (hostBound && profile.workspace_mode === "location" && profile.location_execution_ready !== true) {
        usable = false;
        reason = "The bound Workspace Location is not ready.";
      } else if (hostBound && !installationAvailable) {
        usable = false;
        reason = "The selected runtime installation is unavailable on the Host.";
      }
      return [{
        runtime_profile_id: profile.runtime_profile_id,
        name: profile.name,
        runtime_key: profile.runtime_key,
        model_name: profile.model_name,
        usable,
        reason,
        host_bound: hostBound,
        host_id: hostBound ? profile.execution_host_id : null,
        workspace_mode: hostBound ? profile.workspace_mode : null,
        project_folder_id: hostBound ? profile.location_project_folder_id : null,
        workspace_location_id: hostBound ? profile.workspace_location_id : null,
        host_name: hostBound ? profile.host_name : null,
        host_online: hostBound ? hostOnline : null,
        host_owner_is_me: hostBound ? hostOwnerIsMe : null,
        git: backendGitSnapshot(profile, hostBound),
        session_config_options: hostBound && profile.runtime_installation
          ? hostInstallationOptions(
              profile.host_capabilities_json,
              profile.runtime_key,
              profile.runtime_installation,
            ).filter((option) => !(profile.model_provider_id && option.category === "model"))
          : [],
        prompt_capabilities: effectivePromptCapabilities(profile),
      }];
    });
  }

  async resolveBinding(input: {
    space_id: string;
    user_id: string;
    session_id: string;
    agent_id: string;
    requested?: { runtime_profile_id: string } | null;
  }): Promise<ResolvedConversationBackend> {
    const executionContext = await this.db.query<{ state: string }>(
      `SELECT state
         FROM conversation_execution_contexts
        WHERE space_id = $1 AND session_id = $2
        LIMIT 1`,
      [input.space_id, input.session_id],
    );
    const initialized = executionContext.rows[0]?.state === "initialized";
    // Once initialized, the Conversation-scoped binding is authoritative.
    // Never let a member's user-scoped Room binding shadow the pinned runtime.
    const existing = initialized
      ? await this.findConversationResolvedBinding(
          input.space_id,
          input.session_id,
          input.agent_id,
        )
      : await this.findResolvedBinding(
          input.space_id,
          input.user_id,
          input.session_id,
          input.agent_id,
        );
    if (initialized) {
      if (!existing) {
        throw new ConversationBackendError(
          "The initialized Conversation Agent runtime binding is missing",
          409,
        );
      }
      if (input.requested && input.requested.runtime_profile_id !== existing.runtime_profile_id) {
        throw new ConversationBackendError(
          "CLI runtime is fixed for this Conversation Agent; start a new Conversation to change it",
          409,
        );
      }
      // An initialized Conversation never re-resolves mutable profile defaults
      // or silently switches to a fallback. Runtime dispatch will additionally
      // replace mutable workspace fields with the pinned Host thread snapshot.
      // ACP option metadata is read afresh because the installed Agent may
      // legitimately change its catalog without changing this binding.
      const option = (await this.listOptions(input.space_id, input.user_id, input.agent_id))
        .find((candidate) => candidate.runtime_profile_id === existing.runtime_profile_id);
      return { ...existing, session_config_options: option?.session_config_options ?? [], prompt_capabilities: option?.prompt_capabilities ?? null };
    }
    const options = await this.listOptions(
      input.space_id,
      input.user_id,
      input.agent_id,
    );
    const stored = input.requested ? null : existing;
    const storedOption = stored
      ? options.find((candidate) => candidate.runtime_profile_id === stored.runtime_profile_id)
      : null;
    let runtimeProfileId =
      input.requested?.runtime_profile_id ??
      storedOption?.runtime_profile_id ??
      (stored?.agent_kind === "system_assistant" ? options[0]?.runtime_profile_id : stored?.runtime_profile_id) ??
      options[0]?.runtime_profile_id;
    let option = options.find(
      (candidate) => candidate.runtime_profile_id === runtimeProfileId,
    );
    if (stored?.agent_kind === "system_assistant" && !input.requested && !storedOption) {
      runtimeProfileId = options[0]?.runtime_profile_id;
      option = options.find((candidate) => candidate.runtime_profile_id === runtimeProfileId);
    }
    if (!option) {
      throw new ConversationBackendError(
        stored
          ? "The stored conversation backend is no longer eligible; select a new backend"
          : "No eligible conversation backend is available for this user",
        409,
      );
    }
    const hostBoundOption = options.find((candidate) => candidate.host_bound);
    // A person may explicitly pick a server profile before initialization.
    // Implicit resolution must not move a Host-bound Agent onto it.
    if (hostBoundOption && !option.host_bound && !input.requested) {
      throw new ConversationBackendError(
        "Host-bound Agents must use their paired execution Host from a Room",
        409,
      );
    }
    if (option.usable === false) {
      throw new ConversationBackendError(
        option.reason ?? "The selected conversation backend is unavailable",
        409,
      );
    }
    const binding: ConversationBackendBinding = {
      runtime_profile_id: option.runtime_profile_id,
      runtime_key: option.runtime_key,
    };
    const resolved = await this.upsertBinding(input, binding, existing?.runtime_state_key ?? null);
    return { ...resolved, session_config_options: option.session_config_options ?? [], prompt_capabilities: option.prompt_capabilities ?? null };
  }

  async findBinding(
    spaceId: string,
    userId: string,
    sessionId: string,
    agentId: string,
  ): Promise<ConversationBackendBinding | null> {
    const binding = await this.findResolvedBinding(spaceId, userId, sessionId, agentId);
    return binding
      ? { runtime_profile_id: binding.runtime_profile_id, runtime_key: binding.runtime_key }
      : null;
  }

  private async findResolvedBinding(
    spaceId: string,
    userId: string,
    sessionId: string,
    agentId: string,
    db: Queryable = this.db,
  ): Promise<ResolvedConversationBackend | null> {
    const result = await db.query<BindingRow>(
      `SELECT agent.agent_kind,
              binding.id AS binding_id,
              binding.runtime_profile_id,
              binding.runtime_key_snapshot AS runtime_key,
              binding.backend_mode_snapshot AS backend_mode,
              binding.runtime_state_key, binding.runtime_session_id,
              binding.runtime_context_fingerprint, binding.runtime_message_cursor_id,
              binding.model_name_snapshot AS model_name,
              binding.model_provider_id_snapshot AS model_provider_id,
              binding.runtime_config_snapshot_json AS runtime_config_json,
              binding.runtime_policy_snapshot_json AS runtime_policy_json,
              profile.execution_host_id, profile.workspace_location_id,
              profile.workspace_mode,
              profile.runtime_installation
         FROM session_conversation_backends binding
         JOIN agent_runtime_profiles profile
           ON profile.id = binding.runtime_profile_id
          AND profile.space_id = binding.space_id
          AND profile.agent_id = binding.agent_id
         JOIN agents agent
           ON agent.id = binding.agent_id
          AND agent.space_id = binding.space_id
        WHERE binding.space_id = $1
          AND binding.bound_by_user_id = $2
          AND binding.session_id = $3
          AND binding.agent_id = $4
        LIMIT 1`,
      [spaceId, userId, sessionId, agentId],
    );
    const row = result.rows[0];
    return row
      ? { ...projectRuntimeProfileSnapshot(row), retired_runtime_state_key: null }
      : null;
  }

  private async findConversationResolvedBinding(
    spaceId: string,
    sessionId: string,
    agentId: string,
    db: Queryable = this.db,
  ): Promise<ResolvedConversationBackend | null> {
    const result = await db.query<BindingRow>(
      `SELECT agent.agent_kind,
              binding.id AS binding_id,
              binding.runtime_profile_id,
              binding.runtime_key_snapshot AS runtime_key,
              binding.backend_mode_snapshot AS backend_mode,
              binding.runtime_state_key, binding.runtime_session_id,
              binding.runtime_context_fingerprint, binding.runtime_message_cursor_id,
              binding.model_name_snapshot AS model_name,
              binding.model_provider_id_snapshot AS model_provider_id,
              binding.runtime_config_snapshot_json AS runtime_config_json,
              binding.runtime_policy_snapshot_json AS runtime_policy_json,
              profile.execution_host_id, profile.workspace_location_id,
              profile.workspace_mode,
              profile.runtime_installation
         FROM session_conversation_backends binding
         JOIN agent_runtime_profiles profile
           ON profile.id = binding.runtime_profile_id
          AND profile.space_id = binding.space_id
          AND profile.agent_id = binding.agent_id
         JOIN sessions session_row
           ON session_row.id = binding.session_id
          AND session_row.space_id = binding.space_id
         JOIN host_threads thread
           ON thread.agent_id = binding.agent_id
          -- A Room Conversation uses a conversation-scoped Host thread; a
          -- direct Agent Conversation deliberately owns a direct thread and
          -- is keyed by its user rather than session_id. The binding is
          -- Conversation-scoped in both cases, so derive the Host-thread
          -- boundary from the Session instead of dropping direct bindings on
          -- the second turn.
          AND (
            (session_row.room_id IS NULL
              AND (
                (thread.container_kind = 'direct'
                  AND thread.container_user_id = session_row.user_id)
                OR (thread.container_kind = 'conversation'
                  AND thread.session_id = binding.session_id)
              ))
            OR (session_row.room_id IS NOT NULL
              AND thread.space_id = binding.space_id
              AND thread.container_kind = 'conversation'
              AND thread.session_id = binding.session_id)
          )
          AND thread.status IN ('active', 'session_reset')
          AND thread.execution_host_id = profile.execution_host_id
          AND thread.workspace_mode = profile.workspace_mode
          AND thread.workspace_location_id IS NOT DISTINCT FROM profile.workspace_location_id
          AND thread.runtime_key = binding.runtime_key_snapshot
          AND thread.runtime_installation = profile.runtime_installation
         JOIN agents agent
           ON agent.id = binding.agent_id
          AND agent.space_id = binding.space_id
        WHERE binding.space_id = $1
          AND binding.session_id = $2
          AND binding.agent_id = $3
          AND profile.enabled = true
        ORDER BY binding.created_at ASC, binding.id ASC
        LIMIT 1`,
      [spaceId, sessionId, agentId],
    );
    const row = result.rows[0];
    return row
      ? { ...projectRuntimeProfileSnapshot(row), retired_runtime_state_key: null }
      : null;
  }

  private async upsertBinding(
    input: {
      space_id: string;
      user_id: string;
      session_id: string;
      agent_id: string;
    },
    binding: ConversationBackendBinding,
    previousStateKey: string | null,
  ): Promise<ResolvedConversationBackend> {
    const now = new Date().toISOString();
    const runtimeStateKey = randomUUID();
    return withQueryableTransaction(this.db, async (db) => {
      const profile = await loadRuntimeProfileSnapshot(db, {
        spaceId: input.space_id,
        agentId: input.agent_id,
        profileId: binding.runtime_profile_id,
      });
      if (!profile) throw new Error("conversation runtime profile was not found");

      const result = await db.query<{ binding_id: string }>(
        `INSERT INTO session_conversation_backends (
            id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
            runtime_key_snapshot, backend_mode_snapshot,
            model_name_snapshot, model_provider_id_snapshot,
            runtime_config_snapshot_json, runtime_policy_snapshot_json,
            runtime_state_key, created_at, updated_at
         ) VALUES (
            $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::varchar,
            $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::varchar, $14::timestamptz, $14::timestamptz
         )
         ON CONFLICT ON CONSTRAINT uq_session_conversation_backends_session_agent
         DO UPDATE SET
           runtime_profile_id = EXCLUDED.runtime_profile_id,
           runtime_key_snapshot = EXCLUDED.runtime_key_snapshot,
           backend_mode_snapshot = EXCLUDED.backend_mode_snapshot,
           model_name_snapshot = EXCLUDED.model_name_snapshot,
           model_provider_id_snapshot = EXCLUDED.model_provider_id_snapshot,
           runtime_config_snapshot_json = EXCLUDED.runtime_config_snapshot_json,
           runtime_policy_snapshot_json = EXCLUDED.runtime_policy_snapshot_json,
           runtime_state_key = CASE
             WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
             THEN session_conversation_backends.runtime_state_key
             ELSE EXCLUDED.runtime_state_key
           END,
           runtime_session_id = CASE
             WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
             THEN session_conversation_backends.runtime_session_id
             ELSE NULL
           END,
           runtime_context_fingerprint = CASE
             WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
             THEN session_conversation_backends.runtime_context_fingerprint
             ELSE NULL
           END,
           runtime_message_cursor_id = CASE
             WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
             THEN session_conversation_backends.runtime_message_cursor_id
             ELSE NULL
           END,
           runtime_session_updated_at = CASE
             WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
             THEN session_conversation_backends.runtime_session_updated_at
             ELSE NULL
           END,
           updated_at = EXCLUDED.updated_at
         RETURNING id AS binding_id`,
        [
          randomUUID(),
          input.space_id,
          input.session_id,
          input.user_id,
          input.agent_id,
          binding.runtime_profile_id,
          profile.runtime_key,
          profile.backend_mode,
          profile.model_name,
          profile.model_provider_id,
          JSON.stringify(profile.runtime_config_json),
          JSON.stringify(profile.runtime_policy_json),
          runtimeStateKey,
          now,
        ],
      );
      if (!result.rows[0]) throw new Error("conversation backend binding was not persisted");
      const resolved = await this.findResolvedBinding(
        input.space_id,
        input.user_id,
        input.session_id,
        input.agent_id,
        db,
      );
      if (!resolved) throw new Error("conversation backend binding was not found after persistence");
      return {
        ...resolved,
        retired_runtime_state_key:
          previousStateKey && previousStateKey !== resolved.runtime_state_key
            ? previousStateKey
            : null,
      };
    });
  }
}

function backendGitSnapshot(profile: BackendRow, hostBound: boolean): ConversationGitSnapshot | null {
  if (!hostBound || !profile.workspace_mode) return null;
  if (profile.workspace_mode === "managed") {
    return {
      source: "managed_workspace",
      workspace_location_id: null,
      branch: null,
      commit_sha: null,
      dirty: null,
      execution_ready: true,
      observed_at: new Date().toISOString(),
    };
  }
  if (!profile.workspace_location_id) return null;
  return {
    source: "workspace_location",
    workspace_location_id: profile.workspace_location_id,
    branch: profile.location_branch,
    commit_sha: profile.location_git_head,
    dirty: profile.location_dirty,
    execution_ready: profile.location_execution_ready === true,
    observed_at: new Date().toISOString(),
  };
}
