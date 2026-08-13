import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowRight, Ban, Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useSpaceNavigate } from '../../../core/spaceNav'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type {
  InquiryEvidenceSignal, InquiryNextFocusKind, InquiryThreadAdvice, InquiryThreadDetail,
  InquiryThreadStep, ProjectResearchWorkflow,
} from '../../../types/api'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { CloseOutForm } from './CloseOutForm'
import { NEXT_FOCUS_LABELS, nextFocusDestination, type ThreadTabId } from './nextFocus'
import {
  deriveStages, inStageAlternatives, recommendStep, recommendStepForStage,
  STAGE_FOR_KIND, STAGE_HELP, STAGE_LABELS, STAGE_ORDER, type StageId, type StageInput,
} from './stages'

/**
 * One stage selector, one adjacent workspace, and one recommendation.
 * Selecting a stage changes only what is being inspected; starting an action
 * is the explicit command that changes Thread work state.
 */
export function StageWorkspace({
  projectId, detail, signals, pendingCandidateCount, startedWorkflow, questionRefined, advice,
  steps, closedRounds, roundStartedAt, onOpenTab, onChanged,
}: {
  projectId: string
  detail: InquiryThreadDetail
  signals: InquiryEvidenceSignal[]
  pendingCandidateCount: number
  startedWorkflow: ProjectResearchWorkflow | null
  questionRefined: boolean
  advice: InquiryThreadAdvice | null
  steps: InquiryThreadStep[]
  closedRounds: number
  roundStartedAt: string | null
  onOpenTab: (tab: ThreadTabId) => void
  onChanged: () => Promise<void>
}) {
  const navigate = useSpaceNavigate()
  const roundSteps = useMemo(() => steps.filter(step => step.iteration_id === null), [steps])
  const stageInput: StageInput = {
    detail, signals, pendingCandidateCount, startedWorkflow, questionRefined,
    roundSteps, closedRounds, roundStartedAt,
  }
  const { stages, current, round } = deriveStages(stageInput)
  const ruleRecommendation = recommendStep(stageInput)
  const activeAdvice = advice?.status === 'open' && !advice.stale ? advice : null
  const recommendation = activeAdvice
    ? { kind: activeAdvice.recommended_focus_kind, reason: activeAdvice.rationale }
    : ruleRecommendation
  const recommendationStage = STAGE_FOR_KIND[recommendation.kind]

  const [viewedStage, setViewedStage] = useState<StageId>(current)
  const [followCurrent, setFollowCurrent] = useState(true)
  const [busy, setBusy] = useState(false)
  const stageTabs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    setViewedStage(current)
    setFollowCurrent(true)
    // A different Thread is a different workspace. The derived current stage
    // is the only safe initial selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id])

  useEffect(() => {
    if (followCurrent) setViewedStage(current)
  }, [current, followCurrent])

  const viewed = stages.find(stage => stage.id === viewedStage)!
  const stageDefault = recommendStepForStage(stageInput, viewedStage)
  const stagePrimary = recommendationStage === viewedStage ? recommendation : stageDefault
  const stageActions = [
    stagePrimary,
    ...(stagePrimary.kind !== stageDefault.kind ? [stageDefault] : []),
    ...inStageAlternatives(stageInput, viewedStage).filter(
      action => action.kind !== stagePrimary.kind && action.kind !== stageDefault.kind,
    ),
  ].map(action => action.kind === detail.next_focus_kind && detail.next_focus_note
    ? { ...action, reason: detail.next_focus_note }
    : action)
  const openBackground = roundSteps.filter(step => step.slot === 'background' && step.status === 'in_progress')
  const canAct = detail.lifecycle_status === 'active'
  const blocked = detail.attention_state === 'blocked' || Boolean(detail.blocked_reason)

  async function refreshFollowingCurrent() {
    setFollowCurrent(true)
    await onChanged()
  }

  async function updateWork(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    try {
      const result = await inquiryApi.updateWork(projectId, detail.id, body)
      if (result.wip_limit_exceeded) {
        toast.warning('Shared Focus WIP limit exceeded — consider moving another Thread to Monitoring')
      }
      await refreshFollowingCurrent()
      return true
    } catch (error) {
      toast.error(errMsg(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function start(kind: InquiryNextFocusKind): Promise<boolean> {
    const adoptsVisibleAdvice = activeAdvice?.recommended_focus_kind === kind
    if (!adoptsVisibleAdvice) {
      return updateWork(detail.attention_state === 'focused'
        ? { next_focus_kind: kind, blocked_reason: null }
        : { next_focus_kind: kind, blocked_reason: null, attention_state: 'focused' })
    }

    setBusy(true)
    try {
      // The adopt command atomically brings the Thread into Focus and starts
      // the server-owned advice Step, preserving its provenance.
      const result = await inquiryApi.adoptAdvice(projectId, detail.id)
      if (result.thread.wip_limit_exceeded) {
        toast.warning('Shared Focus WIP limit exceeded — consider moving another Thread to Monitoring')
      }
      await refreshFollowingCurrent()
      return true
    } catch (error) {
      toast.error(errMsg(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function go(kind: InquiryNextFocusKind) {
    if (!(await start(kind))) return
    const destination = nextFocusDestination(kind, { projectId, threadId: detail.id, startedWorkflow })
    if (destination.kind === 'tab') onOpenTab(destination.tab)
    else navigate(destination.to)
  }

  async function ignoreSuggestion() {
    if (!activeAdvice) return
    setBusy(true)
    try {
      await inquiryApi.dismissAdvice(projectId, detail.id)
      await onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  const viewedStatus = viewed.complete
    ? 'Completed this round'
    : viewed.running
      ? 'Work running'
      : viewed.current
        ? 'Current stage'
      : 'Not started this round'

  function inspectStage(stage: StageId, focus = false) {
    setViewedStage(stage)
    setFollowCurrent(false)
    if (focus) stageTabs.current[STAGE_ORDER.indexOf(stage)]?.focus()
  }

  function handleStageKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let target: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (index + 1) % stages.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (index - 1 + stages.length) % stages.length
    if (event.key === 'Home') target = 0
    if (event.key === 'End') target = stages.length - 1
    if (target === null) return
    event.preventDefault()
    inspectStage(stages[target]!.id, true)
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Round {round}</p>
          <span className="text-xs text-muted-foreground">· Select a stage to see its work</span>
        </div>
        <div role="tablist" aria-label={`Round ${round} stages`} className="flex flex-wrap items-center gap-1">
          {stages.map((stage, index) => (
            <div key={stage.id} className="flex items-center gap-1">
              {index > 0 && <span aria-hidden className="text-muted-foreground/30">—</span>}
              <button
                type="button"
                role="tab"
                id={`stage-tab-${stage.id}`}
                aria-controls="stage-workspace-panel"
                aria-selected={viewedStage === stage.id}
                aria-current={stage.current ? 'step' : undefined}
                tabIndex={viewedStage === stage.id ? 0 : -1}
                ref={node => { stageTabs.current[index] = node }}
                onClick={() => inspectStage(stage.id)}
                onKeyDown={event => handleStageKey(event, index)}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  viewedStage === stage.id
                    ? 'border-primary bg-primary/10 font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50'
                }`}
              >
                {stage.complete && <Check aria-hidden className="size-3" />}
                {stage.running && <Loader2 aria-hidden className="size-3 animate-spin" />}
                {STAGE_LABELS[stage.id]}
                {stage.complete && <span className="sr-only"> — completed this round</span>}
                {stage.running && <span className="sr-only"> — work running</span>}
                {stage.current && (
                  <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide">
                    Current
                  </span>
                )}
                {recommendationStage === stage.id && <span className="sr-only"> — recommended</span>}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="border-b bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested next</p>
            <p className="mt-0.5 text-sm font-medium">{NEXT_FOCUS_LABELS[recommendation.kind]}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{recommendation.reason}</p>
          </div>
          {viewedStage !== recommendationStage && (
            <Button size="sm" variant="outline" onClick={() => inspectStage(recommendationStage, true)}>
              View {STAGE_LABELS[recommendationStage]}
            </Button>
          )}
          {activeAdvice && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void ignoreSuggestion()}>
              Ignore suggestion
            </Button>
          )}
        </div>
      </div>

      <div
        id="stage-workspace-panel"
        role="tabpanel"
        aria-labelledby={`stage-tab-${viewedStage}`}
        className="space-y-4 p-4"
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-medium">{STAGE_LABELS[viewedStage]}</h2>
              <Badge variant={viewed.current ? 'default' : 'outline'}>{viewedStatus}</Badge>
              {viewed.running && viewed.complete && <Badge variant="secondary">Work running</Badge>}
              {viewedStage !== current && <Badge variant="secondary">Current: {STAGE_LABELS[current]}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{STAGE_HELP[viewedStage].purpose}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium">Done when:</span> {STAGE_HELP[viewedStage].done}
            </p>
          </div>
        </div>

        {blocked && (
          <div className="flex flex-wrap items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <Ban className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Blocked</p>
              <p className="text-sm text-muted-foreground">{detail.blocked_reason ?? 'This Thread is blocked.'}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canAct || busy}
              onClick={() => void updateWork({ attention_state: 'focused', blocked_reason: null })}
            >
              Unblock
            </Button>
          </div>
        )}

        {canAct
          ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Actions in this stage</p>
              {stageActions.map((action, index) => {
                const running = (detail.attention_state === 'focused' && detail.next_focus_kind === action.kind)
                  || (action.kind === 'search_acquisition' && startedWorkflow !== null)
                  || roundSteps.some(step => step.kind === action.kind && step.status === 'in_progress')
                const destination = nextFocusDestination(action.kind, { projectId, threadId: detail.id, startedWorkflow })
                const primary = index === 0
                return (
                  <div key={action.kind} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {NEXT_FOCUS_LABELS[action.kind]}
                        {running && <span className="ml-2 text-xs font-normal text-muted-foreground">In progress</span>}
                      </p>
                      {(recommendationStage !== viewedStage || index > 0) && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{action.reason}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={primary ? 'default' : 'outline'}
                      disabled={busy || blocked}
                      onClick={() => void go(action.kind)}
                    >
                      {running || blocked
                        ? destination.cta
                        : detail.attention_state === 'focused'
                          ? destination.cta
                          : `Bring into Focus and start ${NEXT_FOCUS_LABELS[action.kind]}`}
                      <ArrowRight className="size-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )
          : (
            <p className="text-sm text-muted-foreground">
              This Thread is {detail.lifecycle_status} — reopen it to start stage work.
            </p>
          )}

        {openBackground.length > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {openBackground.map(step => NEXT_FOCUS_LABELS[step.kind]).join(' · ')} running in the background
          </p>
        )}

        {canAct && !blocked && viewedStage === 'land' && current === 'land' && (
          <div className="border-t pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Close out round {round}
            </p>
            <CloseOutForm projectId={projectId} detail={detail} onRecorded={refreshFollowingCurrent} />
          </div>
        )}
      </div>
    </Card>
  )
}
