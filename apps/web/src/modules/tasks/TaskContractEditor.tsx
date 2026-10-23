import { useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentOut, Board, Task } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { TASK_PRIORITY_OPTIONS, TASK_RISK_OPTIONS, taskTypeOptions } from './taskFormOptions'

interface TaskContractEditorProps {
  task: Task
  boards: Board[]
  agents: AgentOut[]
  submitLabel: string
  busy?: boolean
  onSubmit: (body: Record<string, unknown>) => Promise<void>
  onCancel?: () => void
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('Numeric contract fields must be valid numbers.')
  return parsed
}

/**
 * A Task has no default time limit, so an empty field means "no limit". The
 * update API leaves an omitted field unchanged; clearing a stored limit must
 * therefore send an explicit `null`, or the old limit keeps stopping Runs.
 */
/** A cleared stored limit is sent as null (no limit); an untouched empty field is omitted (unchanged). */
function clearableLimit(value: string, stored: number | null | undefined): number | null | undefined {
  const parsed = optionalNumber(value)
  if (parsed !== undefined) return parsed
  return stored == null ? undefined : null
}

export default function TaskContractEditor({ task, boards, agents, submitLabel, busy = false, onSubmit, onCancel }: TaskContractEditorProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [taskType, setTaskType] = useState('general')
  const [priority, setPriority] = useState('normal')
  const [riskLevel, setRiskLevel] = useState('low')
  const [boardId, setBoardId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [definitionOfDone, setDefinitionOfDone] = useState('')
  const [maxRuns, setMaxRuns] = useState('')
  const [maxCost, setMaxCost] = useState('')
  const [maxDuration, setMaxDuration] = useState('')
  const [tags, setTags] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description ?? '')
    setTaskType(task.task_type)
    setPriority(task.priority)
    setRiskLevel(task.risk_level)
    setBoardId(task.board_id ?? '')
    setAgentId(task.assigned_agent_id ?? '')
    setDefinitionOfDone(task.definition_of_done ?? '')
    setMaxRuns(task.max_runs?.toString() ?? '')
    setMaxCost(task.max_cost?.toString() ?? '')
    setMaxDuration(task.max_duration_seconds?.toString() ?? '')
    setTags(task.tags?.join(', ') ?? '')
    setAdvancedOpen(false)
  }, [task])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) { toast.error('Title is required'); return }
    setSaving(true)
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        task_type: taskType,
        priority,
        risk_level: riskLevel,
        board_id: boardId || null,
        assigned_agent_id: agentId || null,
        definition_of_done: definitionOfDone.trim() || null,
        max_runs: clearableLimit(maxRuns, task.max_runs),
        max_cost: clearableLimit(maxCost, task.max_cost),
        max_duration_seconds: clearableLimit(maxDuration, task.max_duration_seconds),
        tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
      })
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        Acceptance criteria, required outputs, policy, and metadata are managed by the Agent from the Task description. Existing generated contract data is preserved when you edit this Task.
      </div>
      <div className="space-y-1.5"><Label htmlFor="task-edit-title">Title</Label><Input id="task-edit-title" value={title} onChange={event => setTitle(event.target.value)} /></div>
      <div className="space-y-1.5"><Label htmlFor="task-edit-description">Context and desired outcome</Label><Textarea id="task-edit-description" className="min-h-28" value={description} onChange={event => setDescription(event.target.value)} /></div>
      <div className="space-y-1.5"><Label htmlFor="task-edit-done">What does done look like? <span className="font-normal text-muted-foreground">(optional)</span></Label><Textarea id="task-edit-done" className="min-h-20" value={definitionOfDone} onChange={event => setDefinitionOfDone(event.target.value)} /></div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Task type</Label><Select value={taskType} onChange={setTaskType} options={taskTypeOptions(taskType)} /></div>
        <div className="space-y-1.5"><Label>Priority</Label><Select value={priority} onChange={setPriority} options={TASK_PRIORITY_OPTIONS} /></div>
        <div className="space-y-1.5"><Label>Risk</Label><Select value={riskLevel} onChange={setRiskLevel} options={TASK_RISK_OPTIONS} /></div>
        <div className="space-y-1.5"><Label>Board</Label><Select value={boardId} onChange={setBoardId} options={[{ value: '', label: 'No board' }, ...boards.map(board => ({ value: board.id, label: board.name }))]} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Assigned Agent</Label><Select value={agentId} onChange={setAgentId} options={[{ value: '', label: 'Unassigned' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]} /></div>
      </div>

      <div className="rounded-lg border border-border">
        <button type="button" className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm font-medium" onClick={() => setAdvancedOpen(value => !value)} aria-expanded={advancedOpen}>
          <span className="flex items-center gap-2"><SlidersHorizontal className="size-4 text-muted-foreground" />Advanced execution limits</span>
          <ChevronDown className={advancedOpen ? 'size-4 rotate-180 transition-transform' : 'size-4 transition-transform'} />
        </button>
        {advancedOpen && <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label htmlFor="task-edit-max-runs">Max runs</Label><Input id="task-edit-max-runs" type="number" min="1" step="1" value={maxRuns} onChange={event => setMaxRuns(event.target.value)} placeholder="No limit" /></div>
          <div className="space-y-1.5"><Label htmlFor="task-edit-max-cost">Max cost</Label><Input id="task-edit-max-cost" type="number" min="0" step="0.01" value={maxCost} onChange={event => setMaxCost(event.target.value)} placeholder="No limit" /></div>
          <div className="space-y-1.5"><Label htmlFor="task-edit-max-duration">Max duration (seconds)</Label><Input id="task-edit-max-duration" type="number" min="1" step="1" value={maxDuration} onChange={event => setMaxDuration(event.target.value)} placeholder="No time limit" /></div>
        </div>}
      </div>

      <div className="space-y-1.5"><Label htmlFor="task-edit-tags">Tags <span className="font-normal text-muted-foreground">(optional, comma separated)</span></Label><Input id="task-edit-tags" value={tags} onChange={event => setTags(event.target.value)} /></div>
      <div className="flex justify-end gap-2 border-t border-border pt-4">{onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy || saving}>Cancel</Button>}<Button type="submit" disabled={busy || saving}>{(busy || saving) ? 'Saving…' : submitLabel}</Button></div>
    </form>
  )
}
