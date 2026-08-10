import type {
  InquiryEvidenceSignal, InquiryNextFocusKind, InquiryThreadDetail, ProjectResearchWorkflow,
} from '../../../types/api'

export type ThreadTabId = 'evidence' | 'relations' | 'notes' | 'history'

/**
 * Where a confirmed Next Focus actually sends the user. `tab` targets stay on
 * this page (the Evidence tab is Inquiry-owned), `link` leaves for the owning
 * Area, and `none` is for a Focus that is a state rather than an errand.
 */
export type NextFocusDestination =
  | { kind: 'link'; to: string; cta: string }
  | { kind: 'tab'; tab: ThreadTabId; cta: string }
  | { kind: 'none' }

export const NEXT_FOCUS_LABELS: Record<InquiryNextFocusKind, string> = {
  search_acquisition: 'Search / acquisition',
  read_evidence: 'Read evidence',
  synthesize: 'Synthesize',
  clarify_or_decompose: 'Clarify or decompose',
  design_run_experiment: 'Design/run an experiment',
  create_decision_case: 'Create a Decision Case',
  create_delivery_task: 'Create/execute a Delivery Task',
  wait_for_monitoring: 'Wait for monitoring',
  promote_knowledge: 'Promote Knowledge',
  pause: 'Pause',
}

export const NEXT_FOCUS_KINDS = Object.keys(NEXT_FOCUS_LABELS) as InquiryNextFocusKind[]

/**
 * A Workflow that has left `not_started` is a real running search; anything
 * before that is still setup, so the Thread should keep offering "start" and
 * not send the user to Operations to watch nothing.
 */
export function startedWorkflowFor(
  threadId: string,
  workflows: ProjectResearchWorkflow[],
): ProjectResearchWorkflow | null {
  return workflows.find(workflow =>
    workflow.primary_thread_id === threadId
    && workflow.status !== 'not_started'
    && workflow.status !== 'completed'
    && workflow.status !== 'archived') ?? null
}

export function draftWorkflowFor(
  threadId: string,
  workflows: ProjectResearchWorkflow[],
): ProjectResearchWorkflow | null {
  return workflows.find(workflow =>
    workflow.primary_thread_id === threadId && workflow.status !== 'archived') ?? null
}

/** The wording has been through the assessment workspace and confirmed there. */
export function isQuestionRefined(draftWorkflow: ProjectResearchWorkflow | null): boolean {
  return draftWorkflow ? draftWorkflow.state_json.question_refine_skipped === false : false
}

export function nextFocusDestination(
  kind: InquiryNextFocusKind,
  context: { projectId: string; threadId: string; startedWorkflow: ProjectResearchWorkflow | null },
): NextFocusDestination {
  const { projectId, threadId, startedWorkflow } = context
  switch (kind) {
    case 'search_acquisition':
      return startedWorkflow
        ? { kind: 'link', to: `/projects/${projectId}/operations`, cta: 'Watch the running search' }
        : { kind: 'link', to: `/projects/${projectId}/research?research=new&thread=${threadId}`, cta: 'Start evidence search' }
    case 'read_evidence':
      return { kind: 'tab', tab: 'evidence', cta: 'Review this Thread’s evidence' }
    case 'synthesize':
      return { kind: 'link', to: `/projects/${projectId}/notes`, cta: 'Open Project Notes' }
    case 'clarify_or_decompose':
      return { kind: 'link', to: `/projects/${projectId}/inquiry/${threadId}/assess`, cta: 'Open the assessment workspace' }
    case 'design_run_experiment':
      return { kind: 'link', to: `/projects/${projectId}/experiments`, cta: 'Go to Experiments' }
    case 'create_decision_case':
      return { kind: 'link', to: `/projects/${projectId}/decisions`, cta: 'Go to Decisions' }
    case 'create_delivery_task':
      return { kind: 'link', to: `/projects/${projectId}/delivery`, cta: 'Go to Delivery' }
    case 'wait_for_monitoring':
      return { kind: 'link', to: `/projects/${projectId}/operations`, cta: 'Check monitoring in Operations' }
    case 'promote_knowledge':
      return { kind: 'link', to: `/projects/${projectId}/knowledge-review`, cta: 'Go to Knowledge Review' }
    case 'pause':
      return { kind: 'none' }
  }
}

export interface NextFocusSuggestion {
  kind: InquiryNextFocusKind
  reason: string
}

/**
 * Deterministic starting points offered when a Thread has no confirmed Next
 * Focus yet. These are reasons drawn from state the user can verify on the
 * page — not a ranking, and not a substitute for the user's own decision.
 */
export function suggestNextFocus(input: {
  detail: InquiryThreadDetail
  signals: InquiryEvidenceSignal[]
  pendingCandidateCount: number
  startedWorkflow: ProjectResearchWorkflow | null
  questionRefined: boolean
}): NextFocusSuggestion[] {
  const { detail, signals, pendingCandidateCount, startedWorkflow, questionRefined } = input
  const suggestions: NextFocusSuggestion[] = []

  if (!questionRefined) {
    suggestions.push({
      kind: 'clarify_or_decompose',
      reason: detail.kind === 'hypothesis'
        ? 'This Hypothesis has not been through the assessment workspace yet.'
        : 'This question’s wording has not been assessed yet.',
    })
  }
  if (startedWorkflow) {
    suggestions.push({ kind: 'wait_for_monitoring', reason: 'An evidence search is already running for this Thread.' })
  } else if (signals.length === 0) {
    suggestions.push({ kind: 'search_acquisition', reason: 'No evidence has reached this Thread yet.' })
  }
  if (pendingCandidateCount > 0) {
    suggestions.push({
      kind: 'read_evidence',
      reason: `${pendingCandidateCount} material change${pendingCandidateCount === 1 ? '' : 's'} on this Thread await review.`,
    })
  }
  if (detail.kind === 'hypothesis' && detail.hypothesis_state?.evaluation_state === 'untested') {
    suggestions.push({ kind: 'design_run_experiment', reason: 'This Hypothesis has no experimental evidence yet.' })
  }
  if (detail.kind === 'question' && detail.question_state?.answer_state === 'partial' && signals.length > 0) {
    suggestions.push({ kind: 'synthesize', reason: 'A partial answer with evidence in hand is ready to be pulled together.' })
  }
  if (detail.question_state?.answer_state === 'answered' || detail.hypothesis_state?.evaluation_state === 'supported') {
    suggestions.push({ kind: 'promote_knowledge', reason: 'This Thread has reached a settled position.' })
  }

  const seen = new Set<InquiryNextFocusKind>()
  return suggestions.filter(item => !seen.has(item.kind) && seen.add(item.kind)).slice(0, 3)
}
