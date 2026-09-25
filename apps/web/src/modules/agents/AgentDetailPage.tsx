import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { FileCode2, Loader2, MessageSquare, Ban, Power } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, hostsApi } from '../../api/client'
import type { AgentOut, AgentRuntimeProfileOut, AgentVersionOut, Host, HostRuntimeDefinitionOption, Run, Proposal } from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import { Button } from '../../components/ui/button'
import { ConfirmDialog } from '../../components/ui/dialog'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { EmptyState } from '../../components/ui/empty-state'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs'
import { errMsg } from '../../lib/utils'
import { InputsView, OutputsView, ScheduleView, SafetyView } from './ConfigCards'
import {
  isScheduleEditorValueValid,
  ScheduleEditorFields,
  scheduleConfigFromEditor,
  scheduleEditorFromConfig,
  type ScheduleEditorValue,
} from './ScheduleEditor'
import AssistantSettingsPanel from './AssistantSettingsPanel'
import ProviderSelector from '../providers/ProviderSelector'
import {
  RetrievalToolDomainControls,
  mergeRetrievalToolDomains,
  readRetrievalToolDomains,
  type RetrievalToolDomainState,
} from './RetrievalToolDomainControls'
import { promptLibraryPath } from '../prompts/paths'
import { ContentAccessControl } from '../../components/ContentAccessControl'
import HostExecutionTargetPicker, { type HostExecutionSelection } from '../command_center/HostExecutionTargetPicker'

export default function AgentDetailPage() {
  const { agentId } = useParams()
  const { userId } = useSpace()
  const [agent, setAgent] = useState<AgentOut | null>(null)
  const [version, setVersion] = useState<AgentVersionOut | null>(null)
  const [versions, setVersions] = useState<AgentVersionOut[]>([])
  const [runtimeProfiles, setRuntimeProfiles] = useState<AgentRuntimeProfileOut[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!agentId) return
    const [a, vs, rs, rps, hs] = await Promise.all([
      agentsApi.get(agentId),
      agentsApi.listVersions(agentId).catch(() => [] as AgentVersionOut[]),
      agentsApi.listRunsForAgent(agentId).catch(() => [] as Run[]),
      agentsApi.listRuntimeProfiles(agentId).catch(() => [] as AgentRuntimeProfileOut[]),
      typeof hostsApi?.list === 'function'
        ? hostsApi.list().then(response => response.items).catch(() => [] as Host[])
        : Promise.resolve([] as Host[]),
    ])
    setAgent(a)
    setVersions(vs)
    setRuntimeProfiles(rps)
    setHosts(hs)
    setRuns(rs)
    setVersion(vs.find(v => v.id === a.current_version_id) ?? vs[0] ?? null)
    agentsApi.listProposals(agentId, 'pending').then(setProposals).catch(() => setProposals([]))
  }, [agentId])

  useEffect(() => {
    setLoading(true)
    reload().catch(err => toast.error(errMsg(err))).finally(() => setLoading(false))
  }, [reload])

  useEffect(() => {
    setActiveTab(null)
  }, [agentId])

  if (loading) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  if (!agent) return <div className="p-6 text-muted-foreground">Agent not found.</div>

  const isAssistant = agent.agent_kind === 'system_assistant'
  const isActive = agent.status === 'active'
  const hostProfile = runtimeProfiles.find(profile => profile.is_default && profile.execution_host_id)
    ?? runtimeProfiles.find(profile => profile.execution_host_id)
  const boundHost = hostProfile?.execution_host_id ? hosts.find(host => host.id === hostProfile.execution_host_id) : null
  const canResetHostContext = Boolean(hostProfile?.execution_host_id && boundHost?.owner_user_id === userId && boundHost.status === 'online')

  const toggleStatus = async () => {
    const next = isActive ? 'disabled' : 'active'
    setStatusBusy(true)
    try {
      const updated = await agentsApi.update(agent.id, { status: next })
      setAgent(updated)
      toast.success(next === 'disabled' ? 'Agent disabled — new runs are blocked by policy' : 'Agent enabled')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setStatusBusy(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            {agent.name} <StatusBadge status={agent.status} />
            {isAssistant && <Badge variant="secondary">System-managed</Badge>}
            {hostProfile && <Badge variant={boundHost?.status === 'online' ? 'secondary' : 'destructive'}>
              {hostProfile.workspace_mode === 'managed' ? 'Managed workspace' : 'Location'} on {boundHost?.name ?? hostProfile.execution_host_id}
              {boundHost?.status !== 'online' ? ' · offline' : ''}
            </Badge>}
          </h1>
          <p className="text-sm text-muted-foreground">{agent.description ?? 'No description'}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <ContentAccessControl resourceType="agent" resourceId={agent.id} ownerUserId={agent.created_by_user_id} />
          {/* Chat works for any agent: the chat turn runs the agent's current
              version through the same execution path (a disabled agent's turn
              is correctly blocked by policy). */}
          <Button asChild size="sm"><Link to={`/agents/${agent.id}/chat`}><MessageSquare className="size-3.5 mr-1" />Open chat</Link></Button>
          {canResetHostContext && (
            <>
              <Button size="sm" variant="outline" onClick={() => setResetConfirmOpen(true)}>Reset context</Button>
              <ConfirmDialog
                open={resetConfirmOpen}
                onOpenChange={setResetConfirmOpen}
                title="Reset this Agent's host context?"
                description="The next direct message starts a fresh vendor session. Files in its workspace stay."
                confirmLabel="Reset context"
                onConfirm={() => {
                  void (async () => {
                    try { await agentsApi.resetContext(agent.id); toast.success('Host context reset') }
                    catch (error) { toast.error(errMsg(error)) }
                  })()
                }}
              />
            </>
          )}
          {!isAssistant && (
            <Button
              size="sm"
              variant={isActive ? 'destructive' : 'success'}
              disabled={statusBusy}
              onClick={toggleStatus}
              title={isActive ? 'Disable this agent — blocks new run execution' : 'Enable this agent'}
            >
              {statusBusy
                ? <Loader2 className="size-3.5 animate-spin" />
                : isActive
                  ? <><Ban className="size-3.5 mr-1" />Disable</>
                  : <><Power className="size-3.5 mr-1" />Enable</>}
            </Button>
          )}
          <Button asChild size="sm" variant="outline"><Link to="/agents">All agents</Link></Button>
        </div>
      </div>

      <Tabs value={activeTab ?? (isAssistant ? 'preferences' : 'overview')} onValueChange={setActiveTab}>
        <TabsList className="w-full flex-wrap justify-start gap-1 h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {isAssistant && <TabsTrigger value="preferences">Preferences</TabsTrigger>}
          <TabsTrigger value="inputs">Inputs</TabsTrigger>
          <TabsTrigger value="outputs">Outputs</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="model">Runtime</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="safety">Review &amp; Safety</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        {isAssistant && (
          <TabsContent value="preferences">
            <AssistantSettingsPanel />
          </TabsContent>
        )}

        <TabsContent value="overview">
          <OverviewTab agent={agent} version={version} runs={runs} proposals={proposals} onSaved={reload} />
        </TabsContent>
        <TabsContent value="inputs">
          {version ? <InputsTab version={version} /> : <Card><NoVersion /></Card>}
        </TabsContent>
        <TabsContent value="outputs">
          <Card>{version ? <OutputsView version={version} /> : <NoVersion />}</Card>
        </TabsContent>
        <TabsContent value="schedule">
          {version ? <ScheduleTab agentId={agent.id} version={version} onSaved={reload} /> : <Card><NoVersion /></Card>}
        </TabsContent>
        <TabsContent value="model">
          {version ? <ModelTab agentId={agent.id} projectId={agent.project_id} version={version} profiles={runtimeProfiles} hosts={hosts} onSaved={reload} /> : <Card><NoVersion /></Card>}
        </TabsContent>
        <TabsContent value="tools">
          {version ? <ToolsTab agentId={agent.id} version={version} onSaved={reload} /> : <Card><NoVersion /></Card>}
        </TabsContent>
        <TabsContent value="safety">
          <Card>{version ? <SafetyView version={version} /> : <NoVersion />}</Card>
        </TabsContent>
        <TabsContent value="versions">
          <VersionsTab agentId={agent.id} versions={versions} currentId={agent.current_version_id} onSaved={reload} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab runs={runs} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ToolsTab({ agentId, version, onSaved }: {
  agentId: string
  version: AgentVersionOut
  onSaved: () => Promise<void>
}) {
  const [domains, setDomains] = useState<RetrievalToolDomainState>(() => readRetrievalToolDomains(version.tool_policy_json))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDomains(readRetrievalToolDomains(version.tool_policy_json))
  }, [version.id, version.tool_policy_json])

  async function save() {
    setSaving(true)
    try {
      await agentsApi.updateConfig(agentId, {
        tool_policy_json: mergeRetrievalToolDomains(version.tool_policy_json, domains),
      })
      toast.success('Retrieval tool settings updated (new version created)')
      await onSaved()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>Managed-run retrieval tools</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          These Agent permissions are immutable version policy shared by all selected Runtime Profiles. Runtime configuration cannot grant itself additional tools.
        </p>
      </div>
      <RetrievalToolDomainControls value={domains} onChange={setDomains} />
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : 'Save tool settings'}
      </Button>
    </Card>
  )
}

function NoVersion() {
  return <p className="text-sm text-muted-foreground">This agent has no current version configured.</p>
}

// ── Inputs / context ─────────────────────────────────────────────────────────

function InputsTab({ version }: {
  version: AgentVersionOut
}) {
  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <InputsView version={version} />
      </Card>
    </div>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────────

function OverviewTab({ agent, version, runs, proposals, onSaved }: {
  agent: AgentOut; version: AgentVersionOut | null; runs: Run[]; proposals: Proposal[]; onSaved: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt ?? '')
  const [saving, setSaving] = useState(false)
  const lastRun = runs[0]
  const promptRef = promptRefFromProvenance(version?.prompt_provenance_json)

  async function save() {
    setSaving(true)
    try {
      await agentsApi.updateConfig(agent.id, {
        name: name.trim(),
        description: description.trim() || null,
        system_prompt: systemPrompt.trim() || null,
      })
      toast.success('Agent updated (new version created)')
      setEditing(false)
      await onSaved()
    } catch (err) { toast.error(errMsg(err)) } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Identity &amp; role</CardTitle>
          {!editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
        </div>
        {editing ? (
          <div className="mt-3 space-y-3">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" />
            <Textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={4} placeholder="System prompt (role/identity)" />
            <p className="text-xs text-muted-foreground">Saving creates a new immutable agent version; the previous version is preserved.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : 'Save'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {agent.system_prompt
              ? <pre className="text-sm whitespace-pre-wrap font-sans text-foreground">{agent.system_prompt}</pre>
              : <p className="text-sm text-muted-foreground">No system prompt set.</p>}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle className="mb-2">Provenance</CardTitle>
        {agent.agent_kind === 'system_assistant' ? (
          <p className="text-sm text-muted-foreground">System-managed default assistant — the space's Chat identity. Its core prompt and safety policy are managed by the system; you can adjust preferences and configurable settings.</p>
        ) : agent.source_template_id ? (
          <div className="text-sm space-y-1">
            <p>Created from template <Link className="underline" to={`/agents/templates/${agent.source_template_id}`}>{agent.source_template_id}</Link></p>
            {agent.source_template_version_id && <p className="text-xs text-muted-foreground">Template version: <span className="font-mono">{agent.source_template_version_id}</span></p>}
            <p className="text-xs text-muted-foreground">Configuration is an independent snapshot — later template updates do not change this agent.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Created directly (not from a template).</p>
        )}
        <p className="text-xs text-muted-foreground mt-2">Current version: <span className="font-mono">{version?.version_label ?? '—'}</span></p>
        {promptRef && (
          <p className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <FileCode2 className="size-3.5 shrink-0" />
            <Link className="min-w-0 truncate underline" to={promptLibraryPath(promptRef.assetKey)}>
              {promptRef.assetKey}
            </Link>
            {promptRef.versionId && <span className="font-mono">v:{shortHash(promptRef.versionId)}</span>}
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardTitle className="mb-2">Last run</CardTitle>
          {lastRun
            ? <div className="text-sm flex items-center gap-2"><StatusBadge status={lastRun.status} /><span className="text-muted-foreground">{new Date(lastRun.created_at).toLocaleString()}</span></div>
            : <p className="text-sm text-muted-foreground">No runs yet.</p>}
          <p className="text-xs text-muted-foreground mt-2">Next run is scheduler-driven and not yet surfaced.</p>
        </Card>
        <Card>
          <CardTitle className="mb-2">Pending proposals</CardTitle>
          {proposals.length
            ? <p className="text-sm">{proposals.length} awaiting review <Badge variant="warning">review</Badge></p>
            : <p className="text-sm text-muted-foreground">None pending.</p>}
        </Card>
      </div>
    </div>
  )
}

// ── Schedule (editable) ─────────────────────────────────────────────────────────

function ScheduleTab({ agentId, version, onSaved }: { agentId: string; version: AgentVersionOut; onSaved: () => Promise<void> }) {
  const [schedule, setSchedule] = useState<ScheduleEditorValue>(() =>
    scheduleEditorFromConfig(version.schedule_config_json),
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSchedule(scheduleEditorFromConfig(version.schedule_config_json))
  }, [version])

  async function save() {
    setSaving(true)
    try {
      await agentsApi.updateConfig(agentId, { schedule_config_json: scheduleConfigFromEditor(schedule) })
      toast.success('Schedule updated (new version created)')
      await onSaved()
    } catch (err) { toast.error(errMsg(err)) } finally { setSaving(false) }
  }

  return (
    <Card className="space-y-4">
      <ScheduleView version={version} />
      <div className="border-t border-border pt-4 space-y-3">
        <CardTitle>Edit schedule</CardTitle>
        <ScheduleEditorFields value={schedule} onChange={setSchedule} />
        <p className="text-xs text-muted-foreground">Stored on the agent version. Actual scheduled execution is wired separately and not driven from here.</p>
        <Button size="sm" onClick={save} disabled={saving || !isScheduleEditorValueValid(schedule)}>{saving ? <Loader2 className="size-4 animate-spin" /> : 'Save schedule'}</Button>
      </div>
    </Card>
  )
}

// ── Model (editable) ──────────────────────────────────────────────────────────

function ModelTab({
  agentId,
  projectId,
  version,
  profiles,
  hosts,
  onSaved,
}: {
  agentId: string
  projectId: string | null
  version: AgentVersionOut
  profiles: AgentRuntimeProfileOut[]
  hosts: Host[]
  onSaved: () => Promise<void>
}) {
  const defaultProfile = profiles.find(profile => profile.is_default) ?? profiles[0] ?? null
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfile?.id ?? '')
  const selectedProfile = selectedProfileId
    ? profiles.find(profile => profile.id === selectedProfileId) ?? null
    : null
  const [hostExecution, setHostExecution] = useState<HostExecutionSelection | null>(() => hostExecutionSelection(selectedProfile))
  const runtimeConfig = (selectedProfile?.runtime_config_json ?? {}) as Record<string, unknown>
  const runtimePolicy = (selectedProfile?.runtime_policy_json ?? {}) as Record<string, unknown>
  const [name, setName] = useState(selectedProfile?.name ?? 'Default')
  const [runtimeKey, setRuntimeKey] = useState(
    selectedProfile?.runtime_key ?? 'opencode',
  )
  // The Profile's provider binding is its own authority (`provider_binding`),
  // not something re-derived here from backend_mode plus a model string.
  const [model, setModel] = useState(selectedProfile?.provider_binding?.model ?? '')
  const [providerSelection, setProviderSelection] = useState<{ provider_id: string; model: string } | null>(
    providerSelectionFromBinding(selectedProfile),
  )
  const [backendMode, setBackendMode] = useState<'runtime_native' | 'model_provider'>(selectedProfile?.backend_mode ?? 'runtime_native')
  const [enabled, setEnabled] = useState(selectedProfile?.enabled ?? true)
  const [isDefault, setIsDefault] = useState(selectedProfile?.is_default ?? profiles.length === 0)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  // Runtime selection comes only from the ACP catalog. Backend support is
  // read from each runtime's definition, not inferred from its display name.
  const [cliAdapters, setCliAdapters] = useState<HostRuntimeDefinitionOption[]>([])
  // A catalog that failed to load is not a catalog that says "unsupported":
  // swallowing it hid every backend-mode control while the Profile still
  // claimed provider mode, leaving no way back.
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // An empty catalog and a catalog that has not answered yet are different
  // facts. Without this flag every open of a `model_provider` Profile flashed
  // "this runtime does not support a ModelProvider binding" until the first
  // response landed.
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [providerModeNotice, setProviderModeNotice] = useState<string | null>(null)
  const loadCatalog = useCallback(() => {
    setCatalogLoading(true)
    hostsApi.listRuntimeDefinitions()
      .then(result => { setCliAdapters(result.items); setCatalogError(null) })
      .catch(error => { setCliAdapters([]); setCatalogError(errMsg(error)) })
      .finally(() => { setCatalogLoading(false) })
  }, [])
  useEffect(() => { loadCatalog() }, [loadCatalog])
  const adapter = cliAdapters.find(candidate => candidate.runtime_key === runtimeKey) ?? null
  const supportsModelProvider = adapter?.supports_model_provider === true
  // Either backend mode is valid on either Host kind: a dispatched Run is
  // handed a short-lived proxy lease URL, never a key, and the daemon's
  // bound-run environment filter keeps a paired machine's own vendor keys out
  // of it (AGENT_RUNTIME_AUTHORITY, "Paired Host path"). What `model_provider`
  // may not be is *unbound* — the complete execution target below is what
  // admission actually requires.
  const canUseModelProvider = supportsModelProvider
  const supportsProviderSelection = backendMode === 'model_provider' && canUseModelProvider
  const requireClaudeCompatible = adapter?.provider_api === 'claude_compatible'
  const requireOpenAiCompatible = adapter?.provider_api === 'openai_compatible'
  const requireVendorCompatible = adapter?.provider_api === 'vendor'
  useEffect(() => {
    setSelectedProfileId(defaultProfile?.id ?? '')
  }, [agentId, defaultProfile?.id])

  // The one place the composer is seeded from. "New profile" only clears the
  // selection: this effect is keyed on that selection and fires on the very
  // transition the click causes, so defaults written in the handler were
  // overwritten here a render later. A new Profile inherits the default
  // Profile's execution target, which is what a second Profile for the same
  // Agent almost always wants and is the only complete target the composer
  // can offer without another round of picking.
  useEffect(() => {
    const composingNew = selectedProfile === null && profiles.length > 0
    const execution = hostExecutionSelection(composingNew ? defaultProfile : selectedProfile)
    setName(selectedProfile?.name ?? (composingNew ? 'New runtime profile' : 'Default'))
    setRuntimeKey(selectedProfile?.runtime_key ?? execution?.runtime_key ?? 'opencode')
    setBackendMode(selectedProfile?.backend_mode ?? 'runtime_native')
    setModel(selectedProfile?.provider_binding?.model ?? '')
    setProviderSelection(providerSelectionFromBinding(selectedProfile))
    setProviderModeNotice(null)
    setEnabled(selectedProfile?.enabled ?? true)
    setIsDefault(selectedProfile?.is_default ?? profiles.length === 0)
    setHostExecution(execution)
  }, [selectedProfile?.id, version.id])

  function changeRuntime(nextRuntimeKey: string) {
    setRuntimeKey(nextRuntimeKey)
    setHostExecution(current => current ? { ...current, runtime_key: nextRuntimeKey } : current)
    const nextAdapter = cliAdapters.find(candidate => candidate.runtime_key === nextRuntimeKey)
    if (nextAdapter && !nextAdapter.supports_model_provider) {
      resetToRuntimeNative(`${nextAdapter.display_name} runs on its own account; this Profile was switched back to runtime-native mode.`)
    }
  }

  /** Undo a provider binding the new target cannot honour, and say so. */
  function resetToRuntimeNative(reason: string) {
    if (backendMode === 'runtime_native') return
    setProviderModeNotice(reason)
    setBackendMode('runtime_native')
    setProviderSelection(null)
    setModel('')
  }

  function changeExecutionTarget(next: HostExecutionSelection | null) {
    setHostExecution(next)
    if (!next) return
    // Only the runtime can refuse the binding; the Host kind cannot.
    changeRuntime(next.runtime_key)
  }

  function changeBackendMode(nextMode: 'runtime_native' | 'model_provider') {
    setBackendMode(nextMode)
    setProviderModeNotice(null)
    if (nextMode === 'runtime_native') {
      setProviderSelection(null)
      setModel('')
    }
  }

  function changeProviderSelection(next: { provider_id: string; model: string } | null) {
    setProviderSelection(next)
    if (next?.model) setModel(next.model)
    if (!next) setModel('')
  }

  async function save() {
    const selectedModel = providerSelection?.model || model.trim()
    if (!hostExecution) {
      toast.error('Choose an available Host, runtime and installation before saving this Profile')
      return
    }
    if (backendMode === 'model_provider' && (!canUseModelProvider || !providerSelection?.provider_id || !selectedModel)) {
      toast.error('ModelProvider mode requires a runtime that supports it and an explicit ModelProvider and model')
      return
    }
    setSaving(true)
    try {
      // Retired runtime/model keys are refused by the server (B58). Deleting
      // them here would have turned an authority violation into a silent save.
      const body = {
        name: name.trim() || 'Default',
        runtime_key: runtimeKey,
        runtime_config_json: runtimeConfig,
        runtime_policy_json: runtimePolicy,
        backend_mode: backendMode,
        execution_host_id: hostExecution.host_id,
        workspace_location_id: hostExecution.workspace_location_id,
        workspace_mode: hostExecution.workspace_mode,
        runtime_installation: hostExecution.installation,
        model_provider_id: backendMode === 'model_provider' ? providerSelection?.provider_id ?? null : null,
        model_name: backendMode === 'model_provider' ? selectedModel : null,
        enabled,
        is_default: isDefault,
      }
      if (selectedProfile) await agentsApi.updateRuntimeProfile(agentId, selectedProfile.id, body)
      else await agentsApi.createRuntimeProfile(agentId, body)
      toast.success('Runtime profile saved')
      await onSaved()
    } catch (err) { toast.error(errMsg(err)) } finally { setSaving(false) }
  }

  /** Clearing the selection is the whole action; the reset effect above seeds the form. */
  function newProfile() {
    setSelectedProfileId('')
  }

  const selectedHost = selectedProfile?.execution_host_id
    ? hosts.find(host => host.id === selectedProfile.execution_host_id)
    : null

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Runtime Profiles</CardTitle>
        <Badge variant={selectedHost?.kind === 'remote' ? 'secondary' : 'muted'}>
          {selectedHost?.kind === 'server' || !selectedProfile?.execution_host_id
            ? 'Server Runtime'
            : selectedHost?.name ?? 'Execution Host'}
          {selectedHost?.kind === 'remote' ? ' · owner-managed' : ''}
        </Badge>
        <Button size="sm" variant="outline" onClick={newProfile}>New profile</Button>
      </div>
      {selectedProfile?.execution_host_id && selectedHost?.kind === 'remote' && (
        <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/20 px-3 py-2">
          Runs in {selectedProfile.workspace_mode === 'managed' ? 'a managed workspace' : <>Location <span className="font-mono">{selectedProfile.workspace_location_id}</span></>} on host{' '}
          <span className="font-mono">{selectedHost.name}</span> using installation{' '}
          <span className="font-mono">{selectedProfile.runtime_installation}</span>. Only the host owner can trigger this specialist from a Room.
        </p>
      )}
      {selectedHost?.kind === 'server' && (
        <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/20 px-3 py-2">
          Server Runtime is provisioned and health-checked by Rainver. Its native account is instance-wide and shared by people authorized to execute Agents there.
        </p>
      )}
      {profiles.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Profile</label>
          <Select
            ariaLabel="Profile"
            value={selectedProfile?.id ?? ''}
            onChange={setSelectedProfileId}
            options={profiles.map(profile => ({
              value: profile.id,
              label: `${profile.name}${profile.is_default ? ' · default' : ''}${profile.enabled ? '' : ' · disabled'} · ${profile.runtime_key}`,
            }))}
          />
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Name</label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Default" />
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Execution target</p>
        <HostExecutionTargetPicker
          // Remounted per Profile so a parent-driven clear is unambiguous: the
          // picker's own sync effect ignores a null value (that is what it
          // emits for an incomplete selection of its own), so without a fresh
          // mount it would keep showing the previous Profile's Host.
          key={selectedProfileId || 'new'}
          projectId={projectId}
          backendMode={backendMode}
          value={hostExecution}
          onChange={changeExecutionTarget}
          onRuntimeChange={changeRuntime}
          disabled={saving}
        />
      </div>
      {catalogError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <span>The runtime catalog could not be loaded, so backend-mode support is unknown: {catalogError}</span>
          <Button size="sm" variant="outline" onClick={loadCatalog}>Retry catalog</Button>
        </div>
      )}
      {providerModeNotice && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">{providerModeNotice}</p>
      )}
      {/* Kept on screen whenever the Profile still claims provider mode, even
          when the runtime or Host cannot support it — otherwise the only
          control that can undo that claim disappears with it. */}
      {(supportsModelProvider || backendMode === 'model_provider') && (
        <label className="block space-y-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Backend mode</span>
          <Select
            ariaLabel="Backend mode"
            value={backendMode}
            onChange={value => changeBackendMode(value as 'runtime_native' | 'model_provider')}
            options={[
              { value: 'runtime_native', label: 'Runtime native account' },
              { value: 'model_provider', label: 'Rainver ModelProvider proxy', disabled: !catalogLoading && !canUseModelProvider },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Native mode uses the selected runtime copy&apos;s own login. Provider mode sends requests through Rainver&apos;s short-lived proxy lease; the upstream key never reaches the runtime process.
          </p>
          {backendMode === 'model_provider' && !canUseModelProvider && !catalogLoading && (
            <p role="alert" className="text-xs text-destructive">
              {catalogError
                ? 'Backend-mode support cannot be confirmed while the runtime catalog is unavailable.'
                : `${adapter?.display_name ?? runtimeKey} does not support a Rainver ModelProvider binding.`}
              {' '}Switch this Profile back to the runtime native account to save it.
            </p>
          )}
        </label>
      )}
      {selectedProfile && (
        <p className="text-xs text-muted-foreground">
          Saved provider binding: {selectedProfile.provider_binding?.state === 'bound'
            ? `${selectedProfile.provider_binding.provider_id ?? 'provider'} · ${selectedProfile.provider_binding.model ?? 'provider default'}`
            : 'none — this Profile uses the runtime\u2019s own account.'}
        </p>
      )}
      {supportsProviderSelection && (
        <ProviderSelector
          value={providerSelection}
          onChange={changeProviderSelection}
          required={false}
          requireClaudeCompatible={requireClaudeCompatible}
          requireOpenAiCompatible={requireOpenAiCompatible}
          requireVendorCompatible={requireVendorCompatible}
          emptyLabel={adapter ? `${adapter.display_name} default` : 'Agent/space default provider'}
        />
      )}
      {backendMode === 'model_provider' && <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Model</label>
        <Input
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder={providerSelection?.provider_id ? 'claude-sonnet-4-6' : 'Provider default'}
          className="font-mono"
          disabled={supportsProviderSelection && !providerSelection?.provider_id}
        />
      </div>}
      <div>
        <button type="button" onClick={() => setShowAdvanced(s => !s)} className="text-xs text-muted-foreground underline">
          {showAdvanced ? 'Hide' : 'Show'} advanced (raw JSON)
        </button>
        {showAdvanced && (
          <pre className="mt-2 text-xs bg-muted rounded-md p-3 overflow-auto">{JSON.stringify({
            runtime_config_json: runtimeConfig,
            runtime_policy_json: runtimePolicy,
          }, null, 2)}</pre>
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} /> Default for this agent
        </label>
      </div>
      <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : 'Save runtime profile'}</Button>
    </Card>
  )
}

/** A Profile's provider binding is the authority for what it is bound to. */
function providerSelectionFromBinding(profile: AgentRuntimeProfileOut | null): { provider_id: string; model: string } | null {
  const binding = profile?.provider_binding
  if (!binding || binding.state !== 'bound' || !binding.provider_id) return null
  return { provider_id: binding.provider_id, model: binding.model ?? '' }
}

function hostExecutionSelection(profile: AgentRuntimeProfileOut | null): HostExecutionSelection | null {
  if (!profile?.execution_host_id || !profile.workspace_mode || !profile.runtime_installation) return null
  if (profile.workspace_mode === 'location' && !profile.workspace_location_id) return null
  return {
    host_id: profile.execution_host_id,
    workspace_location_id: profile.workspace_mode === 'managed' ? null : profile.workspace_location_id,
    workspace_mode: profile.workspace_mode,
    runtime_key: profile.runtime_key,
    installation: profile.runtime_installation,
  }
}

// ── Versions ────────────────────────────────────────────────────────────────────

function VersionsTab({ agentId, versions, currentId, onSaved }: {
  agentId: string; versions: AgentVersionOut[]; currentId: string | null; onSaved: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  async function restore(versionId: string) {
    setBusy(versionId)
    try {
      await agentsApi.restoreVersion(agentId, versionId)
      toast.success('Restored as a new version')
      await onSaved()
    } catch (err) { toast.error(errMsg(err)) } finally { setBusy(null) }
  }

  if (versions.length === 0) return <Card><EmptyState title="No versions" /></Card>

  return (
    <div className="space-y-3">
      {versions.map(v => (
        <Card key={v.id}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium flex items-center gap-2">
                {v.version_label}
                {v.id === currentId && <Badge variant="success">current</Badge>}
                {v.source_proposal_id && <Badge variant="outline">from proposal</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">{new Date(v.created_at).toLocaleString()}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(open === v.id ? null : v.id)}>{open === v.id ? 'Hide' : 'View config'}</Button>
              {v.id !== currentId && (
                <Button size="sm" variant="outline" disabled={busy === v.id} onClick={() => restore(v.id)}>
                  {busy === v.id ? <Loader2 className="size-4 animate-spin" /> : 'Restore'}
                </Button>
              )}
            </div>
          </div>
          {open === v.id && (
            <pre className="mt-3 text-xs bg-muted rounded-md p-3 overflow-auto max-h-80">{JSON.stringify({
              system_prompt: v.system_prompt,
              prompt_provenance_json: v.prompt_provenance_json,
              context_policy_json: v.context_policy_json,
              memory_policy_json: v.memory_policy_json,
              output_policy_json: v.output_policy_json,
              schedule_config_json: v.schedule_config_json,
            }, null, 2)}</pre>
          )}
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">Restoring copies the selected version's config into a new version — old versions are never mutated.</p>
    </div>
  )
}

function promptRefFromProvenance(value: unknown): { assetKey: string; versionId: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const assetKey = typeof record.asset_key === 'string' && record.asset_key.trim() ? record.asset_key : null
  if (!assetKey) return null
  return {
    assetKey,
    versionId: typeof record.version_id === 'string' && record.version_id.trim() ? record.version_id : null,
  }
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

// ── Runs ──────────────────────────────────────────────────────────────────────

function RunsTab({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return <Card><EmptyState title="No runs yet" description="This agent hasn't been run. Runs will appear here once it executes." /></Card>
  }
  return (
    <div className="space-y-2">
      {runs.map(r => (
        <Card key={r.id} className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm flex items-center gap-2"><StatusBadge status={r.status} /> <span className="text-muted-foreground">{r.trigger_origin} · {r.mode}</span></p>
            <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</p>
          </div>
          <Link to={`/runs/${r.id}`} className="text-xs underline text-muted-foreground">View run</Link>
        </Card>
      ))}
    </div>
  )
}
