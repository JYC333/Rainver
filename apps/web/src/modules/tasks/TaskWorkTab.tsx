import { SpaceLink as Link } from "../../core/spaceNav";
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Bot, User } from 'lucide-react'
import { tasksApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { ResponsibleActor, TaskWorkView } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'
// The Board words each refusal the same way; two copies would drift and tell
// the same person two different things about one Task.
import { completionReasonLabel } from '../projects/board/completionOverride'

/** Task completion requirements, responsibility and recorded work. */
function actorLabel(actor: ResponsibleActor): string {
  if (actor.kind === 'user') return actor.display_name ?? 'Someone'
  if (actor.kind === 'agent') return actor.display_name ?? 'An Agent'
  return actor.display_name ?? 'System'
}

/** The server's failure codes in words; the raw code stays in the record. */
function mergeFailureText(error: string | null): string {
  switch (error) {
    case 'location_unavailable': return 'its Location is no longer available'
    case 'main_checked_out_elsewhere': return 'the main branch is checked out in another worktree'
    case 'no_main_branch': return 'the checkout has no main branch to merge into'
    case 'git_too_old': return "the host's git is too old to merge"
    case 'task_merge_unexpected_answer': return 'the host gave an answer the merge did not expect'
    default: return 'the merge failed on the host'
  }
}

function mergeBlockedSummary(reason: string | null, data: Record<string, unknown>): string {
  const listed = (key: string) => {
    const files = Array.isArray(data[key]) ? (data[key] as unknown[]).filter((f): f is string => typeof f === 'string') : []
    return files.length > 0 ? `: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}` : ''
  }
  switch (reason) {
    case 'waiting_local_changes': return listed('overlapping_files')
      ? `Ready to merge, waiting for uncommitted changes in the checkout${listed('overlapping_files')}`
      : 'Ready to merge, waiting for a rebase, merge or bisect of the main branch to finish'
    case 'conflict': return `Not merged: conflicts with the main branch${listed('conflicted_files')}; the branch is kept to merge by hand`
    case 'verification_failed': return 'Not merged: its checks failed on the latest main branch'
    default: return `Not merged: ${mergeFailureText(typeof data.error === 'string' ? data.error : null)}`
  }
}

function eventSummary(kind: string, data: Record<string, unknown>): string {
  const str = (key: string) => (typeof data[key] === 'string' ? data[key] as string : null)
  switch (kind) {
    case 'task.created': return 'Created the Task'
    case 'task.entity_linked': return 'Linked the Task to a question'
    case 'task.flow_changed': return `Moved it from ${str('from') ?? '—'} to ${str('to') ?? '—'}`
    case 'task.accepted': return Array.isArray(data.overridden) && data.overridden.length > 0
      ? `Accepted, overriding ${data.overridden.length} requirement${data.overridden.length === 1 ? '' : 's'}`
      : 'Accepted the result'
    case 'task.responsibility_changed': return 'Changed who is responsible'
    case 'task.run_settled': return `A Run settled: ${str('reason') ?? str('run_status') ?? '—'}`
    case 'task.merged': return `Merged into ${str('main_branch') ?? 'the main branch'}`
    case 'task.merge_blocked': return mergeBlockedSummary(str('reason'), data)
    case 'task.reported': return str('summary') ?? 'Reported on the work'
    default: return kind
  }
}

export default function TaskWorkTab({ taskId, refreshToken = 0 }: {
  taskId: string
  /** Incremented by the page after a write that may have changed the Work view. */
  refreshToken?: number
}) {
  const [view, setView] = useState<TaskWorkView | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    try {
      setView(await tasksApi.work(taskId))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => { void load() }, [load, refreshToken])

  if (loading) return <Skeleton className="h-64 w-full" />
  if (!view) return null

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Responsible</Label>
          <span className="text-xs text-muted-foreground">
            {view.responsible.kind === 'agent'
              ? <span className="inline-flex items-center gap-1"><Bot className="size-3" />{actorLabel(view.responsible)}</span>
              : <span className="inline-flex items-center gap-1"><User className="size-3" />{actorLabel(view.responsible)}</span>}
          </span>
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
                {link.entity_type === 'inquiry_thread' && view.task.project_id ? (
                  <Link className="text-primary underline underline-offset-4" to={`/projects/${encodeURIComponent(view.task.project_id)}/inquiry?thread=${encodeURIComponent(link.entity_id)}`}>Open question</Link>
                ) : <span className="font-mono text-[11px]">{link.entity_id.slice(0, 8)}</span>}
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
