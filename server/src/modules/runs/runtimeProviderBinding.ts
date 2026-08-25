import type { ServerConfig } from "../../config";
import type { CredentialGrant } from "../providers/cli/credentialBroker";
import { resolveProvidersDbPort } from "../providers/dbReader";
import {
  providerProxyLeaseBaseUrl,
  providerProxyLeaseUrl,
  providerProxyLeases,
  type ProviderProxyLeaseRegistry,
  type ProviderProxyRoute,
} from "../providers/proxy/lease";
import type { LocalCliRuntimeAdapterSpec } from "../runtimeAdapters";
import { subscriptionEgressLeases, type SubscriptionRuntime } from "../providers/proxy/subscriptionEgress";
import type { RunRecord } from "./repository";
import type { InvocationAuditRefs } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  CodexProviderConfigError,
  materializeRunCodexHome,
  writeCodexProviderConfig,
} from "./codexProviderConfig";
import {
  OpenCodeProviderConfigError,
  writeOpenCodeProviderConfig,
} from "./opencodeProviderConfig";

export interface RuntimeProviderResolverPort {
  getProvider(
    spaceId: string,
    userId: string | null,
    providerId: string,
  ): Promise<unknown | null>;
}

export interface RuntimeProviderBinding {
  env: Record<string, string>;
  lease_id: string | null;
  lease_registry: ProviderProxyLeaseRegistry | null;
  model: string | null;
  provider_id: string | null;
  protocol: "anthropic" | "openai_responses" | "openai_chat_completions" | null;
  cleanup?: () => Promise<void>;
}

interface RuntimeProviderBindingInput {
  run: RunRecord;
  model: string | null;
  sandbox_cwd?: string | null;
  invocation_audit_refs?: InvocationAuditRefs | null;
}

export class RuntimeProviderBindingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProviderBindingError";
  }
}

export interface AdapterProviderRequirement {
  /** The `ModelProvider` field the adapter's binding reads for its upstream. */
  base_url_field: "claude_compatible_base_url" | "openai_compatible_base_url";
  missing_base_url_code: string;
/** Article included: "a Claude-compatible" / "an OpenAI-compatible". */
  base_url_label: string;
  route: ProviderProxyRoute;
}

/**
 * What makes a `ModelProvider` usable by a runtime adapter. Single source of
 * truth on purpose: dispatch-time validation
 * (`hosts/runtimeProviderBindingResolution.ts`) and the execution-time binding
 * construction below must agree, or a dispatch validates and then fails at run
 * time with an error nobody is waiting on.
 */
export function adapterProviderRequirement(adapterType: string): AdapterProviderRequirement | null {
  switch (adapterType) {
    case "claude_code":
      return {
        base_url_field: "claude_compatible_base_url",
        missing_base_url_code: "claude_compatible_base_url_required",
        base_url_label: "a Claude-compatible",
        route: "anthropic",
      };
    case "codex_cli":
    case "opencode":
      return {
        base_url_field: "openai_compatible_base_url",
        missing_base_url_code: "openai_compatible_base_url_required",
        base_url_label: "an OpenAI-compatible",
        route: "openai",
      };
    default:
      return null;
  }
}

function requireProviderBaseUrl(
  adapterType: string,
  providerId: string,
  provider: Record<string, unknown>,
): string {
  const requirement = adapterProviderRequirement(adapterType);
  if (!requirement) {
    throw new RuntimeProviderBindingError(
      "adapter_provider_binding_unsupported",
      `Runtime adapter '${adapterType}' does not support a ModelProvider binding.`,
    );
  }
  const baseUrl = stringValue(provider[requirement.base_url_field]);
  if (!baseUrl) {
    throw new RuntimeProviderBindingError(
      requirement.missing_base_url_code,
      `ModelProvider '${providerId}' is not configured with ${requirement.base_url_label} URL.`,
    );
  }
  return baseUrl;
}

export async function buildRuntimeProviderBinding(
  config: ServerConfig,
  input: RuntimeProviderBindingInput,
  spec: LocalCliRuntimeAdapterSpec,
  deps: {
    credential: CredentialGrant;
    providerResolver?: RuntimeProviderResolverPort;
    leaseRegistry?: ProviderProxyLeaseRegistry;
    proxyBaseUrl?: string;
    ttlSeconds: number;
  },
): Promise<RuntimeProviderBinding> {
  if (spec.adapter_type !== "claude_code" && spec.adapter_type !== "codex_cli" && spec.adapter_type !== "opencode") {
    return emptyRuntimeProviderBinding();
  }
  const providerId = input.run.model_provider_id;
  if (!providerId) {
    const base = spec.adapter_type === "codex_cli"
      ? await codexHomeOnlyBinding(deps.credential)
      : emptyRuntimeProviderBinding();
    if (!deps.credential.profile_id) return base;
    const lease = subscriptionEgressLeases.create(
      spec.adapter_type as SubscriptionRuntime,
      Math.max(deps.ttlSeconds, 1) * 1000,
    );
    return {
      ...base,
      env: {
        ...base.env,
        HTTP_PROXY: lease.proxy_url,
        HTTPS_PROXY: lease.proxy_url,
        http_proxy: lease.proxy_url,
        https_proxy: lease.proxy_url,
      },
      cleanup: async () => {
        subscriptionEgressLeases.revoke(lease.id);
        await base.cleanup?.();
      },
    };
  }

  const provider = await resolveRuntimeProvider(config, input.run, providerId, deps.providerResolver);
  if (spec.adapter_type === "claude_code") {
    return buildClaudeProviderBinding(input, providerId, provider, deps);
  }
  if (spec.adapter_type === "opencode") {
    return buildOpenCodeProviderBinding(input, providerId, provider, deps);
  }
  return buildCodexProviderBinding(input, providerId, provider, deps);
}

export async function cleanupRuntimeProviderBinding(binding: RuntimeProviderBinding): Promise<void> {
  if (binding.lease_id) binding.lease_registry?.revoke(binding.lease_id);
  await binding.cleanup?.();
}

async function resolveRuntimeProvider(
  config: ServerConfig,
  run: RunRecord,
  providerId: string,
  providerResolver?: RuntimeProviderResolverPort,
): Promise<Record<string, unknown>> {
  const resolver = providerResolver ?? resolveProvidersDbPort(config);
  if (!resolver) {
    throw new RuntimeProviderBindingError(
      "providers_db_unavailable",
      "Provider database read port is unavailable.",
    );
  }
  const provider = recordValue(await resolver.getProvider(run.space_id, null, providerId));
  if (Object.keys(provider).length === 0) {
    throw new RuntimeProviderBindingError(
      "model_provider_not_found",
      `ModelProvider '${providerId}' not found.`,
    );
  }
  return provider;
}

function buildClaudeProviderBinding(
  input: RuntimeProviderBindingInput,
  providerId: string,
  provider: Record<string, unknown>,
  deps: {
    leaseRegistry?: ProviderProxyLeaseRegistry;
    proxyBaseUrl?: string;
    ttlSeconds: number;
  },
): RuntimeProviderBinding {
  const baseUrl = requireProviderBaseUrl("claude_code", providerId, provider);

  const model =
    input.model ??
    modelFromRun(input.run) ??
    stringValue(provider.default_model) ??
    firstString(provider.available_models) ??
    null;
  const leaseRegistry = deps.leaseRegistry ?? providerProxyLeases;
  const lease = leaseRegistry.create({
    run_id: input.run.id,
    space_id: input.run.space_id,
    provider_id: providerId,
    provider_type: stringValue(provider.provider_type),
    provider_name_snapshot: stringValue(provider.name),
    network_profile_id: stringValue(provider.network_profile_id),
    route: "anthropic",
    upstream_base_url: baseUrl,
    model,
    adapter_type: input.run.adapter_type,
    session_id: input.run.session_id,
    parent_run_id: input.run.parent_run_id ?? null,
    root_run_id: input.run.root_run_id ?? null,
    run_group_id: input.run.run_group_id ?? null,
    agent_id: input.run.agent_id,
    project_id: input.run.project_id,
    project_folder_id: input.run.project_folder_id,
    trigger_origin: input.run.trigger_origin ?? null,
    invocation_audit_refs: input.invocation_audit_refs ?? null,
    ttl_ms: Math.max(deps.ttlSeconds, 1) * 1000,
  });
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: runtimeProviderProxyUrl("anthropic", lease.id, deps.proxyBaseUrl),
    ANTHROPIC_AUTH_TOKEN: lease.token,
  };
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  }
  return {
    env,
    lease_id: lease.id,
    lease_registry: leaseRegistry,
    model,
    provider_id: providerId,
    protocol: "anthropic",
  };
}

async function buildCodexProviderBinding(
  input: RuntimeProviderBindingInput,
  providerId: string,
  provider: Record<string, unknown>,
  deps: {
    credential: CredentialGrant;
    leaseRegistry?: ProviderProxyLeaseRegistry;
    proxyBaseUrl?: string;
    ttlSeconds: number;
  },
): Promise<RuntimeProviderBinding> {
  const baseUrl = requireProviderBaseUrl("codex_cli", providerId, provider);
  const model =
    input.model ??
    modelFromRun(input.run) ??
    stringValue(provider.default_model) ??
    firstString(provider.available_models) ??
    null;
  if (!model) {
    throw new RuntimeProviderBindingError(
      "codex_model_required",
      `ModelProvider '${providerId}' must provide a model for Codex CLI.`,
    );
  }

  const leaseRegistry = deps.leaseRegistry ?? providerProxyLeases;
  const lease = leaseRegistry.create({
    run_id: input.run.id,
    space_id: input.run.space_id,
    provider_id: providerId,
    provider_type: stringValue(provider.provider_type),
    provider_name_snapshot: stringValue(provider.name),
    network_profile_id: stringValue(provider.network_profile_id),
    route: "openai",
    upstream_base_url: baseUrl,
    model,
    adapter_type: input.run.adapter_type,
    session_id: input.run.session_id,
    parent_run_id: input.run.parent_run_id ?? null,
    root_run_id: input.run.root_run_id ?? null,
    run_group_id: input.run.run_group_id ?? null,
    agent_id: input.run.agent_id,
    project_id: input.run.project_id,
    project_folder_id: input.run.project_folder_id,
    trigger_origin: input.run.trigger_origin ?? null,
    invocation_audit_refs: input.invocation_audit_refs ?? null,
    ttl_ms: Math.max(deps.ttlSeconds, 1) * 1000,
  });
  let codexHome: string;
  try {
    codexHome = await writeCodexProviderConfig({
      tempHome: deps.credential.temp_home,
      providerName: stringValue(provider.name) ?? "Agent Space Provider",
      proxyBaseUrl: runtimeProviderProxyUrl("openai", lease.id, deps.proxyBaseUrl),
      leaseToken: lease.token,
      model,
      availableModels: stringArray(provider.available_models),
    });
  } catch (error) {
    leaseRegistry.revoke(lease.id);
    if (error instanceof CodexProviderConfigError) {
      throw new RuntimeProviderBindingError(error.code, error.message);
    }
    throw error;
  }

  return {
    env: { CODEX_HOME: codexHome },
    lease_id: lease.id,
    lease_registry: leaseRegistry,
    model,
    provider_id: providerId,
    protocol: "openai_responses",
  };
}

async function buildOpenCodeProviderBinding(
  input: RuntimeProviderBindingInput,
  providerId: string,
  provider: Record<string, unknown>,
  deps: {
    credential: CredentialGrant;
    leaseRegistry?: ProviderProxyLeaseRegistry;
    proxyBaseUrl?: string;
    ttlSeconds: number;
  },
): Promise<RuntimeProviderBinding> {
  const baseUrl = requireProviderBaseUrl("opencode", providerId, provider);
  const model =
    input.model ??
    modelFromRun(input.run) ??
    stringValue(provider.default_model) ??
    firstString(provider.available_models) ??
    null;
  if (!model) {
    throw new RuntimeProviderBindingError(
      "opencode_model_required",
      `ModelProvider '${providerId}' must provide a model for OpenCode.`,
    );
  }

  const leaseRegistry = deps.leaseRegistry ?? providerProxyLeases;
  const lease = leaseRegistry.create({
    run_id: input.run.id,
    space_id: input.run.space_id,
    provider_id: providerId,
    provider_type: stringValue(provider.provider_type),
    provider_name_snapshot: stringValue(provider.name),
    network_profile_id: stringValue(provider.network_profile_id),
    route: "openai",
    upstream_base_url: baseUrl,
    model,
    adapter_type: input.run.adapter_type,
    session_id: input.run.session_id,
    parent_run_id: input.run.parent_run_id ?? null,
    root_run_id: input.run.root_run_id ?? null,
    run_group_id: input.run.run_group_id ?? null,
    agent_id: input.run.agent_id,
    project_id: input.run.project_id,
    project_folder_id: input.run.project_folder_id,
    trigger_origin: input.run.trigger_origin ?? null,
    invocation_audit_refs: input.invocation_audit_refs ?? null,
    ttl_ms: Math.max(deps.ttlSeconds, 1) * 1000,
  });
  try {
    const config = await writeOpenCodeProviderConfig({
      sandboxCwd: input.sandbox_cwd ?? null,
      providerName: stringValue(provider.name) ?? "Agent Space Provider",
      proxyBaseUrl: runtimeProviderProxyUrl("openai", lease.id, deps.proxyBaseUrl),
      leaseToken: lease.token,
      model,
      availableModels: stringArray(provider.available_models),
    });
    return {
      env: {},
      lease_id: lease.id,
      lease_registry: leaseRegistry,
      model: config.model,
      provider_id: providerId,
      protocol: "openai_chat_completions",
      cleanup: config.restore,
    };
  } catch (error) {
    leaseRegistry.revoke(lease.id);
    if (error instanceof OpenCodeProviderConfigError) {
      throw new RuntimeProviderBindingError(error.code, error.message);
    }
    throw error;
  }
}

async function codexHomeOnlyBinding(credential: CredentialGrant): Promise<RuntimeProviderBinding> {
  const codexHome = credential.temp_home
    ? await materializeRunCodexHome(credential.temp_home)
    : null;
  return {
    env: codexHome ? { CODEX_HOME: codexHome } : {},
    lease_id: null,
    lease_registry: null,
    model: null,
    provider_id: null,
    protocol: null,
  };
}

function emptyRuntimeProviderBinding(): RuntimeProviderBinding {
  return {
    env: {},
    lease_id: null,
    lease_registry: null,
    model: null,
    provider_id: null,
    protocol: null,
  };
}

function runtimeProviderProxyUrl(
  route: ProviderProxyRoute,
  leaseId: string,
  proxyBaseUrl?: string,
): string {
  if (proxyBaseUrl) {
    return providerProxyLeaseUrl(proxyBaseUrl, route, leaseId);
  }
  return providerProxyLeaseBaseUrl(route, leaseId);
}

function modelFromRun(run: RunRecord): string | null {
  return stringValue(recordValue(run.model_override_json).model);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}
