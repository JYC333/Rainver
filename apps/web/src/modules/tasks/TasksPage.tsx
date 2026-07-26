import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSpaceNavigate as useNavigate } from '../../core/spaceNav'
import { ListTodo, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, boardsApi, tasksApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { AgentOut, Board, Task } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { ScopeBadge } from '../../components/ScopeBadge'
import { WriteTargetPicker, useWriteTarget } from '../../components/WriteTargetPicker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import TaskCreateForm from './TaskCreateForm'

const OPEN_STATUSES = new Set(['inbox', 'ready', 'in_progress', 'blocked'])

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

function acPreview(task: Task): string | null {
  const raw = task.acceptance_criteria_json
  if (!raw || typeof raw !== 'object') return null
  try {
    const s = JSON.stringify(raw)
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  } catch {
    return null
  }
}

export default function TasksPage() {
  const navigate = useNavigate()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const { writeTargetSpaceId, hasWriteTarget } = useWriteTarget()
  const [boards, setBoards] = useState<Board[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [boardId, setBoardId] = useState<string>('')
  const [fStatus, setFStatus] = useState<string>('')
  const [fPriority, setFPriority] = useState<string>('')
  const [fRisk, setFRisk] = useState<string>('')
  const [fType, setFType] = useState<string>('')
  const [createOpen, setCreateOpen] = useState(false)

  const loadBoards = useCallback(async () => {
    if (!activeSpaceId) {
      setBoards([])
      return
    }
    try {
      const p = await boardsApi.list({ limit: '100' })
      setBoards(p.items)
    } catch {
      setBoards([])
    }
  }, [activeSpaceId])

  const loadTasks = useCallback(async () => {
    if (!activeSpaceId) {
      setTasks([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const params: Record<string, string> = { limit: '200' }
      if (boardId) params.board_id = boardId
      const p = await tasksApi.list(params)
      setTasks(p.items)
    } catch (e) {
      toast.error(errMsg(e))
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [boardId, activeSpaceId])

  useEffect(() => { loadBoards() }, [loadBoards])
  useEffect(() => {
    if (!activeSpaceId) { setAgents([]); return }
    void agentsApi.list({ limit: '100' }).then(setAgents).catch(error => toast.error(errMsg(error)))
  }, [activeSpaceId])
  useEffect(() => { loadTasks() }, [loadTasks])

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (fStatus && t.status !== fStatus) return false
      if (fPriority && t.priority !== fPriority) return false
      if (fRisk && t.risk_level !== fRisk) return false
      if (fType && t.task_type !== fType) return false
      return true
    })
  }, [tasks, fStatus, fPriority, fRisk, fType])

  const statusOpts = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => s.add(t.status))
    return [...s].sort().map(v => ({ value: v, label: v }))
  }, [tasks])
  const priorityOpts = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => s.add(t.priority))
    return [...s].sort().map(v => ({ value: v, label: v }))
  }, [tasks])
  const riskOpts = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => s.add(t.risk_level))
    return [...s].sort().map(v => ({ value: v, label: v }))
  }, [tasks])
  const typeOpts = useMemo(() => {
    const s = new Set<string>()
    tasks.forEach(t => s.add(t.task_type))
    return [...s].sort().map(v => ({ value: v, label: v }))
  }, [tasks])

  async function createTask(body: Record<string, unknown>) {
    if (!hasWriteTarget) { toast.error('Select a write target'); return }
    try {
      const t = await tasksApi.create(body, { spaceId: writeTargetSpaceId ?? undefined })
      toast.success('Task created')
      setCreateOpen(false)
      navigate(`/tasks/${t.id}`)
      await loadTasks()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function quickStatus(task: Task, status: string) {
    try {
      await tasksApi.update(task.id, { status })
      toast.success('Updated')
      await loadTasks()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const boardOptions = [
    { value: '', label: 'All boards' },
    ...boards.map(b => ({ value: b.id, label: b.name })),
  ]

  const emptyFilter = (label: string, value: string, set: (v: string) => void, options: { value: string; label: string }[]) => (
    <div className="flex flex-col gap-1 min-w-[120px]">
      <Label className="text-xs">{label}</Label>
      <Select value={value} options={[{ value: '', label: 'Any' }, ...options]} onChange={set} />
    </div>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-border gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
              border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
            }}
          >
            <ListTodo className="size-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
            <p className="text-sm text-muted-foreground">Board work items, runs, and downstream artifacts.</p>
            <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="size-4" />
          New task
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1 min-w-[160px]">
          <Label className="text-xs">Board</Label>
          <Select value={boardId} options={boardOptions} onChange={setBoardId} />
        </div>
        {emptyFilter('Status', fStatus, setFStatus, statusOpts)}
        {emptyFilter('Priority', fPriority, setFPriority, priorityOpts)}
        {emptyFilter('Risk', fRisk, setFRisk, riskOpts)}
        {emptyFilter('Type', fType, setFType, typeOpts)}
      </div>

      {loading ? (
        <Card className="p-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          {activeSpaceId ? 'No tasks match these filters. Create a task or adjust filters.' : 'Select an operational space to browse tasks.'}
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map(task => {
            const b = boards.find(x => x.id === task.board_id)
            const preview = acPreview(task)
            return (
              <Card
                key={task.id}
                className="p-4 cursor-pointer hover:bg-accent/30 transition-colors"
                onClick={() => navigate(`/tasks/${task.id}`)}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="font-medium text-sm leading-snug">{task.title}</span>
                  <StatusBadge status={task.status} />
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <Badge variant="secondary">{task.task_type}</Badge>
                  <Badge variant="outline">{task.priority}</Badge>
                  <Badge variant="muted">{task.risk_level} risk</Badge>
                  <ScopeBadge visibility={task.visibility} omitShared />
                </div>
                {(task.assigned_agent_id || task.assigned_user_id) && (
                  <p className="text-xs text-muted-foreground mb-1">
                    {task.assigned_agent_id && <span>Agent {task.assigned_agent_id.slice(0, 8)}… </span>}
                    {task.assigned_user_id && <span>User {task.assigned_user_id.slice(0, 8)}…</span>}
                  </p>
                )}
                {task.due_at && (
                  <p className="text-xs text-muted-foreground mb-1">Due {fmt(task.due_at)}</p>
                )}
                {(b || task.project_folder_id) && (
                  <p className="text-xs text-muted-foreground mb-1">
                    {b && <span>Board: {b.name}</span>}
                    {b && task.project_folder_id && ' · '}
                    {task.project_folder_id && <span className="font-mono">ws {task.project_folder_id.slice(0, 8)}…</span>}
                  </p>
                )}
                {preview && (
                  <p className="text-xs text-muted-foreground border-t border-border pt-2 mt-2 line-clamp-2">
                    {preview}
                  </p>
                )}
                <div className="flex gap-2 mt-3 flex-wrap" onClick={e => e.stopPropagation()}>
                  {OPEN_STATUSES.has(task.status) && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => quickStatus(task, 'ready')}>Mark ready</Button>
                      <Button size="sm" variant="ghost" onClick={() => quickStatus(task, 'in_progress')}>In progress</Button>
                    </>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>Start with the goal. The Agent can clarify and structure the contract when you ask it to plan.</DialogDescription>
          </DialogHeader>
          <WriteTargetPicker />
          <TaskCreateForm boards={boards} agents={agents} submitLabel="Create task" onSubmit={createTask} onCancel={() => setCreateOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
