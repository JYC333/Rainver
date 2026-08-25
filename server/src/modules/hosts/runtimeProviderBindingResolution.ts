import { HttpError, type Queryable } from "../routeUtils/common";
import { adapterProviderRequirement } from "../runs/runtimeProviderBinding";
import { PgHostRuntimeProviderBindingRepository } from "./runtimeProviderBindingRepository";

/**
 * The ModelProvider a remote dispatch will run against, resolved and validated
 * at dispatch time.
 *
 * `provider_id: null` means the run uses the executing machine's own ambient
 * login state — the pre-existing behavior and the default.
 */
export interface ResolvedHostProviderBinding {
  provider_id: string | null;
  model: string | null;
}

export interface HostProviderBindingOverride {
  /**
   * Where the provider in this override came from, for the failure message
   * only. A thread-inherited provider is an override as far as resolution is
   * concerned — it must be validated exactly like an explicit one — but the
   * user did not name it in this request.
   */
  provenance?: ProviderProvenance;
  /**
   * Explicit per-dispatch provider, as it arrived on the request. Typed
   * `unknown` rather than `string | null` so resolution can reject a malformed
   * value instead of a caller coercing it to null on the way in — that
   * coercion is what would turn a typo into a silent ambient-login run.
   */
  model_provider_id?: unknown;
  model?: string | null;
}

export interface ProviderLookupPort {
  getProvider(spaceId: string, userId: string | null, providerId: string): Promise<unknown | null>;
}

/**
 * Precedence: an explicit per-dispatch provider wins; otherwise the Host ×
 * adapter default; otherwise none.
 *
 * Three request shapes, all distinct:
 * - neither key present → the Host default (or ambient login if it has none);
 * - `model_provider_id: null` → a real choice, "ignore the host default, use
 *   ambient login for this one dispatch", which is why presence is read by key
 *   rather than by truthiness;
 * - `model` alone → keep the resolved provider, narrow only the model.
 *
 * A present-but-unusable `model_provider_id` (empty string, wrong type) is
 * rejected rather than coerced to ambient login: the caller asked for a
 * provider, and quietly running on someone's machine login instead is the
 * failure this whole path exists to prevent.
 */
export async function resolveHostProviderBinding(input: {
  db: Queryable;
  providers: ProviderLookupPort | null;
  spaceId: string;
  hostId: string;
  adapterType: string;
  override: HostProviderBindingOverride;
  overrideProvided: boolean;
  modelOverrideProvided?: boolean;
}): Promise<ResolvedHostProviderBinding> {
  let selected: ResolvedHostProviderBinding;
  if (input.overrideProvided) {
    const requested = input.override.model_provider_id;
    const usable = requested === null || requested === undefined
      ? null
      : typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
    if (usable === undefined) {
      throw new HttpError(422, "model_provider_id must be a ModelProvider id, or null for the machine's own login");
    }
    selected = { provider_id: usable, model: input.override.model ?? null };
  } else {
    selected = await hostDefault(input.db, input.hostId, input.adapterType);
    if (input.modelOverrideProvided) selected = { ...selected, model: input.override.model ?? null };
  }

  if (!selected.provider_id) return { provider_id: null, model: null };

  const provider = await assertProviderUsable({
    providers: input.providers,
    spaceId: input.spaceId,
    adapterType: input.adapterType,
    providerId: selected.provider_id,
    // Names the cause when the failing provider is the host's stored default
    // rather than something this request asked for — otherwise a provider
    // removed months ago reads as an unexplained dispatch failure. Removal is
    // a soft delete, so the binding row outlives the provider.
    provenance: input.overrideProvided
      ? input.override.provenance ?? "request"
      : "host_default",
  });
  // Resolve "the provider's default" to the model it means *now*. The message
  // this is stamped on is what a later message inherits, and a null there
  // would be re-read against the provider's `default_model` every time — so
  // editing that field would move the model of every thread that never named
  // one, which is the same drift the thread-level inheritance exists to stop,
  // one level down. It also makes the message the authority the conversation
  // view reads for what a turn ran on.
  return selected.model
    ? selected
    : { ...selected, model: defaultModelOf(provider) };
}

async function hostDefault(
  db: Queryable,
  hostId: string,
  adapterType: string,
): Promise<ResolvedHostProviderBinding> {
  const binding = await new PgHostRuntimeProviderBindingRepository(db).get(hostId, adapterType);
  if (!binding) return { provider_id: null, model: null };
  return { provider_id: binding.model_provider_id, model: binding.model };
}

/**
 * Fails the request rather than the run: this turns "the run failed on
 * someone's laptop" into a 422 the sender is still waiting on.
 *
 * It is not full parity with execution. `buildRuntimeProviderBinding` re-checks
 * these same conditions and additionally needs a resolvable credential and
 * lease, so a provider with a compatible base URL and no usable API key still
 * passes here and fails at run time. The port does expose `has_api_key`, so
 * checking it here is possible; it is left out because a provider's credential
 * pool can be healthy at dispatch and exhausted by the time the run starts, so
 * the check would narrow the window without closing it.
 *
 * `userId` is deliberately `null`, matching the runtime path: that excludes
 * `subscription_oauth` providers, which have no API key and no compatible base
 * URL and can never back a CLI binding.
 */
export type ProviderProvenance = "request" | "host_default" | "thread";

function defaultModelOf(provider: Record<string, unknown>): string | null {
  const named = provider.default_model;
  if (typeof named === "string" && named.trim()) return named.trim();
  const available = provider.available_models;
  const first = Array.isArray(available) ? available[0] : null;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

export async function assertProviderUsable(input: {
  providers: ProviderLookupPort | null;
  spaceId: string;
  adapterType: string;
  providerId: string;
  provenance?: ProviderProvenance;
}): Promise<Record<string, unknown>> {
  // Three provenances, three remedies. Telling a user to change the host's
  // backend is wrong for a thread-inherited provider — a thread no longer
  // follows that default, so the suggested fix is the one thing that cannot
  // work.
  const subject = input.provenance === "host_default"
    ? "This host's configured model backend"
    : input.provenance === "thread"
      ? "The model backend this conversation has been running on"
      : "ModelProvider";
  const remedy = input.provenance === "host_default"
    ? "Choose another backend for this host."
    : "Choose another backend for this message.";
  const requirement = adapterProviderRequirement(input.adapterType);
  if (!requirement) {
    throw new HttpError(422, `Runtime adapter '${input.adapterType}' does not support a ModelProvider binding`);
  }
  if (!input.providers) {
    throw new HttpError(503, "Provider database read port is unavailable");
  }
  const provider = await input.providers.getProvider(input.spaceId, null, input.providerId);
  if (!provider || typeof provider !== "object") {
    throw new HttpError(422, `${subject} is not available in this Space — it may have been removed. ${remedy}`);
  }
  const baseUrl = (provider as Record<string, unknown>)[requirement.base_url_field];
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new HttpError(
      422,
      `${subject} is not configured with ${requirement.base_url_label} URL, which '${input.adapterType}' requires. ${remedy}`,
    );
  }
  return provider as Record<string, unknown>;
}
