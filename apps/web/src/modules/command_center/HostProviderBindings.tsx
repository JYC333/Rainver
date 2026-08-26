import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { hostsApi, type ModelProviderOut } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { HostRuntimeAdapterOption, HostRuntimeProviderBinding } from '../../types/api'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'

import { AMBIENT_BACKEND as AMBIENT, eligibleProviders } from './backendChoice'

/**
 * Per-adapter model backend for one execution host. Absence of a binding is a
 * real, common answer — "use whatever this machine is logged into" — so it is
 * the first option rather than an empty state.
 *
 * `providers` is passed in rather than fetched here: one panel renders many
 * host cards, and the provider list is identical for all of them.
 */
export default function HostProviderBindings({
  hostId,
  runtimeAdapters,
  installedProbes,
  providers,
}: {
  hostId: string
  runtimeAdapters: HostRuntimeAdapterOption[]
  installedProbes: string[]
  providers: ModelProviderOut[]
}) {
  const [bindings, setBindings] = useState<HostRuntimeProviderBinding[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  // Only adapters this host actually reports as installed: a backend choice
  // for a runtime the machine does not have is noise.
  const adapters = useMemo(
    () => runtimeAdapters.filter(a => a.remote_eligible && installedProbes.includes(a.capability_probe)),
    [runtimeAdapters, installedProbes],
  )

  useEffect(() => {
    if (adapters.length === 0) return
    let cancelled = false
    hostsApi.listProviderBindings(hostId)
      .then(result => { if (!cancelled) setBindings(result.items) })
      .catch(error => { if (!cancelled) toast.error(errMsg(error)) })
    return () => { cancelled = true }
  }, [hostId, adapters.length])

  async function choose(adapterType: string, providerId: string) {
    const current = bindings.find(b => b.adapter_type === adapterType)?.model_provider_id ?? AMBIENT
    // The select fires on every click, including the already-selected option.
    // Clearing a binding that is not there answers 404.
    if (providerId === current) return
    setBusy(adapterType)
    try {
      if (providerId === AMBIENT) {
        await hostsApi.clearProviderBinding(hostId, adapterType)
        setBindings(cur => cur.filter(b => b.adapter_type !== adapterType))
      } else {
        const saved = await hostsApi.setProviderBinding(hostId, adapterType, providerId)
        setBindings(cur => [...cur.filter(b => b.adapter_type !== adapterType), saved])
      }
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  // Never render nothing. A host whose daemon has not reported an installed
  // runtime has no backend to choose, and the reason for that is exactly what
  // someone looking for this control needs to be told — an empty space says
  // the feature is missing rather than that this host is not ready for it.
  if (adapters.length === 0) {
    return (
      <div className="w-full space-y-1 border-t pt-2">
        <Label className="text-xs text-muted-foreground">Model backend</Label>
        <p className="text-xs text-muted-foreground">
          {installedProbes.length === 0
            ? 'This host has not reported an installed runtime yet. Start the daemon (rainver-host run) and wait for its next heartbeat.'
            : `None of this host's runtimes (${installedProbes.join(', ')}) can be dispatched to remotely, so there is no backend to choose.`}
        </p>
      </div>
    )
  }

  return (
    <div className="w-full space-y-2 border-t pt-2">
      <Label className="text-xs text-muted-foreground">Model backend</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {adapters.map(adapter => {
          const bound = bindings.find(b => b.adapter_type === adapter.adapter_type)
          const options = eligibleProviders(providers, adapter.adapter_type)
          // A provider removed after being bound is soft-deleted, so the
          // binding outlives it and every dispatch on this host now fails.
          // Say that, rather than rendering a bare id.
          const stale = bound && !options.some(p => p.id === bound.model_provider_id)
          return (
            <div key={adapter.adapter_type} className="space-y-1">
              <Label className="text-xs">{adapter.display_name}</Label>
              <Select
                value={bound?.model_provider_id ?? AMBIENT}
                disabled={busy === adapter.adapter_type}
                onChange={value => choose(adapter.adapter_type, value)}
                options={[
                  { value: AMBIENT, label: "This machine's login" },
                  ...options.map(p => ({ value: p.id, label: p.default_model ? `${p.name} · ${p.default_model}` : p.name })),
                  ...(stale ? [{ value: bound.model_provider_id, label: 'Unavailable backend — pick another' }] : []),
                ]}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
