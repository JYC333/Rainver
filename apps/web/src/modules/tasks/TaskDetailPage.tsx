import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft, ExternalLink, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, artifactsApi, boardsApi, tasksApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { AgentOut, Board, PlanDetail, Task, TaskArtifact, TaskProposal, TaskRunCreateBody, TaskRunListItem } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { EmptyState } from '../../components/ui/empty-state'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { PreviewBadge, DryRunBanner } from '../../components/PreviewBadge'
import { ScopeBadge } from '../../components/ScopeBadge'
import { ContentAccessControl } from '../../components/ContentAccessControl'
import TaskContractEditor from './TaskContractEditor'

type TaskDetailTab = 'overview' | 'runs' | 'artifacts' | 'proposals'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="text-muted-foreground text-sm">—</span>
  return (
    <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto border border-border">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

export default function TaskDetailPage() {
  const { taskId = '' } = useParams()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const [task, setTask] = useState<Task | null>(null)
  const [runs, setRuns] = useState<TaskRunListItem[]>([])
  const [arts, setArts] = useState<TaskArtifact[]>([])
  const [props, setProps] = useState<TaskProposal[]>([])
  const [plan, setPlan] = useState<PlanDetail | null>(null)
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [boards, setBoards] = useState<Board[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<string>('live')
  const [agentPick, setAgentPick] = useState<string>('')
  const [creatingRun, setCreatingRun] = useState(false)
  const [requestingPlan, setRequestingPlan] = useState(false)
  const [activeTab, setActiveTab] = useState<TaskDetailTab>('overview')
  const [editOpen, setEditOpen] = useState(false)

  const load = useCallback(async () => {
    if (!taskId) return
    if (!activeSpaceId) {
      setTask(null)
      setRuns([])
      setArts([])
      setProps([])
      setPlan(null)
      setAgents([])
      setBoards([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [t, r, a, p, ag, boardPage, nextPlan] = await Promise.all([
        tasksApi.get(taskId),
        tasksApi.runs(taskId, { limit: '50' }),
        tasksApi.artifacts(taskId, { limit: '50' }),
        tasksApi.proposals(taskId, { limit: '50' }),
        agentsApi.list({ limit: '50' }).catch(() => []),
        boardsApi.list({ limit: '100' }).catch(() => ({ items: [] as Board[] })),
        tasksApi.plan(taskId).catch(() => null),
      ])
      setTask(t)
      setRuns(r.items)
      setArts(a.items)
      setProps(p.items)
      setAgents(ag)
      setBoards(boardPage.items)
      setPlan(nextPlan)
    } catch (e) {
      if (!isNotFoundError(e)) toast.error(errMsg(e))
      setTask(null)
    } finally {
      setLoading(false)
    }
  }, [taskId, activeSpaceId])

  useEffect(() => { load() }, [load])
  useEffect(() => { setActiveTab('overview') }, [taskId])

  async function createRun() {
    if (!taskId || !task) return
    setCreatingRun(true)
    try {
      const body: TaskRunCreateBody = { mode }
      const aid = task.assigned_agent_id || agentPick || undefined
      if (aid) body.agent_id = aid
      await tasksApi.createRun(taskId, body)
      toast.success('Queued run created')
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreatingRun(false)
    }
  }

  async function askAgentToPlan() {
    if (!task || task.task_role !== 'source') return
    const agentId = task.assigned_agent_id || agentPick
    if (!agentId) { toast.error('Select an agent for the planning Run'); return }
    setRequestingPlan(true)
    try {
      const run = await tasksApi.requestPlan(task.id, { agent_id: agentId })
      toast.success(`Planning Run queued: ${run.id.slice(0, 8)}…`)
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setRequestingPlan(false)
    }
  }

  async function exportArt(artifactId: string) {
    try {
      await artifactsApi.export(artifactId)
      toast.success('Download started')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function saveContract(body: Record<string, unknown>) {
    if (!task) return
    await tasksApi.update(task.id, body)
    toast.success('Task contract updated')
    setEditOpen(false)
    await load()
  }

  if (loading && !task) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!task) {
    return (
      <div className="p-6">
        <Button variant="ghost" asChild>
          <Link to="/tasks"><ArrowLeft className="size-4 mr-1" />Back</Link>
        </Button>
        <EmptyState
          className="mt-6"
          title={activeSpaceId ? 'Task not found or not accessible' : 'No space selected'}
          description={activeSpaceId
            ? 'This task may not exist, or it may not be visible in your current space.'
            : 'Select an operational space to inspect this task.'}
          action={
            <Button variant="ghost" asChild>
              <Link to="/tasks">Back to Tasks</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const agentOptions = agents.map(a => ({ value: a.id, label: a.name }))
  const needsAgentPick = !task.assigned_agent_id

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/tasks"><ArrowLeft className="size-4" /></Link>
        </Button>
      </div>

      <div className="border-b border-border pb-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">{task.title}</h1><Button size="sm" variant="outline" onClick={() => setEditOpen(true)}><Pencil className="size-3.5" /> Edit contract</Button></div>
          <ContentAccessControl resourceType="task" resourceId={task.id} ownerUserId={task.owner_user_id} />
        </div>
        <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
        <div className="flex flex-wrap gap-1.5 items-center">
          <StatusBadge status={task.status} />
          <Badge variant="outline">{task.priority}</Badge>
          <Badge variant="muted">{task.risk_level} risk</Badge>
          <Badge variant="secondary">{task.task_type}</Badge>
          <Badge variant="outline">{task.task_role}</Badge>
          <ScopeBadge visibility={task.visibility} />
          {task.assigned_agent_id && (
            <Badge variant="outline">agent {task.assigned_agent_id.slice(0, 8)}…</Badge>
          )}
          {task.assigned_user_id && (
            <Badge variant="outline">user {task.assigned_user_id.slice(0, 8)}…</Badge>
          )}
          {task.due_at && <span className="text-xs text-muted-foreground">Due {fmt(task.due_at)}</span>}
        </div>
        {mode === 'dry_run' && <DryRunBanner />}
        <div className="flex flex-wrap gap-3 items-end pt-2">
          {needsAgentPick && (
            <div className="min-w-[200px]">
              <Label className="text-xs">Agent for this run</Label>
              <Select
                value={agentPick}
                options={[{ value: '', label: 'Select agent…' }, ...agentOptions]}
                onChange={setAgentPick}
              />
            </div>
          )}
          <div className="min-w-[140px]">
            <Label className="text-xs">Mode</Label>
            <Select
              value={mode}
              options={[
                { value: 'live', label: 'live' },
                { value: 'dry_run', label: 'dry_run' },
              ]}
              onChange={setMode}
            />
          </div>
          <Button
            onClick={createRun}
            disabled={creatingRun || (needsAgentPick && !agentPick)}
          >
            {creatingRun ? 'Creating…' : 'Create queued run'}
          </Button>
        </div>
        {task.task_role === 'source' && (
          <Card className="mt-3 border-primary/30 bg-primary/5 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">Agent planning</p>
                <p className="mt-1 text-sm text-muted-foreground">Ask the assigned Agent to create or revise the dynamic execution Plan for this Task. The request only queues a planning Run.</p>
                {plan ? <p className="mt-2 text-xs text-muted-foreground">Current Plan: <Link to={`/plans/${plan.id}`} className="text-accent-foreground hover:underline">{plan.name}</Link> · {plan.status} · version {plan.current_version?.version ?? '—'}</p> : <p className="mt-2 text-xs text-muted-foreground">No Plan has been proposed yet.</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {plan?.current_version?.approval_proposal_id && <Button size="sm" variant="outline" asChild><Link to={`/proposals/${plan.current_version.approval_proposal_id}`}>Review proposal</Link></Button>}
                <Button size="sm" variant="outline" onClick={() => void askAgentToPlan()} disabled={requestingPlan || (!task.assigned_agent_id && !agentPick)}>{requestingPlan ? 'Queueing…' : plan ? 'Ask Agent to revise' : 'Ask Agent to plan'}</Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as TaskDetailTab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <Card className="p-4 space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Description</Label>
              <p className="text-sm mt-1 whitespace-pre-wrap">{task.description ?? '—'}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Acceptance criteria</Label>
              <div className="mt-1"><JsonBlock value={task.acceptance_criteria_json ?? null} /></div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Definition of done</Label>
              <p className="text-sm mt-1 whitespace-pre-wrap">{task.definition_of_done ?? '—'}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Required outputs</Label>
              <div className="mt-1"><JsonBlock value={task.required_outputs_json ?? null} /></div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Blocked reason</Label>
              <p className="text-sm mt-1">{task.blocked_reason ?? '—'}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Tags</Label>
              <p className="text-sm mt-1">
                {task.tags?.length ? task.tags.join(', ') : '—'}
              </p>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="runs" className="space-y-3 mt-4">
          {runs.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No runs yet.</Card>
          ) : runs.map(({ link, run }) => (
            <Card key={link.id} className="p-4 flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap gap-1.5 items-center">
                  <StatusBadge status={run.status} />
                  <Badge variant="secondary">{run.mode}</Badge>
                  <ScopeBadge visibility={run.visibility} omitShared />
                  <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
                  {run.mode === 'dry_run' && <PreviewBadge />}
                </div>
                <p className="text-xs text-muted-foreground">
                  created {fmt(run.created_at)} · started {fmt(run.started_at)} · ended {fmt(run.ended_at)}
                </p>
              </div>
              <Button size="sm" variant="outline" asChild>
                <Link to={`/runs/${run.id}`}>Open run <ExternalLink className="size-3 ml-1" /></Link>
              </Button>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="artifacts" className="space-y-3 mt-4">
          {arts.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No artifacts linked.</Card>
          ) : arts.map(row => (
            <Card key={row.id} className="p-4 flex flex-wrap justify-between gap-2">
              <div>
                <Link
                  to={`/artifacts/${row.artifact.id}`}
                  className="font-medium text-sm text-accent-foreground hover:underline"
                >
                  {row.artifact.title}
                </Link>
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  <Badge variant="secondary">{row.artifact.artifact_type}</Badge>
                  {row.run_id && <Badge variant="outline">run: {row.run_id.slice(0, 8)}…</Badge>}
                  {row.artifact.run_id && row.artifact.run_id !== row.run_id && (
                    <Badge variant="muted">produced: {row.artifact.run_id.slice(0, 8)}…</Badge>
                  )}
                  <ScopeBadge visibility={row.artifact.visibility} omitShared />
                  {row.artifact.preview && <PreviewBadge />}
                  <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => exportArt(row.artifact.id)}>Export</Button>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="proposals" className="space-y-3 mt-4">
          {props.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No proposals linked.</Card>
          ) : props.map(row => (
            <Card key={row.id} className="p-4 space-y-2">
              <div className="flex flex-wrap gap-1.5 items-center">
                <Link
                  to={`/proposals/${row.proposal.id}`}
                  className="font-medium text-sm text-accent-foreground hover:underline"
                >
                  {row.proposal.title}
                </Link>
                <Badge variant="outline">{row.proposal.proposal_type}</Badge>
                <StatusBadge status={row.proposal.status} />
                <ScopeBadge visibility={row.proposal.visibility} omitShared />
                {row.proposal.preview && <PreviewBadge />}
                {row.proposal.expired && <Badge variant="destructive">EXPIRED</Badge>}
              </div>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Edit task contract</DialogTitle><DialogDescription>Changes are saved through the canonical Task API and will apply to future queued runs.</DialogDescription></DialogHeader>
          <TaskContractEditor task={task} boards={boards} agents={agents} submitLabel="Save contract" onSubmit={saveContract} onCancel={() => setEditOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
