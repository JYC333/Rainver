import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { resolveProvidersDbPort } from "../providers/dbReader.js";
import {
  providerProxyLeases,
  type ProviderProxyLeaseRegistry,
  type ProviderProxyRoute,
} from "../providers/proxy/lease.js";
import { adapterProviderApi, adapterProviderRequirement } from "./adapterProviderRequirement.js";
import { resolveHostLeaseUrl } from "./hostProviderProxyAddress.js";
import { codexModelCatalog, renderCodexProviderToml } from "./codexProviderConfig.js";
import { applyOpenCodeProviderConfig, openCodeModelId } from "./opencodeProviderConfig.js";
import {
  authorizeCredentialSpend,
  CredentialSpendDeniedError,
  type CredentialSpendAuthorization,
  type CredentialSpendDeps,
} from "../policy/credentialSpend.js";
import type { HostLaunchProviderBinding } from "@rainver/protocol";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import type { AgentRunRecord } from "./repository.js";
import type { VendorCliRuntimeKey } from "../runtimeAdapters/specs.js";

/**
 * What the executing host is told. Deliberately runtime-agnostic: the daemon
 * creates a directory, writes these bytes, and reports the paths back as
 * environment. Every Codex-TOML or OpenCode-JSON decision stays here, next to
 * the server-host path that already makes it — one implementation, not two
 * that drift.
 *
 * The wire contract owns the shape; this alias is what the rest of the remote
 * path calls it. Every host-bound Agent run carries one, bound or not.
 */
export type RemoteProviderBindingFrame = HostLaunchProviderBinding;

/**
 * Which Agent, in which container, this run's CLI profile belongs to.
 *
 * The scope is deliberately *not* the run. A CLI's conversation state lives
 * inside the profile — Claude Code keeps its session transcripts under
 * `CLAUDE_CONFIG_DIR` — so a per-run profile is deleted along with the
 * session the next turn is about to resume, and every turn after the first
 * fails with the runtime reporting no such conversation.
 *
 * It is not machine-global either, which is what it used to be: keyed by
 * adapter and provider alone, every Agent on a machine shared one login,
 * one session store, and one pile of vendor auto-memory, and an unbound run
 * simply used the machine's own `~/.claude`. Keying by Agent × container is
 * what makes "the Agent is the memory boundary, the Conversation is the
 * context boundary" true of the substrate as well as of Rainver's own
 * Memory ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §6).
 *
 * The container is the Conversation for a Room turn, the owner for a direct
 * chat, and the WorkspaceLocation for everything else — a Task thread, an
 * Automation, a Plan or Workflow node, an evolution run whose Folder prefers
 * a remote Location. Those last have no conversation to be the boundary of,
 * and the Location is the thing their vendor session already belongs to.
 */
export interface RuntimeProfileScope {
  agent_id: string;
  container_kind: "conversation" | "direct" | "location" | "agent";
  container_id: string;
}

export const PROFILE_ROOT_PLACEHOLDER = "{{RAINVER_RUN_PROFILE}}";

/**
 * Which Agent × container this run's profile belongs to.
 *
 * Read from `host_threads` when the Run has one, because that table is where
 * the container identity actually lives: a Conversation thread is keyed
 * `(session_id, agent_id)` and a direct-chat thread `(agent_id,
 * container_user_id)`. The launch workspace is deliberately *not* the source —
 * a Conversation pinned to a registered WorkspaceLocation has
 * `workspace.kind = "location"` while still being a Conversation, and keying
 * the profile off the workspace would put two Rooms on one machine back into
 * one directory.
 *
 * Without a thread there is no conversation to be the boundary of, so the
 * Location is: an Automation, a Room root run, a Plan or Workflow node, and an
 * evolution run whose Folder prefers a remote Location all reach the host this
 * way, and their vendor session already belongs to that Location.
 */
export async function resolveRuntimeProfileScope(
  db: Queryable,
  run: { agent_id: string; host_task_thread_id?: string | null },
  workspaceLocationId: string | null,
): Promise<RuntimeProfileScope> {
  if (run.host_task_thread_id) {
    const thread = await db.query<{
      agent_id: string | null;
      container_kind: string | null;
      container_id: string | null;
    }>(
      `SELECT agent_id, container_kind,
              CASE WHEN container_kind = 'direct' THEN container_user_id
                   WHEN container_kind = 'conversation' THEN session_id
                   ELSE workspace_location_id END AS container_id
         FROM host_threads WHERE id = $1 LIMIT 1`,
      [run.host_task_thread_id],
    );
    const row = thread.rows[0];
    if (row?.container_id && (row.container_kind === "direct" || row.container_kind === "conversation")) {
      // The thread's Agent and the Run's are the same on every path that
      // creates one, and the archive keys off the thread's column — so a
      // divergence would write this run into another Agent's profile and
      // archive the wrong one. Enforced rather than assumed: failing open here
      // crosses the boundary this whole phase exists to draw.
      if (row.agent_id && row.agent_id !== run.agent_id) {
        throw new RemoteProviderBindingError(
          "runtime_profile_agent_mismatch",
          `Host thread ${run.host_task_thread_id} belongs to Agent ${row.agent_id}, but this run is Agent ${run.agent_id}.`,
        );
      }
      return {
        agent_id: row.agent_id ?? run.agent_id,
        container_kind: row.container_kind,
        container_id: row.container_id,
      };
    }
    if (row?.container_id) {
      return { agent_id: run.agent_id, container_kind: "location", container_id: row.container_id };
    }
    throw new RemoteProviderBindingError(
      "runtime_profile_scope_unresolved",
      "The Run's Host thread has no valid runtime profile container.",
    );
  }
  if (!workspaceLocationId) {
    // Ordinary Agent Runs have no Conversation thread or Workspace Location.
    // The Agent itself is their durable runtime-state boundary.
    return { agent_id: run.agent_id, container_kind: "agent", container_id: run.agent_id };
  }
  return { agent_id: run.agent_id, container_kind: "location", container_id: workspaceLocationId };
}

/**
 * The profile directory this run's runtime uses, as a `/`-separated key the
 * daemon validates segment by segment before building a path from it.
 *
 * `ambient` rather than an empty segment for a run with no ModelProvider: the
 * machine's own login is a real backend choice, and it gets its own directory
 * beside the bound ones so that switching a Conversation between a
 * subscription login and a ModelProvider starts a fresh vendor session rather
 * than resuming one whose context another backend produced.
 */
export function runtimeProfileKey(
  scope: RuntimeProfileScope,
  runtimeKey: string,
  providerId: string | null,
): string {
  return [
    "agents",
    scope.agent_id,
    scope.container_kind,
    scope.container_id,
    runtimeKey,
    providerId ?? "ambient",
  ].join("/");
}

/**
 * The profile frame for a run with no ModelProvider binding.
 *
 * There used to be none: an unbound run was launched with the machine's own
 * environment, so its CLI read `~/.claude` — one login, one session store and
 * one pile of vendor auto-memory shared by every Agent on the machine. This
 * gives it the same profile a bound run gets, minus the lease: no `files`, no
 * `env`, only the state-root variables and a link to the one credential file
 * this installation was logged in with.
 *
 * The link, rather than a token in the environment: passing the credential
 * through `CLAUDE_CODE_OAUTH_TOKEN` or its equivalents would mean Rainver read
 * a credential and injected it into a subprocess, which is the shape
 * [ADR 0008](../../../../.agent/decisions/0008-credential-channel-isolation.md)
 * forbids. With a link the CLI opens its own file and neither the server nor
 * the daemon ever holds the bytes.
 */
export function buildUnboundRuntimeProfile(
  runtimeKey: string,
  scope: RuntimeProfileScope,
): RemoteProviderBindingFrame {
  const login = getRuntimeAdapterSpec(runtimeKey)?.credentials?.login ?? null;
  // A runtime profile can replace the machine's state root only when its login
  // can travel with it. Running without that contract would put every Agent on
  // the managed installation's one session/auto-memory tree, contradicting
  // B68. Fail closed until the registry entry declares the login boundary.
  if (!login) {
    throw new RemoteProviderBindingError(
      "runtime_profile_isolation_unsupported",
      `Runtime adapter '${runtimeKey}' does not declare a login/state-root boundary, so Rainver cannot isolate its CLI state by Agent.`,
    );
  }
  return {
    profile_key: runtimeProfileKey(scope, runtimeKey, null),
    env: {},
    profile_env: profileStateEnv(runtimeKey),
    files: [],
    credential_source: "host_login",
    login_link: { home_subdir: login.home_subdir, credential_file: login.credential_file },
  };
}

/**
 * Where a runtime on **this machine's own login** keeps its state, as
 * profile-relative paths the daemon resolves.
 *
 * Deliberately **not** `HOME`. A bound run gets `HOME: "."` because B67 wants
 * the machine contributing nothing at all, and pays for it by losing
 * `~/.gitconfig` and `~/.ssh` — a cost that phase accepted for bound runs and
 * recorded. An unbound run must not pay it: a Task run on a paired machine
 * commits and pushes inside a registered Location, and moving its `HOME` would
 * break `git commit` on the author identity and `git push` on the user's ssh
 * config, for runs that worked the day before.
 *
 * Each runtime names its own state root instead, and each of these is the
 * variable that runtime's own binding already uses:
 *
 * - Claude Code — `CLAUDE_CONFIG_DIR`, which holds both its session
 *   transcripts and the `.credentials.json` the login link lands on.
 * - Codex — `CODEX_HOME`, likewise for `sessions/` and `auth.json`.
 * - OpenCode — the XDG roots. Its data directory is `$XDG_DATA_HOME/opencode`,
 *   falling back to `HOME/.local/share/opencode`, which is why the bound path
 *   redirects `HOME`: `XDG_DATA_HOME` is not on B67's allowlist so there is
 *   nothing to point. Here there is. **This is the one state root not verified
 *   on a real host** — if OpenCode ignores `XDG_DATA_HOME`, its state stays
 *   machine-global, which is no worse than before this phase but is not the
 *   isolation this claims. Recorded in the deferred register.
 */
function profileStateEnv(runtimeKey: string): Record<string, string> {
  if (runtimeKey === "claude_code") return { CLAUDE_CONFIG_DIR: ".claude" };
  if (runtimeKey === "codex_cli") return { CODEX_HOME: ".codex" };
  return {
    XDG_DATA_HOME: ".local/share",
    XDG_CONFIG_HOME: ".config",
    XDG_STATE_HOME: ".local/state",
    XDG_CACHE_HOME: ".cache",
  };
}

/**
 * `model_override_json.source` written after the selected Runtime Profile's
 * backend is handed to the remote runtime. It marks a backend actually used,
 * rather than a value merely predicted by route selection.
 */
export const RUNTIME_PROFILE_MODEL_SOURCE = "runtime_profile";

/**
 * Records the backend this remote run was resolved to — written once the
 * binding is built and before the run launches, replacing whatever the router
 * predicted. A run that then fails to launch keeps this record, which is
 * correct: it says which backend was chosen, and the run's own failure says
 * the rest.
 *
 * Without this the two disagree in the strong form: the router stamps the
 * provider its candidate scoring chose, execution uses the Host's binding, and
 * usage attributes to the second while the Run row names the first. Clearing
 * the column for an unbound run matters just as much — a run on the machine's
 * own login must not name a provider at all.
 */
export async function recordRemoteRunBackend(
  db: Queryable,
  runId: string,
  used: { provider_id: string; model: string | null } | null,
  spaceId: string,
): Promise<void> {
  // Merge, never replace. `model_override_json` is the run's control blob, not
  // a model record: it also carries `execution_mode`, `chat_turn` and
  // `conversation_runtime`, and a Room conversation turn on a remote
  // Folder reaches this path. Overwriting the document would drop the keys
  // `finalizeChatTurn` reads after the run is re-read from the database, so
  // the agent's reply would never be written back and neither recovery sweep
  // — both filter on `model_override_json->'chat_turn'` — could find it.
  //
  // `source` is written even when no model resolved: it is the marker that
  // says this provider was used rather than predicted, and a `claude_code`
  // binding legitimately has no model.
  const patch: Record<string, unknown> = used
    ? { source: RUNTIME_PROFILE_MODEL_SOURCE, ...(used.model ? { model: used.model } : {}) }
    : {};
  await db.query(
    used
      ? `UPDATE runs SET model_provider_id = $2,
             model_override_json = COALESCE(model_override_json, '{}'::jsonb) || $3::jsonb,
             updated_at = now()
           WHERE id = $1 AND space_id = $4`
      // Unbound: drop only this path's own keys, leaving the rest of the blob
      // intact, and null the column out entirely if nothing else was in it.
      : `UPDATE runs SET model_provider_id = NULL,
             model_override_json = NULLIF(
               COALESCE(model_override_json, '{}'::jsonb) - 'model' - 'source',
               '{}'::jsonb
             ),
             updated_at = now()
           WHERE id = $1 AND space_id = $2`,
    used ? [runId, used.provider_id, JSON.stringify(patch), spaceId] : [runId, spaceId],
  );
}

export interface RemoteProviderBinding {
  frame: RemoteProviderBindingFrame;
  /** The model the lease was actually issued for, after every fallback. */
  used_model: string | null;
  revoke: () => void;
}

export class RemoteProviderBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteProviderBindingError";
  }
}

export interface ResolvedRemoteBinding {
  provider_id: string;
  model: string | null;
}

/**
 * The Run's frozen Runtime Profile snapshot is the only source of its backend.
 * A `model_provider` snapshot names the provider and the model; anything else
 * — a `runtime_native` Profile, or a snapshot without those fields — binds
 * nothing, and the runtime spends its execution Host's own login. There is no
 * dispatch-time provider override and no Host-wide default to fall back to:
 * `AgentRuntimeProfile` is the single deployment authority (ADR 0022).
 */
export async function resolveRemoteRunBinding(
  db: Queryable,
  run: { id: string; host_task_thread_id?: string | null },
): Promise<ResolvedRemoteBinding | null> {
  const dispatched = await db.query<{
    runtime_profile_snapshot_json: Record<string, unknown> | null;
  }>(
    `SELECT runtime_profile_snapshot_json
       FROM runs WHERE id = $1 LIMIT 1`,
    [run.id],
  );
  const row = dispatched.rows[0];
  const profile = row?.runtime_profile_snapshot_json ?? {};
  if (profile.backend_mode === "model_provider" && typeof profile.model_provider_id === "string") {
    return {
      provider_id: profile.model_provider_id,
      model: typeof profile.model_name === "string" ? profile.model_name : null,
    };
  }
  return null;
}

/**
 * Turns a resolved binding into a lease the host can use and the files its
 * runtime needs. The provider's real key is never part of this — the proxy
 * substitutes it inside the server process.
 */
export async function buildRemoteProviderBinding(input: {
  config: ServerConfig;
  run: AgentRunRecord;
  hostId: string;
  runtimeKey: string;
  binding: ResolvedRemoteBinding;
  scope: RuntimeProfileScope;
  ttlSeconds: number;
  leaseRegistry?: ProviderProxyLeaseRegistry;
  db: Queryable;
  /** The Run executor's policy seam; unset in production, where the policy service decides. */
  enforcer?: CredentialSpendDeps["enforcer"];
}): Promise<RemoteProviderBinding> {
  if (!adapterProviderApi(input.runtimeKey)) {
    throw new RemoteProviderBindingError(
      "adapter_provider_binding_unsupported",
      `Runtime adapter '${input.runtimeKey}' does not support a ModelProvider binding.`,
    );
  }

  const providers = resolveProvidersDbPort(input.config);
  if (!providers) {
    throw new RemoteProviderBindingError("providers_db_unavailable", "Provider database read port is unavailable.");
  }
  // `userId: null` matches the server-host runtime path and excludes
  // subscription providers, which have no key and no compatible base URL.
  const provider = await providers.getProvider(input.run.space_id, null, input.binding.provider_id);
  if (!provider || typeof provider !== "object") {
    throw new RemoteProviderBindingError(
      "model_provider_not_found",
      "The ModelProvider this run was bound to is no longer available in this Space.",
    );
  }
  const record = provider as Record<string, unknown>;
  // Which endpoint and route the binding uses can depend on the provider: a
  // runtime declaring `vendor` (OpenCode) speaks the bound vendor's own
  // protocol, so the requirement is resolved only once the provider is known.
  const requirement = adapterProviderRequirement(input.runtimeKey, stringValue(record.provider_type));
  if (!requirement) {
    throw new RemoteProviderBindingError(
      "provider_protocol_unsupported",
      `Runtime adapter '${input.runtimeKey}' cannot bind a ModelProvider of type '${stringValue(record.provider_type) ?? "unknown"}': `
        + "its vendor protocol is neither Anthropic Messages nor OpenAI-compatible.",
    );
  }
  const upstreamBaseUrl = stringValue(record[requirement.base_url_field]);
  if (!upstreamBaseUrl) {
    throw new RemoteProviderBindingError(
      requirement.missing_base_url_code,
      `The ModelProvider this run was bound to is not configured with ${requirement.base_url_label} URL.`,
    );
  }

  const providerName = stringValue(record.name) ?? "Rainver Provider";
  const availableModels = stringArray(record.available_models);
  const model = input.binding.model
    ?? stringValue(recordValue(input.run.model_override_json).model)
    ?? stringValue(record.default_model)
    ?? availableModels[0]
    ?? null;
  // Codex and OpenCode name a model in their config, and the server-host path
  // refuses without one rather than letting the runtime fall back to a
  // built-in default that the bound provider does not serve.
  if (!model && input.runtimeKey !== "claude_code") {
    throw new RemoteProviderBindingError(
      `${input.runtimeKey === "codex_cli" ? "codex" : "opencode"}_model_required`,
      `ModelProvider '${providerName}' must provide a model for '${input.runtimeKey}'.`,
    );
  }

  // Decided before the lease exists: a lease is what lets the proxy spend the
  // server-held key, so a Run the policy would not let spend must never hold
  // one. Decided on the Run's root and the live Automation grant, so a grant
  // revoked while the Run was queued stops it here.
  let authorization: CredentialSpendAuthorization;
  try {
    authorization = await authorizeCredentialSpend(
      input.config,
      { space_id: input.run.space_id, provider_id: input.binding.provider_id, basis: { kind: "run", run: input.run } },
      { db: input.db, enforcer: input.enforcer },
    );
  } catch (error) {
    if (error instanceof CredentialSpendDeniedError) {
      throw new RemoteProviderBindingError(error.code, error.message);
    }
    throw error;
  }

  const registry = input.leaseRegistry ?? providerProxyLeases;
  const lease = registry.create(authorization, {
    run_id: input.run.id,
    space_id: input.run.space_id,
    provider_id: input.binding.provider_id,
    provider_type: stringValue(record.provider_type),
    provider_name_snapshot: providerName,
    network_profile_id: stringValue(record.network_profile_id),
    route: requirement.route,
    upstream_base_url: upstreamBaseUrl,
    model,
    runtime_key: input.runtimeKey,
    session_id: input.run.session_id,
    parent_run_id: input.run.parent_run_id ?? null,
    root_run_id: input.run.root_run_id ?? null,
    run_group_id: input.run.run_group_id ?? null,
    agent_id: input.run.agent_id,
    project_id: input.run.project_id,
    project_folder_id: input.run.project_folder_id,
    trigger_origin: input.run.trigger_origin ?? null,
    host_id: input.hostId,
    ttl_ms: Math.max(input.ttlSeconds, 1) * 1000,
  });

  const leaseUrl = await resolveHostLeaseUrl({
    db: input.db,
    config: input.config,
    hostId: input.hostId,
    route: requirement.route,
    leaseId: lease.id,
  });
  if (!leaseUrl) {
    registry.revoke(lease.id);
    throw new RemoteProviderBindingError(
      "provider_proxy_not_reachable",
      "No provider proxy address this host can reach. The built-in host needs the proxy listener "
        + "running. A paired host needs its proxy address set in the Command Center, "
        + "PROVIDER_PROXY_EXTERNAL_BASE_URL for the whole instance, or an http: FRONTEND_URL with a "
        + "fixed PROVIDER_PROXY_PORT to derive one from.",
    );
  }

  try {
    return {
      frame: bindingFrame({
        runtimeKey: input.runtimeKey,
        providerId: input.binding.provider_id,
        scope: input.scope,
        leaseUrl,
        leaseToken: lease.token,
        model,
        providerName,
        availableModels,
        route: requirement.route,
      }),
      used_model: model,
      revoke: () => registry.revoke(lease.id),
    };
  } catch (error) {
    registry.revoke(lease.id);
    throw error;
  }
}


/**
 * The bound model expressed in the runtime's own identifier space, ready to be
 * sent as ACP `session/set_config_option` — or null when ACP is not how that
 * runtime learns its model.
 *
 * The spaces genuinely differ, and each is defined by the config this module
 * writes, which is why the translation lives here rather than in the protocol
 * controller:
 *
 * - **OpenCode** addresses a model as `<providerId>/<model>`; a bound run's
 *   provider id is the one `applyOpenCodeProviderConfig` declares. The bare
 *   name names no provider OpenCode knows.
 * - **Codex** resolves against the model catalog the binding writes, whose
 *   entries are keyed by the provider's own model name.
 * - **Claude** does not participate. Its model comes from `ANTHROPIC_MODEL`
 *   and the three `ANTHROPIC_DEFAULT_*` variables the binding sets, which
 *   between them decide it completely. ACP's model options are Claude's *own*
 *   alias space (`default`, `sonnet`, `opus`, …), and a third-party provider's
 *   model name exists nowhere in it — so the controller's reconciliation
 *   necessarily falls through to the session's current value. On a fresh
 *   session that is `default`, which carries no information; on a **resumed**
 *   one it is the model the previous turn used, so asking for a new model
 *   would re-assert the old one and the run would silently continue on it
 *   while every record said otherwise. Saying nothing leaves the env in sole
 *   charge, which is where the answer already is.
 *
 * Null also when a bound provider named no model at all.
 */
export function boundAcpModelId(
  runtimeKey: VendorCliRuntimeKey,
  model: string | null,
): string | null {
  if (!model || runtimeKey === "claude_code") return null;
  if (runtimeKey === "opencode") return openCodeModelId(model);
  return model;
}

function bindingFrame(input: {
  runtimeKey: string;
  providerId: string;
  scope: RuntimeProfileScope;
  leaseUrl: string;
  leaseToken: string;
  model: string | null;
  providerName: string;
  availableModels: string[];
  route: ProviderProxyRoute;
}): RemoteProviderBindingFrame {
  // Every segment is already constrained — the adapter type comes from the
  // runtime-adapter catalog, the ids are generated identifiers — and the
  // daemon validates the shape again before it builds a path from it.
  const profile_key = runtimeProfileKey(input.scope, input.runtimeKey, input.providerId);
  // A bound run reaches its backend through the lease this frame carries, so
  // it needs no login and gets no link: linking one in would put the machine's
  // subscription credential inside a profile that is not using it. B67 applies
  // in full, which is what `credential_source` tells the daemon.
  const login_link = null;
  const credential_source = "provider_lease" as const;
  if (input.runtimeKey === "claude_code") {
    // Claude has no binding-supplied config file; what it needs is an empty
    // profile so this machine's own login is not visible, plus the endpoint.
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: input.leaseUrl,
      ANTHROPIC_AUTH_TOKEN: input.leaseToken,
    };
    if (input.model) {
      env.ANTHROPIC_MODEL = input.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = input.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = input.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.model;
    }
    return { profile_key, env, profile_env: { HOME: ".", CLAUDE_CONFIG_DIR: ".claude" }, files: [], credential_source, login_link };
  }

  const model = input.model!;
  if (input.runtimeKey === "codex_cli") {
    const catalogRelative = ".codex/model-catalogs/rainver-provider.json";
    return {
      profile_key,
      env: {},
      profile_env: { HOME: ".", CODEX_HOME: ".codex" },
      credential_source,
      login_link,
      files: [
        {
          relative_path: catalogRelative,
          contents: JSON.stringify(codexModelCatalog(input.providerName, model, input.availableModels), null, 2),
        },
        {
          relative_path: ".codex/config.toml",
          // The catalog path must be absolute on the executing machine and
          // only the daemon knows the profile root, so it is a placeholder —
          // substituted **after** TOML escaping, since a Windows profile root
          // (`C:\\Users\\…`) inside a quoted string has to be escaped as a
          // path, not as the literal placeholder text.
          contents: renderCodexProviderToml({
            providerName: input.providerName,
            proxyBaseUrl: input.leaseUrl,
            leaseToken: input.leaseToken,
            model,
            catalogPath: `${PROFILE_ROOT_PLACEHOLDER}/${catalogRelative}`,
          }),
          escape: "toml_basic_string",
        },
      ],
    };
  }

  const document: Record<string, unknown> = {};
  applyOpenCodeProviderConfig(document, {
    route: input.route,
    providerName: input.providerName,
    proxyBaseUrl: input.leaseUrl,
    leaseToken: input.leaseToken,
    model,
    availableModels: input.availableModels,
  });
  document.model = openCodeModelId(model);
  return {
    profile_key,
    env: {},
    profile_env: { HOME: ".", OPENCODE_CONFIG: "opencode.json" },
    credential_source,
    login_link,
    files: [{ relative_path: "opencode.json", contents: JSON.stringify(document, null, 2) }],
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}
