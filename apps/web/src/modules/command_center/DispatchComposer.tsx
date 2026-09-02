import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Check, X } from 'lucide-react'
import { hostsApi, projectsApi, tasksApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { DispatchBackend, DispatchOptions, Host, HostRuntimeAdapterOption, RuntimeInstallation } from '../../types/api'
import { ProjectSelector } from '../../components/ProjectFolderSelectors'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { useRemoteWorkspaces, lastUsedWorkspaceId, rememberWorkspaceId } from './useRemoteWorkspaces'
import { AMBIENT_BACKEND, INHERIT_BACKEND } from '@rainver/protocol'
import { choiceLabel } from './backendChoice'

const HOST_LIST_REFRESH_INTERVAL_MS = 3_000

export interface DispatchComposerProps {
  /** Pre-selects a Project/workspace (e.g. arriving from a "dispatch diagnostic run" quick action). */
  initialProjectId?: string
  initialFolderId?: string
  /** Locks the workspace and always resumes this thread — used by a thread's follow-up composer. */
  fixedThreadId?: string
  fixedFolderId?: string
  /** A follow-up composer resumes the thread's already-pinned runtime; no runtime selector is shown. */
  fixedAdapterType?: string
  initialPrompt?: string
  onDispatched: (result: { run_id: string | null; thread_id: string }) => void
  onProjectChange?: (projectId: string) => void
}

function NewProjectInline({ onCreated }: { onCreated: (projectId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const project = await projectsApi.create({ name: name.trim() })
      setOpen(false)
      setName('')
      onCreated(project.id)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent-foreground hover:underline"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3" /> New project
      </button>
    )
  }
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <Input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') create() }}
        placeholder="Project name"
        className="h-7 flex-1 text-xs"
        autoFocus
      />
      <Button size="sm" variant="ghost" className="px-2" onClick={create} disabled={busy || !name.trim()} aria-label="Create project">
        <Check className="size-3.5" />
      </Button>
      <Button size="sm" variant="ghost" className="px-2" onClick={() => setOpen(false)} aria-label="Cancel">
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

/** How a copy of a runtime reads: which one, and whether it is logged in. */
export function installationLabel(entry: Pick<RuntimeInstallation, 'id' | 'version' | 'logged_in'>): string {
  const name = entry.id === 'own' ? "This machine's own install" : `Managed ${entry.version ?? entry.id.replace(/^managed:/, '')}`
  return entry.logged_in === null ? name : `${name} · ${entry.logged_in ? 'logged in' : 'not logged in'}`
}

/**
 * Dispatches a run to a paired host. Everything about *what can be chosen* —
 * which runtimes the host has copies of, which backends each copy can run
 * on and why not, which models and efforts each backend offers — comes from
 * the server's `dispatch-options`, which is decided where dispatch is
 * validated. This component picks a host, a workspace and a prompt, renders
 * the options, and sends back what was picked.
 */
export default function DispatchComposer({
  initialProjectId = '',
  initialFolderId = '',
  fixedThreadId,
  fixedFolderId,
  fixedAdapterType,
  initialPrompt = '',
  onDispatched,
  onProjectChange,
}: DispatchComposerProps) {
  const isNewConversation = !fixedThreadId
  const [hostId, setHostId] = useState('')
  const [projectId, setProjectId] = useState(initialProjectId)
  const [locationId, setLocationId] = useState('')
  const [adapterType, setAdapterType] = useState(fixedAdapterType ?? '')
  const [installation, setInstallation] = useState('')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [hosts, setHosts] = useState<Host[]>([])
  const [runtimeAdapters, setRuntimeAdapters] = useState<HostRuntimeAdapterOption[]>([])
  const [options, setOptions] = useState<DispatchOptions | null>(null)
  const [backend, setBackend] = useState(INHERIT_BACKEND)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [busy, setBusy] = useState(false)
  const [projectListKey, setProjectListKey] = useState(0)
  const { workspaces, loading: workspacesLoading } = useRemoteWorkspaces(projectId)

  useEffect(() => { onProjectChange?.(projectId) }, [projectId, onProjectChange])

  useEffect(() => {
    if (!isNewConversation) return
    const load = (showErrors: boolean) =>
      hostsApi.list()
        .then(result => setHosts(result.items.filter(h => h.kind === 'remote')))
        .catch(error => { if (showErrors) toast.error(errMsg(error)) })
    void load(true)
    const timer = window.setInterval(() => load(false), HOST_LIST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [isNewConversation])

  useEffect(() => {
    hostsApi.listRuntimeAdapters().then(result => setRuntimeAdapters(result.items)).catch(error => toast.error(errMsg(error)))
  }, [])

  useEffect(() => {
    if (!projectId || workspaces.length === 0) return
    if (workspaces.some(w => w.location.id === locationId)) return
    const remembered = lastUsedWorkspaceId(projectId)
    const preferred =
      workspaces.find(w => w.location.id === remembered && (!hostId || w.host?.id === hostId)) ??
      workspaces.find(w => w.folder.id === (fixedFolderId ?? initialFolderId) && (!hostId || w.host?.id === hostId)) ??
      workspaces.find(w => !hostId || w.host?.id === hostId) ??
      null
    if (preferred) setLocationId(preferred.location.id)
  }, [projectId, workspaces, locationId, fixedFolderId, initialFolderId, hostId])

  const workspacesForHost = useMemo(
    () => (hostId ? workspaces.filter(w => w.host?.id === hostId) : workspaces),
    [workspaces, hostId],
  )
  const selected = useMemo(() => workspaces.find(w => w.location.id === locationId) ?? null, [workspaces, locationId])
  const selectedTrustMode = selected?.location.execution_host_kind === 'remote' ? 'trusted_host' : selected ? 'sandboxed' : null
  // The host in play: the chosen workspace's, else the one picked outright.
  const chosenHost = useMemo(() => selected?.host ?? hosts.find(h => h.id === hostId) ?? null, [selected?.host, hosts, hostId])
  const hostOnline = selected?.host?.status === 'online' && selected.location.execution_ready

  // What this host can run and, for the chosen copy, what it can run on.
  // Re-asked as the choice changes and on the host refresh cadence, since a
  // login completing or a copy being installed changes the answer.
  const chosenHostId = chosenHost?.id ?? null
  const loadOptions = useCallback(async () => {
    if (!chosenHostId) { setOptions(null); return }
    try {
      setOptions(await hostsApi.dispatchOptions(chosenHostId, {
        adapter_type: fixedAdapterType ?? adapterType ?? null,
        installation: installation || null,
        thread_id: fixedThreadId ?? null,
      }))
    } catch {
      // Losing this costs the option lists, not the pickers; the next refresh retries.
    }
  }, [chosenHostId, fixedAdapterType, adapterType, installation, fixedThreadId])
  useEffect(() => {
    void loadOptions()
    const timer = window.setInterval(() => { void loadOptions() }, HOST_LIST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [loadOptions])

  const hostAdapters = options?.adapters ?? []
  // Follow the host: a runtime it lacks is not a choice, and a sole one
  // needs no choosing — same "kill the ceremony" spirit as C8 removing the
  // Agent step outright.
  useEffect(() => {
    if (!isNewConversation || fixedAdapterType || !options) return
    if (adapterType && !hostAdapters.some(a => a.adapter_type === adapterType)) setAdapterType('')
    else if (!adapterType && options.adapter_type) setAdapterType(options.adapter_type)
  }, [isNewConversation, fixedAdapterType, adapterType, hostAdapters, options])

  const effectiveAdapterType = fixedAdapterType ?? adapterType
  const selectedAdapter = useMemo(
    () => runtimeAdapters.find(a => a.adapter_type === effectiveAdapterType) ?? null,
    [runtimeAdapters, effectiveAdapterType],
  )
  const installations = useMemo(
    () => hostAdapters.find(a => a.adapter_type === effectiveAdapterType)?.installations ?? [],
    [hostAdapters, effectiveAdapterType],
  )
  const runtimeInstalled = !selectedAdapter || installations.length > 0
  const effectiveInstallation = options?.adapter_type === effectiveAdapterType ? options.installation ?? '' : ''

  const detectedIneligible = useMemo(
    () =>
      chosenHost?.capabilities_json?.runtimes?.filter(runtime =>
        runtimeAdapters.some(a => a.capability_probe === runtime && !a.remote_eligible)) ?? [],
    [chosenHost, runtimeAdapters],
  )

  // The backends, as the server decided them for the chosen copy.
  const backends: DispatchBackend[] = options?.adapter_type === effectiveAdapterType ? options.backends : []
  const chosenBackend = backends.find(b => b.id === backend) ?? null
  // A provider that can back claude_code often cannot back codex or opencode;
  // a selection made before switching runtimes or copies must not be sent
  // anyway. Only on a real switch — not when the first answer arrives —
  // and declared before the move below so the move has the last word.
  const copyKey = effectiveAdapterType && effectiveInstallation ? `${effectiveAdapterType}@${effectiveInstallation}` : ''
  const [previousCopyKey, setPreviousCopyKey] = useState('')
  useEffect(() => {
    if (copyKey === previousCopyKey) return
    setPreviousCopyKey(copyKey)
    if (previousCopyKey) { setBackend(INHERIT_BACKEND); setModel(''); setEffort('') }
  }, [copyKey, previousCopyKey])
  // A choice the list no longer offers (the copy changed under it, or the
  // backend became unusable) moves to the first usable one.
  useEffect(() => {
    if (backends.length === 0) return
    if (chosenBackend?.usable) return
    const first = backends.find(b => b.usable)
    if (first && first.id !== backend) { setBackend(first.id); setModel(''); setEffort('') }
  }, [backends, chosenBackend, backend])

  const availableModels = chosenBackend?.models ?? []
  const availableEfforts = chosenBackend?.efforts ?? []
  const currentModel = chosenBackend?.current_model ?? ''
  const currentEffort = chosenBackend?.current_effort ?? ''
  const backendUsable = chosenBackend?.usable === true
  const anyBackendUsable = backends.some(b => b.usable)

  const hostOptions = [
    { value: '', label: 'Select a host' },
    ...hosts.map(h => ({ value: h.id, label: `${h.name}${h.status === 'online' ? '' : ' (offline)'}`, disabled: h.status !== 'online' })),
  ]
  const workspaceOptions = [
    { value: '', label: workspacesLoading ? 'Loading workspaces…' : (projectId ? 'No workspace registered for this project yet' : 'Select a project first') },
    ...workspacesForHost.map(w => ({
      value: w.location.id,
      label: `${w.host?.name ?? 'Unknown host'} · ${w.folder.name}${w.location.branch ? ` · ${w.location.branch}` : ''}${w.location.dirty ? ' · dirty' : ''}`,
    })),
  ]

  async function dispatch() {
    if (!selected || !effectiveAdapterType || !prompt.trim()) return
    const requestedModel = model.trim() || null
    setBusy(true)
    try {
      const result = await tasksApi.createRunWithoutTask({
        project_id: projectId,
        project_folder_id: selected.folder.id,
        workspace_location_id: selected.location.id,
        adapter_type: effectiveAdapterType,
        // A thread already pins its copy; only a new conversation chooses one.
        ...(!fixedThreadId && effectiveInstallation ? { installation: effectiveInstallation } : {}),
        prompt: prompt.trim(),
        thread_id: fixedThreadId ?? null,
        // Presence, not truthiness: omitting the key means "whatever this
        // thread already runs on" (or the host default on a first message),
        // while an explicit null means the machine's own login. Sending null
        // for "inherit" would silently unbind the thread.
        ...(backend === INHERIT_BACKEND
          ? {
              ...(requestedModel ? { model: requestedModel } : {}),
              ...(effort ? { reasoning_effort: effort } : {}),
            }
          : {
              model_provider_id: backend === AMBIENT_BACKEND ? null : backend,
              ...(requestedModel ? { model: requestedModel } : {}),
              ...(effort ? { reasoning_effort: effort } : {}),
            }),
      })
      if (!fixedFolderId) rememberWorkspaceId(projectId, selected.location.id)
      setPrompt('')
      setBackend(INHERIT_BACKEND)
      setModel('')
      setEffort('')
      if ('thread_id' in result && result.thread_id) onDispatched(result)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  // A disabled button that does not say why is a dead end; name the first
  // blocker in the order the person would fix them.
  const blocker = !selected
    ? null
    : selected.host?.status !== 'online'
      ? `${selected.host?.name ?? 'The host'} is offline.`
      : !selected.location.execution_ready
        ? `This workspace is not ready on ${selected.host?.name ?? 'the host'}: its daemon does not report the directory — register it there with \`rainver-host workspace add\`, or check the path exists.`
        : !runtimeInstalled
          ? `${selectedAdapter?.display_name ?? 'The runtime'} is not on ${selected.host?.name ?? 'this host'} — add it under Hosts.`
          : effectiveAdapterType && backends.length > 0 && !anyBackendUsable
            ? backends.find(b => b.id === AMBIENT_BACKEND)?.reason ?? 'No usable backend — log in or add a provider.'
            : chosenBackend && !chosenBackend.usable
              ? chosenBackend.reason ?? 'That backend cannot be used here.'
              : null

  return (
    <Card className="p-4 space-y-3">
      {isNewConversation && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Host</Label>
              <Select ariaLabel="Host" value={hostId} onChange={id => { setHostId(id); setLocationId('') }} options={hostOptions} />
            </div>
            <div>
              <ProjectSelector key={projectListKey} value={projectId} onChange={id => { setProjectId(id); setLocationId('') }} optional={false} />
              <NewProjectInline onCreated={id => { setProjectId(id); setLocationId(''); setProjectListKey(k => k + 1) }} />
            </div>
          </div>

          <div>
            <Label>Workspace</Label>
            <Select value={locationId} onChange={setLocationId} disabled={!projectId} options={workspaceOptions} />
            {projectId && workspacesForHost.length === 0 && !workspacesLoading && (
              <p className="mt-1 text-xs text-muted-foreground">
                No workspace is registered yet{hostId ? ' for this host and project' : ''}. On the target machine, run:{' '}
                <code className="font-mono select-all">
                  rainver-host workspace add &lt;path-on-host&gt; --project {projectId}
                </code>
              </p>
            )}
          </div>

          {(hostAdapters.length !== 1 || !adapterType) && (
            <div>
              <Label>Runtime</Label>
              <Select
                ariaLabel="Runtime"
                value={adapterType}
                onChange={setAdapterType}
                disabled={!chosenHost || hostAdapters.length === 0}
                options={[
                  {
                    value: '',
                    label: !chosenHost
                      ? 'Select a host first'
                      : hostAdapters.length === 0 ? 'No runtime on this host — install one under Hosts' : 'Select a runtime',
                  },
                  ...hostAdapters.map(a => ({ value: a.adapter_type, label: a.display_name })),
                ]}
              />
            </div>
          )}
          {detectedIneligible.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Also detected on this host:</span>
              {detectedIneligible.map(runtime => (
                <Badge key={runtime} variant="muted">{runtime} · next phase</Badge>
              ))}
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={selected.host?.status === 'online' ? 'success' : 'muted'}>{selected.host?.name ?? 'Unknown host'} · {selected.host?.status ?? 'unknown'}</Badge>
          <Badge variant={selectedTrustMode === 'trusted_host' ? 'warning' : 'secondary'}>
            {selectedTrustMode === 'trusted_host' ? 'trusted host' : 'sandboxed'}
          </Badge>
          {selectedAdapter && (
            <Badge variant={runtimeInstalled ? 'secondary' : 'destructive'}>
              {selectedAdapter.capability_probe} {runtimeInstalled ? 'installed' : 'not installed on this host'}
            </Badge>
          )}
          {!fixedThreadId && installations.length > 1 && (
            <Select
              ariaLabel="Installation"
              value={effectiveInstallation}
              onChange={value => { setInstallation(value); setModel(''); setEffort('') }}
              options={installations.map(entry => ({ value: entry.id, label: installationLabel(entry) }))}
            />
          )}
          <span className="text-muted-foreground truncate">
            {selected.location.branch ?? 'no branch'} · {selected.location.dirty ? 'dirty' : 'clean'} · {selected.location.execution_ready ? 'ready' : 'not ready'}
          </span>
        </div>
      )}

      {selected && effectiveAdapterType && backends.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Model backend</Label>
            <Select
              ariaLabel="Model backend"
              value={backendUsable ? backend : ''}
              disabled={!anyBackendUsable}
              onChange={value => { setBackend(value); setModel(''); setEffort('') }}
              options={anyBackendUsable
                // An unusable backend stays listed, disabled, with its reason:
                // hiding it made the list look like it had forgotten the login.
                ? backends.map(b => ({ value: b.id, label: b.usable ? b.label : `${b.label} — ${b.reason ?? 'unavailable'}`, disabled: !b.usable }))
                : [{ value: '', label: 'No usable backend — log in or add a provider' }]}
            />
          </div>
          {/* One list per setting, showing every option the backend has and
              selecting the one in force. */}
          {availableModels.length > 0 && (
            <div>
              <Label>Model</Label>
              <Select
                ariaLabel="Model"
                value={model || currentModel}
                onChange={setModel}
                options={availableModels.map(choice => ({ value: choice.value, label: choiceLabel(choice) }))}
              />
            </div>
          )}
          {availableEfforts.length > 0 && (
            <div>
              <Label>Reasoning effort</Label>
              <Select
                ariaLabel="Reasoning effort"
                value={effort || currentEffort}
                onChange={setEffort}
                options={availableEfforts.map(choice => ({ value: choice.value, label: choiceLabel(choice) }))}
              />
            </div>
          )}
        </div>
      )}

      <div>
        <Label>{fixedThreadId ? 'Message' : 'Task'}</Label>
        <Textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Describe what to do in this workspace…"
          rows={3}
        />
      </div>

      {blocker && <p className="text-xs text-destructive">{blocker}</p>}
      <div className="flex justify-end">
        <Button
          onClick={dispatch}
          disabled={busy || !selected || !effectiveAdapterType || !prompt.trim() || !hostOnline || !runtimeInstalled || !backendUsable}
        >
          {busy ? 'Sending…' : fixedThreadId ? 'Send' : 'Start conversation'}
        </Button>
      </div>
    </Card>
  )
}
