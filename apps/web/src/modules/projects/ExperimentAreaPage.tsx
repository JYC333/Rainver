import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, FlaskConical, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../core/spaceNav'
import { agentsApi, experimentsApi, inquiryApi, projectFoldersApi, projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type {
  ExperimentDefinition,
  ExperimentInterpretation,
  ExperimentRun,
  ExperimentVersion,
  AgentOut,
  InquiryThread,
  Project,
  ProjectFolder,
} from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { ThreadOriginBar } from './inquiryArea/ThreadOriginBar'

export default function ExperimentAreaPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [definitions, setDefinitions] = useState<ExperimentDefinition[]>([])
  const [threads, setThreads] = useState<InquiryThread[]>([])
  const [folders, setFolders] = useState<ProjectFolder[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [definition, setDefinition] = useState<(ExperimentDefinition & { versions: ExperimentVersion[] }) | null>(null)
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [interpretations, setInterpretations] = useState<ExperimentInterpretation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [hypothesisThreadId, setHypothesisThreadId] = useState('')
  const [linkThreadId, setLinkThreadId] = useState('')
  const [metricName, setMetricName] = useState('result')
  const [metricValue, setMetricValue] = useState('')
  const [verdict, setVerdict] = useState<'supports' | 'contradicts' | 'inconclusive'>('inconclusive')
  const [conclusion, setConclusion] = useState('')
  const [managedFolderId, setManagedFolderId] = useState('')
  const [managedAgentId, setManagedAgentId] = useState('')
  const [managedCommand, setManagedCommand] = useState('')
  const [editableScope, setEditableScope] = useState('')
  const [protectedScope, setProtectedScope] = useState('')

  const loadIndex = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [projectResult, definitionResult, threadResult, folderResult, agentResult] = await Promise.all([
        projectsApi.get(projectId),
        experimentsApi.listDefinitions(projectId),
        inquiryApi.listThreads(projectId),
        projectFoldersApi.list(projectId, { status: 'active', limit: '100' }),
        agentsApi.list({ status: 'active' }),
      ])
      setProject(projectResult)
      setDefinitions(definitionResult)
      setThreads(threadResult.filter(thread => thread.kind === 'hypothesis'))
      setFolders(folderResult.items.filter(folder => folder.execution_enabled))
      setAgents(agentResult.filter(agent => agent.status === 'active' && agent.current_version_id))
      setSelectedId(current => current ?? definitionResult[0]?.id ?? null)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadSelected = useCallback(async () => {
    if (!projectId || !selectedId) {
      setDefinition(null)
      setRuns([])
      setInterpretations([])
      return
    }
    try {
      const [definitionResult, runResult, interpretationResult] = await Promise.all([
        experimentsApi.getDefinition(projectId, selectedId),
        experimentsApi.listRuns(projectId, selectedId),
        experimentsApi.listInterpretations(projectId, selectedId),
      ])
      setDefinition(definitionResult)
      setRuns(runResult)
      setInterpretations(interpretationResult)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }, [projectId, selectedId])

  useEffect(() => { void loadIndex() }, [loadIndex])
  useEffect(() => { void loadSelected() }, [loadSelected])

  const manualVersions = useMemo(
    () => definition?.versions.filter(version => version.executor_type === 'manual' && version.status !== 'archived') ?? [],
    [definition],
  )
  const approvedManualVersions = manualVersions.filter(version => version.status === 'approved')
  const managedVersions = definition?.versions.filter(version => version.executor_type === 'managed_code_comparison' && version.status !== 'archived') ?? []
  const approvedManagedVersions = managedVersions.filter(version => version.status === 'approved')
  const terminalRuns = runs.filter(run => run.status === 'completed' || run.status === 'failed')

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  function createDefinition() {
    if (!projectId || !name.trim()) return
    void perform(async () => {
      const created = await experimentsApi.createDefinition(projectId, {
        name: name.trim(),
        objective: objective.trim() || null,
        primary_hypothesis_thread_id: hypothesisThreadId || null,
      })
      setName('')
      setObjective('')
      setHypothesisThreadId('')
      await loadIndex()
      setSelectedId(created.id)
      toast.success('Experiment created')
    })
  }

  function createManualVersion() {
    if (!projectId || !definition) return
    void perform(async () => {
      await experimentsApi.createVersion(projectId, definition.id, {
        executor_type: 'manual',
        planned_summary: 'Manual observation protocol',
      })
      await loadSelected()
      toast.success('Draft protocol version created for review')
    })
  }

  function approveManualVersion(version: ExperimentVersion) {
    if (!projectId || !definition) return
    void perform(async () => {
      await experimentsApi.approveVersion(projectId, definition.id, version.id)
      await loadSelected()
      toast.success(`Protocol v${version.version} approved`)
    })
  }

  function createManagedVersion() {
    if (!projectId || !definition || !managedFolderId.trim() || !managedCommand.trim()) return
    void perform(async () => {
      await experimentsApi.createVersion(projectId, definition.id, {
        executor_type: 'managed_code_comparison',
        planned_summary: 'Governed managed code comparison',
        config: {
          project_folder_id: managedFolderId.trim(),
          editable_scope: editableScope.split(',').map(value => value.trim()).filter(Boolean),
          protected_scope: protectedScope.split(',').map(value => value.trim()).filter(Boolean),
          setup_commands: [],
          run_command: managedCommand.trim(),
          metric_parser: {},
        },
      })
      await loadSelected()
      toast.success('Draft managed Version created')
    })
  }

  function launchManagedRun() {
    if (!projectId || !definition || !managedAgentId.trim() || approvedManagedVersions.length === 0) return
    void perform(async () => {
      const version = approvedManagedVersions[0]!
      await experimentsApi.launchRun(projectId, definition.id, version.id, {
        agent_id: managedAgentId.trim(),
        is_baseline: !definition.baseline_run_id,
      })
      await loadSelected()
      toast.success(definition.baseline_run_id ? 'Managed comparison queued' : 'Managed baseline queued')
    })
  }

  function linkPrimaryHypothesis() {
    if (!projectId || !definition || !linkThreadId) return
    void perform(async () => {
      await experimentsApi.updateDefinition(projectId, definition.id, {
        primary_hypothesis_thread_id: linkThreadId,
      })
      setLinkThreadId('')
      await Promise.all([loadSelected(), loadIndex()])
      toast.success('Primary hypothesis linked')
    })
  }

  function createManualRun() {
    if (!projectId || !definition || approvedManualVersions.length === 0) return
    const version = approvedManualVersions[0]!
    void perform(async () => {
      await experimentsApi.createRun(projectId, definition.id, version.id, {
        is_baseline: !definition.baseline_run_id,
      })
      await loadSelected()
      toast.success(definition.baseline_run_id ? 'Run created' : 'Baseline run created')
    })
  }

  function completeRun(run: ExperimentRun) {
    if (!projectId || !definition || !metricName.trim() || !metricValue.trim()) return
    const numericValue = Number(metricValue)
    void perform(async () => {
      await experimentsApi.completeRun(projectId, definition.id, run.id, {
        status: 'completed',
        observations: [{
          metric_name: metricName.trim(),
          ...(Number.isFinite(numericValue) ? { value_number: numericValue } : { value_text: metricValue.trim() }),
          is_primary: true,
        }],
      })
      setMetricValue('')
      await Promise.all([loadSelected(), loadIndex()])
      toast.success('Run completed and observation recorded')
    })
  }

  function createInterpretation() {
    if (!projectId || !definition || terminalRuns.length === 0) return
    void perform(async () => {
      await experimentsApi.createInterpretation(projectId, definition.id, {
        run_ids: terminalRuns.map(run => run.id),
        verdict,
        conclusion: conclusion.trim() || null,
      })
      setConclusion('')
      await loadSelected()
      toast.success('Interpretation drafted')
    })
  }

  function reviewOrConvert(item: ExperimentInterpretation) {
    if (!projectId) return
    void perform(async () => {
      if (item.status === 'draft') {
        await experimentsApi.reviewInterpretation(projectId, item.id)
        toast.success('Interpretation reviewed')
      } else if (item.status === 'reviewed') {
        await experimentsApi.convertInterpretation(projectId, item.id)
        toast.success('Evidence Signal created for Inquiry review')
      }
      await loadSelected()
    })
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading experiments…</div>
  if (!projectId || !project) return <EmptyState title="Project not found" />

  return (
    <div className="space-y-5 p-6">
      <ThreadOriginBar projectId={projectId} kinds={['design_run_experiment']} />
      <div>
        <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" />{project.name}
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <FlaskConical className="size-5" />
          <h1 className="text-xl font-semibold">Experiments</h1>
          <Badge variant="secondary">Project capability</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Define a test, capture immutable runs and observations, then send a reviewed interpretation into Inquiry.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card className="space-y-3 p-4">
            <div className="font-medium">New experiment</div>
            <div><Label>Name</Label><Input value={name} onChange={event => setName(event.target.value)} /></div>
            <div><Label>Objective</Label><Textarea value={objective} onChange={event => setObjective(event.target.value)} /></div>
            <div>
              <Label>Primary hypothesis</Label>
              <select className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={hypothesisThreadId} onChange={event => setHypothesisThreadId(event.target.value)}>
                <option value="">Link later</option>
                {threads.map(thread => <option key={thread.id} value={thread.id}>{thread.statement}</option>)}
              </select>
              {threads.length === 0 && (
                <Link
                  to={`/projects/${projectId}/inquiry?new=hypothesis`}
                  className="mt-1 inline-block text-xs text-accent-foreground hover:underline"
                >
                  Create a hypothesis in Inquiry
                </Link>
              )}
            </div>
            <Button disabled={busy || !name.trim()} onClick={createDefinition}><Plus className="size-4" />Create</Button>
          </Card>
          <div className="space-y-2">
            {definitions.map(item => (
              <button key={item.id} className={`w-full rounded-md border p-3 text-left ${selectedId === item.id ? 'border-primary bg-muted' : ''}`} onClick={() => setSelectedId(item.id)}>
                <div className="font-medium">{item.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{item.status}</div>
              </button>
            ))}
          </div>
        </div>

        {!definition ? (
          <EmptyState title="Select or create an experiment" />
        ) : (
          <div className="space-y-4">
            <Card className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div><h2 className="font-semibold">{definition.name}</h2><p className="text-sm text-muted-foreground">{definition.objective || 'No objective recorded.'}</p></div>
                <Badge variant="outline">{definition.status}</Badge>
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button variant="outline" disabled={busy} onClick={createManualVersion}>New manual protocol version</Button>
                <Button disabled={busy || approvedManualVersions.length === 0 || !definition.primary_hypothesis_thread_id} onClick={createManualRun}>Create manual run</Button>
              </div>
              <div className="grid gap-2 border-t pt-3 md:grid-cols-2">
                <select aria-label="Execution folder" className="rounded-md border bg-background p-2 text-sm" value={managedFolderId} onChange={event => setManagedFolderId(event.target.value)}>
                  <option value="">{folders.length ? 'Select an execution-enabled Folder' : 'No execution-enabled Folder available'}</option>
                  {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}{folder.is_primary ? ' (primary)' : ''}</option>)}
                </select>
                <Input value={managedCommand} onChange={event => setManagedCommand(event.target.value)} placeholder="Run command" />
                <Input value={editableScope} onChange={event => setEditableScope(event.target.value)} placeholder="Editable paths, comma separated" />
                <Input value={protectedScope} onChange={event => setProtectedScope(event.target.value)} placeholder="Protected paths, comma separated" />
                <Button variant="outline" disabled={busy || !managedFolderId.trim() || !managedCommand.trim()} onClick={createManagedVersion}>New managed Version</Button>
                <div className="flex gap-2">
                  <select aria-label="Execution agent" className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm" value={managedAgentId} onChange={event => setManagedAgentId(event.target.value)}>
                    <option value="">{agents.length ? 'Select an execution Agent' : 'No active Agent available'}</option>
                    {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{agent.adapter_type ? ` · ${agent.adapter_type.replace(/_/g, ' ')}` : ''}</option>)}
                  </select>
                  <Button disabled={busy || !managedAgentId || approvedManagedVersions.length === 0 || !definition.primary_hypothesis_thread_id} onClick={launchManagedRun}>Launch</Button>
                </div>
              </div>
              {folders.length === 0 && <p className="text-xs text-muted-foreground">Create or enable a Project Folder in Files &amp; Code before creating a managed Version.</p>}
              {manualVersions.length > 0 && (
                <div className="space-y-2 pt-2">
                  {manualVersions.map(version => (
                    <div key={version.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
                      <span>Manual protocol v{version.version}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{version.status}</Badge>
                        {version.status === 'draft' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => approveManualVersion(version)}>
                            Approve
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {managedVersions.length > 0 && <div className="space-y-2 pt-2">{managedVersions.map(version => <div key={version.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"><span>Managed Version v{version.version}</span><div className="flex items-center gap-2"><Badge variant="outline">{version.status}</Badge>{version.status === 'draft' && <Button size="sm" variant="outline" disabled={busy} onClick={() => approveManualVersion(version)}>Approve</Button>}</div></div>)}</div>}
              {!definition.primary_hypothesis_thread_id && (
                threads.length > 0
                  ? (
                    <div className="flex max-w-xl gap-2 pt-2">
                      <select className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm" value={linkThreadId} onChange={event => setLinkThreadId(event.target.value)}>
                        <option value="">Select a Hypothesis Thread</option>
                        {threads.map(thread => <option key={thread.id} value={thread.id}>{thread.statement}</option>)}
                      </select>
                      <Button variant="outline" disabled={busy || !linkThreadId} onClick={linkPrimaryHypothesis}>Link hypothesis</Button>
                    </div>
                  )
                  : (
                    <div className="space-y-2 pt-2">
                      <p className="text-sm text-muted-foreground">No Hypothesis Threads exist in this Project yet.</p>
                      <Button variant="outline" asChild>
                        <Link to={`/projects/${projectId}/inquiry?new=hypothesis`}>Create hypothesis in Inquiry</Link>
                      </Button>
                    </div>
                  )
              )}
              {manualVersions.length === 0 && <p className="text-xs text-muted-foreground">Create a protocol version before starting a run.</p>}
              {manualVersions.length > 0 && approvedManualVersions.length === 0 && <p className="text-xs text-muted-foreground">Review and approve a protocol Version before starting a Run.</p>}
              {!definition.primary_hypothesis_thread_id && <p className="text-xs text-muted-foreground">Link the primary Hypothesis before the first Run; the target is frozen once evidence collection starts.</p>}
            </Card>

            <Card className="space-y-3 p-4">
              <h3 className="font-medium">Runs and observations</h3>
              {runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : runs.map(run => (
                <div key={run.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between"><span className="text-sm font-medium">{run.is_baseline ? 'Baseline' : 'Run'}</span><Badge variant="outline">{run.status}</Badge></div>
                  {!['completed', 'failed', 'cancelled'].includes(run.status) && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <Input aria-label="Metric name" value={metricName} onChange={event => setMetricName(event.target.value)} placeholder="Metric" />
                      <Input aria-label="Metric value" value={metricValue} onChange={event => setMetricValue(event.target.value)} placeholder="Value" />
                      <Button disabled={busy || !metricValue.trim()} onClick={() => completeRun(run)}>Complete</Button>
                    </div>
                  )}
                </div>
              ))}
            </Card>

            <Card className="space-y-3 p-4">
              <h3 className="font-medium">Interpretation → Inquiry</h3>
              {!definition.primary_hypothesis_thread_id && (
                <p className="text-xs text-amber-700 dark:text-amber-300">Link a primary Hypothesis Thread before converting a reviewed Interpretation.</p>
              )}
              <div className="grid gap-2 sm:grid-cols-[180px_1fr_auto]">
                <select className="rounded-md border bg-background p-2 text-sm" value={verdict} onChange={event => setVerdict(event.target.value as typeof verdict)}>
                  <option value="supports">Supports</option>
                  <option value="contradicts">Contradicts</option>
                  <option value="inconclusive">Inconclusive</option>
                </select>
                <Input value={conclusion} onChange={event => setConclusion(event.target.value)} placeholder="Conclusion" />
                <Button disabled={busy || terminalRuns.length === 0} onClick={createInterpretation}>Draft</Button>
              </div>
              {interpretations.map(item => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                  <div><div className="text-sm font-medium">{item.verdict}</div><div className="text-xs text-muted-foreground">{item.conclusion || 'No conclusion text'} · {item.status}</div></div>
                  {item.status !== 'converted' && <Button variant="outline" disabled={busy || (item.status === 'reviewed' && !definition.primary_hypothesis_thread_id)} onClick={() => reviewOrConvert(item)}>{item.status === 'draft' ? 'Mark reviewed' : 'Create Signal'}</Button>}
                  {item.status === 'converted' && <Badge variant="secondary">Awaiting Inquiry review</Badge>}
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
