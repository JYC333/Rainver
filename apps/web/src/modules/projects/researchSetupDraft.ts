import type {
  ProjectResearchInitialIntakeInput,
  ProjectResearchQuestionRefinementResult,
  ProjectResearchWorkflow,
} from '../../types/api'

export interface ResearchSetupDraft {
  thread_id?: string
  research_question: string
  research_context_version_id?: string
  query_strategy_id?: string
  history_mode: 'bounded_range' | 'all_available'
  from: string
  to: string
  max_items: string
  monitoring_field: 'submittedDate' | 'lastUpdatedDate'
  report_depth: 'quick' | 'full'
  question_refine_skipped: boolean
  /** Latest refinement assessment; persisted with the server-side draft so it survives devices and sessions. */
  question_refinement?: ProjectResearchQuestionRefinementResult | null
  execution: {
    model_provider_id: string
    model_name: string
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function researchSetupDraftFromWorkflow(
  workflow: ProjectResearchWorkflow | null,
  researchQuestion: string,
  _defaultChannelIds: string[] = [],
  corpusItemCount = 0,
): ResearchSetupDraft {
  const state = objectValue(workflow?.state_json)
  const initialIntake = objectValue(state.initial_intake)
  const execution = objectValue(state.execution)
  return {
    thread_id: (() => {
      const scope = Array.isArray(state.thread_scope) ? state.thread_scope[0] : null
      return stringValue(objectValue(scope).thread_id) ?? stringValue(state.thread_id) ?? ''
    })(),
    research_question: stringValue(state.research_question) ?? researchQuestion,
    research_context_version_id: stringValue(state.research_context_version_id) ?? '',
    query_strategy_id: stringValue(state.query_strategy_id) ?? '',
    history_mode: initialIntake.history_mode === 'all_available' ? 'all_available' : 'bounded_range',
    from: stringValue(initialIntake.from)?.slice(0, 10) ?? '',
    to: stringValue(initialIntake.to)?.slice(0, 10) ?? '',
    max_items: initialIntake.max_items === undefined || initialIntake.max_items === null
      ? '10000'
      : String(initialIntake.max_items),
    monitoring_field: initialIntake.monitoring_field === 'lastUpdatedDate' ? 'lastUpdatedDate' : 'submittedDate',
    report_depth: initialIntake.report_depth === 'quick' ? 'quick' : initialIntake.report_depth === 'full' ? 'full' : corpusItemCount < 15 ? 'quick' : 'full',
    question_refine_skipped: state.question_refine_skipped !== false,
    question_refinement: state.question_refinement && typeof state.question_refinement === 'object' && !Array.isArray(state.question_refinement)
      ? state.question_refinement as ProjectResearchQuestionRefinementResult
      : null,
    execution: {
      model_provider_id: stringValue(execution.model_provider_id) ?? '',
      model_name: stringValue(execution.model_name) ?? '',
    },
  }
}

/**
 * Browser-local UI recovery for unsaved setup fields only. Question-assessment
 * messages and model context are server-authoritative and never restored from
 * this object.
 */
export interface ResearchSetupSession {
  base_fingerprint: string
  draft: ResearchSetupDraft
  step?: number
  /**
   * The Workflow this in-progress session has already saved a draft to (once
   * the dialog opened with no Workflow of its own — otherwise this always
   * equals that Workflow's own id, never a fresh one). Restoring it is what
   * lets every subsequent autosave and the final Save/Start reuse that one
   * row instead of creating a new draft Workflow on every autosave.
   */
  workflow_id?: string | null
}

// Scoped by which Workflow (if any) the dialog opened for, not just the
// Project — the "edit this Workflow" dialog and the independent "start a new
// search" dialog can be open/used around the same time and must not stomp on
// each other's in-progress session.
function sessionKey(projectId: string, workflowScope: string): string {
  return `rainver:research-setup-session:${projectId}:${workflowScope}`
}

export function loadResearchSetupSession(projectId: string, workflowScope: string): ResearchSetupSession | null {
  try {
    const raw = window.localStorage.getItem(sessionKey(projectId, workflowScope))
    if (!raw) return null
    const value = objectValue(JSON.parse(raw))
    const draft = objectValue(value.draft)
    if (typeof value.base_fingerprint !== 'string' || typeof draft.research_question !== 'string') return null
    return value as unknown as ResearchSetupSession
  } catch {
    return null
  }
}

export function saveResearchSetupSession(projectId: string, workflowScope: string, session: ResearchSetupSession): void {
  try {
    window.localStorage.setItem(sessionKey(projectId, workflowScope), JSON.stringify(session))
  } catch {
    // Storage may be unavailable (private mode, quota); the dialog still works, it just will not restore.
  }
}

export function clearResearchSetupSession(projectId: string, workflowScope: string): void {
  try {
    window.localStorage.removeItem(sessionKey(projectId, workflowScope))
  } catch {
    // Ignore storage failures on cleanup.
  }
}

export function serializeResearchSetupDraft(draft: ResearchSetupDraft): ProjectResearchInitialIntakeInput {
  return {
    ...(draft.thread_id ? { thread_id: draft.thread_id } : {}),
    ...(draft.research_context_version_id ? { research_context_version_id: draft.research_context_version_id } : {}),
    ...(draft.query_strategy_id ? { query_strategy_id: draft.query_strategy_id } : {}),
    research_question: draft.research_question.trim(),
    history_mode: draft.history_mode,
    ...(draft.history_mode === 'bounded_range' ? { from: draft.from, to: draft.to } : {}),
    max_items: Math.max(1, Math.min(10000, Number(draft.max_items) || 10000)),
    monitoring_field: draft.monitoring_field,
    report_depth: draft.report_depth,
    question_refine_skipped: draft.question_refine_skipped,
    question_refinement: draft.question_refinement ?? null,
    execution: {
      ...(draft.execution.model_provider_id ? { model_provider_id: draft.execution.model_provider_id } : {}),
      ...(draft.execution.model_name.trim() ? { model_name: draft.execution.model_name.trim() } : {}),
    },
  }
}
