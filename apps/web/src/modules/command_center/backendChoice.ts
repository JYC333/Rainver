import type { ModelProviderOut } from '../../api/client'

/** The composer's value for "run this on the machine's own login". */
export const AMBIENT_BACKEND = ''
/** The composer's value for "whatever this thread already runs on". */
export const INHERIT_BACKEND = 'inherit'

/**
 * Which providers can back a given runtime adapter. Mirrors the server's
 * `adapterProviderRequirement` — the server re-checks at dispatch, so this
 * filter is about not offering a choice that would be rejected, not about
 * enforcement.
 *
 * Shared by the host-default selector and the per-dispatch one. Two copies of
 * this rule would let the two surfaces offer different providers for the same
 * adapter, and the disagreement would only show up as a dispatch failing.
 */
export function eligibleProviders(
  providers: ModelProviderOut[],
  adapterType: string,
): ModelProviderOut[] {
  const field = adapterType === 'claude_code' ? 'claude_compatible_base_url' : 'openai_compatible_base_url'
  return providers.filter(p => (
    p.enabled
    && p.grant_enabled !== false
    // The server resolves a CLI binding's provider with no user id, which
    // excludes subscription-credentialed providers — they have no API key for
    // the proxy to present. Offering one here produced a dispatch rejected as
    // "not available in this Space", which reads as a permissions problem
    // rather than the kind-of-credential problem it is.
    && !p.has_subscription
    && Boolean(p[field])
  ))
}

/**
 * The models a provider offers, with its default first. `available_models` can
 * be empty — a provider that never reported a catalog still works, the runtime
 * just uses whatever the endpoint defaults to.
 */
export function providerModels(provider: ModelProviderOut | undefined): string[] {
  if (!provider) return []
  const listed = provider.available_models ?? []
  if (!provider.default_model) return listed
  return [provider.default_model, ...listed.filter(m => m !== provider.default_model)]
}

/**
 * How a resolved backend reads in the conversation: provider name, then model.
 *
 * `providers` is null until the list has loaded (or if loading it failed), and
 * that is deliberately not the same as an empty list. Without the distinction,
 * an unresolvable id reads as "Unavailable provider" either way — so a failed
 * fetch permanently labels every turn in the thread as running on a deleted
 * provider, and even a successful one flashes that label whenever the messages
 * arrive first. Null renders nothing; empty means the provider really is gone.
 */
export function backendLabel(
  providers: ModelProviderOut[] | null,
  providerId: string | null,
  model: string | null,
): string | null {
  if (!providerId) return model ? `This machine's login · ${model}` : "This machine's login"
  if (!providers) return null
  const provider = providers.find(p => p.id === providerId)
  // A provider removed after the message ran leaves the binding behind. Naming
  // the id is more useful than dropping the row, since that id is what the run
  // actually used.
  const name = provider?.name ?? `Unavailable provider (${providerId.slice(0, 8)})`
  return model ? `${name} · ${model}` : name
}
