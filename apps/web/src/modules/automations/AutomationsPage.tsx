import { useState, useEffect, useId } from 'react'
import { Archive, Clock, Loader2, Pause, Play, Plus, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { automationsApi, agentsApi, evolutionApi, projectsApi } from '../../api/client'
import type { AutomationOut, AutomationTargetType, AutomationTriggerType, AgentOut, EvolvableAsset, EvolvableAssetVersion, Project, WorkflowExecutionSummary } from '../../types/api'
import { useSpace } from '../../contexts/SpaceContext'
import { SpaceLink } from '../../core/spaceNav'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 15 min', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 9am', expr: '0 9 * * *' },
  { label: 'Weekdays 9am', expr: '0 9 * * 1-5' },
]

const fieldLabel = 'text-[11px] font-medium text-muted-foreground uppercase tracking-wider'
const selectCls = 'flex h-9 w-full rounded-md border border-border bg-input px-3 text-sm'

function fmt(dt: string | null): string {
  if (!dt) return '—'
  try { return new Date(dt).toLocaleString() } catch { return dt }
}

function cfgString(cfg: Record<string, unknown> | null, key: string): string {
  const v = cfg?.[key]
  return typeof v === 'string' ? v : ''
}

function cfgBool(cfg: Record<string, unknown> | null, key: string): boolean {
  return cfg?.[key] === true
}

function cfgBoolDefault(cfg: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  const value = cfg?.[key]
  return typeof value === 'boolean' ? value : fallback
}

function automationTarget(auto: AutomationOut): AutomationTargetType {
  const target = cfgString(auto.config_json, 'target_type')
  if (target === 'knowledge_retrieval_maintenance') return 'knowledge_retrieval_maintenance'
  if (target === 'context_ops_review_cycle') return 'context_ops_review_cycle'
  if (target === 'workflow') return 'workflow'
  return 'agent_run'
}

function shortTargetLabel(target: AutomationTargetType): string {
  if (target === 'knowledge_retrieval_maintenance') return 'knowledge maintenance'
  if (target === 'context_ops_review_cycle') return 'context ops review cycle'
  if (target === 'workflow') return 'workflow'
  return 'agent run'
}

function defaultName(target: AutomationTargetType): string {
  if (target === 'knowledge_retrieval_maintenance') return 'Knowledge maintenance scan'
  if (target === 'context_ops_review_cycle') return 'Context Review Cycle'
  if (target === 'workflow') return 'Workflow automation'
  return 'Automation'
}

function isAutomationOut(value: unknown): value is AutomationOut {
  return Boolean(value && typeof value === 'object' && 'id' in value && 'name' in value && 'status' in value)
}

function AddAutomationForm({ agents, projects, workflowAssets, onAdded, canCreate }: {
  agents: AgentOut[]
  projects: Project[]
  workflowAssets: EvolvableAsset[]
  onAdded: (automation: AutomationOut) => void
  canCreate: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [targetType, setTargetType] = useState<AutomationTargetType>('agent_run')
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>('schedule')
  const [cron, setCron] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState(BROWSER_TZ)
  const [prompt, setPrompt] = useState('')
  const [createPacket, setCreatePacket] = useState(false)
  const [includeMemoryMaintenance, setIncludeMemoryMaintenance] = useState(true)
  const [workflowAssetKey, setWorkflowAssetKey] = useState('')
  const [workflowVersionId, setWorkflowVersionId] = useState('')
  const [workflowResolution, setWorkflowResolution] = useState<'pin' | 'follow'>('pin')
  const [workflowInputJson, setWorkflowInputJson] = useState('{}')
  const [workflowVersions, setWorkflowVersions] = useState<EvolvableAssetVersion[]>([])
  const [saving, setSaving] = useState(false)

  const selectedWorkflowAsset = workflowAssets.find(asset => asset.asset_key === workflowAssetKey) ?? null

  useEffect(() => {
    if (!selectedWorkflowAsset) { setWorkflowVersions([]); setWorkflowVersionId(''); return }
    let active = true
    void evolutionApi.assetVersions(selectedWorkflowAsset.id).then(versions => { if (active) setWorkflowVersions(versions.filter(version => ['approved', 'candidate', 'testing'].includes(version.status))) }).catch(err => { if (active) toast.error(errMsg(err)) })
    return () => { active = false }
  }, [selectedWorkflowAsset])

  function reset() {
    setName(''); setAgentId(''); setProjectId(''); setTargetType('agent_run'); setTriggerType('schedule')
    setCron('0 9 * * *'); setTimezone(BROWSER_TZ); setPrompt(''); setCreatePacket(false); setIncludeMemoryMaintenance(true); setWorkflowAssetKey(''); setWorkflowVersionId(''); setWorkflowResolution('pin'); setWorkflowInputJson('{}'); setWorkflowVersions([]); setExpanded(false)
  }

  function handleTargetChange(next: AutomationTargetType) {
    setTargetType(next)
    if (next === 'context_ops_review_cycle') {
      setCreatePacket(true)
      setIncludeMemoryMaintenance(true)
    }
    if (next === 'knowledge_retrieval_maintenance') setCreatePacket(false)
    if (next === 'workflow' && triggerType === 'schedule') setWorkflowResolution('pin')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canCreate) { toast.error('Select an operational space first'); return }
    if (!agentId) { toast.error('Pick an agent for this automation'); return }
    if (triggerType === 'schedule' && !cron.trim()) { toast.error('A cron expression is required'); return }
    if (targetType === 'workflow') {
      if (!workflowAssetKey) { toast.error('Pick a workflow template'); return }
      if (workflowResolution === 'pin' && !workflowVersionId) { toast.error('Pinned workflow automation requires a version'); return }
      if (triggerType === 'schedule' && workflowResolution === 'follow') { toast.error('Scheduled workflow automations must use a pinned version'); return }
      try {
        const parsed = JSON.parse(workflowInputJson)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      } catch { toast.error('Workflow input must be a JSON object'); return }
    }

    const config: Record<string, unknown> = { target_type: targetType }
    if (triggerType === 'schedule') { config.cron = cron.trim(); config.timezone = timezone.trim() || 'UTC' }
    if (targetType === 'agent_run' && prompt.trim()) config.prompt = prompt.trim()
    if (targetType === 'knowledge_retrieval_maintenance') {
      config.create_packet = createPacket
    }
    if (targetType === 'context_ops_review_cycle') {
      config.create_packets = createPacket
      config.include_memory_maintenance = includeMemoryMaintenance
    }
    if (targetType === 'workflow') {
      config.workflow_asset_key = workflowAssetKey
      config.workflow_resolution = workflowResolution
      if (workflowVersionId) config.workflow_version_id = workflowVersionId
      config.input_json = JSON.parse(workflowInputJson)
    }

    setSaving(true)
    try {
      const automation = await automationsApi.create({
        name: name.trim() || defaultName(targetType),
        agent_id: agentId,
        project_id: (targetType === 'agent_run' || targetType === 'workflow') && projectId ? projectId : undefined,
        trigger_type: triggerType,
        config_json: config,
      })
      toast.success('Automation created')
      reset()
      onAdded(automation)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  if (!expanded) {
    return (
      <Button variant="outline" size="sm" onClick={() => setExpanded(true)} disabled={!canCreate}>
        <Plus className="size-3.5 mr-1.5" />
        New automation
      </Button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 border border-border rounded-lg bg-accent/30">
      <div className="space-y-1.5">
        <label className={fieldLabel}>Agent</label>
        <select value={agentId} onChange={e => setAgentId(e.target.value)} className={selectCls}>
          <option value="">Select an agent…</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {agents.length === 0 && (
          <p className="text-xs text-muted-foreground">No agents yet — create one on the Agents page first.</p>
        )}
        {targetType !== 'agent_run' && (
          <p className="text-xs text-muted-foreground">Workflow automation uses the selected agent for execution; maintenance targets use it for attribution only.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <label className={fieldLabel}>Target</label>
        <select value={targetType} onChange={e => handleTargetChange(e.target.value as AutomationTargetType)} className={selectCls}>
          <option value="agent_run">Agent run</option>
          <option value="knowledge_retrieval_maintenance">Knowledge maintenance scan</option>
          <option value="context_ops_review_cycle">Context Review Cycle</option>
          <option value="workflow">Workflow</option>
        </select>
      </div>

      {(targetType === 'agent_run' || targetType === 'workflow') && (
        <div className="space-y-1.5">
          <label className={fieldLabel}>Project (optional)</label>
          <select value={projectId} onChange={e => setProjectId(e.target.value)} className={selectCls}>
            <option value="">No project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">Bound runs read project evidence and memory, and their outputs are attributed to the project.</p>
        </div>
      )}

      {targetType === 'workflow' && <div className="space-y-3 rounded-md border border-border p-3"><div className="space-y-1.5"><label className={fieldLabel}>Workflow template</label><select value={workflowAssetKey} onChange={e => { setWorkflowAssetKey(e.target.value); setWorkflowVersionId('') }} className={selectCls}><option value="">Select workflow…</option>{workflowAssets.map(asset => <option key={asset.id} value={asset.asset_key}>{asset.display_name}</option>)}</select></div><div className="grid gap-3 md:grid-cols-2"><div className="space-y-1.5"><label className={fieldLabel}>Resolution</label><select value={workflowResolution} onChange={e => setWorkflowResolution(e.target.value as 'pin' | 'follow')} className={selectCls} disabled={triggerType === 'schedule'}><option value="pin">Pin version</option><option value="follow">Follow approved version</option></select></div><div className="space-y-1.5"><label className={fieldLabel}>Version</label><select value={workflowVersionId} onChange={e => setWorkflowVersionId(e.target.value)} className={selectCls} disabled={workflowResolution !== 'pin'}><option value="">Select version…</option>{workflowVersions.map(version => <option key={version.id} value={version.id}>v{version.version} · {version.status}</option>)}</select></div></div><div className="space-y-1.5"><label className={fieldLabel}>Workflow input JSON</label><textarea value={workflowInputJson} onChange={e => setWorkflowInputJson(e.target.value)} rows={5} className="flex w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xs" /></div>{triggerType === 'schedule' && <p className="text-xs text-muted-foreground">Scheduled workflow automations are pinned so future executions remain reproducible.</p>}</div>}

      <div className="space-y-1.5">
        <label className={fieldLabel}>Name</label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={targetType === 'agent_run' ? 'Daily summary' : defaultName(targetType)}
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <label className={fieldLabel}>Trigger</label>
        <select value={triggerType} onChange={e => setTriggerType(e.target.value as AutomationTriggerType)} className={selectCls}>
          <option value="schedule">Schedule (cron)</option>
          <option value="manual">Manual only</option>
        </select>
      </div>

      {triggerType === 'schedule' && (
        <>
          <div className="space-y-1.5">
            <label className={fieldLabel}>Cron expression</label>
            <Input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *" className="font-mono text-sm" />
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map(p => (
                <button key={p.expr} type="button" onClick={() => setCron(p.expr)}
                  className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent">
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">min hour day month weekday — e.g. <span className="font-mono">0 9 * * 1-5</span></p>
          </div>
          <div className="space-y-1.5">
            <label className={fieldLabel}>Timezone</label>
            <Input value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="UTC" className="font-mono text-sm" />
          </div>
          {targetType === 'agent_run' ? (
            <div className="flex items-start gap-2 text-xs text-muted-foreground p-2 rounded-md bg-amber-500/10">
              <ShieldCheck className="size-3.5 mt-0.5 shrink-0 text-amber-600" />
              <span>Creating a schedule pre-authorizes this automation to run unattended with the agent's configured credentials. Archiving it revokes that authorization.</span>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-xs text-muted-foreground p-2 rounded-md bg-accent">
              <ShieldCheck className="size-3.5 mt-0.5 shrink-0" />
              <span>Scheduled operations run as the owner/admin actor and save private operational reports. They do not use model credentials.</span>
            </div>
          )}
        </>
      )}

      {targetType === 'agent_run' ? (
        <div className="space-y-1.5">
          <label className={fieldLabel}>Prompt (optional)</label>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
            placeholder="What should the agent do on each run?"
            className="flex w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
        </div>
      ) : (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={createPacket}
              onChange={e => setCreatePacket(e.target.checked)}
              className="mt-1"
            />
            <span>{targetType === 'context_ops_review_cycle' ? 'Create Context Review Cycle review packets after saving reports.' : 'Create a maintenance proposal packet after saving the private report.'}</span>
          </label>
          {targetType === 'context_ops_review_cycle' && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeMemoryMaintenance}
                onChange={e => setIncludeMemoryMaintenance(e.target.checked)}
                className="mt-1"
              />
              <span>Include Memory maintenance scan.</span>
            </label>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : 'Create'}</Button>
        <Button type="button" size="sm" variant="outline" onClick={reset}>Cancel</Button>
      </div>
    </form>
  )
}

function AutomationCard({ auto, agentName, projectName, projects, onChanged }: {
  auto: AutomationOut
  agentName: string
  projectName: string | null
  projects: Project[]
  onChanged: (updated?: AutomationOut) => void
}) {
  const [busy, setBusy] = useState(false)
  const [projectDraft, setProjectDraft] = useState(auto.project_id ?? '')
  const [savingProject, setSavingProject] = useState(false)
  const [executions, setExecutions] = useState<WorkflowExecutionSummary[]>([])
  const isSchedule = auto.trigger_type === 'schedule'
  const archived = auto.status === 'archived'
  const target = automationTarget(auto)

  useEffect(() => {
    setProjectDraft(auto.project_id ?? '')
  }, [auto.project_id])

  useEffect(() => {
    if (target !== 'workflow') { setExecutions([]); return }
    let active = true
    void automationsApi.workflowExecutions(auto.id).then(rows => { if (active) setExecutions(rows.slice(0, 5)) }).catch(() => { if (active) setExecutions([]) })
    return () => { active = false }
  }, [auto.id, target])

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try {
      const result = await fn()
      toast.success(ok)
      onChanged(isAutomationOut(result) ? result : undefined)
    }
    catch (err) { toast.error(errMsg(err)) }
    finally { setBusy(false) }
  }

  async function saveProjectBinding() {
    setSavingProject(true)
    try {
      const updated = await automationsApi.update(auto.id, { project_id: projectDraft || null })
      toast.success(projectDraft ? 'Project binding updated' : 'Project binding cleared')
      onChanged(updated)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSavingProject(false)
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <CardTitle>{auto.name}</CardTitle>
          <Badge variant="muted" className="text-[10px]">
            {shortTargetLabel(target)}
          </Badge>
          <Badge variant={isSchedule ? 'default' : 'muted'} className="text-[10px]">{auto.trigger_type}</Badge>
          {projectName && <Badge variant="muted" className="text-[10px]">{projectName}</Badge>}
          {auto.status === 'active' && <Badge variant="muted" className="text-[10px]">active</Badge>}
          {auto.status === 'paused' && <Badge variant="muted" className="text-[10px]">paused</Badge>}
          {archived && <Badge variant="muted" className="text-[10px]">archived</Badge>}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">{agentName}</span>
      </div>

      {isSchedule && (
        <div className="text-xs text-muted-foreground space-y-0.5 mb-3">
          <p>Cron: <span className="font-mono text-foreground">{cfgString(auto.config_json, 'cron') || '—'}</span> <span className="font-mono">({cfgString(auto.config_json, 'timezone') || 'UTC'})</span></p>
          <p>Next run: <span className="text-foreground">{fmt(auto.next_run_at)}</span></p>
          <p>Last fired: {fmt(auto.last_fired_at)}</p>
        </div>
      )}
      {cfgString(auto.config_json, 'prompt') && (
        <p className="text-xs mb-3 line-clamp-2"><span className="text-muted-foreground">Prompt: </span>{cfgString(auto.config_json, 'prompt')}</p>
      )}
      {target === 'agent_run' && !archived && (
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <label className="min-w-48 flex-1 space-y-1">
            <span className={fieldLabel}>Project binding</span>
            <select value={projectDraft} onChange={e => setProjectDraft(e.target.value)} className={selectCls}>
              <option value="">No project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={savingProject || projectDraft === (auto.project_id ?? '')}
            onClick={saveProjectBinding}
          >
            {savingProject ? <Loader2 className="size-3.5 animate-spin" /> : 'Save'}
          </Button>
        </div>
      )}
      {target !== 'agent_run' && (
        <p className="text-xs mb-3 flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          {target === 'workflow'
            ? `Workflow ${cfgString(auto.config_json, 'workflow_asset_key') || '—'} · ${cfgString(auto.config_json, 'workflow_resolution') || 'pin'}${cfgString(auto.config_json, 'workflow_version_id') ? ` · version ${cfgString(auto.config_json, 'workflow_version_id').slice(-8)}` : ''}`
            : target === 'context_ops_review_cycle'
            ? `Context Review Cycle report${cfgBool(auto.config_json, 'create_packets') ? ' + review packets' : ''} · memory ${cfgBoolDefault(auto.config_json, 'include_memory_maintenance', true) ? 'on' : 'off'}`
            : `Private report${cfgBool(auto.config_json, 'create_packet') ? ' + proposal packet' : ''}`}
        </p>
      )}

      {target === 'workflow' && (
        <div className="mb-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">Workflow executions</p><span className="text-[10px] text-muted-foreground">{executions.length} recent</span></div>
          {executions.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">No Workflow Execution has been fired yet.</p> : <div className="mt-2 space-y-1.5">{executions.map(execution => <div key={execution.workflow_execution_id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-mono text-muted-foreground">{execution.workflow_execution_id.slice(0, 8)}…</span><span>{execution.completed_node_count}/{execution.node_count} nodes</span><StatusBadge status={execution.status} /><span className="text-muted-foreground">{fmt(execution.created_at)}</span>{execution.root_run_id && <SpaceLink to={`/runs/${execution.root_run_id}`} className="text-accent-foreground hover:underline">root run</SpaceLink>}</div>)}</div>}
        </div>
      )}

      {!archived && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                // Nothing supplied: "Run now" runs the automation's own
                // configured prompt, which the server reads from the
                // automation. Sending a copy of it here would make the Run
                // read as this person asking for it, and ADR 0003 §5 decides
                // a persona write on exactly that difference.
                const result = await automationsApi.fire(auto.id)
                if (result.skipped) toast.info(result.skip_reason ? `Skipped — ${result.skip_reason}` : 'Skipped')
                else toast.success(target === 'agent_run' || target === 'workflow' ? 'Run queued' : 'Scan completed')
                onChanged()
              } catch (err) {
                toast.error(errMsg(err))
              } finally {
                setBusy(false)
              }
            }}>
            <Play className="size-3.5 mr-1" /> {target === 'agent_run' || target === 'workflow' ? 'Run now' : 'Scan now'}
          </Button>
          {auto.status === 'active' ? (
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => act(() => automationsApi.update(auto.id, { status: 'paused' }), 'Paused')}>
              <Pause className="size-3.5 mr-1" /> Pause
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => act(() => automationsApi.update(auto.id, { status: 'active' }), 'Resumed')}>
              <Play className="size-3.5 mr-1" /> Resume
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} className="text-red-500"
            onClick={() => act(() => automationsApi.update(auto.id, { status: 'archived' }), 'Archived')}>
            <Archive className="size-3.5" />
          </Button>
        </div>
      )}
    </Card>
  )
}

export default function AutomationsPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [autos, setAutos] = useState<AutomationOut[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [workflowAssets, setWorkflowAssets] = useState<EvolvableAsset[]>([])
  const [loading, setLoading] = useState(true)
  const headingId = useId()

  function upsertAutomation(automation: AutomationOut) {
    setAutos(current => {
      const existing = current.findIndex(item => item.id === automation.id)
      if (existing === -1) return [automation, ...current]
      return current.map(item => item.id === automation.id ? automation : item)
    })
  }

  async function refreshAutomation(id: string) {
    try {
      upsertAutomation(await automationsApi.get(id))
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  useEffect(() => { loadAll() }, [activeSpaceId])

  async function loadAll() {
    setLoading(true)
    try {
      if (!activeSpaceId) { setAutos([]); setAgents([]); setProjects([]); setWorkflowAssets([]); return }
      const [a, ag, pr, assets] = await Promise.all([
        automationsApi.list(),
        agentsApi.list(),
        projectsApi.list({ status: 'active' }),
        evolutionApi.assets({ asset_type: 'workflow_template' }),
      ])
      setAutos(a)
      setAgents(ag)
      setProjects(pr.items)
      setWorkflowAssets(assets)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setLoading(false)
    }
  }

  const agentName = (id: string) => agents.find(a => a.id === id)?.name ?? id.slice(0, 8)
  const projectName = (id: string | null) => (id ? projects.find(p => p.id === id)?.name ?? id.slice(0, 8) : null)
  const visible = autos.filter(a => a.status !== 'archived')

  return (
    <div className="p-6 space-y-6 max-w-2xl" id={headingId}>
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'color-mix(in oklch, var(--primary) 12%, transparent)', border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)' }}>
          <Clock className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Automations</h1>
          <p className="text-sm text-muted-foreground">Schedule agent runs or Knowledge maintenance scans, or keep them manual-only.</p>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin mr-2" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          <AddAutomationForm agents={agents} projects={projects} workflowAssets={workflowAssets} onAdded={upsertAutomation} canCreate={Boolean(activeSpaceId)} />
          {visible.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground p-4">
                {activeSpaceId
                  ? 'No automations yet. Create one to run an agent or Knowledge maintenance scan.'
                  : 'Select an operational space to manage automations.'}
              </p>
            </Card>
          ) : (
            visible.map(a => (
              <AutomationCard
                key={a.id}
                auto={a}
                agentName={agentName(a.agent_id)}
                projectName={projectName(a.project_id)}
                projects={projects}
                onChanged={updated => updated ? upsertAutomation(updated) : void refreshAutomation(a.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
