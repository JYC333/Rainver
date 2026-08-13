import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { inquiryApi } from '../../../api/client'
import { SpaceLink as Link } from '../../../core/spaceNav'
import type { InquiryNextFocusKind, InquiryOpenStep } from '../../../types/api'
import { NEXT_FOCUS_LABELS } from './nextFocus'

/**
 * Which Thread sent you here, shown in the Area where the work happens.
 *
 * Following a call to action used to leave the Thread behind entirely: the
 * destination knew nothing about why the user had arrived, so the round was
 * only ever closed by someone who remembered to navigate back. The open Step
 * carries that context, which means it survives a refresh, a second
 * navigation, and another device — none of which a URL parameter does.
 *
 * Rendered only for steps whose work belongs to this Area, so Operations does
 * not claim a Thread that is off reading evidence somewhere else.
 */
export function ThreadOriginBar({ projectId, kinds, className }: {
  projectId: string
  kinds: InquiryNextFocusKind[]
  /** Spacing owned by the caller, applied only when there is a bar to space. */
  className?: string
}) {
  const [steps, setSteps] = useState<InquiryOpenStep[]>([])

  useEffect(() => {
    let cancelled = false
    // Best-effort: a Thread's context is an aid, and failing to load it must
    // never keep the Area the user actually asked for off the screen.
    void inquiryApi.listOpenSteps(projectId)
      .then(result => { if (!cancelled) setSteps(result) })
      .catch(() => { if (!cancelled) setSteps([]) })
    return () => { cancelled = true }
  }, [projectId])

  const relevant = steps.filter(step => kinds.includes(step.kind))
  if (relevant.length === 0) return null

  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      {relevant.map(step => (
        <div
          key={step.id}
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs"
        >
          <span className="text-muted-foreground">
            {NEXT_FOCUS_LABELS[step.kind]} for
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{step.statement}</span>
          <Link
            to={`/projects/${projectId}/inquiry?thread=${step.thread_id}`}
            className="flex shrink-0 items-center gap-1 text-primary hover:underline"
          >
            <ArrowLeft className="size-3" />
            Back to the Thread
          </Link>
        </div>
      ))}
    </div>
  )
}
