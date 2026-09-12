import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { acpAgentsApi, hostsApi, type AcpAgentOut, type AcpRegistryEntry, type ModelProviderOut } from '../../api/client'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type { Host, HostRuntimeAdapterOption, HostRuntimeUsage, RuntimeInstallation } from '../../types/api'
import HostAgentRow, { agentAcceptsProviderBinding, type HostAgentLoginTarget } from './HostAgentRow'
import RuntimeLoginTerminal from './RuntimeLoginTerminal'
import { useHostProviderBindings } from './useHostProviderBindings'

/** The copies of an adapter a host reports (the server has already normalized older daemons' reports). */
/** How long a finished, successful login stays on screen before the panel closes itself. */
export const LOGIN_PANEL_AUTO_CLOSE_MS = 3_000

export function installationsOn(host: Host, adapter: HostRuntimeAdapterOption): RuntimeInstallation[] {
  return host.capabilities_json?.installations?.[adapter.adapter_type] ?? []
}

/** The quota rows for one adapter, re-keyed by installation id for the row. */
function usageFor(usage: ReadonlyMap<string, HostRuntimeUsage>, adapterType: string): ReadonlyMap<string, HostRuntimeUsage> {
  const prefix = `${adapterType}:`
  return new Map(
    [...usage.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, item]) => [key.slice(prefix.length), item] as const),
  )
}

function usageBusyFor(busy: ReadonlySet<string>, adapterType: string): ReadonlySet<string> {
  const prefix = `${adapterType}:`
  return new Set([...busy].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)))
}

/**
 * The agents on one host: those this machine has a copy of — its own
 * install (detected, never touched) and managed copies the daemon installed
 * — with log-in and remove, plus "Add agent…" for the rest of the enabled
 * catalog. Instance admins can also enable an ACP registry entry and install
 * it on this host in one flow; non-admin owners only see the enabled catalog.
 */
export default function HostAgents({
  host,
  adapters,
  providers,
  isInstanceAdmin,
  manageable,
  onChanged,
}: {
  host: Host
  adapters: HostRuntimeAdapterOption[]
  providers: ModelProviderOut[]
  isInstanceAdmin: boolean
  /**
   * Whether this viewer may change what is installed on this host. A paired
   * host is its owner's, so this is true wherever the card is shown at all;
   * the built-in host has no owner and is managed by instance admins, so a
   * member sees its copies and their login state without the controls.
   */
  manageable: boolean
  onChanged: () => Promise<void> | void
}) {
  // One key per in-flight action, not one slot: two installs started back to
  // back must each keep their own spinner until their own request settles.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const startBusy = (key: string) => setBusy(previous => new Set(previous).add(key))
  const endBusy = (key: string) => setBusy(previous => {
    const next = new Set(previous)
    next.delete(key)
    return next
  })
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
    adapterType: string
    installation: string
    target: HostAgentLoginTarget
  } | null>(null)
  const [adding, setAdding] = useState(false)
  const [registry, setRegistry] = useState<AcpRegistryEntry[] | null>(null)
  const [enabledRegistryAgents, setEnabledRegistryAgents] = useState<AcpAgentOut[] | null>(null)
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [registryQuery, setRegistryQuery] = useState('')
  const [installedRegistryIds, setInstalledRegistryIds] = useState<Set<string>>(() => new Set())
  // Subscription quota per `<adapter_type>:<installation>`, read from the
  // server's cache. Never probed on render: the numbers live on the host and
  // reading them costs a network call or a CLI launch there.
  const [usage, setUsage] = useState<ReadonlyMap<string, HostRuntimeUsage>>(() => new Map())
  const [usageBusy, setUsageBusy] = useState<ReadonlySet<string>>(() => new Set())
  const online = host.status === 'online'

  useEffect(() => {
    let cancelled = false
    void hostsApi.usage(host.id)
      .then(result => {
        if (cancelled) return
        setUsage(new Map(result.items.map(item => [`${item.adapter_type}:${item.installation}`, item])))
      })
      // A missing quota panel is not worth a toast: the copies, their logins
      // and every control on this card work without it.
      .catch(() => {})
    return () => { cancelled = true }
  }, [host.id])

  async function refreshUsage(adapterType: string, installation: string) {
    const key = `${adapterType}:${installation}`
    setUsageBusy(previous => new Set(previous).add(key))
    try {
      const item = await hostsApi.refreshUsage(host.id, adapterType, installation)
      setUsage(previous => new Map(previous).set(key, item))
      if (!item.quota.available && item.quota.error) toast.message(item.quota.error)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setUsageBusy(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  const present = useMemo(() => adapters.filter(adapter => installationsOn(host, adapter).length > 0), [adapters, host])
  // Only a paired host has a host×adapter model source. The built-in host's
  // Runs are not provider-bound, and `/hosts/:id/runtime-provider-bindings`
  // answers 404 for it — asking anyway put a "Host not found" toast in front of
  // every member the moment an admin installed a bindable copy on it.
  const providerBindingsSupported = host.kind === 'remote'
  const providerBindingsEnabled = providerBindingsSupported && present.some(agentAcceptsProviderBinding)
  const providerBindings = useHostProviderBindings(host.id, providerBindingsEnabled)
  const builtinAdaptersByRegistryId = useMemo(
    () => new Map(adapters.flatMap(adapter => adapter.registry_id ? [[adapter.registry_id, adapter] as const] : [])),
    [adapters],
  )
  const enabledRegistryById = useMemo(
    () => new Map((enabledRegistryAgents ?? []).map(agent => [agent.id, agent] as const)),
    [enabledRegistryAgents],
  )
  // One list for everything a host can gain: the registry, with the builtin
  // CLIs and already-enabled agents offering Install and the rest offering
  // Enable & install. A non-admin cannot enable, so they see only the
  // installable ones — never a separate "default" list above the registry.
  const registryCandidates = useMemo(() => {
    const needle = registryQuery.trim().toLowerCase()
    return (registry ?? [])
      .filter(entry => isInstanceAdmin || enabledRegistryById.has(entry.id) || builtinAdaptersByRegistryId.has(entry.id))
      .filter(entry => !needle || entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle))
  }, [registry, registryQuery, isInstanceAdmin, enabledRegistryById, builtinAdaptersByRegistryId])

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
    if (busy.has(key)) return
    startBusy(key)
    try {
      await action()
      await onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      endBusy(key)
    }
  }

  const install = (adapter: HostRuntimeAdapterOption) => withBusy(adapter.adapter_type, async () => {
    const result = await hostsApi.installRuntime(host.id, adapter.adapter_type)
    if (!result.ok) throw new Error(result.error ?? 'install failed')
    toast.success(`${adapter.display_name} ${result.installation ?? ''} installed on ${host.name}`)
  })

  async function installFromRegistry(entry: AcpRegistryEntry) {
    const key = `registry:${entry.id}`
    if (busy.has(key)) return
    startBusy(key)
    let enabledAgent = enabledRegistryById.get(entry.id) ?? null
    let enabledNow = false
    let changed = false
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
      const adapterType = enabledAgent?.adapter_type ?? builtinAdapter?.adapter_type
      if (!adapterType) throw new Error(`No runtime adapter is available for ${entry.name}`)
      const result = await hostsApi.installRuntime(host.id, adapterType)
      if (!result.ok) throw new Error(result.error ?? 'install failed')
      changed = true
      setInstalledRegistryIds(previous => new Set(previous).add(entry.id))
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
      }
    }
  }

  const uninstall = (adapter: HostRuntimeAdapterOption, entry: RuntimeInstallation) =>
    withBusy(`${adapter.adapter_type}:${entry.id}`, async () => {
      const result = await hostsApi.uninstallRuntime(host.id, adapter.adapter_type, entry.id)
      if (!result.ok) throw new Error(result.error ?? 'uninstall failed')
    })

  const rollback = (adapter: HostRuntimeAdapterOption) =>
    withBusy(`${adapter.adapter_type}:rollback`, async () => {
      const result = await hostsApi.rollbackRuntime(host.id, adapter.adapter_type)
      // The daemon drains the copy's Runs first and refuses rather than
      // killing one, so "still in use" is an ordinary answer, not a fault.
      if (!result.ok) throw new Error(result.error ?? 'rollback failed')
    })

  return (
    <div className="w-full border-t pt-2 space-y-1" data-testid={`host-agents-${host.id}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Agents</p>
        {manageable && (
          <Button size="sm" variant={adding ? 'ghost' : 'outline'} disabled={!online} onClick={toggleAdding}>
            {adding ? 'Close' : 'Add agent…'}
          </Button>
        )}
      </div>
      {present.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">No agent on this host yet.</p>
      )}
      <ul className="space-y-1">
        {present.map(adapter => (
          <HostAgentRow
            key={adapter.adapter_type}
            host={host}
            adapter={adapter}
            copies={installationsOn(host, adapter)}
            providers={providers}
            binding={providerBindings.bindings.find(binding => binding.adapter_type === adapter.adapter_type) ?? null}
            installBusy={busy}
            providerBusy={providerBindings.loading || providerBindings.busyAdapter === adapter.adapter_type}
            manageable={manageable}
            providerBindingSupported={providerBindingsSupported}
            usage={usageFor(usage, adapter.adapter_type)}
            usageBusy={usageBusyFor(usageBusy, adapter.adapter_type)}
            onInstall={() => { void install(adapter) }}
            onUninstall={entry => { void uninstall(adapter, entry) }}
            onRollback={() => { void rollback(adapter) }}
            onLogin={(installation, target) => {
              clearLoginCloseTimer()
              setLoginOpen(previous => ({ attempt: (previous?.attempt ?? 0) + 1, adapterType: adapter.adapter_type, installation, target }))
            }}
            onRefreshUsage={installation => { void refreshUsage(adapter.adapter_type, installation) }}
            onChooseProvider={providerId => { void providerBindings.choose(adapter.adapter_type, providerId) }}
          />
        ))}
      </ul>

      {adding && (
        <div className="space-y-2 rounded-md border border-border p-2" data-testid={`host-add-agent-${host.id}`}>
          <section className="space-y-1">
              <p className="text-xs font-medium">Install managed agent</p>
              <p className="text-xs text-muted-foreground">
                {isInstanceAdmin
                  ? <>Installs a managed copy on {host.name}; an agent not yet enabled for the instance is enabled first. Registry agents run at low trust using their own host login.</>
                  : <>Installs a managed copy on {host.name}. Only agents an instance admin has enabled are listed.</>}
              </p>
              {registryLoading ? (
                <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3 animate-spin" />Loading registry…</p>
              ) : registryError ? (
                <div className="flex items-center justify-between gap-2 text-xs text-destructive">
                  <span>{registryError}</span>
                  <Button size="sm" variant="outline" onClick={() => void loadRegistry()}>Retry</Button>
                </div>
              ) : registry !== null ? (
                <>
                  <Input
                    aria-label="Search agent registry"
                    placeholder="Search agents"
                    value={registryQuery}
                    onChange={event => setRegistryQuery(event.target.value)}
                  />
                  <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                    {registryCandidates.map(entry => {
                      const enabledAgent = enabledRegistryById.get(entry.id)
                      const adapter = enabledAgent
                        ? adapters.find(candidate => candidate.adapter_type === enabledAgent.adapter_type)
                        : builtinAdaptersByRegistryId.get(entry.id)
                      const installed = installedRegistryIds.has(entry.id)
                        || enabledAgent?.installed_on.some(item => item.host_id === host.id) === true
                        || (adapter ? installationsOn(host, adapter).length > 0 : false)
                      const installing = busy.has(`registry:${entry.id}`)
                      const alreadyEnabled = Boolean(enabledAgent || builtinAdaptersByRegistryId.has(entry.id))
                      return (
                        <li key={entry.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                          <div className="min-w-0">
                            <span className="font-medium">{entry.name}</span>
                            <span className="ml-2 text-muted-foreground">{entry.version} · {entry.distribution.kind}</span>
                            {entry.description && <p className="truncate text-muted-foreground">{entry.description}</p>}
                          </div>
                          {installed ? (
                            <Badge variant="secondary">Installed</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`${alreadyEnabled ? 'Install' : 'Enable and install'} ${entry.name} on ${host.name}`}
                              disabled={installing}
                              onClick={() => void installFromRegistry(entry)}
                            >
                              {installing ? <><Loader2 className="mr-1 size-3 animate-spin" />Installing…</> : alreadyEnabled ? 'Install' : 'Enable & install'}
                            </Button>
                          )}
                        </li>
                      )
                    })}
                    {registryCandidates.length === 0 && <li className="py-2 text-muted-foreground">Nothing matches.</li>}
                  </ul>
                </>
              ) : null}
            </section>
        </div>
      )}

      {loginOpen && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>{loginOpen.target.kind === 'logout' ? 'Logout' : 'Login'} · {adapters.find(adapter => adapter.adapter_type === loginOpen.adapterType)?.display_name ?? loginOpen.adapterType} · {loginOpen.installation}</span>
            <Button size="sm" variant="ghost" onClick={() => setLoginOpen(null)}>Close</Button>
          </div>
          <RuntimeLoginTerminal
            key={`${loginOpen.attempt}:${loginOpen.adapterType}:${loginOpen.installation}:${loginOpen.target.kind === 'acp' ? loginOpen.target.method.id : loginOpen.target.kind}`}
            hostId={host.id}
            adapterType={loginOpen.adapterType}
            installation={loginOpen.installation}
            target={loginOpen.target.kind === 'acp'
              ? { kind: 'acp', methodId: loginOpen.target.method.id }
              : loginOpen.target.kind === 'cli' ? { kind: 'cli' }
              : loginOpen.target.kind === 'logout' ? { kind: 'logout' } : null}
            interactive={loginOpen.target.kind !== 'acp' || loginOpen.target.method.type !== 'agent'}
            onDone={loggedIn => {
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
        </div>
      )}
    </div>
  )
}
