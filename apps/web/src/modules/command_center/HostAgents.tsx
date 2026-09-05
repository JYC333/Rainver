import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { acpAgentsApi, hostsApi, type AcpAgentOut, type AcpRegistryEntry, type ModelProviderOut } from '../../api/client'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'
import type { Host, HostRuntimeAdapterOption, RuntimeInstallation } from '../../types/api'
import HostAgentRow, { agentAcceptsProviderBinding, type HostAgentLoginTarget } from './HostAgentRow'
import RuntimeLoginTerminal from './RuntimeLoginTerminal'
import { useHostProviderBindings } from './useHostProviderBindings'

/** The copies of an adapter a host reports (the server has already normalized older daemons' reports). */
export function installationsOn(host: Host, adapter: HostRuntimeAdapterOption): RuntimeInstallation[] {
  return host.capabilities_json?.installations?.[adapter.adapter_type] ?? []
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
  onChanged,
}: {
  host: Host
  adapters: HostRuntimeAdapterOption[]
  providers: ModelProviderOut[]
  isInstanceAdmin: boolean
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState<{
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
  const online = host.status === 'online'

  const present = useMemo(() => adapters.filter(adapter => installationsOn(host, adapter).length > 0), [adapters, host])
  const absent = useMemo(() => adapters.filter(adapter => installationsOn(host, adapter).length === 0), [adapters, host])
  const providerBindingsEnabled = present.some(agentAcceptsProviderBinding)
  const providerBindings = useHostProviderBindings(host.id, providerBindingsEnabled)
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
      .filter(entry => !needle || entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle))
  }, [registry, registryQuery])

  async function loadRegistry() {
    if (!isInstanceAdmin || registryLoading) return
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
    if (opening && isInstanceAdmin && registry === null) void loadRegistry()
  }

  async function withBusy(key: string, action: () => Promise<void>) {
    setBusy(key)
    try {
      await action()
      await onChanged()
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
  })

  async function installFromRegistry(entry: AcpRegistryEntry) {
    const key = `registry:${entry.id}`
    setBusy(key)
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
        setBusy(null)
      }
    }
  }

  const uninstall = (adapter: HostRuntimeAdapterOption, entry: RuntimeInstallation) =>
    withBusy(`${adapter.adapter_type}:${entry.id}`, async () => {
      const result = await hostsApi.uninstallRuntime(host.id, adapter.adapter_type, entry.id)
      if (!result.ok) throw new Error(result.error ?? 'uninstall failed')
    })

  return (
    <div className="w-full border-t pt-2 space-y-1" data-testid={`host-agents-${host.id}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Agents</p>
        <Button size="sm" variant={adding ? 'ghost' : 'outline'} disabled={!online} onClick={toggleAdding}>
          {adding ? 'Close' : 'Add agent…'}
        </Button>
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
            onInstall={() => { void install(adapter) }}
            onUninstall={entry => { void uninstall(adapter, entry) }}
            onLogin={(installation, target) => setLoginOpen({ adapterType: adapter.adapter_type, installation, target })}
            onChooseProvider={providerId => { void providerBindings.choose(adapter.adapter_type, providerId) }}
          />
        ))}
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
              Every enabled agent is already on this host.
            </p>
          )}
          {isInstanceAdmin && (
            <section className="space-y-1 border-t border-border pt-2">
              <p className="text-xs font-medium">Install from ACP registry</p>
              <p className="text-xs text-muted-foreground">
                This enables the agent for the instance, then installs a managed copy on {host.name}. Registry agents run at low trust using their own host login.
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
                    aria-label="Search ACP registry"
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
                      const installing = busy === `registry:${entry.id}`
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
            key={`${loginOpen.adapterType}:${loginOpen.installation}:${loginOpen.target.kind === 'acp' ? loginOpen.target.method.id : loginOpen.target.kind}`}
            hostId={host.id}
            adapterType={loginOpen.adapterType}
            installation={loginOpen.installation}
            target={loginOpen.target.kind === 'acp'
              ? { kind: 'acp', methodId: loginOpen.target.method.id }
              : loginOpen.target.kind === 'cli' ? { kind: 'cli' } : null}
            interactive={loginOpen.target.kind !== 'acp' || loginOpen.target.method.type !== 'agent'}
            onDone={onChanged}
          />
        </div>
      )}
    </div>
  )
}
