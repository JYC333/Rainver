import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, LogIn, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { hostsApi } from '../../api/client'
import type { HostExecutionTarget, HostRuntimeDefinitionOption, HostRuntimeProvisioningStatus } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { Input } from '../../components/ui/input'
import HostDirectoryBrowser from './HostDirectoryBrowser'
import { errMsg } from '../../lib/utils'
import RuntimeLoginTerminal from './RuntimeLoginTerminal'
import { SpaceLink } from '../../core/spaceNav'

export interface HostExecutionSelection {
  host_id: string
  workspace_location_id: string | null
  workspace_mode: 'location' | 'managed'
  runtime_key: string
  installation: string
}

/**
 * What Rainver's own provisioner is doing to the Server Runtime's pinned copy.
 *
 * Plan "Default path" §3: an Agent surface says installing, failed/retry or
 * incompatible — never "login required" — while the copy is not yet usable.
 * Returns null once the installed copy is the pinned one and healthy.
 */
function serverProvisioningNote(
  installation: HostRuntimeProvisioningStatus['installation'],
): string | null {
  if (installation.state === 'failed') return 'Rainver could not provision the Server Runtime\u2019s OpenCode copy.'
  if (installation.state === 'queued' || installation.state === 'installing') {
    return `Rainver is installing the Server Runtime\u2019s OpenCode copy (${installation.desired_version}). Agents here can be saved now and will run once it reports ready.`
  }
  if (installation.active_version !== installation.desired_version) {
    return `The Server Runtime is running ${installation.active_version ?? 'an unreported version'} while Rainver pins ${installation.desired_version}.`
  }
  return null
}

/**
 * The one UI for choosing a Project Location and the exact runtime copy that
 * will execute an Agent. The server remains authoritative: this is a
 * discoverability and setup surface, not a capability grant.
 */
export default function HostExecutionTargetPicker({
  projectId,
  value,
  onChange,
  onRuntimeChange,
  disabled = false,
  managedOnly = false,
  backendMode = 'runtime_native',
}: {
  projectId?: string | null
  value: HostExecutionSelection | null
  onChange: (value: HostExecutionSelection | null) => void
  onRuntimeChange?: (runtimeKey: string) => void
  disabled?: boolean
  /** Provider mode uses Rainver's proxy and does not require the runtime's native login. */
  backendMode?: 'runtime_native' | 'model_provider'
  /** Offer only managed workspaces when a caller explicitly needs a private, Location-independent directory. */
  managedOnly?: boolean
}) {
  const [targets, setTargets] = useState<HostExecutionTarget[]>([])
  const [adapterCatalog, setAdapterCatalog] = useState<HostRuntimeDefinitionOption[]>([])
  const [loading, setLoading] = useState(Boolean(projectId))
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [login, setLogin] = useState<{ hostId: string; runtimeKey: string; installation: string } | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [registerPath, setRegisterPath] = useState<string | null>(null)
  const [registerName, setRegisterName] = useState('')
  const [registering, setRegistering] = useState(false)
  const [draftHostId, setDraftHostId] = useState(value?.host_id ?? '')
  const [draftLocationId, setDraftLocationId] = useState(value?.workspace_location_id ?? '')
  const [draftRuntimeKey, setDraftRuntimeKey] = useState(value?.runtime_key ?? '')
  const [draftMode, setDraftMode] = useState<'location' | 'managed'>(value?.workspace_mode ?? 'location')
  const [serverProvisioning, setServerProvisioning] = useState<HostRuntimeProvisioningStatus | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [targetResponse, adapterResponse] = await Promise.all([
        hostsApi.executionTargets(projectId || null),
        hostsApi.listRuntimeDefinitions(),
      ])
      setTargets(targetResponse.targets)
      setAdapterCatalog(adapterResponse.items)
    } catch (caught) {
      setError(errMsg(caught))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    // Only a *bound* value re-seeds the drafts. A null value is what this
    // picker itself emits for an incomplete selection — the host the person
    // just chose has no installed copy yet — and clearing the drafts from it
    // discarded that choice, unmounting the "No copy installed"/Install block
    // and snapping the host select back to the Server Runtime.
    if (!value) return
    setDraftHostId(value.host_id)
    setDraftLocationId(value.workspace_location_id ?? '')
    setDraftRuntimeKey(value.runtime_key)
    setDraftMode(value.workspace_mode)
  }, [value?.host_id, value?.workspace_location_id, value?.workspace_mode, value?.runtime_key])

  const target = targets.find(item => item.host_id === (value?.host_id ?? draftHostId)) ?? null
  const hostId = value?.host_id ?? draftHostId
  const locationId = value?.workspace_location_id ?? draftLocationId
  const workspaceMode = value?.workspace_mode ?? draftMode
  const runtimeKey = value?.runtime_key ?? draftRuntimeKey
  const locations = managedOnly ? [] : target?.locations ?? []
  const adapters = useMemo(() => {
    const fromTarget = target?.runtimes ?? []
    const byType = new Map(fromTarget.map(adapter => [adapter.runtime_key, adapter]))
    for (const adapter of adapterCatalog) {
      if (adapter.remote_eligible === false || byType.has(adapter.runtime_key)) continue
      byType.set(adapter.runtime_key, {
        runtime_key: adapter.runtime_key,
        display_name: adapter.display_name,
        installations: [],
      })
    }
    if (runtimeKey && !byType.has(runtimeKey)) {
      byType.set(runtimeKey, {
        runtime_key: runtimeKey,
        display_name: `${runtimeKey} (not in runtime catalog)`,
        installations: [],
      })
    }
    return [...byType.values()]
  }, [adapterCatalog, runtimeKey, target])
  const selectedAdapter = adapters.find(item => item.runtime_key === runtimeKey) ?? null
  const installations = selectedAdapter?.installations ?? []
  const selectedInstallation = installations.find(item => item.id === value?.installation) ?? null
  // Lifecycle, not label: a Server Runtime target is `hosts.kind === 'server'`.
  const isServerTarget = target?.host_kind === 'server'
  const selectedInstallationUnreported = Boolean(
    isServerTarget && value?.host_id === hostId && value.installation && !selectedInstallation,
  )

  // Presentational and cheap: read once when the chosen target becomes a
  // Server Runtime, never polled. The Hosts page owns the refresh loop and the
  // retry; this only stops the composer from claiming a copy is ready.
  const serverProvisioningHostId = isServerTarget ? target?.host_id ?? null : null
  useEffect(() => {
    if (!serverProvisioningHostId) {
      setServerProvisioning(null)
      return undefined
    }
    let cancelled = false
    void (async () => {
      try {
        const status = await hostsApi.serverRuntimeProvisioning(serverProvisioningHostId)
        if (!cancelled) setServerProvisioning(status)
      } catch {
        if (!cancelled) setServerProvisioning(null)
      }
    })()
    return () => { cancelled = true }
  }, [serverProvisioningHostId])
  const provisioningNote = isServerTarget && serverProvisioning
    ? serverProvisioningNote(serverProvisioning.installation)
    : null

  function emitSelection(mode: 'location' | 'managed', nextLocationId: string | null, nextRuntimeKey: string, nextInstallationId: string) {
    if (!hostId || !nextRuntimeKey || !nextInstallationId || (mode === 'location' && !nextLocationId)) {
      onChange(null)
      return
    }
    onChange({
      host_id: hostId,
      workspace_location_id: mode === 'managed' ? null : nextLocationId,
      workspace_mode: mode,
      runtime_key: nextRuntimeKey,
      installation: nextInstallationId,
    })
  }

  function selectHost(nextHostId: string) {
    const nextTarget = targets.find(item => item.host_id === nextHostId)
    const nextLocation = nextTarget?.locations.find(location => location.execution_ready) ?? nextTarget?.locations[0]
    const nextInstalledRuntime = nextTarget?.runtimes[0]
    const nextRuntimeKey = nextInstalledRuntime?.runtime_key
      ?? adapterCatalog.find(adapter => adapter.runtime_key === 'opencode')?.runtime_key
      ?? adapterCatalog[0]?.runtime_key
    const nextMode: 'location' | 'managed' = nextLocation ? 'location' : nextTarget?.managed_workspace_available ? 'managed' : 'location'
    setDraftHostId(nextHostId)
    setDraftLocationId(nextLocation?.id ?? '')
    setDraftRuntimeKey(nextRuntimeKey ?? '')
    setDraftMode(nextMode)
    setLogin(null)
    if (nextRuntimeKey) onRuntimeChange?.(nextRuntimeKey)
    const nextInstallation = nextInstalledRuntime?.installations[0]
    if (!nextRuntimeKey || !nextInstallation) onChange(null)
    else onChange({
      host_id: nextHostId,
      workspace_location_id: nextMode === 'managed' ? null : nextLocation?.id ?? null,
      workspace_mode: nextMode,
      runtime_key: nextRuntimeKey,
      installation: nextInstallation.id,
    })
  }

  function selectMode(nextMode: 'location' | 'managed') {
    setDraftMode(nextMode)
    const nextLocationId = nextMode === 'managed' ? null : locations.find(location => location.execution_ready)?.id ?? locations[0]?.id ?? null
    setDraftLocationId(nextLocationId ?? '')
    if (selectedAdapter && installations[0]) emitSelection(nextMode, nextLocationId, runtimeKey, value?.installation ?? installations[0].id)
  }

  function selectLocation(nextLocationId: string) {
    setDraftLocationId(nextLocationId)
    if (selectedAdapter && installations[0]) emitSelection('location', nextLocationId, runtimeKey, value?.installation ?? installations[0].id)
  }

  function selectAdapter(nextRuntimeKey: string) {
    setDraftRuntimeKey(nextRuntimeKey)
    setLogin(null)
    onRuntimeChange?.(nextRuntimeKey)
    const nextAdapter = adapters.find(item => item.runtime_key === nextRuntimeKey)
    const nextInstallation = nextAdapter?.installations[0]
    if (nextInstallation) emitSelection(workspaceMode, workspaceMode === 'managed' ? null : locationId, nextRuntimeKey, nextInstallation.id)
    else onChange(null)
  }

  function selectInstallation(nextInstallationId: string) {
    if (!hostId || !runtimeKey || !nextInstallationId) return
    emitSelection(workspaceMode, workspaceMode === 'managed' ? null : locationId, runtimeKey, nextInstallationId)
  }

  async function registerDirectory() {
    if (!hostId || !projectId || !registerPath || !registerName.trim()) return
    setRegistering(true)
    try {
      await hostsApi.registerWorkspace(hostId, { path: registerPath, project_id: projectId, name: registerName.trim() })
      toast.success('Directory registered on the host')
      setRegisterOpen(false)
      setRegisterName('')
      await reload()
    } catch (caught) {
      toast.error(errMsg(caught))
    } finally {
      setRegistering(false)
    }
  }

  async function install() {
    if (!hostId || !runtimeKey) return
    setInstalling(runtimeKey)
    try {
      const result = await hostsApi.installRuntime(hostId, runtimeKey)
      if (!result.ok) throw new Error(result.error ?? 'Runtime installation failed')
      await reload()
      if (result.installation) emitSelection(workspaceMode, workspaceMode === 'managed' ? null : locationId, runtimeKey, result.installation)
      toast.success(`${selectedAdapter?.display_name ?? runtimeKey} installed`)
    } catch (caught) {
      toast.error(errMsg(caught))
    } finally {
      setInstalling(null)
    }
  }

  const serverTarget = targets.find(item => item.host_kind === 'server')
  const hostOptions = [
    // The Server Runtime is a real Host row, so it is offered only when the
    // server actually returned it. Until then it is shown disabled with the
    // reason rather than as a choice whose selection resolves to nothing.
    ...(serverTarget
      ? []
      : [{ value: 'server', label: 'Server Runtime · not available yet', disabled: true }]),
    ...(value?.host_id && !targets.some(item => item.host_id === value.host_id)
      ? [{ value: value.host_id, label: `${value.host_id} · unavailable`, disabled: true }]
      : []),
    ...targets.map(item => ({ value: item.host_id, label: `${item.host_name} · ${item.host_online === false ? 'offline' : 'online'}` })),
  ]
  const selectedHostValue = hostId || serverTarget?.host_id || 'server'

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3" data-testid="host-execution-target-picker">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium">Where it runs</p>
          <p className="text-[11px] text-muted-foreground">
            {!projectId
              ? 'Choose a host for a Space-level managed workspace, or select a Project Location when a Project is available.'
              : !loading && targets.length === 0
                ? 'None of your online hosts has a directory registered for this Project. Run `rainver-host workspace add <path>` there, then reload.'
                : 'Server Runtime is provisioned by Rainver. A paired Host uses its owner-managed runtime installation.'}
          </p>
        </div>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      <Select
        ariaLabel="Execution host"
        value={selectedHostValue}
        onChange={selectHost}
        options={hostOptions}
        disabled={disabled || loading}
      />
      {/* Effective trust is a property of the execution target, not of the
          runtime (ROUTING.md, "Effective trust"). A paired Host reaches
          `medium` only for the Run its own owner is responsible for, and
          nothing reaches `high`, so a Profile bound here can still save and
          then die `route_no_candidate` for another member or for a
          high/critical-risk Agent. */}
      {target?.host_kind === 'remote' && (
        <p className="text-[11px] text-muted-foreground">
          On a paired Host only its owner's own Runs route, up to medium risk; another member's Run and any high or critical risk Agent will not route here — use the Server Runtime for those.
        </p>
      )}
      {error && (
        <div className="flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{error}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}><RefreshCw className="size-3.5" /></Button>
        </div>
      )}
      {target && (
        <>
          <Select
            ariaLabel="Workspace mode"
            value={workspaceMode}
            onChange={mode => selectMode(mode as 'location' | 'managed')}
            options={[
              ...(target.managed_workspace_available ? [{ value: 'managed', label: 'Managed workspace on this host (no Project files)' }] : []),
              ...(target.locations.length > 0 ? [{ value: 'location', label: 'Project Location' }] : []),
            ]}
            disabled={disabled}
          />
          {workspaceMode === 'location' && <Select
            ariaLabel="Execution Location"
            value={locationId}
            onChange={selectLocation}
            options={locations.map(location => ({
              value: location.id,
              label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}${location.execution_ready ? '' : ' · not ready'}`,
              disabled: !location.execution_ready,
            }))}
            disabled={disabled || locations.length === 0}
          />}
          {projectId && !managedOnly && (
            <div className="space-y-2">
              <Button type="button" size="sm" variant="ghost" className="px-1 text-xs" disabled={disabled} onClick={() => setRegisterOpen(open => !open)}>
                {registerOpen ? 'Hide directory registration' : 'Register a directory on this host…'}
              </Button>
              {registerOpen && hostId && (
                <div className="space-y-2">
                  <HostDirectoryBrowser hostId={hostId} value={registerPath} onChange={setRegisterPath} disabled={disabled || registering} />
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Folder name"
                      placeholder="Folder name"
                      value={registerName}
                      onChange={event => setRegisterName(event.target.value)}
                      className="h-8 text-xs"
                      disabled={disabled || registering}
                    />
                    <Button type="button" size="sm" disabled={disabled || registering || !registerPath || !registerName.trim()} onClick={() => void registerDirectory()}>
                      {registering ? 'Registering…' : 'Register'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          <Select
            ariaLabel="Runtime"
            value={runtimeKey}
            onChange={selectAdapter}
            options={adapters.map(adapter => ({ value: adapter.runtime_key, label: adapter.display_name }))}
            disabled={disabled || adapters.length === 0}
          />
          {selectedAdapter && (installations.length > 0 || selectedInstallationUnreported) ? (
            <Select
              ariaLabel="Runtime installation"
              value={value?.installation ?? installations[0]?.id ?? ''}
              onChange={selectInstallation}
              options={[
                ...(selectedInstallationUnreported && value?.installation
                  ? [{ value: value.installation, label: `${value.installation} · not currently reported`, disabled: true }]
                  : []),
                ...installations.map(installation => ({
                  value: installation.id,
                  label: `${installation.id}${installation.version ? ` · ${installation.version}` : ''}${backendMode === 'runtime_native' && installation.logged_in === false ? ' · login required' : backendMode === 'runtime_native' && installation.logged_in === true ? ' · logged in' : ''}`,
                })),
              ]}
              disabled={disabled}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 rounded border border-dashed border-border px-2 py-1.5 text-xs">
              {isServerTarget
                ? <span className="text-muted-foreground">Server Runtime installation is managed by Rainver.</span>
                : <>
                  <span className="text-muted-foreground">No copy of this runtime is installed on this host.</span>
                  <Button type="button" size="sm" variant="outline" disabled={disabled || Boolean(installing)} onClick={() => void install()}>
                    {installing ? <Loader2 className="size-3 animate-spin" /> : 'Install'}
                  </Button>
                </>}
            </div>
          )}
          {provisioningNote && serverProvisioning && (
            <div
              className="space-y-1 rounded border border-dashed border-border px-2 py-1.5 text-xs"
              data-testid="server-runtime-provisioning"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={serverProvisioning.installation.state === 'failed' ? 'destructive' : 'warning'}>
                  {serverProvisioning.installation.state}
                </Badge>
                <span className="text-muted-foreground">{provisioningNote}</span>
              </div>
              {serverProvisioning.installation.error && (
                <p className="text-destructive">{serverProvisioning.installation.error}</p>
              )}
              <SpaceLink to="/command-center" className="underline underline-offset-2">
                Open Command Center to retry provisioning
              </SpaceLink>
            </div>
          )}
          {backendMode === 'runtime_native' && value && selectedInstallation?.logged_in === false && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <Badge variant="warning">Login required</Badge>
                <Button type="button" size="sm" variant="outline" onClick={() => setLogin({ hostId: value.host_id, runtimeKey: value.runtime_key, installation: value.installation })}>
                  <LogIn className="mr-1 size-3.5" />Login
                </Button>
              </div>
              {login && <RuntimeLoginTerminal key={`${login.hostId}:${login.runtimeKey}:${login.installation}`} {...login} onDone={() => { void reload(); setLogin(null) }} />}
            </div>
          )}
        </>
      )}
      {!projectId && <p className="text-xs text-muted-foreground">Managed workspaces are host-owned and isolated per Agent; Project Locations remain optional.</p>}
    </div>
  )
}
