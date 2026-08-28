import { useState, type FormEvent } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentOut, Board } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import {
  DEFAULT_TASK_LIMITS,
  TASK_PRIORITY_OPTIONS,
  TASK_RISK_OPTIONS,
  TASK_TYPE_OPTIONS,
} from './taskFormOptions'

interface TaskCreateFormProps {
  boards: Board[]
  agents: AgentOut[]
  submitLabel: string
  busy?: boolean
  onSubmit: (body: Record<string, unknown>) => Promise<void>
  onCancel?: () => void
}

export default function TaskCreateForm({ boards, agents, submitLabel, busy = false, onSubmit, onCancel }: TaskCreateFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [taskType, setTaskType] = useState('general')
  const [priority, setPriority] = useState('normal')
  const [riskLevel, setRiskLevel] = useState('low')
  const [boardId, setBoardId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [definitionOfDone, setDefinitionOfDone] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) {
      toast.error('Tell us what needs to be done.')
      return
    }
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
        tags: tags.split(',').map(tag => tag.trim()).filter(Boolean),
        // The server also applies these defaults for non-UI callers.
        ...DEFAULT_TASK_LIMITS,
      })
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <p className="text-muted-foreground">Describe the outcome in your own words. When you ask the Agent to plan, it will derive the acceptance criteria, outputs, policy, and execution path.</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="task-create-title">What needs to be done?</Label>
        <Input id="task-create-title" autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Prepare a decision brief for next week's meeting" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-create-description">Context and desired outcome</Label>
        <Textarea id="task-create-description" className="min-h-28" value={description} onChange={event => setDescription(event.target.value)} placeholder="Add context, constraints, links, or anything the Agent should know." />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-create-done">What does done look like? <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Textarea id="task-create-done" className="min-h-20" value={definitionOfDone} onChange={event => setDefinitionOfDone(event.target.value)} placeholder="Describe the expected result in plain language." />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Task type</Label><Select value={taskType} onChange={setTaskType} options={TASK_TYPE_OPTIONS} /></div>
        <div className="space-y-1.5"><Label>Priority</Label><Select value={priority} onChange={setPriority} options={TASK_PRIORITY_OPTIONS} /></div>
        <div className="space-y-1.5"><Label>Risk</Label><Select value={riskLevel} onChange={setRiskLevel} options={TASK_RISK_OPTIONS} /></div>
        {boards.length > 0 && (
          <div className="space-y-1.5"><Label>Board</Label><Select value={boardId} onChange={setBoardId} options={[{ value: '', label: 'No board' }, ...boards.map(board => ({ value: board.id, label: board.name }))]} /></div>
        )}
        <div className="space-y-1.5 sm:col-span-2"><Label>Planning Agent <span className="font-normal text-muted-foreground">(optional)</span></Label><Select value={agentId} onChange={setAgentId} options={[{ value: '', label: 'Choose later' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]} /></div>
      </div>

      <div className="space-y-1.5"><Label htmlFor="task-create-tags">Tags <span className="font-normal text-muted-foreground">(optional, comma separated)</span></Label><Input id="task-create-tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="e.g. planning, launch" /></div>
      <p className="text-xs text-muted-foreground">Execution defaults: {DEFAULT_TASK_LIMITS.max_runs} runs · ${DEFAULT_TASK_LIMITS.max_cost} budget · {DEFAULT_TASK_LIMITS.max_duration_seconds / 60} minutes. You can change these later under advanced contract settings.</p>

      <div className="flex justify-end gap-2 border-t border-border pt-4">{onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy || saving}>Cancel</Button>}<Button type="submit" disabled={busy || saving}>{(busy || saving) ? 'Creating…' : submitLabel}</Button></div>
    </form>
  )
}
