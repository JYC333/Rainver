import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, Inbox, Lightbulb, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { systemActionsForObjectType, type SourceSystemActionId } from '@agent-space/protocol'
import { projectResearchApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type { ProjectResearchStandingStatus } from '../../types/api'

export interface ProjectResearchStandingPanelProps {
  projectId: string
  canAct: boolean
}

type StandingSourceActionId = Extract<SourceSystemActionId, 'source.raise_as_question'>

const SOURCE_ACTION_LABELS = {
  'source.raise_as_question': 'Create question',
} satisfies Record<StandingSourceActionId, string>

const SOURCE_ACTIONS = new Map(
  systemActionsForObjectType('source').map(definition => [
    definition.id as StandingSourceActionId,
    SOURCE_ACTION_LABELS[definition.id as StandingSourceActionId],
  ]),
)

export function ProjectResearchStandingPanel({ projectId, canAct }: ProjectResearchStandingPanelProps) {
  const [status, setStatus] = useState<ProjectResearchStandingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyAdviceId, setBusyAdviceId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoadError(null)
      setStatus(await projectResearchApi.standing(projectId))
    } catch (error) {
      setLoadError(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  async function act(adviceId: string) {
    setBusyAdviceId(adviceId)
    try {
      await projectResearchApi.actionStandingAdvice(projectId, adviceId)
      toast.success('Question created in Inquiry')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyAdviceId(null)
    }
  }

  async function dismiss(adviceId: string) {
    setBusyAdviceId(adviceId)
    try {
      await projectResearchApi.dismissStandingAdvice(projectId, adviceId)
      setStatus(current => current ? { ...current, advice: current.advice.filter(item => item.id !== adviceId) } : current)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyAdviceId(null)
    }
  }

  async function retryBatch(batchId: string, needsBaseline: boolean) {
    setBusyAdviceId(batchId)
    try {
      if (needsBaseline) await projectResearchApi.initializeArea(projectId)
      await projectResearchApi.retryStandingBatch(projectId, batchId)
      toast.success('Standing comparison queued again')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyAdviceId(null)
    }
  }

  if (loading) {
    return <section aria-label="Loading standing research" className="h-40 animate-pulse rounded-lg border border-border bg-muted/30" />
  }
  if (loadError || !status) {
    return (
      <Card className="p-4">
        <EmptyState title="Standing research unavailable" description={loadError ?? 'Could not load standing research.'} />
        <div className="flex justify-center"><Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button></div>
      </Card>
    )
  }

  const budgetPercent = status.budget.daily_limit > 0
    ? Math.min(100, status.budget.daily_used / status.budget.daily_limit * 100)
    : 0
  return (
    <div className="space-y-4" aria-label="Standing research">
      <Card className="p-4 lg:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><Inbox className="size-4 text-accent-foreground" /><h2 className="font-semibold">Standing research</h2></div>
            <p className="mt-1 text-sm text-muted-foreground">New material is compared with the Project’s current understanding before you choose a focused question.</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status.enabled ? 'secondary' : 'outline'}>{status.enabled ? `${status.enabled_binding_count} monitored source${status.enabled_binding_count === 1 ? '' : 's'}` : 'Monitoring off'}</Badge>
            <Button aria-label="Refresh standing research" size="icon" variant="ghost" onClick={() => void load()}><RefreshCw className="size-4" /></Button>
          </div>
        </div>
        <div className="mt-4 rounded-md border border-border p-3">
          <div className="flex items-center justify-between text-xs"><span className="font-medium">Daily comparison budget</span><span className="text-muted-foreground">{status.budget.daily_used} of {status.budget.daily_limit} runs used</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${budgetPercent}%` }} /></div>
        </div>
      </Card>

      {status.batches.some(batch => ['blocked_baseline', 'budget_exhausted', 'failed'].includes(batch.status)) && (
        <section className="space-y-2" aria-labelledby="standing-status-heading">
          <h2 id="standing-status-heading" className="text-sm font-semibold">Needs attention</h2>
          {status.batches
            .filter(batch => ['blocked_baseline', 'budget_exhausted', 'failed'].includes(batch.status))
            .map(batch => (
              <Card key={batch.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      {batch.status === 'blocked_baseline'
                        ? 'Project understanding is not ready'
                        : batch.status === 'budget_exhausted'
                          ? 'Daily comparison budget reached'
                          : 'Standing comparison failed'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {batch.status === 'blocked_baseline'
                        ? `The ${batch.missing_baseline_role ?? 'understanding'} note is required before this batch can be compared.`
                        : batch.status === 'budget_exhausted'
                          ? 'The queued material remains visible; comparison can resume after the UTC daily budget resets.'
                          : batch.error ?? 'The batch did not complete. Review the Project setup and retry with the next source scan.'}
                    </p>
                  </div>
                  {batch.status === 'blocked_baseline' && (
                    <Link to={`/projects/${projectId}/notes`}><Button size="sm" variant="outline">Open Project notes</Button></Link>
                  )}
                  {['blocked_baseline', 'failed'].includes(batch.status) && (
                    <Button size="sm" disabled={!canAct || busyAdviceId !== null} onClick={() => void retryBatch(batch.id, batch.status === 'blocked_baseline')}>
                      {busyAdviceId === batch.id ? 'Queueing…' : 'Retry comparison'}
                    </Button>
                  )}
                  {batch.run_id && <Link to={`/runs/${batch.run_id}`}><Button size="sm" variant="outline">Open run</Button></Link>}
                </div>
              </Card>
            ))}
        </section>
      )}

      <section className="space-y-2" aria-labelledby="standing-advice-heading">
        <div className="flex items-center justify-between"><h2 id="standing-advice-heading" className="text-sm font-semibold">Advice</h2><Link className="text-xs text-muted-foreground hover:underline" to={`/projects/${projectId}/inquiry`}>Open Inquiry</Link></div>
        {status.advice.length === 0 ? (
          <Card className="p-4"><p className="text-sm text-muted-foreground">No new directions need a decision.</p></Card>
        ) : status.advice.map(advice => {
          const actionLabel = SOURCE_ACTIONS.get(advice.action_id)
          return (
          <Card key={advice.id} className="p-4">
            <div className="flex items-start gap-3">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">{advice.source_title}</p>
                <p className="mt-1 text-sm">{advice.detail}</p>
                {advice.affected_sections_json.length > 0 && <p className="mt-2 text-xs text-muted-foreground">May affect {advice.affected_sections_json.join(', ')}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {actionLabel && <Button size="sm" disabled={!canAct || busyAdviceId !== null} onClick={() => void act(advice.id)}>
                    <ArrowUpRight className="size-3.5" />{busyAdviceId === advice.id ? 'Creating…' : actionLabel}
                  </Button>}
                  <Button aria-label={`Dismiss advice from ${advice.source_title}`} size="sm" variant="ghost" disabled={!canAct || busyAdviceId !== null} onClick={() => void dismiss(advice.id)}><X className="size-3.5" />Dismiss</Button>
                </div>
              </div>
            </div>
          </Card>
          )
        })}
      </section>

      <section className="space-y-2" aria-labelledby="recent-inflow-heading">
        <div className="flex items-center justify-between"><h2 id="recent-inflow-heading" className="text-sm font-semibold">Recent inflow</h2><Link className="text-xs text-muted-foreground hover:underline" to={`/projects/${projectId}/research`}>Open Reading List</Link></div>
        {status.recent_inflow.length === 0 ? (
          <Card className="p-4"><p className="text-sm text-muted-foreground">No material has arrived from monitored sources yet.</p></Card>
        ) : (
          <Card className="divide-y divide-border">
            {status.recent_inflow.slice(0, 8).map(item => (
              <div key={item.source_item_id} className="p-3 first:rounded-t-lg last:rounded-b-lg">
                <div className="flex items-start justify-between gap-3"><p className="text-sm font-medium">{item.title}</p><time className="shrink-0 text-xs text-muted-foreground" dateTime={item.matched_at}>{new Date(item.matched_at).toLocaleDateString()}</time></div>
                {item.excerpt && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.excerpt}</p>}
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  )
}
