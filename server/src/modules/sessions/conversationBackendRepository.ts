import { randomUUID } from "node:crypto";
import type {
  ConversationBackendBinding,
  ConversationBackendOption,
} from "@rainver/protocol";
import { getRuntimeAdapterSpec, isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import {
  isProviderEligibleForUser,
  providerCredentialEligibilitySql,
} from "../providers/eligibility.js";
import { isStale } from "../hosts/repository.js";
import { hostInstallationIds } from "../hosts/capabilities.js";
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
  runtime_installation: string | null;
  agent_project_id: string | null;
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

interface CredentialRow {
  id: string;
  runtime: string;
  name: string;
  is_default: boolean;
}

interface CliCredentialAvailability {
  availableProfiles(
    spaceId: string,
    userId: string,
  ): Promise<Record<string, unknown>[]>;
}

interface BindingRow {
  agent_kind: string;
  binding_id: string;
  runtime_profile_id: string;
  credential_profile_id: string | null;
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
  runtime_installation: string | null;
  retired_runtime_state_key: string | null;
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
  constructor(
    private readonly db: Queryable,
    private readonly cliCredentials: CliCredentialAvailability,
  ) {}

  async listOptions(
    spaceId: string,
    userId: string,
    agentId: string,
  ): Promise<ConversationBackendOption[]> {
    const [profiles, credentials, availableCredentials] = await Promise.all([
      this.db.query<BackendRow>(
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
                profile.runtime_installation,
                agent.project_id AS agent_project_id,
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
      ),
      this.db.query<CredentialRow>(
        `SELECT profile.id, profile.runtime, profile.name, credential_grant.is_default
           FROM cli_credential_space_grants credential_grant
           JOIN cli_credential_profiles profile
             ON profile.id = credential_grant.profile_id
            AND profile.owner_user_id = $2
          WHERE credential_grant.space_id = $1
            AND credential_grant.owner_user_id = $2
            AND credential_grant.enabled = true
          ORDER BY credential_grant.is_default DESC, profile.name ASC, profile.id ASC`,
        [spaceId, userId],
      ),
      this.cliCredentials.availableProfiles(spaceId, userId),
    ]);
    const loggedInCredentialIds = new Set(
      availableCredentials
        .filter((profile) => profile.logged_in === true)
        .map((profile) => profile.id)
        .filter((id): id is string => typeof id === "string"),
    );

    return profiles.rows.flatMap((profile) => {
      const spec = getRuntimeAdapterSpec(profile.adapter_type);
      if (!spec || spec.implementation_status !== "implemented") return [];
      const hostBound = Boolean(
        profile.execution_host_id && profile.workspace_location_id && profile.runtime_installation,
      );
      const requiresCliCredential = isLocalCliRuntimeAdapter(profile.adapter_type) && !hostBound;
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
        !requiresCliCredential &&
        !providerAvailable
      ) {
        return [];
      }
      const credentialProfiles = requiresCliCredential
        ? credentials.rows
            .filter((credential) =>
              credential.runtime === spec.credentials.credential_runtime_name &&
              loggedInCredentialIds.has(credential.id))
            .map((credential) => ({
              id: credential.id,
              name: credential.name,
              is_default: credential.is_default,
            }))
        : [];
      if (requiresCliCredential && credentialProfiles.length === 0) return [];
      const hostOnline = hostBound
        && profile.host_status === "online"
        && !isStale(profile.host_last_heartbeat_at);
      const hostOwnerIsMe = hostBound && profile.host_owner_user_id === userId;
      const locationMatchesAgentProject = hostBound
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
      } else if (hostBound && profile.location_status !== "active") {
        usable = false;
        reason = "The bound Workspace Location is unavailable.";
      } else if (hostBound && !locationMatchesAgentProject) {
        usable = false;
        reason = "The bound Workspace Location belongs to a different Project.";
      } else if (hostBound && profile.location_execution_ready !== true) {
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
        requires_cli_credential: requiresCliCredential,
        usable,
        reason,
        host_bound: hostBound,
        host_name: hostBound ? profile.host_name : null,
        host_online: hostBound ? hostOnline : null,
        host_owner_is_me: hostBound ? hostOwnerIsMe : null,
        credential_profiles: credentialProfiles,
      }];
    });
  }

  async resolveBinding(input: {
    space_id: string;
    user_id: string;
    session_id: string;
    agent_id: string;
    requested?: {
      runtime_profile_id: string;
      credential_profile_id?: string | null;
    } | null;
  }): Promise<ResolvedConversationBackend> {
    const options = await this.listOptions(
      input.space_id,
      input.user_id,
      input.agent_id,
    );
    const existing = await this.findResolvedBinding(
      input.space_id,
      input.user_id,
      input.session_id,
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
    let recoveringManagedAssistant = false;
    if (stored?.agent_kind === "system_assistant" && !input.requested) {
      const storedCredentialAvailable = !stored.credential_profile_id || Boolean(
        storedOption?.credential_profiles.some((credential) => credential.id === stored.credential_profile_id),
      );
      if (!storedOption || !storedCredentialAvailable) {
        recoveringManagedAssistant = true;
        runtimeProfileId = options[0]?.runtime_profile_id;
        option = options.find((candidate) => candidate.runtime_profile_id === runtimeProfileId);
      }
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
    if (hostBoundOption && !option.host_bound) {
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
    if (!option.requires_cli_credential && input.requested?.credential_profile_id) {
      throw new ConversationBackendError(
        "credential_profile_id is valid only for a CLI conversation backend",
        422,
      );
    }

    const requestedCredentialId =
      input.requested?.credential_profile_id ??
      (recoveringManagedAssistant ? null : stored?.credential_profile_id) ??
      null;
    const selectedCredential = option.credential_profiles.find(
      (credential) => credential.id === requestedCredentialId,
    );
    if (stored?.credential_profile_id && !selectedCredential && !recoveringManagedAssistant) {
      throw new ConversationBackendError(
        "The stored CLI credential is no longer eligible; select a new backend",
        409,
      );
    }
    const credentialProfileId = option.requires_cli_credential
      ? (
          selectedCredential ??
          option.credential_profiles.find((credential) => credential.is_default) ??
          option.credential_profiles[0]
        )?.id ?? null
      : null;
    if (option.requires_cli_credential && !credentialProfileId) {
      throw new ConversationBackendError(
        `Conversation backend '${option.name}' requires one of the user's enabled CLI credential profiles`,
        409,
      );
    }
    if (
      input.requested?.credential_profile_id &&
      credentialProfileId !== input.requested.credential_profile_id
    ) {
      throw new ConversationBackendError(
        "The selected CLI credential is not owned by this user, enabled in this space, or compatible with the backend",
        403,
      );
    }

    const binding: ConversationBackendBinding = {
      runtime_profile_id: option.runtime_profile_id,
      adapter_type: option.adapter_type,
      credential_profile_id: credentialProfileId,
    };
    return this.upsertBinding(input, binding, existing?.runtime_state_key ?? null);
  }

  async findBinding(
    spaceId: string,
    userId: string,
    sessionId: string,
    agentId: string,
  ): Promise<ConversationBackendBinding | null> {
    const binding = await this.findResolvedBinding(spaceId, userId, sessionId, agentId);
    return binding
      ? {
          runtime_profile_id: binding.runtime_profile_id,
          adapter_type: binding.adapter_type,
          credential_profile_id: binding.credential_profile_id,
        }
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
              binding.runtime_profile_id, binding.credential_profile_id,
              binding.runtime_state_key, binding.runtime_session_id,
              binding.runtime_context_fingerprint, binding.runtime_message_cursor_id,
              profile.adapter_type, profile.model_name,
              profile.model_provider_id, profile.runtime_config_json,
              profile.runtime_policy_json,
              profile.execution_host_id, profile.workspace_location_id,
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
          AND binding.user_id = $2
          AND binding.session_id = $3
          AND binding.agent_id = $4
        LIMIT 1`,
      [spaceId, userId, sessionId, agentId],
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
          id, space_id, session_id, user_id, agent_id, runtime_profile_id,
          credential_profile_id, runtime_state_key, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT ON CONSTRAINT uq_session_conversation_backends_session_user_agent
       DO UPDATE SET
         runtime_profile_id = EXCLUDED.runtime_profile_id,
         credential_profile_id = EXCLUDED.credential_profile_id,
         runtime_state_key = CASE
           WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
            AND session_conversation_backends.credential_profile_id
                IS NOT DISTINCT FROM EXCLUDED.credential_profile_id
           THEN session_conversation_backends.runtime_state_key
           ELSE EXCLUDED.runtime_state_key
         END,
         runtime_session_id = CASE
           WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
            AND session_conversation_backends.credential_profile_id
                IS NOT DISTINCT FROM EXCLUDED.credential_profile_id
           THEN session_conversation_backends.runtime_session_id
           ELSE NULL
         END,
         runtime_context_fingerprint = CASE
           WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
            AND session_conversation_backends.credential_profile_id
                IS NOT DISTINCT FROM EXCLUDED.credential_profile_id
           THEN session_conversation_backends.runtime_context_fingerprint
           ELSE NULL
         END,
         runtime_message_cursor_id = CASE
           WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
            AND session_conversation_backends.credential_profile_id
                IS NOT DISTINCT FROM EXCLUDED.credential_profile_id
           THEN session_conversation_backends.runtime_message_cursor_id
           ELSE NULL
         END,
         runtime_session_updated_at = CASE
           WHEN session_conversation_backends.runtime_profile_id = EXCLUDED.runtime_profile_id
            AND session_conversation_backends.credential_profile_id
                IS NOT DISTINCT FROM EXCLUDED.credential_profile_id
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
        binding.credential_profile_id,
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
