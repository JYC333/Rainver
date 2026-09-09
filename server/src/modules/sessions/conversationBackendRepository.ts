import { randomUUID } from "node:crypto";
import type {
  ConversationBackendBinding,
  ConversationBackendOption,
  RuntimeSessionConfigOption,
} from "@rainver/protocol";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
} from "../providers/eligibility.js";
import { isStale } from "../hosts/repository.js";
import { hostInstallationIds, hostInstallationOptions } from "../hosts/capabilities.js";
import type { Queryable } from "../routeUtils/common.js";

interface BackendRow {
  agent_kind: string;
  runtime_profile_id: string;
  name: string;
  adapter_type: string;
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
  workspace_mode?: "location" | "managed" | null;
  runtime_installation: string | null;
  agent_project_id: string | null;
  host_kind: "server" | "remote" | null;
  host_name: string | null;
  host_owner_user_id: string | null;
  host_status: string | null;
  host_last_heartbeat_at: string | null;
  host_capabilities_json: unknown;
  location_status: string | null;
  location_project_id: string | null;
  location_execution_ready: boolean | null;
  is_default: boolean;
}

interface BindingRow {
  agent_kind: string;
  binding_id: string;
  runtime_profile_id: string;
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
                profile.adapter_type, profile.model_name,
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
                location.status AS location_status,
                location_folder.project_id AS location_project_id,
                location.execution_ready AS location_execution_ready,
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
      const spec = getRuntimeAdapterSpec(profile.adapter_type);
      if (!spec || spec.implementation_status !== "implemented") return [];
      const hostBound = Boolean(
        profile.execution_host_id && profile.workspace_mode && profile.runtime_installation,
      );
      // A CLI profile that names no execution host runs nowhere: since ADR
      // 0016 there is no server-side copy of a vendor CLI to fall back to.
      if (!hostBound && isLocalCliRuntimeAdapter(profile.adapter_type)) return [];
      const providerAvailable =
        profile.model_provider_id !== null &&
        isProviderEligibleForUser(profile, userId);
      if (
        !hostBound &&
        spec.credentials.credential_mode === "model_provider_api_key" &&
        !providerAvailable
      ) {
        return [];
      }
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
        && hostInstallationIds(profile.host_capabilities_json, profile.adapter_type).includes(
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
        adapter_type: profile.adapter_type,
        model_name: profile.model_name,
        usable,
        reason,
        host_bound: hostBound,
        host_id: hostBound ? profile.execution_host_id : null,
        workspace_mode: hostBound ? profile.workspace_mode : null,
        host_name: hostBound ? profile.host_name : null,
        host_online: hostBound ? hostOnline : null,
        host_owner_is_me: hostBound ? hostOwnerIsMe : null,
        session_config_options: hostBound && profile.runtime_installation
          ? hostInstallationOptions(
              profile.host_capabilities_json,
              profile.adapter_type,
              profile.runtime_installation,
            ).filter((option) => !(profile.model_provider_id && option.category === "model"))
          : [],
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
      return { ...existing, session_config_options: option?.session_config_options ?? [] };
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
      adapter_type: option.adapter_type,
    };
    const resolved = await this.upsertBinding(input, binding, existing?.runtime_state_key ?? null);
    return { ...resolved, session_config_options: option.session_config_options ?? [] };
  }

  async findBinding(
    spaceId: string,
    userId: string,
    sessionId: string,
    agentId: string,
  ): Promise<ConversationBackendBinding | null> {
    const binding = await this.findResolvedBinding(spaceId, userId, sessionId, agentId);
    return binding
      ? { runtime_profile_id: binding.runtime_profile_id, adapter_type: binding.adapter_type }
      : null;
  }

  private async findResolvedBinding(
    spaceId: string,
    userId: string,
    sessionId: string,
    agentId: string,
  ): Promise<ResolvedConversationBackend | null> {
    const result = await this.db.query<BindingRow & { adapter_type: string }>(
      `SELECT agent.agent_kind,
              binding.id AS binding_id,
              binding.runtime_profile_id,
              binding.runtime_state_key, binding.runtime_session_id,
              binding.runtime_context_fingerprint, binding.runtime_message_cursor_id,
              profile.adapter_type, profile.model_name,
              profile.model_provider_id, profile.runtime_config_json,
              profile.runtime_policy_json,
              profile.execution_host_id, profile.workspace_location_id,
              profile.workspace_mode,
              profile.runtime_installation
         FROM session_conversation_backends binding
         JOIN sessions session_row
           ON session_row.id = binding.session_id
          AND session_row.space_id = binding.space_id
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
    return row ? { ...row, retired_runtime_state_key: null } : null;
  }

  private async findConversationResolvedBinding(
    spaceId: string,
    sessionId: string,
    agentId: string,
  ): Promise<ResolvedConversationBackend | null> {
    const result = await this.db.query<BindingRow & { adapter_type: string }>(
      `SELECT agent.agent_kind,
              binding.id AS binding_id,
              binding.runtime_profile_id,
              binding.runtime_state_key, binding.runtime_session_id,
              binding.runtime_context_fingerprint, binding.runtime_message_cursor_id,
              profile.adapter_type,
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
         JOIN host_threads thread
           ON thread.space_id = binding.space_id
          AND thread.session_id = binding.session_id
          AND thread.agent_id = binding.agent_id
          AND thread.container_kind = 'conversation'
          AND thread.status IN ('active', 'session_reset')
          AND thread.execution_host_id = profile.execution_host_id
          AND thread.workspace_mode = profile.workspace_mode
          AND thread.workspace_location_id IS NOT DISTINCT FROM profile.workspace_location_id
          AND thread.adapter_type = profile.adapter_type
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
    return row ? { ...row, retired_runtime_state_key: null } : null;
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
    const result = await this.db.query<{ binding_id: string }>(
      `INSERT INTO session_conversation_backends (
          id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
          model_name_snapshot, model_provider_id_snapshot,
          runtime_config_snapshot_json, runtime_policy_snapshot_json,
          runtime_state_key, created_at, updated_at
       ) SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, profile.id,
                profile.model_name, profile.model_provider_id,
                profile.runtime_config_json, profile.runtime_policy_json,
                $7::varchar, $8::timestamptz, $8::timestamptz
           FROM agent_runtime_profiles profile
          WHERE profile.id = $6 AND profile.space_id = $2 AND profile.agent_id = $5
       ON CONFLICT ON CONSTRAINT uq_session_conversation_backends_session_agent
       DO UPDATE SET
         runtime_profile_id = EXCLUDED.runtime_profile_id,
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
        runtimeStateKey,
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("conversation backend binding was not persisted");
    const resolved = await this.findResolvedBinding(
      input.space_id,
      input.user_id,
      input.session_id,
      input.agent_id,
    );
    if (!resolved) throw new Error("conversation backend binding was not found after persistence");
    return {
      ...resolved,
      retired_runtime_state_key:
        previousStateKey && previousStateKey !== resolved.runtime_state_key
          ? previousStateKey
          : null,
    };
  }
}
