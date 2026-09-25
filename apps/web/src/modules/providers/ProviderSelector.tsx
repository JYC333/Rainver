import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Plus } from 'lucide-react'
import { providersApi, type ModelProviderOut } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'

interface ProviderSelectorProps {
  value: { provider_id: string; model: string } | null
  onChange: (value: { provider_id: string; model: string } | null) => void
  /** When true, a provider must be chosen (no "System default" option) and an empty
   *  state nudges the user to define one. */
  required?: boolean
  requireClaudeCompatible?: boolean
  requireOpenAiCompatible?: boolean
  /** The runtime follows each provider's vendor protocol (`provider_api: 'vendor'`, OpenCode):
   *  an Anthropic-protocol vendor needs its Claude-compatible URL, an OpenAI-protocol vendor its
   *  OpenAI-compatible URL, and any other protocol cannot be bound. */
  requireVendorCompatible?: boolean
  providerFilter?: (provider: ModelProviderOut) => string | null
  defaultModelForProvider?: (provider: ModelProviderOut) => string | null | undefined
  disabled?: boolean
  emptyLabel?: string
}

function ManageProvidersLink({ label = 'Manage providers' }: { label?: string }) {
  return (
    <Link
      to="/providers"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      <Plus className="size-3" /> {label}
    </Link>
  )
}

export default function ProviderSelector({
  value,
  onChange,
  required = false,
  requireClaudeCompatible = false,
  requireOpenAiCompatible = false,
  requireVendorCompatible = false,
  providerFilter,
  defaultModelForProvider,
  disabled = false,
  emptyLabel,
}: ProviderSelectorProps) {
  const [providers, setProviders] = useState<ModelProviderOut[]>([])
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  const loadProviders = useCallback(() => {
    setLoading(true)
    providersApi.list()
      .then(list => setProviders(list.filter(p => p.enabled)))
      .catch(() => setProviders([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadProviders() }, [loadProviders])

  // Vendor → protocol, read from the server's registry rather than guessed here.
  // Null until loaded (or when not needed): nothing is blocked on a lookup that has not answered.
  const [vendorProtocols, setVendorProtocols] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    if (!requireVendorCompatible) { setVendorProtocols(null); return }
    let cancelled = false
    providersApi.vendors()
      .then(vendors => { if (!cancelled) setVendorProtocols(new Map(vendors.map(v => [v.id, v.protocol]))) })
      .catch(() => { if (!cancelled) setVendorProtocols(null) })
    return () => { cancelled = true }
  }, [requireVendorCompatible])

  const incompatibleReason = useCallback((provider: ModelProviderOut): string | null => {
    if (requireClaudeCompatible && !provider.claude_compatible_base_url) {
      return 'no Claude-compatible URL'
    }
    if (requireOpenAiCompatible && !provider.openai_compatible_base_url) {
      return 'no OpenAI-compatible URL'
    }
    if (requireVendorCompatible && vendorProtocols) {
      const protocol = vendorProtocols.get(provider.provider_type)
      if (protocol === 'anthropic_messages') {
        if (!provider.claude_compatible_base_url) return 'no Claude-compatible URL'
      } else if (protocol === 'openai_completions') {
        if (!provider.openai_compatible_base_url) return 'no OpenAI-compatible URL'
      } else {
        return 'protocol not supported by this runtime'
      }
    }
    const customReason = providerFilter?.(provider) ?? null
    if (customReason) return customReason
    return null
  }, [providerFilter, requireClaudeCompatible, requireOpenAiCompatible, requireVendorCompatible, vendorProtocols])

  const isSelectable = useCallback((provider: ModelProviderOut) => (
    incompatibleReason(provider) === null
  ), [incompatibleReason])

  useEffect(() => {
    if (!value?.provider_id) return
    const selected = providers.find(p => p.id === value.provider_id)
    if (selected && !isSelectable(selected)) onChange(null)
  }, [isSelectable, onChange, providers, value?.provider_id])

  useEffect(() => {
    if (!value?.provider_id) { setModels([]); return }
    providersApi.models(value.provider_id)
      .then(r => setModels(r.models))
      .catch(() => {
        const p = providers.find(x => x.id === value.provider_id)
        setModels(p?.available_models ?? (p?.default_model ? [p.default_model] : []))
      })
  }, [value?.provider_id, providers])

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading providers…</p>
  }

  const hasSelectableProvider = providers.some(isSelectable)

  if (providers.length === 0 || (required && !hasSelectableProvider)) {
    return (
      <div className="space-y-2 p-3 rounded-md border border-dashed border-border text-sm">
        <p className="text-muted-foreground">
          {providers.length === 0
            ? `No enabled model providers yet.${required ? ' One is required for this runtime.' : ''}`
            : 'No selectable model providers for this runtime.'}
        </p>
        <div className="flex items-center gap-3">
          <Link
            to="/providers"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
          >
            <Plus className="size-3.5" /> Define a provider
          </Link>
          <button type="button" onClick={loadProviders} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <RefreshCw className="size-3" /> Refresh
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Model provider</label>
          <div className="flex items-center gap-3">
            <button type="button" onClick={loadProviders} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <RefreshCw className="size-3" /> Refresh
            </button>
            {!disabled && <ManageProvidersLink label="Add" />}
          </div>
        </div>
        <select
          disabled={disabled}
          value={value?.provider_id ?? ''}
          onChange={e => {
            const id = e.target.value
            if (!id) { onChange(null); return }
            const p = providers.find(x => x.id === id)
            onChange({
              provider_id: id,
              model: p ? (defaultModelForProvider?.(p) ?? p.default_model ?? '') : '',
            })
          }}
          className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="" disabled={required}>{emptyLabel ?? (required ? 'Select a provider…' : 'System default')}</option>
          {providers.map(p => {
            const reason = incompatibleReason(p)
            return (
              <option key={p.id} value={p.id} disabled={reason !== null}>
                {p.name} ({p.provider_type}){reason ? ` — ${reason}` : ''}
              </option>
            )
          })}
        </select>
        {required && !value?.provider_id && (
          <p className="text-xs text-amber-600">This runtime requires a model provider. Not seeing the right one? <ManageProvidersLink label="Add a provider" /></p>
        )}
      </div>
      {value?.provider_id && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Model</label>
          {models.length > 0 ? (
            <select
              disabled={disabled}
              value={value.model}
              onChange={e => onChange({ ...value, model: e.target.value })}
              className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm font-mono disabled:cursor-not-allowed disabled:opacity-60"
            >
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input
              disabled={disabled}
              value={value.model}
              onChange={e => onChange({ ...value, model: e.target.value })}
              placeholder="model name"
              className="flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm font-mono disabled:cursor-not-allowed disabled:opacity-60"
            />
          )}
        </div>
      )}
    </div>
  )
}
