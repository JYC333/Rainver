import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { inquiryApi } from '../../../api/client'
import { errMsg } from '../../../lib/utils'
import type { InquiryThreadDetail } from '../../../types/api'
import { Button } from '../../../components/ui/button'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'

const ANSWER_STATES = ['open', 'partial', 'answered', 'unanswerable'] as const
const EVALUATION_STATES = ['untested', 'supported', 'challenged', 'contradicted', 'inconclusive'] as const

const ANSWER_LABELS: Record<(typeof ANSWER_STATES)[number], string> = {
  open: 'Open', partial: 'Partial', answered: 'Answered', unanswerable: 'Unanswerable',
}
const EVALUATION_LABELS: Record<(typeof EVALUATION_STATES)[number], string> = {
  untested: 'Untested', supported: 'Supported', challenged: 'Challenged',
  contradicted: 'Contradicted', inconclusive: 'Inconclusive',
}

/**
 * Closing the round. This is the joint of the loop, not bookkeeping tacked on
 * the end: it is what ends the round's steps and starts the next one, so it is
 * offered rather than hidden behind a disclosure.
 *
 * Two controls. The cognitive state is a real judgement only the user can make,
 * so it stays — as one-click segments instead of a two-click menu. The Next
 * Focus dropdown that used to live here is gone: the next round's first step is
 * computed, and asking twice was the duplication that made this form feel like
 * a form.
 */
export function CloseOutForm({ projectId, detail, onRecorded }: {
  projectId: string
  detail: InquiryThreadDetail
  onRecorded: () => Promise<void>
}) {
  const isQuestion = detail.kind === 'question'
  const storedAnswer = detail.question_state?.answer_state ?? 'open'
  const storedSummary = detail.question_state?.current_answer_summary ?? ''
  const storedEvaluation = detail.hypothesis_state?.evaluation_state ?? 'untested'
  const storedConfidence = detail.hypothesis_state?.confidence

  const [answerState, setAnswerState] = useState(storedAnswer)
  const [answerSummary, setAnswerSummary] = useState(storedSummary)
  const [evaluationState, setEvaluationState] = useState(storedEvaluation)
  const [confidence, setConfidence] = useState<number | null>(storedConfidence ?? null)
  const [changeSummary, setChangeSummary] = useState('')
  const [saving, setSaving] = useState(false)

  // Reset only when the form is pointed at a different Thread. Keying on the
  // whole `detail` object threw away half-typed input every time a sibling
  // refresh produced a new object for the same Thread.
  useEffect(() => {
    setAnswerState(storedAnswer)
    setAnswerSummary(storedSummary)
    setEvaluationState(storedEvaluation)
    setConfidence(storedConfidence ?? null)
    setChangeSummary('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id])

  /**
   * An Iteration records a change of position, so the server rejects one that
   * moves nothing. Saying so here, before the click, beats a 422 — and the
   * state that makes the round *look* finished is exactly the state where the
   * default submission would have moved nothing.
   */
  const positionMoved = isQuestion
    ? answerState !== storedAnswer || answerSummary.trim() !== storedSummary.trim()
    : evaluationState !== storedEvaluation || confidence !== (storedConfidence ?? null)

  async function record() {
    if (!changeSummary.trim()) { toast.error('Say what changed — that is what makes this a round and not a save'); return }
    setSaving(true)
    try {
      await inquiryApi.recordIteration(projectId, detail.id, isQuestion
        ? {
          change_summary: changeSummary.trim(),
          answer_state: answerState,
          current_answer_summary: answerSummary.trim() || null,
        }
        : {
          change_summary: changeSummary.trim(),
          evaluation_state: evaluationState,
          // Never invent a number over a stored null: an untouched slider
          // would otherwise record 50% confidence the user never expressed.
          ...(confidence === null ? {} : { confidence }),
        })
      setChangeSummary('')
      toast.success('Round recorded')
      await onRecorded()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{isQuestion ? 'Where the answer stands now' : 'Where the hypothesis stands now'}</Label>
        <div className="flex flex-wrap gap-1.5">
          {isQuestion
            ? ANSWER_STATES.map(state => (
              <Button
                key={state}
                size="sm"
                variant={answerState === state ? 'default' : 'outline'}
                onClick={() => setAnswerState(state)}
              >
                {ANSWER_LABELS[state]}
              </Button>
            ))
            : EVALUATION_STATES.map(state => (
              <Button
                key={state}
                size="sm"
                variant={evaluationState === state ? 'default' : 'outline'}
                onClick={() => setEvaluationState(state)}
              >
                {EVALUATION_LABELS[state]}
              </Button>
            ))}
        </div>
      </div>

      {isQuestion && (
        <div className="space-y-1.5">
          <Label htmlFor="closeout-answer">Where the answer stands</Label>
          <Textarea
            id="closeout-answer"
            value={answerSummary}
            onChange={event => setAnswerSummary(event.target.value)}
            placeholder="Caching helps p95 on read-heavy workloads; write-heavy is still open"
            rows={2}
          />
        </div>
      )}

      {!isQuestion && (
        <div className="space-y-1.5">
          <Label htmlFor="closeout-confidence">
            Confidence — {confidence === null ? 'not set' : `${confidence}%`}
          </Label>
          <input
            id="closeout-confidence"
            type="range"
            min={0}
            max={100}
            step={5}
            value={confidence ?? 50}
            onChange={event => setConfidence(Number(event.target.value))}
            className="w-full accent-primary"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="closeout-summary">What changed this round? <span className="text-destructive">*</span></Label>
        <Textarea
          id="closeout-summary"
          value={changeSummary}
          onChange={event => setChangeSummary(event.target.value)}
          placeholder="Read the six 2023 papers; none measured p95 directly"
          rows={2}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={record} disabled={saving || !positionMoved}>
          {saving ? 'Recording…' : 'Record this round'}
        </Button>
        {!positionMoved && (
          <span className="text-xs text-muted-foreground">
            A round records how the position moved — update the state above to close it out.
          </span>
        )}
      </div>
    </div>
  )
}
