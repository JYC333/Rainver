import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { hostsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, HostPairingCode, HostRuntimeDefinitionOption, HostRuntimeProvisioningStatus } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import HostAgents from './HostAgents'
import { useAuth } from '../../contexts/AuthContext'
import HostProxyAddress from './HostProxyAddress'
import ServerRuntimeProvisioningPanel from './ServerRuntimeProvisioningPanel'

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
  const { currentUser } = useAuth()
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [pairing, setPairing] = useState<HostPairingCode | null>(null)
  const [pairingName, setPairingName] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [runtimeAdapters, setRuntimeAdapters] = useState<HostRuntimeDefinitionOption[]>([])
  // One refresh loop for the page: the host list and each server host's
  // provisioning status come from the same tick, instead of every panel
  // running a timer of its own.
  const [provisioning, setProvisioning] = useState<Record<string, { status: HostRuntimeProvisioningStatus | null; error: string | null }>>({})
  const [provisioningLoading, setProvisioningLoading] = useState(true)
  const machineGroups = useMemo(() => {
    const groups = new Map<string, Host[]>()
    for (const host of hosts) {
      const machineId = host.machine_id ?? host.id
      groups.set(machineId, [...(groups.get(machineId) ?? []), host])
    }
    return [...groups.entries()]
  }, [hosts])

  const loadAdapters = useCallback(async () => {
    try {
      const result = await hostsApi.listRuntimeDefinitions()
      setRuntimeAdapters(result.items)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }, [])
  useEffect(() => {
    loadAdapters()
  }, [loadAdapters])

  // One fan-out at a time. A 3s tick is shorter than a slow provisioning read,
  // so an unguarded loop stacked requests whose responses could land out of
  // order; a caller that arrives mid-flight joins that read instead of opening
  // a second one.
  const provisioningInFlight = useRef<Promise<void> | null>(null)
  const loadProvisioning = useCallback((serverHosts: Host[]): Promise<void> => {
    if (provisioningInFlight.current) return provisioningInFlight.current
    if (serverHosts.length === 0) {
      setProvisioningLoading(false)
      setProvisioning(previous => (Object.keys(previous).length === 0 ? previous : {}))
      return Promise.resolve()
    }
    const read = (async () => {
      const entries = await Promise.all(serverHosts.map(async host => {
        try {
          return [host.id, { status: await hostsApi.serverRuntimeProvisioning(host.id), error: null }] as const
        } catch (error) {
          return [host.id, { status: null, error: errMsg(error) }] as const
        }
      }))
      // Rebuilt from this tick's own answers, so a host that has gone away
      // leaves no entry behind. A failed read keeps the last status it had,
      // because "could not ask again" is not "the copy disappeared".
      setProvisioning(previous => Object.fromEntries(entries.map(([hostId, entry]) => [
        hostId,
        entry.error === null ? entry : { status: previous[hostId]?.status ?? null, error: entry.error },
      ])))
      setProvisioningLoading(false)
    })()
    provisioningInFlight.current = read.finally(() => { provisioningInFlight.current = null })
    return provisioningInFlight.current
  }, [])

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const result = await hostsApi.list()
      setHosts(result.items)
      await loadProvisioning(result.items.filter(host => host.kind === 'server'))
    } catch (error) {
      // Background refreshes should not produce a toast every few seconds
      // while the server is temporarily unavailable. The initial load still
      // reports the failure to the user.
      if (showLoading) toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [loadProvisioning])

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
            Linux: download the latest installer from GitHub, then use the generated code to install, pair, and start the background service.
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
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
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
            <code aria-label="Linux host installation command" className="block overflow-x-auto whitespace-nowrap rounded bg-background p-2 font-mono text-xs">
              curl -fsSL https://github.com/JYC333/Rainver/releases/download/host-installer/install-host.sh | bash<br />
              {'\n'}rainver-host register --server &lt;Rainver URL&gt; --code {pairing.pairing_code}
            </code>
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
                  {/* The row is seeded as `server`; the card names it the way
                      the product talks about it. */}
                  <span className="text-sm font-medium">{host.kind === 'server' ? 'Server Runtime' : host.name}</span>
                  <Badge variant={HOST_STATUS_VARIANT[host.status]}>{host.status}</Badge>
                  <Badge variant="outline">{host.kind}</Badge>
                  <Badge variant="outline">{host.environment_kind ?? host.platform ?? 'unknown environment'}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {host.kind === 'server' ? 'Built-in execution host · strictly isolated · ' : ''}
                  {`${host.platform ?? '—'} / ${host.arch ?? '—'} · daemon ${host.daemon_version ?? 'unknown'} · last seen ${fmt(host.last_heartbeat_at)}`}
                </p>
              </div>
              {host.kind === 'remote' && host.status !== 'revoked' && (
                <Button size="sm" variant="destructive" onClick={() => revoke(host.id)}>Revoke</Button>
              )}
              {host.kind === 'server' && (
                // The built-in host is not anyone's machine: it serves every
                // Space of the instance, one isolated namespace per Run, and
                // installing or logging in a copy on it is instance-admin work.
                // Members still see what is installed, because that is what
                // says whether their Run can run here at all.
                <p className="w-full border-t pt-2 text-xs text-muted-foreground">
                  The instance's own execution host: every Run is isolated in its own namespace, and
                  {host.max_concurrent_runs !== null && host.max_concurrent_runs !== undefined
                    ? ` up to ${host.max_concurrent_runs} run${host.max_concurrent_runs === 1 ? '' : 's'} execute at once.`
                    : ' its capacity is set per machine.'}
                  {currentUser?.is_instance_admin ? '' : ' Installing and logging in its agents is instance-admin work.'}
                </p>
              )}
              {host.kind === 'server' && (
                <ServerRuntimeProvisioningPanel
                  hostId={host.id}
                  canRetry={Boolean(currentUser?.is_instance_admin)}
                  status={provisioning[host.id]?.status ?? null}
                  error={provisioning[host.id]?.error ?? null}
                  loading={provisioningLoading}
                  onRefresh={() => load()}
                />
              )}
              {/* Every runtime definition, not only the dispatch-eligible ones: a
                  registry agent is installable and managed here even while
                  `remote_eligible` is false (hosts.md, profile isolation), and
                  filtering it out hid the copy that had just been installed.
                  Eligibility gates dispatch, not installation visibility. */}
              {host.status !== 'revoked' && (
                <HostAgents
                  host={host}
                  adapters={runtimeAdapters}
                  isInstanceAdmin={Boolean(currentUser?.is_instance_admin)}
                  manageable={host.kind === 'remote' || Boolean(currentUser?.is_instance_admin)}
                  provisioningFailed={provisioning[host.id]?.status?.installation.state === 'failed'}
                  onChanged={async () => {
                    await Promise.all([load(), loadAdapters()])
                  }}
                />
              )}
              {host.kind === 'remote' && host.status !== 'revoked' && (
                <div className="w-full">
                  <HostProxyAddress host={host} onChanged={() => { void load() }} />
                </div>
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
