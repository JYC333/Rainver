import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { hostsApi } from '../../api/client'
import { cn, errMsg } from '../../lib/utils'
import type { Host, HostPairingCode, HostRuntimeDefinitionOption } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { useAuth } from '../../contexts/AuthContext'
import { useAppTranslation } from '../../i18n'
import HostSummaryList from './HostSummaryList'
import HostDetail from './HostDetail'
import { fmt, type HostProvisioning } from './hostDisplay'
import { hostSectionParam } from './hostLinks'

const HOST_REFRESH_INTERVAL_MS = 3_000

/**
 * The Hosts a person can see, as a list and the one selected Host's detail
 * (`?host=<id>`, optionally `&section=runtime|cli|connection`). With several
 * Hosts, below `md` the list and the detail take turns, as in Agent Work;
 * with one, its detail is the page. The detail is rendered once, keyed by
 * Host, so a refresh never remounts it and switching Host ends what was open
 * on the previous one. A named Host that is not in the list is reported, never
 * replaced by another.
 */
export default function HostsPanel() {
  const { t } = useAppTranslation()
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
  const [provisioning, setProvisioning] = useState<Record<string, HostProvisioning>>({})
  const [provisioningLoading, setProvisioningLoading] = useState(true)
  const [pairingOpen, setPairingOpen] = useState(false)
  // Execution environments, not physical-device claims. The built-in sandbox
  // leads; paired environments retain the server's order and their own names.
  const orderedHosts = useMemo(() => [...hosts].sort((a, b) =>
    Number(b.kind === 'server') - Number(a.kind === 'server')), [hosts])

  const [searchParams, setSearchParams] = useSearchParams()
  const hostParam = searchParams.get('host')
  const sectionParam = hostSectionParam(searchParams.get('section'))
  const defaultHost = hosts.find(host => host.kind === 'server') ?? orderedHosts[0] ?? null
  // Only a named Host, or the default when none is named; never a stand-in for a missing one.
  const selected = hostParam ? hosts.find(host => host.id === hostParam) ?? null : defaultHost
  const multiple = hosts.length > 1
  const selectHost = useCallback((hostId: string, replace = false) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current)
      next.set('host', hostId)
      if (current.get('host') !== hostId) next.delete('section')
      return next
    }, { replace })
  }, [setSearchParams])
  const location = useLocation()
  // Leaving a named Host (Back, or history) leaves its detail: the next one is
  // a fresh mount, even when it is the same Host shown by default, so nothing
  // it had open stays running behind the list.
  const [leaves, setLeaves] = useState(0)
  const namedBefore = useRef(hostParam)
  useEffect(() => {
    if (namedBefore.current && !hostParam) setLeaves(count => count + 1)
    namedBefore.current = hostParam
  }, [hostParam])
  // Back to the list returns the keyboard to the Host it left; choosing a
  // Host whose list button then hides moves it into that Host's detail.
  const returnTo = useRef<string | null>(null)
  const enterDetail = useRef(false)
  const detailArea = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hostParam && returnTo.current) {
      const id = returnTo.current
      returnTo.current = null
      document.querySelector<HTMLElement>(`[data-host-button="${CSS.escape(id)}"]`)?.focus()
    }
    if (hostParam && enterDetail.current) {
      enterDetail.current = false
      const active = document.activeElement as HTMLElement | null
      if (active && active !== document.body && active.offsetParent === null) detailArea.current?.querySelector<HTMLElement>('article')?.focus({ preventScroll: true })
    }
  }, [hostParam, location.key])
  const showAllHosts = useCallback(() => {
    setSearchParams(current => {
      const next = new URLSearchParams(current)
      next.delete('host')
      next.delete('section')
      return next
    })
  }, [setSearchParams])

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

  // The 3s tick and a refresh after an action can overlap, and answers do not
  // arrive in order; only the latest request's list is kept.
  const hostsRequest = useRef(0)
  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    const request = ++hostsRequest.current
    try {
      const result = await hostsApi.list()
      if (request !== hostsRequest.current) return
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

  const pairingVisible = pairingOpen || Boolean(pairing) || (!loading && hosts.length === 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('command_center.hosts')}</h2>
        {!(!loading && hosts.length === 0) && (
          <Button size="sm" variant="outline" aria-expanded={pairingVisible} onClick={() => { setPairingOpen(open => !open); setPairing(null) }}>
            {pairingVisible ? t('command_center.hide_pairing') : t('command_center.pair_machine')}
          </Button>
        )}
      </div>
      {pairingVisible && (
      <Card className="p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t('command_center.pair_title')}</h2>
          <p className="text-xs text-muted-foreground">
            Linux: download the latest installer from GitHub, then use the generated code to install, pair, and start the background service.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px]">
            <Label className="text-xs">{t('command_center.pair_name')}</Label>
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
      )}

      {loading ? (
        <Card className="p-6 space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </Card>
      ) : hosts.length === 0 ? (
        <Card><EmptyState title="No hosts registered yet" /></Card>
      ) : (
        <div className={cn('grid min-w-0 gap-4', multiple && 'md:grid-cols-[minmax(13rem,17rem)_minmax(0,1fr)]')}>
          {multiple && (
            <HostSummaryList hosts={orderedHosts} selectedId={selected?.id ?? null} provisioning={provisioning}
              onSelect={hostId => { enterDetail.current = true; selectHost(hostId) }} className={cn(hostParam && 'hidden md:block')} />
          )}
          {/* With no Host named, the default detail sits beside the list on a
              wide screen and stays mounted, hidden, below md. The first
              interaction with it names it in the URL, so a narrower window
              then shows that same detail instead of hiding it. */}
          <div ref={detailArea} className={cn('min-w-0', multiple && !hostParam && 'hidden md:block')}
            onFocusCapture={() => { if (!hostParam && selected) selectHost(selected.id, true) }}>
            {selected ? (
              <HostDetail
                key={`${selected.id}:${leaves}`}
                host={selected}
                isInstanceAdmin={Boolean(currentUser?.is_instance_admin)}
                adapters={runtimeAdapters}
                provisioning={provisioning[selected.id]}
                provisioningLoading={provisioningLoading}
                sectionRequest={hostParam === selected.id && sectionParam ? { section: sectionParam, key: location.key } : null}
                showBack={multiple}
                onBack={() => { returnTo.current = selected.id; showAllHosts() }}
                onRefresh={() => load()}
                onAdaptersChanged={async () => { await Promise.all([load(), loadAdapters()]) }}
                onRevoke={hostId => { void revoke(hostId) }}
              />
            ) : (
              <Card role="alert" className="space-y-2 p-4">
                <p className="text-sm font-medium">{t('command_center.host_unavailable_title')}</p>
                <p className="text-xs text-muted-foreground">{t('command_center.host_unavailable_body')}</p>
                <Button size="sm" variant="outline" onClick={showAllHosts}>{t('command_center.show_all_hosts')}</Button>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
