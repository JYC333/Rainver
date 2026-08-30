import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, LogIn, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { hostsApi } from '../../api/client'
import type { HostExecutionTarget, HostRuntimeAdapterOption } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'
import RuntimeLoginTerminal from './RuntimeLoginTerminal'

export interface HostExecutionSelection {
  host_id: string
  workspace_location_id: string | null
  workspace_mode: 'location' | 'managed'
  adapter_type: string
  installation: string
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
  disabled = false,
}: {
  projectId?: string | null
  value: HostExecutionSelection | null
  onChange: (value: HostExecutionSelection | null) => void
  disabled?: boolean
}) {
  const [targets, setTargets] = useState<HostExecutionTarget[]>([])
  const [adapterCatalog, setAdapterCatalog] = useState<HostRuntimeAdapterOption[]>([])
  const [loading, setLoading] = useState(Boolean(projectId))
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [login, setLogin] = useState<{ hostId: string; adapterType: string; installation: string } | null>(null)
  const [draftHostId, setDraftHostId] = useState(value?.host_id ?? '')
  const [draftLocationId, setDraftLocationId] = useState(value?.workspace_location_id ?? '')
  const [draftAdapterType, setDraftAdapterType] = useState(value?.adapter_type ?? '')
  const [draftMode, setDraftMode] = useState<'location' | 'managed'>(value?.workspace_mode ?? 'location')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [targetResponse, adapterResponse] = await Promise.all([
        hostsApi.executionTargets(projectId || null),
        hostsApi.listRuntimeAdapters(),
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
    setDraftHostId(value?.host_id ?? '')
    setDraftLocationId(value?.workspace_location_id ?? '')
    setDraftAdapterType(value?.adapter_type ?? '')
    setDraftMode(value?.workspace_mode ?? 'location')
  }, [value?.host_id, value?.workspace_location_id, value?.workspace_mode, value?.adapter_type])

  const target = targets.find(item => item.host_id === (value?.host_id ?? draftHostId)) ?? null
  const hostId = value?.host_id ?? draftHostId
  const locationId = value?.workspace_location_id ?? draftLocationId
  const workspaceMode = value?.workspace_mode ?? draftMode
  const adapterType = value?.adapter_type ?? draftAdapterType
  const locations = target?.locations ?? []
  const adapters = useMemo(() => {
    const fromTarget = target?.adapters ?? []
    const byType = new Map(fromTarget.map(adapter => [adapter.adapter_type, adapter]))
    for (const adapter of adapterCatalog) {
      if (adapter.remote_eligible === false || byType.has(adapter.adapter_type)) continue
      byType.set(adapter.adapter_type, {
        adapter_type: adapter.adapter_type,
        display_name: adapter.display_name,
        installations: [],
      })
    }
    return [...byType.values()]
  }, [adapterCatalog, target])
  const selectedAdapter = adapters.find(item => item.adapter_type === adapterType) ?? null
  const installations = selectedAdapter?.installations ?? []
  const selectedInstallation = installations.find(item => item.id === value?.installation) ?? null

  function emitSelection(mode: 'location' | 'managed', nextLocationId: string | null, nextAdapterType: string, nextInstallationId: string) {
    if (!hostId || !nextAdapterType || !nextInstallationId || (mode === 'location' && !nextLocationId)) {
      onChange(null)
      return
    }
    onChange({
      host_id: hostId,
      workspace_location_id: mode === 'managed' ? null : nextLocationId,
      workspace_mode: mode,
      adapter_type: nextAdapterType,
      installation: nextInstallationId,
    })
  }

  function selectServer() {
    setDraftHostId('')
    setDraftLocationId('')
    setDraftAdapterType('')
    setDraftMode('location')
    setLogin(null)
    onChange(null)
  }

  function selectHost(nextHostId: string) {
    if (nextHostId === 'server') {
      selectServer()
      return
    }
    const nextTarget = targets.find(item => item.host_id === nextHostId)
    const nextLocation = nextTarget?.locations.find(location => location.execution_ready) ?? nextTarget?.locations[0]
    const nextAdapter = nextTarget?.adapters[0] ?? adapters[0]
    const nextMode: 'location' | 'managed' = nextLocation ? 'location' : nextTarget?.managed_workspace_available ? 'managed' : 'location'
    setDraftHostId(nextHostId)
    setDraftLocationId(nextLocation?.id ?? '')
    setDraftAdapterType(nextAdapter?.adapter_type ?? '')
    setDraftMode(nextMode)
    setLogin(null)
    const nextInstallation = nextAdapter?.installations[0]
    if (!nextAdapter || !nextInstallation) onChange(null)
    else onChange({
      host_id: nextHostId,
      workspace_location_id: nextMode === 'managed' ? null : nextLocation?.id ?? null,
      workspace_mode: nextMode,
      adapter_type: nextAdapter.adapter_type,
      installation: nextInstallation.id,
    })
  }

  function selectMode(nextMode: 'location' | 'managed') {
    setDraftMode(nextMode)
    const nextLocationId = nextMode === 'managed' ? null : locations.find(location => location.execution_ready)?.id ?? locations[0]?.id ?? null
    setDraftLocationId(nextLocationId ?? '')
    if (selectedAdapter && installations[0]) emitSelection(nextMode, nextLocationId, adapterType, value?.installation ?? installations[0].id)
  }

  function selectLocation(nextLocationId: string) {
    setDraftLocationId(nextLocationId)
    if (selectedAdapter && installations[0]) emitSelection('location', nextLocationId, adapterType, value?.installation ?? installations[0].id)
  }

  function selectAdapter(nextAdapterType: string) {
    setDraftAdapterType(nextAdapterType)
    setLogin(null)
    const nextAdapter = adapters.find(item => item.adapter_type === nextAdapterType)
    const nextInstallation = nextAdapter?.installations[0]
    if (nextInstallation) emitSelection(workspaceMode, workspaceMode === 'managed' ? null : locationId, nextAdapterType, nextInstallation.id)
    else onChange(null)
  }

  function selectInstallation(nextInstallationId: string) {
    if (!hostId || !adapterType || !nextInstallationId) return
    emitSelection(workspaceMode, workspaceMode === 'managed' ? null : locationId, adapterType, nextInstallationId)
  }

  async function install() {
    if (!hostId || !adapterType) return
    setInstalling(adapterType)
    try {
      const result = await hostsApi.installRuntime(hostId, adapterType)
      if (!result.ok) throw new Error(result.error ?? 'Runtime installation failed')
      await reload()
      if (result.installation) emitSelection(workspaceMode, workspaceMode === 'managed' ? null : locationId, adapterType, result.installation)
      toast.success(`${selectedAdapter?.display_name ?? adapterType} installed`)
    } catch (caught) {
      toast.error(errMsg(caught))
    } finally {
      setInstalling(null)
    }
  }

  const hostOptions = [
    { value: 'server', label: 'Server (default)' },
    ...targets.map(item => ({ value: item.host_id, label: `${item.host_name} · ${item.host_online === false ? 'offline' : 'online'}` })),
  ]
  const selectedHostValue = hostId || 'server'

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
                : 'Server is the default. A host choice uses its own logged-in runtime.'}
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
          <Select
            ariaLabel="Execution Location"
            value={locationId}
            onChange={selectLocation}
            options={locations.map(location => ({
              value: location.id,
              label: `${location.folder_name}${location.display_path ? ` · ${location.display_path}` : ''}${location.execution_ready ? '' : ' · not ready'}`,
              disabled: !location.execution_ready,
            }))}
            disabled={disabled || workspaceMode === 'managed' || locations.length === 0}
          />
          <Select
            ariaLabel="Execution adapter"
            value={adapterType}
            onChange={selectAdapter}
            options={adapters.map(adapter => ({ value: adapter.adapter_type, label: adapter.display_name }))}
            disabled={disabled || adapters.length === 0}
          />
          {selectedAdapter && installations.length > 0 ? (
            <Select
              ariaLabel="Runtime installation"
              value={value?.installation ?? installations[0]!.id}
              onChange={selectInstallation}
              options={installations.map(installation => ({
                value: installation.id,
                label: `${installation.id}${installation.version ? ` · ${installation.version}` : ''}${installation.logged_in === false ? ' · login required' : installation.logged_in === true ? ' · logged in' : ''}`,
              }))}
              disabled={disabled}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 rounded border border-dashed border-border px-2 py-1.5 text-xs">
              <span className="text-muted-foreground">No copy of this runtime is installed on this host.</span>
              <Button type="button" size="sm" variant="outline" disabled={disabled || Boolean(installing)} onClick={() => void install()}>
                {installing ? <Loader2 className="size-3 animate-spin" /> : 'Install'}
              </Button>
            </div>
          )}
          {value && selectedInstallation?.logged_in === false && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <Badge variant="warning">Login required</Badge>
                <Button type="button" size="sm" variant="outline" onClick={() => setLogin({ hostId: value.host_id, adapterType: value.adapter_type, installation: value.installation })}>
                  <LogIn className="mr-1 size-3.5" />Login
                </Button>
              </div>
              {login && <RuntimeLoginTerminal key={`${login.hostId}:${login.adapterType}:${login.installation}`} {...login} onDone={() => { void reload(); setLogin(null) }} />}
            </div>
          )}
        </>
      )}
      {!projectId && <p className="text-xs text-muted-foreground">Managed workspaces are host-owned and isolated per Agent; Project Locations remain optional.</p>}
    </div>
  )
}
