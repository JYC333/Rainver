import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { resolveProvidersDbPort } from "../providers/dbReader.js";
import {
  providerProxyLeases,
  type ProviderProxyLeaseRegistry,
} from "../providers/proxy/lease.js";
import { adapterProviderRequirement } from "./runtimeProviderBinding.js";
import { resolveHostLeaseUrl } from "./hostProviderProxyAddress.js";
import { codexModelCatalog, renderCodexProviderToml } from "./codexProviderConfig.js";
import { applyOpenCodeProviderConfig, openCodeModelId } from "./opencodeProviderConfig.js";
import { PgHostRuntimeProviderBindingRepository } from "../hosts/runtimeProviderBindingRepository.js";
import type { RunRecord } from "./repository.js";
import type { VendorCliAdapterType } from "./vendorCliAdapter.js";

/**
 * What the executing host is told. Deliberately runtime-agnostic: the daemon
 * creates a directory, writes these bytes, and reports the paths back as
 * environment. Every Codex-TOML or OpenCode-JSON decision stays here, next to
 * the server-host path that already makes it — one implementation, not two
 * that drift.
 */
export interface RemoteProviderBindingFrame {
  /**
   * Which profile directory on the executing machine this run's runtime uses,
   * as `<adapter_type>/<provider_id>`.
   *
   * The scope is deliberately *not* the run. A CLI's conversation state lives
   * inside the profile — Claude Code keeps its session transcripts under
   * `CLAUDE_CONFIG_DIR` — so a per-run profile is deleted along with the
   * session the next turn is about to resume, and every turn after the first
   * fails with the runtime reporting no such conversation. Keying by adapter
   * and provider keeps a conversation resumable for as long as its backend
   * does not change, and makes changing the backend start a fresh session
   * rather than resume one whose context another vendor's model produced.
   */
  profile_key: string;
  env: Record<string, string>;
  profile_env: Record<string, string>;
  /**
   * `contents` may contain `PROFILE_ROOT_PLACEHOLDER`, which the daemon
   * replaces with the absolute profile directory — Codex's `config.toml` needs
   * an absolute path to its own model catalog, and only the executing machine
   * knows where that is. `escape` says how to encode the substituted path for
   * the file's own syntax: a Windows root inside a TOML basic string would
   * otherwise produce invalid escapes.
   */
  files: Array<{ relative_path: string; contents: string; escape?: "toml_basic_string" }>;
}

export const PROFILE_ROOT_PLACEHOLDER = "{{RAINVER_RUN_PROFILE}}";

/**
 * `model_override_json.source` written when the remote path actually bound a
 * run to a provider. It is the marker that separates a provider the router
 * predicted from one the run actually used — for a remote run those are
 * different questions with different answers.
 */
export const HOST_BINDING_MODEL_SOURCE = "host_binding";

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
  // `conversation_runtime`, and a Room conversation turn on a remote-preferred
  // Folder reaches this path. Overwriting the document would drop the keys
  // `finalizeChatTurn` reads after the run is re-read from the database, so
  // the agent's reply would never be written back and neither recovery sweep
  // — both filter on `model_override_json->'chat_turn'` — could find it.
  //
  // `source` is written even when no model resolved: it is the marker that
  // says this provider was used rather than predicted, and a `claude_code`
  // binding legitimately has no model.
  const patch: Record<string, unknown> = used
    ? { source: HOST_BINDING_MODEL_SOURCE, ...(used.model ? { model: used.model } : {}) }
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
  /**
   * Where the choice came from, which decides what happens when it turns out
   * to be unusable. `dispatch` was asked for explicitly and validated in the
   * dispatching Space, so failing it is right. `host_default` was never asked
   * for by this run — a Host is user-scoped and can back Locations in several
   * Spaces, so its default may name a provider granted in a different one.
   * Failing there would turn runs that used to work into hard errors.
   */
  origin: "dispatch" | "host_default";
}

/**
 * The backend this remote Run was bound to.
 *
 * A thread-dispatched Run carries the choice its dispatch resolved and
 * validated, snapshotted on the message. Anything else — an Automation, Room
 * root run, Plan or Workflow node, evolution run whose Folder prefers a remote
 * Location — never went through dispatch, so it falls back to the Host ×
 * adapter default, which is what the user configured for that machine.
 *
 * Deliberately never `runs.model_provider_id`: the router stamps that column
 * for any routed run before host kind is resolved, so it can name a provider
 * the run never used.
 */
export async function resolveRemoteRunBinding(
  db: Queryable,
  run: { id: string; host_task_thread_id?: string | null },
  hostId: string,
  adapterType: string,
): Promise<ResolvedRemoteBinding | null> {
  // Room host-bound specialists deliberately use only the vendor runtime's
  // own host login. Their rendered Room prompt is the only control-plane
  // context allowed across the boundary; a Room thread must never inherit a
  // Host × adapter ModelProvider default or mint a proxy lease.
  const roomThread = await db.query<{ room_id: string | null }>(
    `SELECT room_id FROM host_threads WHERE id = $1 AND room_id IS NOT NULL LIMIT 1`,
    [run.host_task_thread_id ?? null],
  );
  if (roomThread.rows[0]?.room_id) return null;
  const message = await db.query<{ model_provider_id: string | null; model: string | null }>(
    `SELECT model_provider_id, model FROM host_thread_messages WHERE run_id = $1 LIMIT 1`,
    [run.id],
  );
  const row = message.rows[0];
  if (row) {
    // A dispatched message is authoritative, including when it deliberately
    // chose ambient login by overriding the host default away.
    return row.model_provider_id
      ? { provider_id: row.model_provider_id, model: row.model, origin: "dispatch" }
      : null;
  }

  const fallback = await new PgHostRuntimeProviderBindingRepository(db).get(hostId, adapterType);
  return fallback
    ? { provider_id: fallback.model_provider_id, model: fallback.model, origin: "host_default" }
    : null;
}

/**
 * Turns a resolved binding into a lease the host can use and the files its
 * runtime needs. The provider's real key is never part of this — the proxy
 * substitutes it inside the server process.
 */
export async function buildRemoteProviderBinding(input: {
  config: ServerConfig;
  run: RunRecord;
  hostId: string;
  adapterType: string;
  binding: ResolvedRemoteBinding;
  ttlSeconds: number;
  leaseRegistry?: ProviderProxyLeaseRegistry;
  db: Queryable;
}): Promise<RemoteProviderBinding> {
  const requirement = adapterProviderRequirement(input.adapterType);
  if (!requirement) {
    throw new RemoteProviderBindingError(
      "adapter_provider_binding_unsupported",
      `Runtime adapter '${input.adapterType}' does not support a ModelProvider binding.`,
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
  if (!model && input.adapterType !== "claude_code") {
    throw new RemoteProviderBindingError(
      `${input.adapterType === "codex_cli" ? "codex" : "opencode"}_model_required`,
      `ModelProvider '${providerName}' must provide a model for '${input.adapterType}'.`,
    );
  }

  const registry = input.leaseRegistry ?? providerProxyLeases;
  const lease = registry.create({
    run_id: input.run.id,
    space_id: input.run.space_id,
    provider_id: input.binding.provider_id,
    provider_type: stringValue(record.provider_type),
    provider_name_snapshot: providerName,
    network_profile_id: stringValue(record.network_profile_id),
    route: requirement.route,
    upstream_base_url: upstreamBaseUrl,
    model,
    adapter_type: input.adapterType,
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
    hostId: input.hostId,
    route: requirement.route,
    leaseId: lease.id,
    proxyPort: input.config.providerProxyPort,
  });
  if (!leaseUrl) {
    registry.revoke(lease.id);
    throw new RemoteProviderBindingError(
      "provider_proxy_not_reachable",
      "No provider proxy address this host can reach. The daemon has not reported the address it "
        + "connects to, so one cannot be derived — set this host's proxy address in the Command "
        + "Center, or PROVIDER_PROXY_EXTERNAL_BASE_URL for the whole instance.",
    );
  }

  try {
    return {
      frame: bindingFrame({
        adapterType: input.adapterType,
        providerId: input.binding.provider_id,
        leaseUrl,
        leaseToken: lease.token,
        model,
        providerName,
        availableModels,
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
  adapterType: VendorCliAdapterType,
  model: string | null,
): string | null {
  if (!model || adapterType === "claude_code") return null;
  if (adapterType === "opencode") return openCodeModelId(model);
  return model;
}

function bindingFrame(input: {
  adapterType: string;
  providerId: string;
  leaseUrl: string;
  leaseToken: string;
  model: string | null;
  providerName: string;
  availableModels: string[];
}): RemoteProviderBindingFrame {
  // Both halves are already constrained — the adapter type comes from the
  // runtime-adapter catalog and the provider id is a generated identifier —
  // and the daemon validates the shape again before it builds a path from it.
  const profile_key = `${input.adapterType}/${input.providerId}`;
  if (input.adapterType === "claude_code") {
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
    return { profile_key, env, profile_env: { HOME: ".", CLAUDE_CONFIG_DIR: ".claude" }, files: [] };
  }

  const model = input.model!;
  if (input.adapterType === "codex_cli") {
    const catalogRelative = ".codex/model-catalogs/rainver-provider.json";
    return {
      profile_key,
      env: {},
      profile_env: { HOME: ".", CODEX_HOME: ".codex" },
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
