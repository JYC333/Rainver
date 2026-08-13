import type { InquiryNextFocusKind, ProjectResearchWorkflow } from '../../../types/api'

export type ThreadTabId = 'evidence' | 'relations' | 'notes' | 'history'

/**
 * Where a step actually sends the user. `tab` targets stay on this page (the
 * Evidence tab is Inquiry-owned) and `link` leaves for the owning Area. Every
 * kind now has somewhere to go: the two that did not — pause and waiting on
 * monitoring — were states rather than errands and are no longer actions.
 */
export type NextFocusDestination =
  | { kind: 'link'; to: string; cta: string }
  | { kind: 'tab'; tab: ThreadTabId; cta: string }

export const NEXT_FOCUS_LABELS: Record<InquiryNextFocusKind, string> = {
  clarify_or_decompose: 'Clarify or decompose',
  search_acquisition: 'Search / acquisition',
  design_run_experiment: 'Design/run an experiment',
  read_evidence: 'Read evidence',
  synthesize: 'Synthesize',
  promote_knowledge: 'Promote Knowledge',
  create_decision_case: 'Create a Decision Case',
  create_delivery_task: 'Create/execute a Delivery Task',
}

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
    && workflow.status === 'active') ?? null
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
    case 'promote_knowledge':
      return { kind: 'link', to: `/projects/${projectId}/knowledge-review`, cta: 'Go to Knowledge Review' }
  }
}
