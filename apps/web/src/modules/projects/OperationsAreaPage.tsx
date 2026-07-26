import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ExternalLink, Play, RotateCcw } from 'lucide-react'
import { automationsApi, projectsApi, runsApi } from '../../api/client'
import type { AutomationOut, ProjectOperation, ProjectOverview, Run } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { SpaceLink as Link } from '../../core/spaceNav'
import { toast } from 'sonner'

function runState(run: Run): { label: string; variant: 'outline' | 'warning' | 'destructive' | 'success' } {
  if (run.status === 'waiting_for_review') return { label: 'Waiting for review', variant: 'warning' }
  if (run.status === 'waiting_for_dependency') return { label: 'Waiting for dependency', variant: 'warning' }
  if (run.status === 'failed') return { label: 'Terminal failure', variant: 'destructive' }
  if (run.status === 'degraded') return { label: 'Completed with fallback', variant: 'warning' }
  if (run.status === 'succeeded') return { label: 'Succeeded', variant: 'success' }
  if (run.status === 'queued') return { label: 'Queued', variant: 'outline' }
  if (run.status === 'running') return { label: 'Running', variant: 'outline' }
  return { label: run.status, variant: 'outline' }
}

export default function OperationsAreaPage() {
  const { projectId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const selectedOperationId = searchParams.get('open')
  const selectedAlertId = searchParams.get('alert')
  const [automations, setAutomations] = useState<AutomationOut[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [operations, setOperations] = useState<ProjectOperation[]>([])
  const [alerts, setAlerts] = useState<ProjectOverview['attention']>([])
  const [projectStatus, setProjectStatus] = useState<string>('active')
  const [busyAutomationId, setBusyAutomationId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [nextAutomations, nextRuns, nextOperations, overview] = await Promise.all([
      automationsApi.list({ project_id: projectId }),
      runsApi.list({ project_id: projectId, limit: 100 }),
      projectsApi.operations(projectId),
      projectsApi.getOverview(projectId),
    ])
    setAutomations(nextAutomations)
    setRuns(nextRuns)
    setOperations(nextOperations)
    setAlerts(overview.attention.filter(item => item.source_type === 'operational_alert'))
    setProjectStatus(overview.project.status)
  }, [projectId])
  useEffect(() => { load().catch(error => toast.error(String(error))) }, [load])

  async function updateAutomation(item: AutomationOut, status: 'active' | 'paused') {
    setBusyAutomationId(item.id)
    try {
      const updated = await automationsApi.update(item.id, { status })
      setAutomations(current => current.map(row => row.id === updated.id ? updated : row))
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusyAutomationId(null)
    }
  }

  async function runAutomation(item: AutomationOut) {
    setBusyAutomationId(item.id)
    try {
      const result = await automationsApi.fire(item.id)
      toast.success(result.run_id ? 'Automation Run queued' : 'Automation started')
      await load()
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusyAutomationId(null)
    }
  }

  const activeRuns = runs.filter(run => ['queued', 'waiting_for_dependency', 'waiting_for_review', 'running'].includes(run.status))
  const failures = runs.filter(run => run.status === 'failed')
  const archived = automations.filter(item => item.status === 'archived')

  return <div className="space-y-5 p-6">
    <div><h1 className="text-xl font-semibold">Operations</h1><p className="text-sm text-muted-foreground">Monitor Automations, governed Runs, alerts, and recovery work for this Project.</p></div>
    {projectStatus === 'archived' && <Card className="border-warning/40 bg-warning/5 p-4 text-sm"><p className="font-medium">Project archived</p><p className="mt-1 text-muted-foreground">Historical Runs and alerts remain visible. Automations and new execution stay paused until the Project is reactivated and each owner is reviewed explicitly.</p></Card>}
    <div className="grid gap-3 sm:grid-cols-4">
      <Card className="p-4"><p className="text-2xl font-semibold">{automations.filter(item => item.status === 'active').length}</p><p className="text-sm text-muted-foreground">Active automations</p></Card>
      <Card className="p-4"><p className="text-2xl font-semibold">{activeRuns.length}</p><p className="text-sm text-muted-foreground">Active / waiting Runs</p></Card>
      <Card className="p-4"><p className="text-2xl font-semibold">{failures.length}</p><p className="text-sm text-muted-foreground">Terminal failures</p></Card>
      <Card className="p-4"><p className="text-2xl font-semibold">{alerts.length}</p><p className="text-sm text-muted-foreground">Operational alerts</p></Card>
    </div>

    {alerts.length > 0 && <Card className="space-y-2 p-4">
      <h2 className="font-medium">Alerts</h2>
      {alerts.map(alert => <div id={`alert-${alert.source_id}`} key={alert.id} className={`rounded border p-3 text-sm ${selectedAlertId === alert.source_id ? 'border-destructive bg-destructive/5' : ''}`}>
        <p className="font-medium">{alert.title}</p>
        {alert.summary && <p className="mt-1 text-muted-foreground">{alert.summary}</p>}
        <p className="mt-2 text-xs text-muted-foreground">Open the linked Run or Automation below to inspect evidence and recover through its owning surface.</p>
      </div>)}
    </Card>}

    {operations.length > 0 && <Card className="space-y-2 p-4">
      <h2 className="font-medium">Project operations</h2>
      {operations.map(operation => <div id={`operation-${operation.id}`} key={operation.id} className={`rounded border p-3 text-sm ${selectedOperationId === operation.id ? 'border-primary bg-primary/5' : ''}`}>
        <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{operation.title}</p><p className="text-xs capitalize text-muted-foreground">{operation.kind.replace(/_/g, ' ')}</p></div><Badge variant={operation.status === 'failed' ? 'destructive' : operation.status === 'waiting_review' ? 'warning' : 'outline'}>{operation.status.replace(/_/g, ' ')}</Badge></div>
        {(operation.steps?.length ?? 0) > 0 && <p className="mt-2 text-xs text-muted-foreground">{operation.steps?.filter(step => step.status === 'done').length}/{operation.steps?.length} steps complete</p>}
      </div>)}
    </Card>}

    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-2 p-4">
        <div className="flex items-center justify-between"><h2 className="font-medium">Automations</h2><Link className="text-xs text-accent-foreground hover:underline" to="/automations">Manage all</Link></div>
        {automations.filter(item => item.status !== 'archived').map(item => <div key={item.id} className="space-y-2 rounded border p-3 text-sm">
          <div className="flex justify-between gap-2"><span>{item.name}</span><Badge variant="outline">{item.status}</Badge></div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busyAutomationId === item.id || item.status !== 'active'} onClick={() => void runAutomation(item)}><Play className="size-3" />Run now</Button>
            <Button size="sm" variant="ghost" disabled={busyAutomationId === item.id} onClick={() => void updateAutomation(item, item.status === 'paused' ? 'active' : 'paused')}>{item.status === 'paused' ? <><RotateCcw className="size-3" />Resume</> : 'Pause'}</Button>
          </div>
        </div>)}
        {automations.filter(item => item.status !== 'archived').length === 0 && <p className="text-sm text-muted-foreground">No Project automations. Create one from Automations and select this Project by name.</p>}
        {archived.length > 0 && <p className="text-xs text-muted-foreground">{archived.length} archived automation{archived.length === 1 ? '' : 's'} retained in history.</p>}
      </Card>
      <Card className="space-y-2 p-4">
        <h2 className="font-medium">Recent Runs</h2>
        {runs.slice(0, 20).map(run => {
          const state = runState(run)
          return <Link key={run.id} to={`/runs/${run.id}`} className="flex items-start justify-between gap-3 rounded border p-3 text-sm hover:bg-muted/40">
            <span className="min-w-0"><span className="block truncate">{run.instruction ?? run.prompt ?? 'Project Run'}</span>{run.status === 'failed' && run.error_message && <span className="mt-1 block text-xs text-destructive">{run.error_message}</span>}</span>
            <Badge variant={state.variant}>{state.label}</Badge><ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </Link>
        })}
        {runs.length === 0 && <p className="text-sm text-muted-foreground">No Project Runs. Start work in the Project Room or launch a configured Workflow.</p>}
      </Card>
    </div>
  </div>
}
