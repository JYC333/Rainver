import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Check, RefreshCw, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type { InquiryThreadAdvice, ProjectResearchWorkflow } from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { NEXT_FOCUS_LABELS, nextFocusDestination, type ThreadTabId } from './nextFocus'

/**
 * Model advice about this Thread's next step. It stays a suggestion: adopting
 * it calls the same work-state command the user's own choice does, so the
 * Next Focus invariant keeps exactly one enforcement point.
 *
 * The entry point for the suggested step is resolved here rather than sent
 * with the advice (ADR 0012 decision 8, amended): route strings and the
 * running-workflow state that picks between them are the client's to know, and
 * a second copy on the server drifted out of date the moment routes moved.
 */
export function AdviceBlock({ projectId, threadId, advice, canAct, startedWorkflow, onOpenTab, onChanged }: {
  projectId: string
  threadId: string
  advice: InquiryThreadAdvice | null
  canAct: boolean
  startedWorkflow: ProjectResearchWorkflow | null
  onOpenTab: (tab: ThreadTabId) => void
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  const generate = () => run(() => inquiryApi.generateAdvice(projectId, threadId))

  if (!advice || advice.status === 'dismissed') {
    if (!canAct) return null
    return (
      <div className="mt-3 border-t pt-3">
        <Button size="sm" variant="ghost" onClick={generate} disabled={busy}>
          <Sparkles className="size-4" />{busy ? 'Thinking…' : 'Ask for a suggested next step'}
        </Button>
      </div>
    )
  }

  const adopted = advice.status === 'adopted'
  const destination = nextFocusDestination(advice.recommended_focus_kind, {
    projectId, threadId, startedWorkflow,
  })

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3" />
        Suggested next step
        {advice.stale && (
          <span className="flex items-center gap-1 text-amber-600">
            <AlertTriangle className="size-3" />
            based on v{advice.thread_version} — this Thread has changed since
          </span>
        )}
        {adopted && <span className="text-emerald-600">· adopted</span>}
      </p>

      <p className="text-sm font-medium">{NEXT_FOCUS_LABELS[advice.recommended_focus_kind]}</p>
      <p className="text-sm text-muted-foreground">{advice.rationale}</p>
      {advice.cited_refs.length > 0 && (
        <p className="text-xs text-muted-foreground">Cites: {advice.cited_refs.join(' · ')}</p>
      )}

      {canAct && (
        <div className="flex flex-wrap gap-1.5">
          {destination.kind === 'link' && (
            <Button size="sm" variant="outline" asChild>
              <Link to={destination.to}>{destination.cta}<ArrowRight className="size-4" /></Link>
            </Button>
          )}
          {destination.kind === 'tab' && (
            <Button size="sm" variant="outline" onClick={() => onOpenTab(destination.tab)}>
              {destination.cta}<ArrowRight className="size-4" />
            </Button>
          )}
          {!adopted && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => inquiryApi.adoptAdvice(projectId, threadId))}>
              <Check className="size-4" />Adopt as next step
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={generate}>
            <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />Regenerate
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => inquiryApi.dismissAdvice(projectId, threadId))}>
            <X className="size-4" />Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}
