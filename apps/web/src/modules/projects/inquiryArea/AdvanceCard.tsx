import { useEffect, useState } from 'react'
import { ArrowRight, Ban, Check, ChevronDown, ChevronUp, Lightbulb } from 'lucide-react'
import { toast } from 'sonner'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type {
  InquiryEvidenceSignal, InquiryNextFocusKind, InquiryThreadAdvice, InquiryThreadDetail, ProjectResearchWorkflow,
} from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { ReasonDialog } from './dialogs'
import { AdviceBlock } from './AdviceBlock'
import {
  NEXT_FOCUS_KINDS, NEXT_FOCUS_LABELS, nextFocusDestination, suggestNextFocus, type ThreadTabId,
} from './nextFocus'

const NEXT_FOCUS_OPTIONS = NEXT_FOCUS_KINDS.map(kind => ({ value: kind, label: NEXT_FOCUS_LABELS[kind] }))

/**
 * The Thread's single "what now" surface. Its two layers are the domain's two
 * distinct commands, not one action split across two cards: the upper layer
 * adjusts the plan through `updateWork` (no change summary — re-planning is
 * not a cognitive change), the lower layer records an Iteration.
 */
export function AdvanceCard({
  projectId, detail, signals, pendingCandidateCount, startedWorkflow, questionRefined, advice, onOpenTab, onChanged,
}: {
  projectId: string
  detail: InquiryThreadDetail
  signals: InquiryEvidenceSignal[]
  pendingCandidateCount: number
  startedWorkflow: ProjectResearchWorkflow | null
  questionRefined: boolean
  advice: InquiryThreadAdvice | null
  onOpenTab: (tab: ThreadTabId) => void
  onChanged: () => Promise<void>
}) {
  const [changingFocus, setChangingFocus] = useState(false)
  const [blockDialogOpen, setBlockDialogOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)

  const canAct = detail.lifecycle_status === 'active'
  const destination = detail.next_focus_kind
    ? nextFocusDestination(detail.next_focus_kind, { projectId, threadId: detail.id, startedWorkflow })
    : null

  async function setNextFocus(kind: InquiryNextFocusKind) {
    try {
      const result = await inquiryApi.updateWork(projectId, detail.id, {
        next_focus_kind: kind,
        blocked_reason: null,
      })
      if (result.wip_limit_exceeded) toast.warning('Shared Focus WIP limit exceeded — consider moving another Thread to Monitoring')
      setChangingFocus(false)
      await onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function block(reason: string) {
    await inquiryApi.updateWork(projectId, detail.id, { blocked_reason: reason, next_focus_kind: null })
    await onChanged()
  }

  if (detail.blocked_reason) {
    return (
      <Card className="border-destructive/40 p-4">
        <div className="flex items-start gap-3">
          <Ban className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Blocked</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{detail.blocked_reason}</p>
          </div>
          <Button size="sm" variant="outline" disabled={!canAct} onClick={() => setChangingFocus(true)}>
            Unblock and pick a next step
          </Button>
        </div>
        {changingFocus && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              ariaLabel="Next focus"
              value=""
              onChange={value => setNextFocus(value as InquiryNextFocusKind)}
              options={[{ value: '', label: 'Choose the next step…' }, ...NEXT_FOCUS_OPTIONS]}
            />
            <Button size="sm" variant="ghost" onClick={() => setChangingFocus(false)}>Cancel</Button>
          </div>
        )}
      </Card>
    )
  }

  return (
    <>
      <Card className="p-4">
        {detail.next_focus_kind
          ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next step</p>
              <p className="text-base font-medium">{NEXT_FOCUS_LABELS[detail.next_focus_kind]}</p>
              {detail.next_focus_note && <p className="text-sm text-muted-foreground">“{detail.next_focus_note}”</p>}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {destination?.kind === 'link' && (
                  <Button size="sm" asChild><Link to={destination.to}>{destination.cta}<ArrowRight className="size-4" /></Link></Button>
                )}
                {destination?.kind === 'tab' && (
                  <Button size="sm" onClick={() => onOpenTab(destination.tab)}>{destination.cta}<ArrowRight className="size-4" /></Button>
                )}
                {canAct && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setChangingFocus(current => !current)}>Change next step</Button>
                    <Button size="sm" variant="ghost" onClick={() => setBlockDialogOpen(true)}>Mark blocked</Button>
                  </>
                )}
              </div>
            </div>
          )
          : (
            <NextFocusPicker
              detail={detail}
              signals={signals}
              pendingCandidateCount={pendingCandidateCount}
              startedWorkflow={startedWorkflow}
              questionRefined={questionRefined}
              canAct={canAct}
              onPick={setNextFocus}
              onBlock={() => setBlockDialogOpen(true)}
            />
          )}

        {changingFocus && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            <Select
              ariaLabel="Next focus"
              value={detail.next_focus_kind ?? ''}
              onChange={value => setNextFocus(value as InquiryNextFocusKind)}
              options={NEXT_FOCUS_OPTIONS}
            />
            <Button size="sm" variant="ghost" onClick={() => setChangingFocus(false)}>Cancel</Button>
          </div>
        )}

        <AdviceBlock
          projectId={projectId}
          threadId={detail.id}
          advice={advice}
          canAct={canAct}
          startedWorkflow={startedWorkflow}
          onOpenTab={onOpenTab}
          onChanged={onChanged}
        />

        {canAct && (
          <div className="mt-3 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setRecordOpen(current => !current)}>
              <Check className="size-4" />Done — record what changed
              {recordOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
            {recordOpen && (
              <RecordIterationForm
                projectId={projectId}
                detail={detail}
                onRecorded={async () => { setRecordOpen(false); await onChanged() }}
              />
            )}
          </div>
        )}
      </Card>

      <ReasonDialog
        open={blockDialogOpen}
        onOpenChange={setBlockDialogOpen}
        title="Mark this Thread blocked"
        description="A blocked Thread has no next step until the blocker clears. This replaces the current Next Focus."
        label="What is blocking it?"
        placeholder="Waiting on the Q1.2 experiment to finish"
        required
        confirmLabel="Mark blocked"
        onConfirm={block}
      />
    </>
  )
}

function NextFocusPicker({ detail, signals, pendingCandidateCount, startedWorkflow, questionRefined, canAct, onPick, onBlock }: {
  detail: InquiryThreadDetail
  signals: InquiryEvidenceSignal[]
  pendingCandidateCount: number
  startedWorkflow: ProjectResearchWorkflow | null
  questionRefined: boolean
  canAct: boolean
  onPick: (kind: InquiryNextFocusKind) => void
  onBlock: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const suggestions = suggestNextFocus({ detail, signals, pendingCandidateCount, startedWorkflow, questionRefined })

  if (!canAct) return <p className="text-sm text-muted-foreground">This Thread is {detail.lifecycle_status} — reopen it to plan a next step.</p>

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next step</p>
        <p className="mt-1 text-sm text-muted-foreground">Not decided yet.</p>
      </div>
      {suggestions.length > 0 && !showAll && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lightbulb className="size-3" />Based on this Thread’s current state:</p>
          {suggestions.map(suggestion => (
            <button
              key={suggestion.kind}
              type="button"
              onClick={() => onPick(suggestion.kind)}
              className="block w-full rounded-md border p-2 text-left transition-colors hover:bg-muted/50"
            >
              <span className="text-sm font-medium">{NEXT_FOCUS_LABELS[suggestion.kind]}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{suggestion.reason}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {showAll
          ? (
            <Select
              ariaLabel="Next focus"
              value=""
              onChange={value => onPick(value as InquiryNextFocusKind)}
              options={[{ value: '', label: 'Choose the next step…' }, ...NEXT_FOCUS_OPTIONS]}
            />
          )
          : <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>Choose something else</Button>}
        <Button size="sm" variant="ghost" onClick={onBlock}>Mark blocked</Button>
      </div>
    </div>
  )
}

function RecordIterationForm({ projectId, detail, onRecorded }: {
  projectId: string
  detail: InquiryThreadDetail
  onRecorded: () => Promise<void>
}) {
  const [answerState, setAnswerState] = useState(detail.question_state?.answer_state ?? 'open')
  const [answerSummary, setAnswerSummary] = useState(detail.question_state?.current_answer_summary ?? '')
  const [evaluationState, setEvaluationState] = useState(detail.hypothesis_state?.evaluation_state ?? 'untested')
  const [confidence, setConfidence] = useState(detail.hypothesis_state?.confidence ?? 0)
  const [nextFocusKind, setNextFocusKind] = useState<InquiryNextFocusKind | ''>(detail.next_focus_kind ?? '')
  const [changeSummary, setChangeSummary] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setAnswerState(detail.question_state?.answer_state ?? 'open')
    setAnswerSummary(detail.question_state?.current_answer_summary ?? '')
    setEvaluationState(detail.hypothesis_state?.evaluation_state ?? 'untested')
    setConfidence(detail.hypothesis_state?.confidence ?? 0)
    setNextFocusKind(detail.next_focus_kind ?? '')
  }, [detail])

  async function record() {
    if (!changeSummary.trim()) { toast.error('A change summary is required to record an Iteration'); return }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        change_summary: changeSummary.trim(),
        confirmed_next_focus: nextFocusKind || undefined,
      }
      if (detail.kind === 'question') {
        body.answer_state = answerState
        body.current_answer_summary = answerSummary
      } else {
        body.evaluation_state = evaluationState
        body.confidence = confidence
      }
      await inquiryApi.recordIteration(projectId, detail.id, body)
      setChangeSummary('')
      toast.success('Iteration recorded')
      await onRecorded()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 space-y-3">
      {detail.kind === 'question'
        ? (
          <>
            <div className="space-y-1.5">
              <Label>Answer state</Label>
              <Select ariaLabel="Answer state" value={answerState} onChange={value => setAnswerState(value as typeof answerState)} options={[
                { value: 'open', label: 'Open' }, { value: 'partial', label: 'Partial' },
                { value: 'answered', label: 'Answered' }, { value: 'unanswerable', label: 'Unanswerable' },
              ]} />
            </div>
            <div className="space-y-1.5">
              <Label>Current answer</Label>
              <Textarea value={answerSummary} onChange={event => setAnswerSummary(event.target.value)} placeholder="Current answer summary" rows={2} />
            </div>
          </>
        )
        : (
          <>
            <div className="space-y-1.5">
              <Label>Evaluation state</Label>
              <Select ariaLabel="Evaluation state" value={evaluationState} onChange={value => setEvaluationState(value as typeof evaluationState)} options={[
                { value: 'untested', label: 'Untested' }, { value: 'supported', label: 'Supported' },
                { value: 'challenged', label: 'Challenged' }, { value: 'contradicted', label: 'Contradicted' },
                { value: 'inconclusive', label: 'Inconclusive' },
              ]} />
            </div>
            <div className="space-y-1.5">
              <Label>Confidence (0-100)</Label>
              <Input type="number" min={0} max={100} value={confidence} onChange={event => setConfidence(Number(event.target.value))} />
            </div>
          </>
        )}
      <div className="space-y-1.5">
        <Label htmlFor="iteration-change-summary">What changed and why? <span className="text-destructive">*</span></Label>
        <Textarea
          id="iteration-change-summary"
          value={changeSummary}
          onChange={event => setChangeSummary(event.target.value)}
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Next step after this</Label>
        <Select
          ariaLabel="Confirmed next focus"
          value={nextFocusKind}
          onChange={value => setNextFocusKind(value as InquiryNextFocusKind)}
          options={[{ value: '', label: 'No change to Next Focus' }, ...NEXT_FOCUS_OPTIONS]}
        />
      </div>
      <Button size="sm" onClick={record} disabled={saving}>{saving ? 'Recording…' : 'Record Iteration'}</Button>
    </div>
  )
}
