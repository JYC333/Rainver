import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { hostsApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type { Host, HostRuntimeAdapterOption, RuntimeInstallation } from '../../types/api'
import RuntimeLoginTerminal from './RuntimeLoginTerminal'

/** The copies of an adapter a host reports (the server has already normalized older daemons' reports). */
export function installationsOn(host: Host, adapter: HostRuntimeAdapterOption): RuntimeInstallation[] {
  return host.capabilities_json?.installations?.[adapter.adapter_type] ?? []
}

/**
 * The agents on one host: those this machine has a copy of — its own
 * install (detected, never touched) and managed copies the daemon installed
 * — with log-in and remove, plus "Add agent…" for the rest of the catalog.
 * The catalog itself (which registry agents the deployment allows) is the
 * admin's, managed in `AcpRegistryPanel`. What this section shows is what
 * the dispatch composer offers for this host.
 */
export default function HostAgents({
  host,
  adapters,
  isInstanceAdmin,
  onChanged,
}: {
  host: Host
  adapters: HostRuntimeAdapterOption[]
  isInstanceAdmin: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState<{ adapterType: string; installation: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const online = host.status === 'online'

  const present = useMemo(() => adapters.filter(adapter => installationsOn(host, adapter).length > 0), [adapters, host])
  const absent = useMemo(() => adapters.filter(adapter => installationsOn(host, adapter).length === 0), [adapters, host])
  async function withBusy(key: string, action: () => Promise<void>) {
    setBusy(key)
    try {
      await action()
      onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(null)
    }
  }

  const install = (adapter: HostRuntimeAdapterOption) => withBusy(adapter.adapter_type, async () => {
    const result = await hostsApi.installRuntime(host.id, adapter.adapter_type)
    if (!result.ok) throw new Error(result.error ?? 'install failed')
    toast.success(`${adapter.display_name} ${result.installation ?? ''} installed on ${host.name}`)
    setAdding(false)
  })

  const uninstall = (adapter: HostRuntimeAdapterOption, entry: RuntimeInstallation) =>
    withBusy(`${adapter.adapter_type}:${entry.id}`, async () => {
      const result = await hostsApi.uninstallRuntime(host.id, adapter.adapter_type, entry.id)
      if (!result.ok) throw new Error(result.error ?? 'uninstall failed')
    })

  return (
    <div className="w-full border-t pt-2 space-y-1" data-testid={`host-agents-${host.id}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Agents</p>
        <Button size="sm" variant={adding ? 'ghost' : 'outline'} disabled={!online} onClick={() => setAdding(previous => !previous)}>
          {adding ? 'Close' : 'Add agent…'}
        </Button>
      </div>
      {present.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">No agent on this host yet.</p>
      )}
      <ul className="space-y-1">
        {present.map(adapter => {
          const copies = installationsOn(host, adapter)
          return (
            <li key={adapter.adapter_type} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid={`host-agent-${host.id}-${adapter.adapter_type}`}>
              <span>{adapter.display_name}</span>
              <span className="flex flex-wrap items-center gap-1">
                {copies.map(entry => (
                  <span key={entry.id} className="flex items-center gap-1">
                    <Badge variant={entry.logged_in === false ? 'warning' : 'secondary'}>
                      {entry.id === 'own' ? 'own' : entry.id}
                      {entry.logged_in === null ? '' : entry.logged_in ? ' · logged in' : ' · not logged in'}
                    </Badge>
                    {entry.logged_in !== null && (
                      <Button
                        size="sm"
                        variant={entry.logged_in ? 'ghost' : 'outline'}
                        aria-label={`Log in ${entry.id} of ${adapter.display_name} on ${host.name}`}
                        disabled={!online}
                        onClick={() => setLoginOpen({ adapterType: adapter.adapter_type, installation: entry.id })}
                      >
                        {entry.logged_in ? 'Log in again' : 'Log in'}
                      </Button>
                    )}
                    {entry.id !== 'own' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${entry.id} of ${adapter.display_name} from ${host.name}`}
                        disabled={!online || busy === `${adapter.adapter_type}:${entry.id}`}
                        onClick={() => void uninstall(adapter, entry)}
                      >
                        Remove
                      </Button>
                    )}
                  </span>
                ))}
                {!copies.some(entry => entry.id !== 'own') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Add a managed copy of ${adapter.display_name} on ${host.name}`}
                    disabled={!online || busy === adapter.adapter_type}
                    onClick={() => void install(adapter)}
                  >
                    {busy === adapter.adapter_type ? <Loader2 className="size-3 animate-spin" /> : '+ managed copy'}
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {adding && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid={`host-add-agent-${host.id}`}>
          {absent.length > 0 && (
            <ul className="space-y-1">
              {absent.map(adapter => (
                <li key={adapter.adapter_type} className="flex items-center justify-between gap-2 text-xs">
                  <span>{adapter.display_name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Install ${adapter.display_name} on ${host.name}`}
                    disabled={busy === adapter.adapter_type}
                    onClick={() => void install(adapter)}
                  >
                    {busy === adapter.adapter_type ? <Loader2 className="size-3 animate-spin" /> : 'Install'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {absent.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Every agent in the catalog is already on this host{isInstanceAdmin ? ' — enable more under Instance Settings → ACP registry' : ''}.
            </p>
          )}
        </div>
      )}

      {loginOpen && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>Login · {adapters.find(adapter => adapter.adapter_type === loginOpen.adapterType)?.display_name ?? loginOpen.adapterType} · {loginOpen.installation}</span>
            <Button size="sm" variant="ghost" onClick={() => setLoginOpen(null)}>Close</Button>
          </div>
          <RuntimeLoginTerminal
            key={`${loginOpen.adapterType}:${loginOpen.installation}`}
            hostId={host.id}
            adapterType={loginOpen.adapterType}
            installation={loginOpen.installation}
            onDone={onChanged}
          />
        </div>
      )}
    </div>
  )
}
