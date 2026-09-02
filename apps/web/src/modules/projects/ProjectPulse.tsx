import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, CircleAlert, CircleDot, Compass, Loader2, RefreshCw, User } from 'lucide-react'
import { toast } from 'sonner'
import { inquiryApi, projectsApi } from '../../api/client'
import { usePeriodicRefresh } from '../../hooks/usePeriodicRefresh'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { ProjectBoard, ProjectOverview, ProjectWorkUpdate } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { inProjectHref, projectTaskHref } from './taskHref'
// The one place that already knows how to say what an Operation is doing —
// "848/873 materials classified". Pulse renders that sentence rather than
// composing a second, quieter version of it.
import { researchOperationDetail, researchOperationPercent, researchOperationStage, researchStageIndex } from './FocusResearchWorkbench'

/**
 * What is actually going on, before anyone opens the Board.
 *
 * Three questions, in the order a person asks them on arriving: what needs
 * attention, what is moving, and what has happened lately. Everything here is
 * already computed server-side — the attention list is the same one the shell
 * renders, and the counts come from the Board read model — so this is wording,
 * not a second opinion. That is also why nothing is filtered out of the
 * attention list: two surfaces on one screen disagreeing about whether
 * anything is pending is worse than either of them alone.
 *
 * Deliberately absent: Health, an Autonomy switch, and Pause. None of the
 * three has anything that writes it, and a control that reports a value nobody
 * maintains is worse than no control.
 */

/** Loud first. Everything in the list is pending; some of it is louder. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 }

/** Loudest first: a gate blocks, a spend waits, a suggestion offers, a doubt informs. */
const ATTENTION_CLASS_ORDER = ['gate', 'remainder', 'next_step', 'uncertain'] as const
const ATTENTION_CLASS_LABELS: Record<(typeof ATTENTION_CLASS_ORDER)[number], string> = {
  gate: 'Waiting on your decision',
  remainder: 'More work available',
  next_step: 'Suggested next step',
  uncertain: 'The Agent was unsure',
}

/** A Task nobody is working on any more is not "in progress". */
const SETTLED_STATUSES = new Set(['done', 'cancelled'])


/** Read refresh cadence; the same five seconds the Inquiry Area uses for a live Thread. */
const PULSE_REFRESH_MS = 5_000

export default function ProjectPulse({
  projectId,
  overview,
  onOverviewChanged,
  onDefineGoal,
}: {
  projectId: string
  overview: ProjectOverview | null
  /** Called when this surface changed something the overview reports. */
  onOverviewChanged?: () => void
  /**
   * Opens the owner's goal dialog. The goal is edited on this page (the
   * header's "Edit goal"), so the prompt to define one opens the same dialog
   * rather than sending the person to another Area to do it.
   */
  onDefineGoal: () => void
}) {
  const [board, setBoard] = useState<ProjectBoard | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)
  const [updates, setUpdates] = useState<ProjectWorkUpdate[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const showingRef = useRef(projectId)
  const load = useCallback(async (quiet = false) => {
    showingRef.current = projectId
    if (!quiet) setLoading(true)
    setFailed(false)
    try {
      const [nextBoard, nextUpdates] = await Promise.all([
        projectsApi.getBoard(projectId),
        projectsApi.updates(projectId, { limit: 3 }),
      ])
      // A late answer for a Project the person has since left says nothing
      // about the one they are looking at.
      if (showingRef.current !== projectId) return
      setBoard(nextBoard)
      setUpdates(nextUpdates.items)
    } catch (error) {
      // A failed read must never render as "nothing is happening". On the one
      // surface whose whole job is situational awareness, a confident all-clear
      // that is really an error is the worst answer available.
      setFailed(true)
      if (!quiet) toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const adopt = useCallback(async (threadId: string) => {
    setAdopting(threadId)
    try {
      await inquiryApi.adoptAdvice(projectId, threadId)
      toast.success('Next step adopted')
      // The attention list lives on the overview, which this surface receives
      // as a prop: without telling the owner, the adopted suggestion stays on
      // screen and a second click 404s against its own "already taken" guard.
      onOverviewChanged?.()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setAdopting(null)
    }
  }, [projectId, load, onOverviewChanged])

  useEffect(() => { void load() }, [load])
  // What the Room's Agent records — a definition accepted, a question opened,
  // a Task created — shows here without leaving the page. The overview
  // (definition status, goal) is the parent's read, refreshed with it.
  const refresh = useCallback(async () => {
    await load(true)
    onOverviewChanged?.()
  }, [load, onOverviewChanged])
  usePeriodicRefresh(refresh, PULSE_REFRESH_MS)

  if (loading) return <Skeleton className="h-40 w-full" />

  if (failed) {
    return (
      <Card className="flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Could not load what is going on in this Project.
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          Try again
        </Button>
      </Card>
    )
  }

  const attention = [...(overview?.attention ?? [])].sort((a, b) =>
    (SEVERITY_ORDER[a.severity ?? 'normal'] ?? 2) - (SEVERITY_ORDER[b.severity ?? 'normal'] ?? 2))
  const moving = (board?.cards ?? [])
    .filter(card => !SETTLED_STATUSES.has(card.status))
    .filter(card => card.responsible.kind === 'agent' || card.status === 'in_progress')
    .sort((a, b) => b.active_run_count - a.active_run_count)
    .slice(0, 6)

  // One list, whatever the work is. A Task moving and a research Operation
  // screening nine hundred documents are both "in progress"; only the first
  // used to appear here, so a Project running for hours read as idle.
  // Operations are work too, and the overview already carries the unfinished
  // ones — reading only the Board is why a research acquisition screening
  // nine hundred documents showed up here as "nothing is being worked on".
  const running = overview?.in_progress ?? []
  const nothingRunning = moving.length === 0 && running.length === 0

  const needsGoal = overview?.definition_status?.status === 'needs_definition'
  const needsFolder = overview?.has_project_folder === false

  return (
    <>
      {/* Setup, above the situation and spaced like the page's other blocks:
          as grid cells these sat closer to each other than to the goal card
          above them. */}
      {/* The one thing a Project has to decide about itself, said until it
          has: creation no longer asks for a goal, and the shell no longer
          carries a readiness checklist, so this is where it is asked. */}
      {needsGoal && (
        <Card className="flex items-start justify-between gap-3 p-4" data-testid="pulse-needs-goal">
          <div>
            <p className="text-sm font-medium">This Project has no goal yet.</p>
            <p className="text-xs text-muted-foreground">
              A sentence about the outcome is what the Assistant and the Loop orient on.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onDefineGoal}>Define the goal</Button>
        </Card>
      )}
      {/* A Folder is optional, so this is a quiet line, not a warning: an
          Agent on a Project with code and no Folder works in a managed
          workspace on the Host rather than in that code, and the only place
          to connect one is Files & Code. */}
      {needsFolder && (
        <Card className="flex items-start justify-between gap-3 p-4" data-testid="pulse-needs-folder">
          <div>
            <p className="text-sm font-medium">No working Folder connected.</p>
            <p className="text-xs text-muted-foreground">
              If this Project has code or files to work on, connect one; until then Agents work in a managed workspace.
            </p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to={`/projects/${projectId}/files?setup=folder`}>Connect a Folder</Link>
          </Button>
        </Card>
      )}
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Needs attention
        </h2>
        {attention.length === 0 ? (
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Nothing is waiting on you.</p>
          </Card>
        ) : (
          /* Grouped by why it needs a person (ADR 0017 §4). A decision, a
             spend, a suggestion and a doubt read differently and are acted on
             differently; one undifferentiated list is what made six identical
             cards feel like an unresolvable pile. */
          <div className="space-y-3">
            {ATTENTION_CLASS_ORDER.filter(cls => attention.some(item => item.attention_class === cls)).map(cls => (
              <div key={cls} className="space-y-2" data-testid={`attention-${cls}`}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {ATTENTION_CLASS_LABELS[cls]}
                </p>
                {attention.filter(item => item.attention_class === cls).map(item => (
                  <Card key={item.id} className="flex items-start gap-2 p-3">
                    {cls === 'next_step'
                      ? <Compass className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      : <CircleAlert className={`mt-0.5 size-4 shrink-0 ${cls === 'gate' ? 'text-destructive' : 'text-muted-foreground'}`} />}
                    <div className="min-w-0 flex-1">
                      <Link to={inProjectHref(projectId, item.href)} className="text-sm font-medium hover:underline">
                        {item.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {item.summary ?? item.reason?.replace(/_/g, ' ')}
                      </p>
                    </div>
                    {/* The system worked the step out; taking it should not
                        mean navigating to an Area to press the same button. */}
                    {cls === 'next_step' && item.source_type === 'inquiry_advice' && item.source_id && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={adopting === item.source_id}
                        onClick={() => void adopt(item.source_id!)}
                      >
                        Adopt
                      </Button>
                    )}
                  </Card>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          In progress
        </h2>
        {nothingRunning ? (
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">Nothing is being worked on right now.</p>
          </Card>
        ) : (
          <div className="space-y-2" data-testid="pulse-in-progress">
            {running.map(operation => (
              <Card key={operation.id} className="space-y-1.5 p-3" data-testid={`in-progress-${operation.id}`}>
                <div className="flex items-start justify-between gap-2">
                  {/* Straight to the Operation itself. "What is running" is no
                      use if reading the detail means hunting for the row. */}
                  <Link
                    to={`/projects/${projectId}/research?tab=runs&open=${operation.id}`}
                    className="min-w-0 text-sm font-medium hover:underline"
                  >
                    {operation.title}
                  </Link>
                  <Badge
                    variant={operation.status === 'waiting_review' ? 'warning' : 'outline'}
                    className="shrink-0 text-[11px]"
                  >
                    {operation.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {operation.status === 'waiting_review'
                    ? <CircleAlert className="size-3 shrink-0" />
                    : <Loader2 className="size-3 shrink-0 animate-spin" />}
                  <span className="min-w-0 truncate">{researchOperationDetail(operation)}</span>
                </p>
                {/* A bar and a spinner say "something is happening" and
                    nothing else. The stages that count items say so in the
                    line above; every stage can at least say where it is and
                    how far along, so no stage is just a turning circle. */}
                <div className="flex items-center gap-2">
                  <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${researchOperationPercent(operation)}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {researchOperationPercent(operation)}% · step {researchStageIndex(researchOperationStage(operation)) + 1}/5
                  </span>
                </div>
              </Card>
            ))}
            {moving.map(card => (
              <Card key={card.id} className="flex items-start justify-between gap-2 p-3">
                <div className="min-w-0">
                  <Link to={projectTaskHref(projectId, card.id)} className="text-sm font-medium hover:underline">
                    {card.title}
                  </Link>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {card.responsible.kind === 'agent' ? <Bot className="size-3" /> : <User className="size-3" />}
                    {card.responsible.display_name ?? 'Unassigned'}
                    {card.active_run_count > 0 && <CircleDot className="size-3 animate-pulse" />}
                  </p>
                </div>
                {card.loop_stage_label && (
                  <Badge variant="outline" className="shrink-0 text-[11px]">{card.loop_stage_label}</Badge>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2 md:col-span-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Latest updates
          </h2>
          <Link to={`/projects/${projectId}/updates`} className="text-xs text-muted-foreground hover:underline">
            All updates
          </Link>
        </div>
        {updates.length === 0 ? (
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">
              Nobody has reported on this Project yet.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {updates.map(update => (
              <Card key={update.id} className="p-3">
                <p className="text-sm">{update.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {update.actor.display_name ?? 'System'}
                  {update.subject ? ` · ${update.subject.title}` : ''}
                  {' · '}
                  {new Date(update.occurred_at).toLocaleString()}
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
    </>
  )
}
