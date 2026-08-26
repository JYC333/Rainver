import type { ModelProviderOut } from '../../api/client'
import type { HostRuntimeAdapterOption, RuntimeOptionChoice } from '../../types/api'

/** The composer's value for "run this on the machine's own login". */
export const AMBIENT_BACKEND = ''
/** The composer's value for "whatever this thread already runs on". */
export const INHERIT_BACKEND = 'inherit'

/**
 * Which providers can back a runtime adapter, for the host-default
 * selector. The rule's inputs come from the server: the adapter's
 * `provider_api` (declared once in its spec) and whether it takes a
 * provider at all. The server re-checks at dispatch, so this is about not
 * offering a choice that would be rejected, not about enforcement.
 */
export function eligibleProviders(
  providers: ModelProviderOut[],
  adapter: Pick<HostRuntimeAdapterOption, 'provider_api' | 'provider_binding'>,
): ModelProviderOut[] {
  if (adapter.provider_binding === false || !adapter.provider_api) return []
  const field = `${adapter.provider_api}_base_url` as const
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

/**
 * How a choice should read: the runtime's own display name, which is better
 * than anything derived from the id — it calls `claude-fable-5[1m]` "Fable",
 * where trimming the id would only reach `claude-fable-5`.
 *
 * A `default` entry is the exception worth spelling out: on its own it names
 * no model at all, and what it resolves to is in its description. So the model
 * goes in brackets after the name, because "Default" alone does not answer
 * which model is about to run.
 */
export function choiceLabel(choice: RuntimeOptionChoice): string {
  const name = choice.name?.trim() || choice.value
  if (!choice.description?.trim()) return name
  const resolvesToSomethingElse = choice.value === 'default'
  if (!resolvesToSomethingElse) return name
  // "Default (recommended)" already carries a parenthetical; keep one pair.
  const base = name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name
  return `${base} (${choice.description.trim()})`
}
