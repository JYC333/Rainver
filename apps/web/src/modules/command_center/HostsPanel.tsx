import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { hostsApi, providersApi, type ModelProviderOut } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, HostPairingCode, HostRuntimeAdapterOption } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import HostProviderBindings from './HostProviderBindings'
import HostProxyAddress from './HostProxyAddress'

const HOST_REFRESH_INTERVAL_MS = 3_000

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : 'never'
}

const HOST_STATUS_VARIANT: Record<Host['status'], 'success' | 'muted' | 'destructive' | 'warning'> = {
  online: 'success',
  offline: 'muted',
  pending_pairing: 'warning',
  revoked: 'destructive',
}

export default function HostsPanel() {
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [pairing, setPairing] = useState<HostPairingCode | null>(null)
  const [pairingName, setPairingName] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [runtimeAdapters, setRuntimeAdapters] = useState<HostRuntimeAdapterOption[]>([])
  // Fetched once for the whole panel; every host card offers the same providers.
  const [providers, setProviders] = useState<ModelProviderOut[]>([])
  const machineGroups = useMemo(() => {
    const groups = new Map<string, Host[]>()
    for (const host of hosts) {
      const machineId = host.machine_id ?? host.id
      groups.set(machineId, [...(groups.get(machineId) ?? []), host])
    }
    return [...groups.entries()]
  }, [hosts])

  useEffect(() => {
    hostsApi.listRuntimeAdapters().then(result => setRuntimeAdapters(result.items)).catch(error => toast.error(errMsg(error)))
    providersApi.list().then(setProviders).catch(error => toast.error(errMsg(error)))
  }, [])

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const result = await hostsApi.list()
      setHosts(result.items)
    } catch (error) {
      // Background refreshes should not produce a toast every few seconds
      // while the server is temporarily unavailable. The initial load still
      // reports the failure to the user.
      if (showLoading) toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
    const refreshTimer = window.setInterval(() => { void load() }, HOST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(refreshTimer)
  }, [load])

  async function issuePairingCode() {
    if (!pairingName.trim()) return
    setIssuing(true)
    try {
      const result = await hostsApi.pairingCode(pairingName.trim())
      setPairing(result)
      setPairingName('')
      void load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setIssuing(false)
    }
  }

  async function revoke(hostId: string) {
    try {
      await hostsApi.revoke(hostId)
      toast.success('Host revoked')
      void load()
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Register a new machine</h2>
          <p className="text-xs text-muted-foreground">
            Generate a pairing code, then run <code className="font-mono">agent-space-host register --server &lt;url&gt; --code &lt;code&gt;</code> on that machine.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px]">
            <Label className="text-xs">Machine name</Label>
            <Input value={pairingName} onChange={e => setPairingName(e.target.value)} placeholder="e.g. laptop" />
          </div>
          <Button onClick={issuePairingCode} disabled={issuing || !pairingName.trim()}>
            {issuing ? 'Generating…' : 'Generate pairing code'}
          </Button>
        </div>
        {pairing && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
            <code className="font-mono text-sm">{pairing.pairing_code}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { navigator.clipboard.writeText(pairing.pairing_code); toast.success('Copied') }}
            >
              <Copy className="size-3.5" />
            </Button>
            <span className="text-xs text-muted-foreground">expires {fmt(pairing.expires_at)}</span>
          </div>
        )}
      </Card>

      {loading ? (
        <Card className="p-6 space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </Card>
      ) : hosts.length === 0 ? (
        <Card><EmptyState title="No hosts registered yet" /></Card>
      ) : (
        <div className="space-y-4">
          {machineGroups.map(([machineId, machineHosts]) => (
            <section key={machineId} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Machine · {machineHosts[0]?.machine_name ?? machineId}</h3>
              {machineHosts.map(host => (
                <Card key={host.id} className="p-3 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{host.name}</span>
                  <Badge variant={HOST_STATUS_VARIANT[host.status]}>{host.status}</Badge>
                  <Badge variant="outline">{host.kind}</Badge>
                  <Badge variant="outline">{host.environment_kind ?? host.platform ?? 'unknown environment'}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {host.kind === 'server'
                    ? 'Built-in server execution host'
                    : `${host.platform ?? '—'} / ${host.arch ?? '—'} · last seen ${fmt(host.last_heartbeat_at)}`}
                </p>
                {host.capabilities_json?.runtimes && host.capabilities_json.runtimes.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {host.capabilities_json.runtimes.map(runtime => {
                      const adapter = runtimeAdapters.find(a => a.capability_probe === runtime)
                      const version = host.capabilities_json?.versions?.[runtime]
                      const label = version ? `${runtime} ${version}` : runtime
                      if (!adapter) return <Badge key={runtime} variant="outline">{label}</Badge>
                      return (
                        <Badge key={runtime} variant={adapter.remote_eligible ? 'secondary' : 'muted'}>
                          {label}{!adapter.remote_eligible && ' · next phase'}
                        </Badge>
                      )
                    })}
                  </div>
                )}
              </div>
              {host.kind === 'remote' && host.status !== 'revoked' && (
                <Button size="sm" variant="destructive" onClick={() => revoke(host.id)}>Revoke</Button>
              )}
              {host.kind === 'server' && (
                // Only a run dispatched to a host daemon carries a provider
                // binding, so this host has no backend to choose. Say so here:
                // otherwise the card next to one that does have the control
                // reads as the control being broken.
                <p className="w-full border-t pt-2 text-xs text-muted-foreground">
                  CLI runs here use the server machine's own logins. A model backend is chosen per paired remote host.
                </p>
              )}
              {host.kind === 'remote' && host.status !== 'revoked' && (
                <>
                  <HostProviderBindings
                    hostId={host.id}
                    runtimeAdapters={runtimeAdapters}
                    installedProbes={host.capabilities_json?.runtimes ?? []}
                    providers={providers}
                  />
                  <div className="w-full">
                    <HostProxyAddress host={host} onChanged={() => { void load() }} />
                  </div>
                </>
              )}
                </Card>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
