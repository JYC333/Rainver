import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Check, X } from 'lucide-react'
import { hostsApi, projectsApi, tasksApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { Host, HostRuntimeAdapterOption } from '../../types/api'
import { ProjectSelector } from '../../components/ProjectFolderSelectors'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { useRemoteWorkspaces, lastUsedWorkspaceId, rememberWorkspaceId } from './useRemoteWorkspaces'

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
  const [prompt, setPrompt] = useState(initialPrompt)
  const [hosts, setHosts] = useState<Host[]>([])
  const [runtimeAdapters, setRuntimeAdapters] = useState<HostRuntimeAdapterOption[]>([])
  const [busy, setBusy] = useState(false)
  // ProjectSelector fetches its own project list once on mount and never
  // refetches — remounting it (via `key`) after an inline create is the
  // only way its trigger picks up the new project's name instead of
  // falling back to rendering the raw id (discovery review, P3).
  const [projectListKey, setProjectListKey] = useState(0)
  const { workspaces, loading: workspacesLoading } = useRemoteWorkspaces(projectId)

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

  async function dispatch() {
    const effectiveAdapterType = fixedAdapterType ?? adapterType
    if (!selected || !effectiveAdapterType || !prompt.trim()) return
    setBusy(true)
    try {
      const result = await tasksApi.createRunWithoutTask({
        project_id: projectId,
        project_folder_id: selected.folder.id,
        workspace_location_id: selected.location.id,
        adapter_type: effectiveAdapterType,
        prompt: prompt.trim(),
        thread_id: fixedThreadId ?? null,
      })
      if (!fixedFolderId) rememberWorkspaceId(projectId, selected.location.id)
      setPrompt('')
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
                  agent-space-host workspace add &lt;path-on-host&gt; --project {projectId}
                </code>
              </p>
            )}
          </div>

          {eligibleAdapters.length > 1 && (
            <div>
              <Label>Runtime</Label>
              <Select
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
