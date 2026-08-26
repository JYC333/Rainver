import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Check, X } from 'lucide-react'
import { hostsApi, projectsApi, providersApi, tasksApi, type ModelProviderOut } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, HostRuntimeAdapterOption, HostRuntimeProviderBinding, RuntimeOptionChoice } from '../../types/api'
import { ProjectSelector } from '../../components/ProjectFolderSelectors'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { useRemoteWorkspaces, lastUsedWorkspaceId, rememberWorkspaceId } from './useRemoteWorkspaces'
import { AMBIENT_BACKEND, INHERIT_BACKEND, eligibleProviders, providerModels, choiceLabel, findChoice } from './backendChoice'

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
  /** Supplied when the surrounding screen already fetched the list; the
   *  composer fetches its own only when mounted standalone. */
  providers?: ModelProviderOut[]
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

export default function DispatchComposer({
  initialProjectId = '',
  initialFolderId = '',
  fixedThreadId,
  fixedFolderId,
  fixedAdapterType,
  initialPrompt = '',
  providers: providedProviders,
  onDispatched,
  onProjectChange,
}: DispatchComposerProps) {
  const isNewConversation = !fixedThreadId
  const [hostId, setHostId] = useState('')
  const [projectId, setProjectId] = useState(initialProjectId)
  const [locationId, setLocationId] = useState('')
  const [adapterType, setAdapterType] = useState(fixedAdapterType ?? '')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [hosts, setHosts] = useState<Host[]>([])
  const [runtimeAdapters, setRuntimeAdapters] = useState<HostRuntimeAdapterOption[]>([])
  const [fetchedProviders, setFetchedProviders] = useState<ModelProviderOut[]>([])
  const providers = providedProviders ?? fetchedProviders
  // Defaults to inheriting, so sending a message never silently changes the
  // backend the conversation is already on.
  const [backend, setBackend] = useState(INHERIT_BACKEND)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  // What this host already runs each of its runtimes on. Without it the
  // default option is an unnamed promise — "this host's default" tells you
  // nothing about which model you are about to use.
  const [hostBindings, setHostBindings] = useState<HostRuntimeProviderBinding[] | null>(null)
  const [busy, setBusy] = useState(false)
  // ProjectSelector fetches its own project list once on mount and never
  // refetches — remounting it (via `key`) after an inline create is the
  // only way its trigger picks up the new project's name instead of
  // falling back to rendering the raw id (discovery review, P3).
  const [projectListKey, setProjectListKey] = useState(0)
  const { workspaces, loading: workspacesLoading } = useRemoteWorkspaces(projectId)

  useEffect(() => {
    if (providedProviders) return
    let cancelled = false
    providersApi.list()
      .then(items => { if (!cancelled) setFetchedProviders(items) })
      // Losing the list costs the ability to override, not the ability to
      // send: the dispatch simply inherits, which is the default anyway.
      .catch(() => {})
    return () => { cancelled = true }
  }, [providedProviders])

  useEffect(() => { onProjectChange?.(projectId) }, [projectId, onProjectChange])

  useEffect(() => {
    if (!isNewConversation) return
    const load = (showErrors: boolean) =>
      hostsApi.list()
        .then(result => setHosts(result.items.filter(h => h.kind === 'remote')))
        // A background refresh failing every 3s should not spam a toast —
        // only the first load reports it, same as HostsPanel's own pattern.
        .catch(error => { if (showErrors) toast.error(errMsg(error)) })
    void load(true)
    // Online/offline is exactly the fact that gates whether a host can even
    // be picked (below) — a one-time fetch went stale the moment a host's
    // connection state changed while this composer stayed open, matching
    // HostsPanel's own refresh cadence for the same reason.
    const timer = window.setInterval(() => load(false), HOST_LIST_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [isNewConversation])

  // Fetched unconditionally — a follow-up composer (fixedAdapterType set,
  // no runtime selector shown) still needs this to resolve `selectedAdapter`
  // below and keep checking the host actually reports the thread's pinned
  // runtime as installed (discovery review, P3: this used to run
  // unconditionally via a hardcoded command/adapter pair before that pair
  // was replaced by this endpoint).
  useEffect(() => {
    hostsApi.listRuntimeAdapters().then(result => setRuntimeAdapters(result.items)).catch(error => toast.error(errMsg(error)))
  }, [])

  const eligibleAdapters = useMemo(() => runtimeAdapters.filter(a => a.remote_eligible), [runtimeAdapters])

  // The common case (one implemented remote runtime) should not force a
  // click — pre-select it, same "kill the ceremony" spirit as C8 removing
  // the Agent step outright.
  useEffect(() => {
    if (!isNewConversation || adapterType || eligibleAdapters.length !== 1) return
    setAdapterType(eligibleAdapters[0].adapter_type)
  }, [isNewConversation, adapterType, eligibleAdapters])

  useEffect(() => {
    if (!projectId || workspaces.length === 0) return
    if (workspaces.some(w => w.location.id === locationId)) return
    const remembered = lastUsedWorkspaceId(projectId)
    const preferred =
      workspaces.find(w => w.location.id === remembered && (!hostId || w.host?.id === hostId)) ??
      workspaces.find(w => w.folder.id === (fixedFolderId ?? initialFolderId) && (!hostId || w.host?.id === hostId)) ??
      workspaces.find(w => w.location.preferred && (!hostId || w.host?.id === hostId)) ??
      workspaces.find(w => !hostId || w.host?.id === hostId) ??
      null
    if (preferred) setLocationId(preferred.location.id)
  }, [projectId, workspaces, locationId, fixedFolderId, initialFolderId, hostId])

  const workspacesForHost = useMemo(
    () => (hostId ? workspaces.filter(w => w.host?.id === hostId) : workspaces),
    [workspaces, hostId],
  )
  const selected = useMemo(() => workspaces.find(w => w.location.id === locationId) ?? null, [workspaces, locationId])
  const hostOnline = selected?.host?.status === 'online' && selected.location.execution_ready
  const selectedTrustMode = selected?.location.execution_host_kind === 'remote' ? 'trusted_host' : selected ? 'sandboxed' : null

  useEffect(() => {
    const hostId = selected?.host?.id
    if (!hostId) { setHostBindings(null); return }
    let cancelled = false
    hostsApi.listProviderBindings(hostId)
      .then(result => { if (!cancelled) setHostBindings(result.items) })
      // Losing this costs the *name* of the default, not the ability to send.
      .catch(() => { if (!cancelled) setHostBindings([]) })
    return () => { cancelled = true }
  }, [selected?.host?.id])

  const selectedAdapter = useMemo(
    () => runtimeAdapters.find(a => a.adapter_type === (fixedAdapterType ?? adapterType)) ?? null,
    [runtimeAdapters, fixedAdapterType, adapterType],
  )
  const runtimeInstalled = !selectedAdapter || Boolean(selected?.host?.capabilities_json?.runtimes?.includes(selectedAdapter.capability_probe))

  const detectedIneligible = useMemo(
    () =>
      selected?.host?.capabilities_json?.runtimes?.filter(runtime =>
        runtimeAdapters.some(a => a.capability_probe === runtime && !a.remote_eligible)) ?? [],
    [selected, runtimeAdapters],
  )

  const hostOptions = [
    { value: '', label: 'Select a host' },
    ...hosts.map(h => ({ value: h.id, label: `${h.name}${h.status === 'online' ? '' : ' (offline)'}`, disabled: h.status !== 'online' })),
  ]
  const workspaceOptions = [
    { value: '', label: workspacesLoading ? 'Loading workspaces…' : (projectId ? 'No workspace registered for this project yet' : 'Select a project first') },
    ...workspacesForHost.map(w => ({
      value: w.location.id,
      label: `${w.host?.name ?? 'Unknown host'} · ${w.folder.name}${w.location.preferred ? ' (preferred)' : ''}${w.location.branch ? ` · ${w.location.branch}` : ''}${w.location.dirty ? ' · dirty' : ''}`,
    })),
  ]

  const effectiveAdapterType = fixedAdapterType ?? adapterType
  const backendOptions = useMemo(
    () => eligibleProviders(providers, effectiveAdapterType),
    [providers, effectiveAdapterType],
  )
  // A provider that can back claude_code often cannot back codex or opencode,
  // so a selection made before switching runtimes would render as a bare id
  // and be sent anyway, failing as a 422 the user cannot read as "your earlier
  // pick no longer applies".
  useEffect(() => {
    setBackend(INHERIT_BACKEND)
    setModel('')
    setEffort('')
  }, [effectiveAdapterType])
  // The provider this host×runtime already uses, when it has one. `null` means
  // ambient login; `undefined` means the bindings are not loaded yet.
  const inheritedProvider = useMemo(() => {
    if (!hostBindings) return undefined
    const bound = hostBindings.find(b => b.adapter_type === effectiveAdapterType)
    if (!bound) return null
    return backendOptions.find(p => p.id === bound.model_provider_id) ?? null
  }, [hostBindings, effectiveAdapterType, backendOptions])

  const inheritedModel = useMemo(() => {
    if (!hostBindings) return null
    const bound = hostBindings.find(b => b.adapter_type === effectiveAdapterType)
    return bound?.model ?? inheritedProvider?.default_model ?? null
  }, [hostBindings, effectiveAdapterType, inheritedProvider])

  // What the machine's own login would run this runtime on, as that CLI's own
  // configuration has it. Nothing else knows: an unbound run's model is the
  // CLI's business, so without this "this machine's login" cannot say whether
  // it means opus or sonnet, sol or luna.
  // What this runtime told the host it can be set to. Asked over ACP by the
  // capability probe, because guessing was wrong in both directions: the
  // effort levels differ per runtime, and a model id can carry brackets of its
  // own that are part of its name.
  const runtimeOptions = useMemo(() => {
    const probe = selectedAdapter?.capability_probe
    return probe ? selected?.host?.capabilities_json?.options?.[probe] ?? null : null
  }, [selectedAdapter?.capability_probe, selected?.host?.capabilities_json])

  const ambient = useMemo(() => {
    const probe = selectedAdapter?.capability_probe
    const capabilities = selected?.host?.capabilities_json
    return {
      model: runtimeOptions?.current_model ?? (probe ? capabilities?.models?.[probe] ?? '' : ''),
      effort: runtimeOptions?.current_effort ?? (probe ? capabilities?.reasoning?.[probe] ?? '' : ''),
    }
  }, [runtimeOptions, selectedAdapter?.capability_probe, selected?.host?.capabilities_json])

  const ambientModels = useMemo<RuntimeOptionChoice[]>(() => runtimeOptions?.models ?? [], [runtimeOptions])
  const ambientModel = ambient.model || null
  // Named the same way the Model list names it: the bracketed variant suffix
  // identifies the model to the runtime but is not what a person reads.
  // Named as the runtime names it, so the backend row and the Model list agree.
  const ambientLabel = ambientModel
    ? `This machine's login · ${choiceLabel(findChoice(ambientModels, ambientModel) ?? { value: ambientModel })}${ambient.effort ? ` · ${ambient.effort}` : ''}`
    : "This machine's login"

  /** Names the default instead of merely promising one. */
  const inheritLabel = useMemo(() => {
    const base = fixedThreadId ? "Keep this conversation's backend" : "This host's default"
    if (fixedThreadId || inheritedProvider === undefined) return base
    if (!inheritedProvider) return `${base} · ${ambientLabel.replace("This machine's login", "this machine's login")}`
    return inheritedModel ? `${base} · ${inheritedProvider.name} · ${inheritedModel}` : `${base} · ${inheritedProvider.name}`
  }, [fixedThreadId, inheritedProvider, inheritedModel, ambientLabel])

  // Which provider's catalog the Model select offers. Sticking with the
  // inherited backend still lets a model be chosen from it — the server keeps
  // the provider and narrows only the model when `model` travels without
  // `model_provider_id`.
  const modelProvider = useMemo(() => {
    if (backend === AMBIENT_BACKEND) return undefined
    if (backend === INHERIT_BACKEND) {
      // Only for a new conversation, where "inherit" means this host's
      // default and is therefore knowable. An existing thread carries its own
      // backend, which may have been overridden on an earlier message — the
      // composer cannot see it, so offering the host default's catalog would
      // name models the thread's actual provider may not serve.
      return fixedThreadId ? undefined : inheritedProvider ?? undefined
    }
    return backendOptions.find(p => p.id === backend)
  }, [backend, fixedThreadId, inheritedProvider, backendOptions])

  const modelOptions = useMemo(() => providerModels(modelProvider), [modelProvider])
  /**
   * Whether the model list to offer is the runtime's own rather than a
   * provider's. True for an explicit "machine's login", and equally true when
   * *inheriting* a host default that is itself the machine's login — the
   * backend is the same either way, and requiring the user to restate it just
   * to see a model list made the default look like it had none.
   *
   * `inheritedProvider` is undefined while the host's bindings load, so this
   * waits rather than briefly offering the wrong list.
   */
  const runtimeIsTheBackend = backend === AMBIENT_BACKEND
    || (backend === INHERIT_BACKEND && !fixedThreadId && inheritedProvider === null)
  // Only where the runtime exposes the setting at all: OpenCode has none, and
  // asking for one it never offered is rejected as invalid_params.
  // Offered only where the runtime said it has them: OpenCode exposes none,
  // and a runtime that could not be asked yields none rather than a guess.
  const availableEfforts = useMemo<RuntimeOptionChoice[]>(() => runtimeOptions?.efforts ?? [], [runtimeOptions])

  /**
   * Whichever backend is in force decides both lists, and what each is
   * currently on. Selecting the current value rather than offering a synthetic
   * "default" entry keeps one name for one thing: the list is what can be
   * chosen, the selection is what is chosen.
   */
  const availableModels = useMemo<RuntimeOptionChoice[]>(
    // A provider's catalogue is bare ids; a runtime names its own choices.
    () => (runtimeIsTheBackend ? ambientModels : modelOptions.map(value => ({ value }))),
    [runtimeIsTheBackend, ambientModels, modelOptions],
  )
  const currentModel = runtimeIsTheBackend
    ? ambientModel ?? ''
    : modelProvider?.default_model ?? ''
  // Effort belongs to the runtime whichever backend answers, so its current
  // value is the runtime's own.
  const currentEffort = ambient.effort

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
        prompt: prompt.trim(),
        thread_id: fixedThreadId ?? null,
        // Presence, not truthiness: omitting the key means "whatever this
        // thread already runs on" (or the host default on a first message),
        // while an explicit null means the machine's own login. Sending null
        // for "inherit" would silently unbind the thread.
        ...(backend === INHERIT_BACKEND
          // Keep the resolved provider, narrow only the model — the server's
          // third request shape. Sending `model_provider_id` here would pin a
          // provider the caller did not choose.
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
      // The choice applied to this message; the thread now inherits it, so
      // leaving it selected would misrepresent the next one as another
      // override.
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

  return (
    <Card className="p-4 space-y-3">
      {isNewConversation && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Host</Label>
              <Select value={hostId} onChange={id => { setHostId(id); setLocationId('') }} options={hostOptions} />
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

          {eligibleAdapters.length > 1 && (
            <div>
              <Label>Runtime</Label>
              <Select
                ariaLabel="Runtime"
                value={adapterType}
                onChange={setAdapterType}
                options={[{ value: '', label: 'Select a runtime' }, ...eligibleAdapters.map(a => ({ value: a.adapter_type, label: a.display_name }))]}
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
          <Badge variant={hostOnline ? 'success' : 'muted'}>{selected.host?.name ?? 'Unknown host'} · {hostOnline ? 'online' : 'offline'}</Badge>
          <Badge variant={selectedTrustMode === 'trusted_host' ? 'warning' : 'secondary'}>
            {selectedTrustMode === 'trusted_host' ? 'trusted host' : 'sandboxed'}
          </Badge>
          {selectedAdapter && (
            <Badge variant={runtimeInstalled ? 'secondary' : 'destructive'}>
              {selectedAdapter.capability_probe} {runtimeInstalled ? 'installed' : 'not installed on this host'}
            </Badge>
          )}
          <span className="text-muted-foreground truncate">
            {selected.location.branch ?? 'no branch'} · {selected.location.dirty ? 'dirty' : 'clean'} · {selected.location.execution_ready ? 'ready' : 'not ready'}
          </span>
        </div>
      )}

      {selected && (fixedAdapterType ?? adapterType) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Model backend</Label>
            <Select
              ariaLabel="Model backend"
              value={backend}
              onChange={value => { setBackend(value); setModel(''); setEffort('') }}
              options={[
                { value: INHERIT_BACKEND, label: inheritLabel },
                { value: AMBIENT_BACKEND, label: ambientLabel },
                ...backendOptions.map(p => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          {/* One list per setting, showing every option the backend has and
              selecting the one in force. An "as configured" entry alongside a
              list the current value had been removed from said the same thing
              twice and hid the real name behind a label. */}
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

      <div className="flex justify-end">
        <Button
          onClick={dispatch}
          disabled={busy || !selected || !(fixedAdapterType ?? adapterType) || !prompt.trim() || !hostOnline || !runtimeInstalled}
        >
          {busy ? 'Sending…' : fixedThreadId ? 'Send' : 'Start conversation'}
        </Button>
      </div>
    </Card>
  )
}
