import {
  INQUIRY_STAGE_FOR_KIND, INQUIRY_STAGE_HELP, INQUIRY_STAGE_LABELS, INQUIRY_STAGE_ORDER, inquiryKindsInStage,
  type InquiryStageId,
} from '@agent-space/protocol'
import type {
  InquiryEvidenceSignal, InquiryNextFocusKind, InquiryThreadDetail, InquiryThreadStep, ProjectResearchWorkflow,
} from '../../../types/api'

/**
 * Research is a spiral, not a line. A round runs Clarify → Acquire → Digest →
 * Conclude → Land and then begins again on what the conclusion raised, so
 * reaching Land closes a round rather than finishing the Thread and there is
 * no such thing as regression here.
 *
 * Stages are derived, never stored. A stage field would be one more thing a
 * user has to maintain, which is the class of problem this surface exists to
 * remove.
 *
 * The kind→stage vocabulary itself (`StageId`, `STAGE_ORDER`, `STAGE_LABELS`,
 * `STAGE_HELP`, `STAGE_FOR_KIND`, `kindsInStage`) lives in
 * `@agent-space/protocol` (plan Phase B) so a future non-frontend consumer —
 * today, none — shares this file's exact classification instead of a second
 * copy. Everything below this point is this page's own derived-state
 * presentation logic and stays here; only the static vocabulary moved.
 */
export type StageId = InquiryStageId
export const STAGE_ORDER = INQUIRY_STAGE_ORDER
export const STAGE_LABELS = INQUIRY_STAGE_LABELS
export const STAGE_HELP = INQUIRY_STAGE_HELP
export const STAGE_FOR_KIND = INQUIRY_STAGE_FOR_KIND
export const kindsInStage = inquiryKindsInStage

export interface StageInput {
  detail: InquiryThreadDetail
  signals: InquiryEvidenceSignal[]
  pendingCandidateCount: number
  startedWorkflow: ProjectResearchWorkflow | null
  questionRefined: boolean
  /** Steps of the round now in progress — everything since the last close-out. */
  roundSteps: InquiryThreadStep[]
  /** Rounds already closed out; the current round is this plus one. */
  closedRounds: number
  /**
   * When the current round began — the last close-out. Null on the first round.
   * Stage completion has to be measured from here: all-time state would leave
   * every stage permanently satisfied after one round, and the spiral would
   * never restart.
   */
  roundStartedAt: string | null
}

/**
 * The stage's work produced something this round. Only meaningful for work with
 * an operation behind it: a step reaches `done` when that operation finishes,
 * or at close-out — and close-out stamps it into the round it ends, so `done`
 * is not observable mid-round for anything a person does by hand.
 */
function completedThisRound(steps: InquiryThreadStep[], stage: StageId): boolean {
  return steps.some(step => step.status === 'done' && STAGE_FOR_KIND[step.kind as InquiryNextFocusKind] === stage)
}

/**
 * The user went and did this stage's work in this round, and has not backed out
 * of it.
 *
 * Starting the step is the signal, because choosing a step and starting it are
 * one action here, and human work has no completion event of its own to wait
 * for: a step only reaches `done` at close-out, in the same statement that
 * stamps it into the round being closed, so it has already left this round's
 * steps by the time it would count.
 *
 * Abandoning is the third action, and it has to be excluded. An abandoned step
 * keeps `iteration_id` null and so stays in the round, which meant glancing at
 * a stage and immediately switching away marked it finished for the rest of the
 * round, with nothing the user could do to take it back.
 */
function engagedThisRound(steps: InquiryThreadStep[], stage: StageId): boolean {
  return steps.some(step =>
    step.status !== 'abandoned' && STAGE_FOR_KIND[step.kind as InquiryNextFocusKind] === stage)
}

/**
 * A system operation for this stage is running right now.
 *
 * Only background steps qualify. A primary step is the user's attention, not
 * work in flight: nothing ends one until the round does, so a spinner on it
 * could never stop — a Thread that had once opened Clarify sat ticked and
 * spinning at the same time for the rest of the round. Where the user is
 * standing is what the Current badge says.
 */
function isRunning(steps: InquiryThreadStep[], stage: StageId): boolean {
  return steps.some(step =>
    step.slot === 'background' && step.status === 'in_progress'
    && STAGE_FOR_KIND[step.kind as InquiryNextFocusKind] === stage)
}

/**
 * This round produced what the stage exists for. Only this earns a tick.
 *
 * Where a stage has an observable product, that product is the test and the
 * user's attention is not: Clarify counted a started step, so the tick landed
 * the moment its action was launched, before the wording had been near the
 * assessment workspace. Writing up and landing have no observable of their own
 * — the user going and doing them is the only evidence there is — so those two
 * still read the step.
 *
 * Everything here is measured against the current round. Reading all-time state
 * instead would make the row useless the moment a round closed: a Thread whose
 * position has ever moved would show Conclude complete forever, so round two
 * would open pinned at Land and recommend promoting Knowledge before any new
 * evidence had been gathered. The spiral has to actually come round.
 */
function hasStageProduct(stage: StageId, input: StageInput): boolean {
  const { signals, pendingCandidateCount, questionRefined, roundSteps, roundStartedAt } = input
  switch (stage) {
    case 'clarify':
      // Wording is the exception to the round window: once a question has been
      // assessed it stays assessed, and re-clarifying every round would be
      // busywork.
      return questionRefined
    case 'acquire': {
      // A running search does not complete Acquire — it *is* Acquire, still
      // happening. Treating it as done pushed the Thread into Digest with
      // nothing to digest, and recommended reading evidence that had not
      // arrived.
      // Acquire exists to yield evidence, and a search still running has not
      // yielded any.
      const arrivedThisRound = signals.some(
        signal => !roundStartedAt || signal.created_at > roundStartedAt,
      )
      return arrivedThisRound || completedThisRound(roundSteps, 'acquire')
    }
    case 'digest':
      return pendingCandidateCount === 0
    case 'conclude':
      // Writing up is work, not a state. Reading the position here would never
      // complete mid-round and never un-complete afterwards; waiting for the
      // step to finish would never complete at all, because that only happens
      // as the round closes.
      return engagedThisRound(roundSteps, 'conclude')
    case 'land':
      return engagedThisRound(roundSteps, 'land')
  }
}

export interface StageView {
  id: StageId
  /** This round produced the stage's own outcome. */
  complete: boolean
  /** Worked this round, with nothing yet to show for it — not the same claim. */
  started: boolean
  current: boolean
  /** A system operation for this stage is running now. */
  running: boolean
}

/**
 * The round has stopped being held at this stage.
 *
 * Settling is not completing. Clarify settles on the user having done the
 * work even when the wording never passed assessment, because skipping
 * refinement is a legitimate choice and a stage that could never settle would
 * pin the round to it forever — but a skipped assessment is not a produced
 * one, so it moves the row on without ticking it.
 */
function isStageSettled(stage: StageId, input: StageInput): boolean {
  return hasStageProduct(stage, input)
    || (stage === 'clarify' && engagedThisRound(input.roundSteps, 'clarify'))
}

/**
 * The current stage is the earliest incomplete one in this round: what is
 * unfinished in front of you is what you are still on. New material arriving
 * after a conclusion therefore puts the Thread back in Digest, which is the
 * loop working rather than a step backwards.
 */
export function deriveStages(input: StageInput): { stages: StageView[]; current: StageId; round: number } {
  const settled = STAGE_ORDER.map(stage => isStageSettled(stage, input))
  const firstUnsettled = settled.findIndex(done => !done)
  // A later stage cannot be finished while an earlier one is not. Jumping
  // straight to a Land action on an untouched Thread satisfies Land's own
  // condition, and showing that as a tick after two blank stages tells the
  // user the round is finished when it has not started.
  const reached = (index: number) => firstUnsettled === -1 || index < firstUnsettled
  // Every stage settled means the round is ready to be recorded, which is
  // Land's own work — so Land stays current rather than the row going nowhere.
  const current = firstUnsettled === -1 ? 'land' : STAGE_ORDER[firstUnsettled]!

  return {
    stages: STAGE_ORDER.map((id, index) => {
      const running = isRunning(input.roundSteps, id) || (id === 'acquire' && input.startedWorkflow !== null)
      const complete = reached(index) && hasStageProduct(id, input)
      return {
        id,
        complete,
        // Work the user did that has not shown a result yet. Said quietly and
        // separately, because the alternative to saying it is a stage the
        // user has worked looking untouched.
        started: !complete && !running && engagedThisRound(input.roundSteps, id),
        current: id === current,
        running,
      }
    }),
    current,
    round: input.closedRounds + 1,
  }
}

export interface StepRecommendation {
  kind: InquiryNextFocusKind
  /** Drawn from state the user can check on this page, never a bare assertion. */
  reason: string
}

/**
 * The deterministic fallback for what to do now. A valid open model suggestion
 * may replace it in the UI, but this remains instant, free, and always present.
 */
export function recommendStep(input: StageInput): StepRecommendation {
  const { current } = deriveStages(input)
  return recommendStepForStage(input, current)
}

/** Default action and state-grounded reason for any stage the user chooses to inspect. */
export function recommendStepForStage(input: StageInput, stage: StageId): StepRecommendation {
  const { detail, signals, pendingCandidateCount, startedWorkflow, roundSteps } = input

  switch (stage) {
    case 'clarify':
      return {
        kind: 'clarify_or_decompose',
        reason: detail.kind === 'hypothesis'
          ? 'This Hypothesis has not been through the assessment workspace yet.'
          : 'This question’s wording has not been assessed yet.',
      }
    case 'acquire':
      // Already searching: the honest recommendation is the search itself,
      // whose call to action resolves to watching it rather than starting a
      // second one.
      if (isRunning(roundSteps, 'acquire') || startedWorkflow) {
        return {
          kind: isRunning(roundSteps, 'acquire')
            ? roundSteps.find(step => step.status === 'in_progress' && STAGE_FOR_KIND[step.kind] === 'acquire')!.kind
            : 'search_acquisition',
          reason: 'Evidence gathering is under way; nothing has reached this Thread yet.',
        }
      }
      return detail.kind === 'hypothesis'
        ? { kind: 'design_run_experiment', reason: 'A Hypothesis needs evidence you produce; none has been run yet.' }
        : { kind: 'search_acquisition', reason: 'No evidence has reached this Thread yet.' }
    case 'digest':
      return {
        kind: 'read_evidence',
        reason: pendingCandidateCount === 1
          ? '1 material change on this Thread awaits review.'
          : `${pendingCandidateCount} material changes on this Thread await review.`,
      }
    case 'conclude':
      return {
        kind: 'synthesize',
        reason: signals.length > 0
          ? `${signals.length} piece${signals.length === 1 ? ' of evidence is' : 's of evidence are'} in hand and no position has been written.`
          : 'No position has been recorded for this round yet.',
      }
    case 'land':
      return {
        kind: 'promote_knowledge',
        // Read from the step rows, the same source as the running-work strip
        // beside it, so the two cannot contradict each other on one screen.
        reason: isRunning(roundSteps, 'acquire')
          ? 'The position is settled; evidence gathering is still running in the background.'
          : 'This Thread has reached a settled position worth reusing.',
      }
  }
}

/**
 * The other things worth doing at this point, each with why it might be wanted
 * now. In-stage alternatives come first because they are the near choices; the
 * rest of the vocabulary stays behind an explicit "somewhere else" so a new
 * user faces two or three explained options rather than eight bare ones.
 */
export function inStageAlternatives(input: StageInput, stage: StageId = deriveStages(input).current): StepRecommendation[] {
  const { detail, signals, pendingCandidateCount, roundSteps } = input
  const recommended = recommendStepForStage(input, stage).kind

  const reasons: Partial<Record<InquiryNextFocusKind, string>> = {
    search_acquisition: signals.length > 0
      ? 'Widen the evidence base — what you have may all come from one direction.'
      : 'Look for existing evidence before producing your own.',
    design_run_experiment: detail.kind === 'hypothesis'
      ? 'Produce evidence directly instead of waiting for the literature.'
      : 'Some questions are settled faster by measuring than by reading.',
    read_evidence: pendingCandidateCount === 0
      ? 'Go back over the evidence already on this Thread.'
      : pendingCandidateCount === 1
        ? '1 change is waiting to be reviewed.'
        : `${pendingCandidateCount} changes are waiting to be reviewed.`,
    promote_knowledge: 'Make this conclusion reusable outside the Thread.',
    create_decision_case: 'Use this conclusion to make a choice that needs weighing up.',
    create_delivery_task: 'Turn this conclusion into work someone will carry out.',
    clarify_or_decompose: 'Re-cut the question if the evidence keeps missing it.',
    synthesize: 'Write down where the evidence leaves you.',
  }

  return kindsInStage(stage)
    .filter(kind => kind !== recommended)
    .filter(kind => !roundSteps.some(step => step.kind === kind && step.status === 'in_progress'))
    .map(kind => ({ kind, reason: reasons[kind] ?? '' }))
}
