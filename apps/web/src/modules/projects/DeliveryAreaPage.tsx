import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ExternalLink, Plus } from 'lucide-react'
import { agentsApi, tasksApi } from '../../api/client'
import type { AgentOut, Task } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { toast } from 'sonner'
import { ThreadOriginBar } from './inquiryArea/ThreadOriginBar'

export default function DeliveryAreaPage() {
  const { projectId = '' } = useParams()
  const { userId } = useSpace()
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const load = useCallback(async () => {
    const [page, nextAgents] = await Promise.all([
      tasksApi.list({ project_id: projectId, limit: '100' }),
      agentsApi.list({ limit: '100', status: 'active' }),
    ])
    setTasks(page.items)
    setAgents(nextAgents)
  }, [projectId])
  useEffect(() => { load().catch(error => toast.error(String(error))) }, [load])

  async function createTask() {
    try {
      const created = await tasksApi.create({ project_id: projectId, title: title.trim(), status: 'inbox', task_role: 'source' })
      setTasks(current => [created, ...current])
      setTitle('')
    } catch (error) {
      toast.error(String(error))
    }
  }

  async function updateTask(task: Task, patch: Record<string, unknown>) {
    setBusyTaskId(task.id)
    try {
      const updated = await tasksApi.update(task.id, patch)
      setTasks(current => current.map(item => item.id === updated.id ? updated : item))
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusyTaskId(null)
    }
  }

  const open = tasks.filter(task => !['done', 'cancelled'].includes(task.status))
  const completed = tasks.filter(task => task.status === 'done')
  return <div className="space-y-5 p-6">
    <ThreadOriginBar projectId={projectId} kinds={['create_delivery_task']} />
    <div><h1 className="text-xl font-semibold">Delivery</h1><p className="text-sm text-muted-foreground">Plan and complete the work that delivers this Project’s target state.</p></div>
    <Card className="flex gap-2 p-4"><Input value={title} onChange={event => setTitle(event.target.value)} placeholder="New delivery task" /><Button disabled={!title.trim()} onClick={() => void createTask()}><Plus className="size-4" />Add</Button></Card>
    <div className="grid gap-3">
      {open.map(task => {
        const assignee = task.assigned_user_id === userId
          ? 'me'
          : task.assigned_user_id
            ? `user:${task.assigned_user_id}`
          : task.assigned_agent_id
            ? `agent:${task.assigned_agent_id}`
            : ''
        return <Card key={task.id} className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Link to={`/tasks/${task.id}`} className="inline-flex items-center gap-1 font-medium hover:underline">{task.title}<ExternalLink className="size-3" /></Link>
              {task.blocked_reason && <p className="text-sm text-destructive">{task.blocked_reason}</p>}
              {task.due_at && <p className="text-xs text-muted-foreground">Due {new Date(task.due_at).toLocaleString()}</p>}
            </div>
            <Badge variant={task.status === 'blocked' ? 'destructive' : 'outline'}>{task.status}</Badge>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48">
              <p className="mb-1 text-xs text-muted-foreground">Assigned to</p>
              <Select
                size="sm"
                value={assignee}
                disabled={busyTaskId === task.id}
                options={[
                  { value: '', label: 'Unassigned' },
                  ...(userId ? [{ value: 'me', label: 'Me' }] : []),
                  ...(task.assigned_user_id && task.assigned_user_id !== userId ? [{ value: `user:${task.assigned_user_id}`, label: 'Another user' }] : []),
                  ...agents.map(agent => ({ value: `agent:${agent.id}`, label: agent.name })),
                ]}
                onChange={value => void updateTask(task, value === 'me'
                  ? { assigned_user_id: userId, assigned_agent_id: null }
                  : value.startsWith('user:')
                    ? { assigned_user_id: value.slice(5), assigned_agent_id: null }
                  : value.startsWith('agent:')
                    ? { assigned_user_id: null, assigned_agent_id: value.slice(6) }
                    : { assigned_user_id: null, assigned_agent_id: null })}
              />
            </div>
            {task.status !== 'in_progress' && <Button size="sm" variant="outline" disabled={busyTaskId === task.id} onClick={() => void updateTask(task, { status: 'in_progress' })}>Start</Button>}
            <Button size="sm" disabled={busyTaskId === task.id} onClick={() => void updateTask(task, { status: 'done' })}>Complete</Button>
          </div>
        </Card>
      })}
      {open.length === 0 && <Card className="p-8 text-center text-sm text-muted-foreground">No open delivery tasks. Add one above or reopen a completed task.</Card>}
    </div>
    {completed.length > 0 && <Card className="space-y-2 p-4">
      <h2 className="font-medium">Completed</h2>
      {completed.map(task => <div key={task.id} className="flex items-center justify-between gap-3 rounded border p-3 text-sm">
        <Link to={`/tasks/${task.id}`} className="truncate hover:underline">{task.title}</Link>
        <Button size="sm" variant="ghost" disabled={busyTaskId === task.id} onClick={() => void updateTask(task, { status: 'ready' })}>Reopen</Button>
      </div>)}
    </Card>}
  </div>
}
