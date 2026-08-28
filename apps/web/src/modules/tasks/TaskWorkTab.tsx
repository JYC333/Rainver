import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Bot, Check, Circle, User } from 'lucide-react'
import { tasksApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { ResponsibleActor, TaskWorkView, WorkLoopStageKey } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
// The Board words each refusal the same way; two copies would drift and tell
// the same person two different things about one Task.
import { completionReasonLabel } from '../projects/board/completionOverride'

/**
 * Where this Task is in its Loop, why it cannot close, and who has had it.
 *
 * Everything shown here is computed server-side. The tab words it and offers
 * the one control a person has over the Loop — moving the stage — because the
 * alternative is a browser copy of rules the write path enforces separately.
 */

function actorLabel(actor: ResponsibleActor): string {
  if (actor.kind === 'user') return actor.display_name ?? 'Someone'
  if (actor.kind === 'agent') return actor.display_name ?? 'An Agent'
  return actor.display_name ?? 'System'
}

function eventSummary(kind: string, data: Record<string, unknown>): string {
  const str = (key: string) => (typeof data[key] === 'string' ? data[key] as string : null)
  switch (kind) {
    case 'task.created': return 'Created the Task'
    case 'task.flow_changed': return `Moved it from ${str('from') ?? '—'} to ${str('to') ?? '—'}`
    case 'task.stage_changed': return `Loop moved to ${str('to_stage') ?? '—'}${str('reason') ? ` — ${str('reason')}` : ''}`
    case 'task.accepted': return Array.isArray(data.overridden) && data.overridden.length > 0
      ? `Accepted, overriding ${data.overridden.length} requirement${data.overridden.length === 1 ? '' : 's'}`
      : 'Accepted the result'
    case 'task.responsibility_changed': return 'Changed who is responsible'
    case 'task.run_settled': return `A Run settled: ${str('reason') ?? str('run_status') ?? '—'}`
    case 'task.reported': return str('summary') ?? 'Reported on the work'
    default: return kind
  }
}

export default function TaskWorkTab({ taskId, onChanged }: { taskId: string; onChanged?: () => void }) {
  const [view, setView] = useState<TaskWorkView | null>(null)
  const [loading, setLoading] = useState(true)
  const [stagePick, setStagePick] = useState<WorkLoopStageKey | ''>('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setView(await tasksApi.work(taskId))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => { void load() }, [load])

  const moveStage = useCallback(async () => {
    if (!stagePick || !reason.trim()) return
    setSaving(true)
    try {
      setView(await tasksApi.setStage(taskId, { to_stage: stagePick, reason: reason.trim() }))
      setStagePick('')
      setReason('')
      onChanged?.()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }, [taskId, stagePick, reason, onChanged])

  if (loading) return <Skeleton className="h-64 w-full" />
  if (!view) return null

  const currentIndex = view.loop
    ? view.stages.findIndex(stage => stage.key === view.loop!.current_stage_key)
    : -1

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Loop</Label>
          <span className="text-xs text-muted-foreground">
            {view.responsible.kind === 'agent'
              ? <span className="inline-flex items-center gap-1"><Bot className="size-3" />{actorLabel(view.responsible)}</span>
              : <span className="inline-flex items-center gap-1"><User className="size-3" />{actorLabel(view.responsible)}</span>}
          </span>
        </div>

        {/* The rail shows every stage, so a Task that skipped one still reads
            as having skipped it rather than as having no such stage — and only
            stages it has actually been in are ticked. A Task that settled
            straight to Evaluate never framed or planned, and marking those
            done by position would claim work nobody did. */}
        <ol className="flex flex-wrap items-center gap-1">
          {view.stages.map((stage, index) => {
            const current = currentIndex === index
            const done = !current && view.visited_stage_keys.includes(stage.key)
            return (
              <li key={stage.key} className="flex items-center gap-1">
                <span
                  className={[
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
                    current ? 'border-primary bg-primary/10 font-medium text-foreground' : '',
                    done ? 'border-border text-muted-foreground' : '',
                    !current && !done ? 'border-dashed border-border text-muted-foreground' : '',
                  ].join(' ')}
                  data-testid={`loop-stage-${stage.key}`}
                  data-current={current ? 'true' : 'false'}
                  data-visited={done ? 'true' : 'false'}
                >
                  {done ? <Check className="size-3" /> : <Circle className="size-3" />}
                  {stage.label}
                </span>
                {index < view.stages.length - 1 && <span className="text-muted-foreground">—</span>}
              </li>
            )
          })}
        </ol>
        {!view.loop && (
          <p className="text-xs text-muted-foreground">
            This Task has not entered its Loop yet.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="min-w-40">
            <Label className="text-xs text-muted-foreground">Move to</Label>
            <Select
              ariaLabel="Move to stage"
              value={stagePick}
              onChange={value => setStagePick(value as WorkLoopStageKey | '')}
              options={[
                { value: '', label: 'Choose a stage…' },
                ...view.stages.map(stage => ({ value: stage.key, label: stage.label })),
              ]}
            />
          </div>
          <div className="min-w-60 flex-1">
            <Label className="text-xs text-muted-foreground">Why</Label>
            <input
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="The method did not hold up"
            />
          </div>
          <Button size="sm" disabled={saving || !stagePick || !reason.trim()} onClick={() => void moveStage()}>
            {saving ? 'Moving…' : 'Move stage'}
          </Button>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <Label className="text-xs text-muted-foreground">Completion</Label>
        {view.completion.ok ? (
          <p className="text-sm text-muted-foreground">Everything this Task declared is in place.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="completion-missing">
            {view.completion.missing.map(reason => (
              <li key={reason} className="text-muted-foreground">○ {completionReasonLabel(reason)}</li>
            ))}
          </ul>
        )}
        {view.task.required_outputs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {view.task.required_outputs.map(token => (
              <Badge key={token} variant={view.present_outputs.includes(token) ? 'secondary' : 'outline'}>
                {view.present_outputs.includes(token) ? '✓' : '○'} {token}
              </Badge>
            ))}
          </div>
        )}
        {view.evaluation && (
          <p className="text-xs text-muted-foreground">
            Latest execution evaluation: {view.evaluation.recommendation ?? 'no recommendation'}
            {view.evaluation.summary ? ` — ${view.evaluation.summary}` : ''}
          </p>
        )}
      </Card>

      {view.links.length > 0 && (
        <Card className="p-4 space-y-2">
          <Label className="text-xs text-muted-foreground">Advancing</Label>
          <ul className="space-y-1 text-sm">
            {view.links.map(link => (
              <li key={`${link.entity_type}:${link.entity_id}:${link.role}`} className="text-muted-foreground">
                <span className="text-foreground">{link.role}</span>{' '}
                {link.entity_type.replace(/_/g, ' ')}{' '}
                <span className="font-mono text-[11px]">{link.entity_id.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4 space-y-3">
        <Label className="text-xs text-muted-foreground">Responsibility timeline</Label>
        {view.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been recorded for this Task yet.</p>
        ) : (
          <ol className="space-y-2">
            {view.events.map(event => (
              <li key={event.id} className="flex gap-2 text-sm">
                <span className="w-40 shrink-0 text-xs text-muted-foreground">
                  {new Date(event.occurred_at).toLocaleString()}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{actorLabel(event.actor)}</span>
                  {' — '}
                  <span className="text-muted-foreground">{eventSummary(event.event_kind, event.data_json)}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
