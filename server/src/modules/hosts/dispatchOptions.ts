import type { Queryable } from "../routeUtils/common.js";
import { listRuntimeAdapterSpecs, getLocalCliRuntimeAdapterSpec } from "../runtimeAdapters/index.js";
import { adapterProviderRequirement } from "../runs/runtimeProviderBinding.js";
import { AMBIENT_BACKEND, DispatchOptionsSchema, INHERIT_BACKEND, OWN_INSTALLATION, type DispatchBackend, type DispatchOptions, type RuntimeOptionChoice } from "@rainver/protocol";
import { normalizeHostCapabilities } from "./capabilities.js";
import { PgHostRuntimeProviderBindingRepository } from "./runtimeProviderBindingRepository.js";
import { PgHostThreadRepository } from "./threadRepository.js";
import { PgHostThreadMessageRepository } from "./threadMessageRepository.js";

/**
 * What a dispatch to this host can choose from — the runtime copies it has
 * and, for the chosen copy, every backend with whether it is usable and
 * why not — decided here, where dispatch is validated, rather than
 * reconstructed in the browser from bindings, providers and capabilities.
 * The shape is the protocol's `DispatchOptions`; the composer renders it
 * and sends back what was picked.
 */
export type { DispatchBackend, DispatchOptions } from "@rainver/protocol";

/** The provider fields this decision reads; the read port's DTO carries more. */
interface ProviderView {
  id: string;
  name: string;
  enabled: boolean;
  grant_enabled: boolean;
  has_subscription: boolean;
  claude_compatible_base_url: string | null;
  openai_compatible_base_url: string | null;
  default_model: string | null;
  available_models: string[];
}

function providerView(raw: unknown): ProviderView | null {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!record || typeof record.id !== "string" || typeof record.name !== "string") return null;
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled === true,
    grant_enabled: record.grant_enabled !== false,
    has_subscription: record.has_subscription === true,
    claude_compatible_base_url: typeof record.claude_compatible_base_url === "string" ? record.claude_compatible_base_url : null,
    openai_compatible_base_url: typeof record.openai_compatible_base_url === "string" ? record.openai_compatible_base_url : null,
    default_model: typeof record.default_model === "string" ? record.default_model : null,
    available_models: Array.isArray(record.available_models) ? record.available_models.filter((m): m is string => typeof m === "string") : [],
  };
}

/**
 * The providers a runtime can be bound to: enabled, granted, with the base
 * URL that runtime speaks, and API-keyed — a subscription-credentialed
 * provider has nothing the proxy could present on a paired host.
 */
export function eligibleProviders(providers: ProviderView[], adapterType: string): ProviderView[] {
  const requirement = adapterProviderRequirement(adapterType);
  const spec = getLocalCliRuntimeAdapterSpec(adapterType);
  if (!requirement || spec?.invocation.remote_host_only) return [];
  return providers.filter((provider) =>
    provider.enabled
    && provider.grant_enabled
    && !provider.has_subscription
    && Boolean(provider[requirement.base_url_field as keyof ProviderView]));
}

function providerModels(provider: ProviderView): RuntimeOptionChoice[] {
  const listed = provider.available_models.filter((model) => model !== provider.default_model);
  return [...(provider.default_model ? [provider.default_model] : []), ...listed].map((value) => ({ value, name: null, description: null }));
}

/** How a runtime names a model it reports: its own display name, else the id. */
function choiceName(choices: RuntimeOptionChoice[], value: string | null): string | null {
  if (!value) return null;
  return choices.find((choice) => choice.value === value)?.name ?? value;
}

export async function dispatchOptions(input: {
  db: Queryable;
  providers: { listProviders(spaceId: string, userId: string): Promise<unknown[]> } | null;
  spaceId: string;
  userId: string;
  hostId: string;
  capabilities: unknown;
  adapterType: string | null;
  installation: string | null;
  threadId: string | null;
}): Promise<DispatchOptions> {
  const capabilities = normalizeHostCapabilities(input.capabilities);
  const adapters = listRuntimeAdapterSpecs()
    .map((spec) => getLocalCliRuntimeAdapterSpec(spec.adapter_type))
    .filter((spec): spec is NonNullable<typeof spec> =>
      Boolean(spec) && spec!.implementation_status === "implemented" && spec!.invocation.protocol === "acp")
    .map((spec) => ({
      adapter_type: spec.adapter_type,
      display_name: spec.display_name,
      installations: (capabilities.installations[spec.adapter_type] ?? []).map(({ id, version, logged_in }) => ({ id, version, logged_in })),
    }))
    .filter((adapter) => adapter.installations.length > 0);

  // A thread pins its runtime and copy; a new dispatch chooses, defaulting to
  // the machine's own copy where there is one.
  const thread = input.threadId ? await new PgHostThreadRepository(input.db).getTaskById(input.threadId) : null;
  const adapterType = thread?.adapter_type ?? input.adapterType ?? (adapters.length === 1 ? adapters[0]!.adapter_type : null);
  const copies = adapters.find((adapter) => adapter.adapter_type === adapterType)?.installations ?? [];
  const installation = thread?.runtime_installation
    ?? (input.installation && copies.some((copy) => copy.id === input.installation) ? input.installation : null)
    ?? (copies.some((copy) => copy.id === OWN_INSTALLATION) ? OWN_INSTALLATION : copies[0]?.id ?? null);
  const copy = capabilities.installations[adapterType ?? ""]?.find((entry) => entry.id === installation) ?? null;
  if (!adapterType || !copy) return DispatchOptionsSchema.parse({ adapters, adapter_type: adapterType, installation, backends: [] });

  const providers = input.providers
    ? (await input.providers.listProviders(input.spaceId, input.userId)).flatMap((raw) => { const view = providerView(raw); return view ? [view] : []; })
    : [];
  const eligible = eligibleProviders(providers, adapterType);
  const options = copy.options;
  const efforts = options?.efforts ?? [];
  const currentEffort = options?.current_effort ?? null;

  const ambientUsable = copy.logged_in !== false;
  const ambientModelName = choiceName(options?.models ?? [], options?.current_model ?? null);
  const ambient: DispatchBackend = {
    id: AMBIENT_BACKEND,
    label: ["This machine's login", ambientModelName, currentEffort].filter(Boolean).join(" · "),
    usable: ambientUsable,
    reason: ambientUsable ? null : `${installation === OWN_INSTALLATION ? "This machine's copy" : `The ${installation} copy`} is not logged in — log it in under Hosts, or use a provider.`,
    resolves_to: null,
    models: options?.models ?? [],
    current_model: options?.current_model ?? null,
    efforts,
    current_effort: currentEffort,
  };

  // What `inherit` stands for: the thread's last backend, else the host default.
  const inherited = thread
    ? await new PgHostThreadMessageRepository(input.db).currentBinding(thread.id)
    : null;
  const hostDefault = thread ? null : await new PgHostRuntimeProviderBindingRepository(input.db).get(input.hostId, adapterType);
  const inheritedProviderId = thread ? inherited?.provider_id ?? null : hostDefault?.model_provider_id ?? null;
  const inheritedModel = thread ? inherited?.model ?? null : hostDefault?.model ?? null;
  const inheritedProvider = inheritedProviderId ? eligible.find((provider) => provider.id === inheritedProviderId) ?? null : null;
  const inheritBase = thread ? "Keep this conversation's backend" : "This host's default";
  let inherit: DispatchBackend;
  if (inheritedProviderId && !inheritedProvider) {
    inherit = {
      id: INHERIT_BACKEND, label: `${inheritBase} · unavailable provider`, usable: false,
      reason: "The provider this would run on is no longer available in this Space.",
      resolves_to: inheritedProviderId, models: [], current_model: null, efforts, current_effort: currentEffort,
    };
  } else if (inheritedProvider) {
    const model = inheritedModel ?? inheritedProvider.default_model;
    inherit = {
      id: INHERIT_BACKEND, label: [inheritBase, inheritedProvider.name, model].filter(Boolean).join(" · "), usable: true, reason: null,
      resolves_to: inheritedProvider.id, models: providerModels(inheritedProvider), current_model: model, efforts, current_effort: currentEffort,
    };
  } else {
    inherit = {
      ...ambient,
      id: INHERIT_BACKEND,
      label: thread
        ? inheritBase
        : ["This host's default", "this machine's login", ambientModelName, currentEffort].filter(Boolean).join(" · "),
      resolves_to: AMBIENT_BACKEND,
      current_model: inheritedModel ?? ambient.current_model,
    };
  }

  const backends: DispatchBackend[] = [
    inherit,
    ambient,
    ...eligible.map((provider) => ({
      id: provider.id, label: provider.name, usable: true, reason: null, resolves_to: null,
      models: providerModels(provider), current_model: provider.default_model, efforts, current_effort: currentEffort,
    })),
  ];
  return DispatchOptionsSchema.parse({ adapters, adapter_type: adapterType, installation, backends });
}
