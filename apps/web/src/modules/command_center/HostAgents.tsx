import { repositoryAcpAdapter, isRepositoryAcpRegistryId } from "@rainver/protocol"
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppTranslation } from '../../i18n'
import { acpAgentsApi, hostsApi, type AcpAgentOut, type AcpRegistryEntry } from '../../api/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/dialog'
import HostAgentCatalog from './HostAgentCatalog'
import { hasStableUpdate } from './runtimeVersions'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type { Host, HostRuntimeDefinitionOption, HostRuntimeUsage, RuntimeInstallation } from '../../types/api'
import HostAgentRow, { type HostAgentLoginTarget } from './HostAgentRow'
import RuntimeLoginTerminal from './RuntimeLoginTerminal'
import { useHostToolOperations } from './useHostToolOperations'
import { SpaceLink } from '../../core/spaceNav'

/** How long a finished, successful login stays on screen before the panel closes itself. */
const LOGIN_PANEL_AUTO_CLOSE_MS = 3_000

/** The copies of an adapter a host reports, in the shape the server stored. */
function installationsOn(host: Host, adapter: HostRuntimeDefinitionOption): RuntimeInstallation[] {
  return host.capabilities_json?.installations?.[adapter.runtime_key] ?? []
}

/** The quota rows for one adapter, re-keyed by installation id for the row. */
function usageFor(usage: ReadonlyMap<string, HostRuntimeUsage>, runtimeKey: string): ReadonlyMap<string, HostRuntimeUsage> {
  const prefix = `${runtimeKey}:`
  return new Map(
    [...usage.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, item]) => [key.slice(prefix.length), item] as const),
  )
}

/**
 * The agents on one host: those this machine has a copy of — its own
 * install (updated only on its owner's explicit request) and managed copies the daemon installed
 * — with log-in and remove, plus "Add agent…" for the rest of the enabled
 * catalog. Instance admins can also enable an ACP registry entry and install
 * it on this host in one flow; non-admin owners only see the enabled catalog.
 */
export default function HostAgents({
  host,
  adapters,
  isInstanceAdmin,
  manageable,
  onChanged,
  runtimeTarget,
}: {
  host: Host
  adapters: HostRuntimeDefinitionOption[]
  isInstanceAdmin: boolean
  /**
   * Whether this viewer may change what is installed on this host. A paired
   * host is its owner's, so this is true wherever the card is shown at all;
   * the built-in host has no owner and is managed by instance admins, so a
   * member sees its copies and their login state without the controls.
   */
  manageable: boolean
  onChanged: () => Promise<void> | void
  runtimeTarget?: { runtime_key: string; installation: string }
}) {
  const { t } = useAppTranslation()
  // One key per in-flight action, not one slot: two installs started back to
  // back must each keep their own spinner until their own request settles.
  const { busy, startBusy, endBusy } = useHostToolOperations(host.id, onChanged, manageable)
  // A successful login shows its "Logged in." line for a moment and then
  // puts the panel away by itself; a failed one stays open so the output can
  // be read. Cleared when another login starts or the card unmounts.
  const loginCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearLoginCloseTimer = () => {
    if (loginCloseTimer.current) clearTimeout(loginCloseTimer.current)
    loginCloseTimer.current = null
  }
  useEffect(() => clearLoginCloseTimer, [])
  const [loginOpen, setLoginOpen] = useState<{
    /** Increments per click so the same copy's Log in always starts a fresh session, even while its last one is still on screen. */
    attempt: number
    runtimeKey: string
    installation: string
    target: HostAgentLoginTarget
  } | null>(null)
  const [adding, setAdding] = useState(false)
  const [registry, setRegistry] = useState<AcpRegistryEntry[] | null>(null)
  const [enabledRegistryAgents, setEnabledRegistryAgents] = useState<AcpAgentOut[] | null>(null)
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [registryQuery, setRegistryQuery] = useState('')
  const [installedRegistryVersions, setInstalledRegistryVersions] = useState<ReadonlyMap<string,string>>(() => new Map())
  // Subscription quota per `<runtime_key>:<installation>`, read from the
  // server's cache. Never probed on render: the numbers live on the host and
  // reading them costs a network call or a CLI launch there.
  const [usage, setUsage] = useState<ReadonlyMap<string, HostRuntimeUsage>>(() => new Map())
  const [usageReload, setUsageReload] = useState(0)
  const installationState = JSON.stringify(host.capabilities_json?.installations ?? {})
  const online = host.status === 'online'

  useEffect(() => {
    if (loginOpen) return
    let cancelled = false
    void hostsApi.usage(host.id)
      .then(result => {
        if (cancelled) return
        setUsage(new Map(result.items.map(item => [`${item.runtime_key}:${item.installation}`, item])))
      })
      // A missing quota panel is not worth a toast: the copies, their logins
      // and every control on this card work without it.
      .catch(() => { if (!cancelled) setUsage(new Map()) })
    return () => { cancelled = true }
  }, [host.id, installationState, usageReload, loginOpen])

  const present = useMemo(() => adapters.filter(adapter => installationsOn(host, adapter).length > 0), [adapters, host])
  const builtinAdaptersByRegistryId = useMemo(
    () => new Map(adapters.flatMap(adapter => adapter.registry_id ? [[adapter.registry_id, adapter] as const] : [])),
    [adapters],
  )
  const enabledRegistryById = useMemo(
    () => new Map((enabledRegistryAgents ?? []).map(agent => [agent.id, agent] as const)),
    [enabledRegistryAgents],
  )
  const registryCandidates = useMemo(() => {
    const needle = registryQuery.trim().toLowerCase()
    return (registry ?? [])
      .filter(entry => !isRepositoryAcpRegistryId(entry.id))
      .filter(entry => isInstanceAdmin || enabledRegistryById.has(entry.id) || builtinAdaptersByRegistryId.has(entry.id))
      .map(entry => {
        const adapter = builtinAdaptersByRegistryId.get(entry.id)
          ?? adapters.find(candidate => candidate.runtime_key === enabledRegistryById.get(entry.id)?.runtime_key)
        const copies = adapter ? installationsOn(host, adapter) : []
        const managed = installedRegistryVersions.has(entry.id)
          ? [installedRegistryVersions.get(entry.id)!]
          : copies.filter(copy => copy.id !== 'own').flatMap(copy => copy.version ? [copy.version] : [])
        const installed = copies.length > 0 || installedRegistryVersions.has(entry.id)
          || enabledRegistryById.get(entry.id)?.installed_on.some(item => item.host_id === host.id) === true
        return {entry, installed, managed, runtimeKey: adapter?.runtime_key, own: copies.some(copy => copy.id === 'own'),
          update: (managed.length > 0 && managed.every(version => hasStableUpdate(version, entry.version)))
,
          enabled: enabledRegistryById.has(entry.id) || Boolean(adapter),
          }
      })
      .filter(row => !needle || row.entry.name.toLowerCase().includes(needle) || row.entry.id.toLowerCase().includes(needle))
      .sort((a,b) => Number(b.installed)-Number(a.installed) || a.entry.name.localeCompare(b.entry.name))
  }, [registry, registryQuery, isInstanceAdmin, enabledRegistryById, builtinAdaptersByRegistryId, host, adapters, installedRegistryVersions])

  // Optimism lasts only until the Host acknowledges that version. Later
  // rollback/removal must render the Host's report rather than this old result.
  useEffect(() => {
    setInstalledRegistryVersions(previous => {
      const next = new Map(previous)
      for (const [id,version] of previous) {
        const key = builtinAdaptersByRegistryId.get(id)?.runtime_key ?? enabledRegistryById.get(id)?.runtime_key
        if (key && host.capabilities_json?.installations?.[key]?.some(copy => copy.id !== 'own' && copy.version === version)) next.delete(id)
      }
      return next.size === previous.size ? previous : next
    })
  }, [host, builtinAdaptersByRegistryId, enabledRegistryById])

  async function loadRegistry() {
    if (registryLoading) return
    setRegistryLoading(true)
    setRegistryError(null)
    try {
      const [registryResult, enabledResult] = await Promise.all([
        acpAgentsApi.registry(),
        acpAgentsApi.list(),
      ])
      setRegistry(registryResult.items)
      setEnabledRegistryAgents(enabledResult.items)
    } catch (error) {
      setRegistryError(errMsg(error))
    } finally {
      setRegistryLoading(false)
    }
  }

  function toggleAdding() {
    const opening = !adding
    setAdding(opening)
    if (opening && registry === null) void loadRegistry()
  }

  async function withBusy(key: string, action: () => Promise<void>) {
    if (!startBusy(key)) {
      toast.info(t('management_ui.host_catalog.operation_in_progress'))
      return
    }
    try {
      await action()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      endBusy(key)
    }
  }

  const install = (adapter: HostRuntimeDefinitionOption) => withBusy(adapter.runtime_key, async () => {
    const nativeUpdate = repositoryAcpAdapter(adapter.runtime_key) && installationsOn(host, adapter).some(copy => copy.id !== 'own')
    const result = await (nativeUpdate ? hostsApi.updateManagedRuntime(host.id, adapter.runtime_key) : hostsApi.installRuntime(host.id, adapter.runtime_key))
    if (!result.ok) throw new Error(result.error ?? 'install failed')
    const bridge = repositoryAcpAdapter(adapter.runtime_key)
    if (bridge && !nativeUpdate && result.installation?.startsWith('managed:')) setInstalledRegistryVersions(previous => new Map(previous).set(bridge.registry_id, result.installation!.slice('managed:'.length)))
    toast.success(`${adapter.display_name} ${nativeUpdate ? 'updated' : 'installed'} on ${host.name}`)
  })
  const updateOwn = (adapter: HostRuntimeDefinitionOption) => withBusy(`${adapter.runtime_key}:own-update`, async () => {
    const result = await hostsApi.updateOwnRuntime(host.id, adapter.runtime_key)
    if (!result.ok) throw new Error(result.error ?? 'Own CLI update failed')
    toast.success(`${adapter.display_name} own installation updated on ${host.name}`)
  })

  async function installFromRegistry(entry: AcpRegistryEntry) {
    const key = `registry:${entry.id}`
    if (!startBusy(key)) {
      toast.info(t('management_ui.host_catalog.operation_in_progress'))
      return
    }
    let enabledAgent = enabledRegistryById.get(entry.id) ?? null
    let enabledNow = false
    let changed = false
    let installingRuntime: string | null = null
    try {
      const builtinAdapter = builtinAdaptersByRegistryId.get(entry.id)
      if (!enabledAgent && !builtinAdapter) {
        enabledAgent = await acpAgentsApi.enable(entry.id)
        enabledNow = true
        changed = true
        setEnabledRegistryAgents(previous => [
          ...(previous ?? []).filter(existing => existing.id !== enabledAgent!.id),
          enabledAgent!,
        ])
      }
      const runtimeKey = enabledAgent?.runtime_key ?? builtinAdapter?.runtime_key
      if (!runtimeKey) throw new Error(`No runtime adapter is available for ${entry.name}`)
      if (!startBusy(runtimeKey)) {
        toast.info(t('management_ui.host_catalog.operation_in_progress'))
        return
      }
      installingRuntime = runtimeKey
      const result = await hostsApi.installRuntime(host.id, runtimeKey, entry.version)
      if (!result.ok) throw new Error(result.error ?? 'install failed')
      changed = true
      setInstalledRegistryVersions(previous => new Map(previous).set(entry.id, entry.version))
      if (enabledAgent) {
        setEnabledRegistryAgents(previous => (previous ?? []).map(agent => agent.id === entry.id
          ? { ...agent, installed_on: [...agent.installed_on.filter(item => item.host_id !== host.id), { host_id: host.id, name: host.name }] }
          : agent))
      }
      toast.success(`${entry.name} ${result.installation ?? ''} installed on ${host.name}`)
    } catch (error) {
      toast.error(enabledNow && enabledAgent
        ? `${enabledAgent.name} was enabled, but installation failed: ${errMsg(error)}`
        : errMsg(error))
    } finally {
      // Enabling changes the runtime-adapter catalog even when the subsequent
      // host install fails, so the parent must refresh both catalog and host.
      try {
        if (changed || enabledAgent) await onChanged()
      } finally {
        endBusy(key)
        if (installingRuntime) endBusy(installingRuntime)
      }
    }
  }

  const uninstall = (adapter: HostRuntimeDefinitionOption, entry: RuntimeInstallation) =>
    withBusy(`${adapter.runtime_key}:${entry.id}`, async () => {
      const result = await hostsApi.uninstallRuntime(host.id, adapter.runtime_key, entry.id)
      if (!result.ok) throw new Error(result.error ?? 'uninstall failed')
    })

  const rollback = (adapter: HostRuntimeDefinitionOption) =>
    withBusy(`${adapter.runtime_key}:rollback`, async () => {
      const result = await hostsApi.rollbackRuntime(host.id, adapter.runtime_key)
      // The daemon drains the copy's Runs first and refuses rather than
      // killing one, so "still in use" is an ordinary answer, not a fault.
      if (!result.ok) throw new Error(result.error ?? 'rollback failed')
    })

  const runtimeRow = (adapter: HostRuntimeDefinitionOption) => (
          <HostAgentRow
            key={adapter.runtime_key}
            host={host}
            adapter={adapter}
            copies={installationsOn(host, adapter)}
            targetInstallation={runtimeTarget?.runtime_key === adapter.runtime_key ? runtimeTarget.installation : undefined}
            installBusy={busy}
            manageable={manageable}
            usage={usageFor(usage, adapter.runtime_key)}
            onInstall={() => { void install(adapter) }}
            onUpdateOwn={() => { void updateOwn(adapter) }}
            onUninstall={entry => { void uninstall(adapter, entry) }}
            onRollback={() => { void rollback(adapter) }}
            onLogin={(installation, target) => {
              setUsage(previous => { const next = new Map(previous); next.delete(`${adapter.runtime_key}:${installation}`); return next })
              clearLoginCloseTimer()
              setLoginOpen(previous => ({ attempt: (previous?.attempt ?? 0) + 1, runtimeKey: adapter.runtime_key, installation, target }))
            }}
          />
  )

  return (
    <div className="w-full border-t border-border pt-2 space-y-1" data-testid={`host-agents-${host.id}`}>
      <div className="flex items-center justify-between">
        {/* Under the Host detail's "Agent Runtimes" heading: these are copies, not Agents. */}
        <p className="text-xs font-medium">Installed copies</p>
        {manageable && (
          <Button size="sm" variant={adding ? 'ghost' : 'outline'} disabled={!online} onClick={toggleAdding}>
            {adding ? 'Close' : 'Add agent…'}
          </Button>
        )}
      </div>
      {[...new Map([...usage.values()].filter(item => {
        const copy = host.capabilities_json?.installations?.[item.runtime_key]?.find(copy => copy.id === item.installation)
        const readings = [
          { used_pct: item.quota.session_pct, resets: item.quota.session_resets },
          { used_pct: item.quota.week_pct, resets: item.quota.week_resets },
          ...(item.quota.windows ?? []),
        ]
        return copy?.logged_in !== false && copy && item.quota.available && readings.some(window => {
          const reset = window.resets ? Date.parse(window.resets.replace(/^Resets\s+/i, '')) : NaN
          return (window.used_pct ?? 0) >= 100 && (!Number.isFinite(reset) || reset > Date.now())
        })
      }).map(item => [item.pool_id ?? `${item.runtime_key}:${item.installation}`, item])).values()].map(item => (
        <p key={item.pool_id ?? `${item.runtime_key}:${item.installation}`} className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning" role="status">
          <SpaceLink className="underline" to={`/usage?tab=quotas&${item.pool_id ? `pool=${encodeURIComponent(item.pool_id)}` : `host=${encodeURIComponent(host.id)}&runtime=${encodeURIComponent(item.runtime_key)}&installation=${encodeURIComponent(item.installation)}`}`}>
            {t('subscription_usage.exhausted', { account: item.quota.account?.account_id.slice(0, 8) ?? item.runtime_key })}
          </SpaceLink>
        </p>
      ))}
      {present.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">No runtime copies are reported on this host yet.</p>
      )}
      {runtimeTarget && <p role="status" className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
        {t(host.capabilities_json?.installations?.[runtimeTarget.runtime_key]?.some(copy => copy.id === runtimeTarget.installation)
          ? 'runtime_failure_ui.located' : 'runtime_failure_ui.target_missing', {
          runtime: adapters.find(adapter => adapter.runtime_key === runtimeTarget.runtime_key)?.display_name ?? runtimeTarget.runtime_key,
          installation: runtimeTarget.installation,
        })}
      </p>}
      <ul className="space-y-1">
        {present.map(runtimeRow)}
      </ul>

      {adding && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid={`host-add-agent-${host.id}`}>
          <ul className="space-y-1">{adapters.filter(adapter => repositoryAcpAdapter(adapter.runtime_key) && installationsOn(host, adapter).length === 0).map(adapter =>
            installedRegistryVersions.has(repositoryAcpAdapter(adapter.runtime_key)!.registry_id)
              ? <li key={adapter.runtime_key} className="flex items-center gap-2 p-2 text-xs"><span>{adapter.display_name}</span><Badge variant="secondary">{t('management_ui.host_catalog.installed')}</Badge></li>
              : runtimeRow(adapter))}</ul>
          <section className="space-y-1">
              <HostAgentCatalog hostName={host.name} rows={registryCandidates} query={registryQuery} onQuery={setRegistryQuery}
                loading={registryLoading} error={registryError} loaded={registry !== null} busy={busy} online={online}
                onRefresh={() => void loadRegistry()} onInstall={entry => void installFromRegistry(entry)}/>

            </section>
        </div>
      )}

      {loginOpen && (
        <Dialog open onOpenChange={open => { if (!open) { clearLoginCloseTimer(); setLoginOpen(null) } }}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{loginOpen.target.kind === 'logout' ? 'Logout' : 'Login'} · {adapters.find(adapter => adapter.runtime_key === loginOpen.runtimeKey)?.display_name ?? loginOpen.runtimeKey}</DialogTitle>
              <DialogDescription>{host.name} · {loginOpen.installation}</DialogDescription>
            </DialogHeader>
          <RuntimeLoginTerminal
            key={`${loginOpen.attempt}:${loginOpen.runtimeKey}:${loginOpen.installation}:${loginOpen.target.kind === 'acp' ? loginOpen.target.method.id : loginOpen.target.kind}`}
            hostId={host.id}
            runtimeKey={loginOpen.runtimeKey}
            installation={loginOpen.installation}
            target={loginOpen.target.kind === 'acp'
              ? { kind: 'acp', methodId: loginOpen.target.method.id }
              : loginOpen.target.kind === 'cli' ? { kind: 'cli' }
              : loginOpen.target.kind === 'logout' ? { kind: 'logout' } : null}
            interactive={loginOpen.target.kind !== 'acp' || loginOpen.target.method.type !== 'agent'}
            onRestart={() => { clearLoginCloseTimer(); setLoginOpen(current => current ? { ...current, attempt: current.attempt + 1 } : null) }}
            onDone={loggedIn => {
              setUsageReload(previous => previous + 1)
              void onChanged()
              clearLoginCloseTimer()
              if (loggedIn === true) {
                loginCloseTimer.current = setTimeout(() => {
                  loginCloseTimer.current = null
                  setLoginOpen(null)
                }, LOGIN_PANEL_AUTO_CLOSE_MS)
              }
            }}
          />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
