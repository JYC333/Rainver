import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, Clock3, Loader2, Pencil, Plus, Send, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ModelProviderOut } from '../../api/client'
import type {
  InquiryThread,
  InquiryThreadRevision,
  ProjectResearchQuestionAssessmentConfirmation,
  ProjectResearchQuestionAssessmentConfirmationResponse,
  ProjectResearchQuestionAssessmentSession,
  ProjectResearchQuestionRefinement,
  ProjectResearchWorkflow,
} from '../../types/api'
import { inquiryApi, projectResearchApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import {
  researchSetupDraftFromWorkflow,
  serializeResearchSetupDraft,
  type ResearchSetupDraft,
} from './researchSetupDraft'
import { defaultModelProvider } from '../providers/defaultProvider'
import { errMsg } from '../../lib/utils'

type ProcessingEvent = NonNullable<ProjectResearchQuestionAssessmentSession['messages'][number]['processing_events']>[number]
type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
  status?: 'pending' | 'complete' | 'failed'
  processingEvents?: ProcessingEvent[]
}
type ClarifyingAnswer = { selected: string[]; other: string }
type ClarifyingQuestion = ProjectResearchQuestionRefinement['clarifying_questions'][number]

const structuredOutputProviderTypes = new Set(['openai', 'openrouter', 'other', 'anthropic', 'ollama'])

/** Sessions saved before clarifying questions gained structured options may still contain strings. */
function clarifyingQuestionItems(refinement: ProjectResearchQuestionRefinement): ClarifyingQuestion[] {
  return refinement.clarifying_questions.map(item =>
    typeof item === 'string'
      ? { question: item, options: [], allow_multiple: false }
      : item,
  )
}

function clarificationAnswerBlocks(
  refinement: ProjectResearchQuestionRefinement,
  answers: Record<number, ClarifyingAnswer>,
): string[] {
  return clarifyingQuestionItems(refinement).map((item, index) => {
    const answer = answers[index] ?? { selected: [], other: '' }
    const value = [...answer.selected, answer.other.trim()].filter(Boolean).join('; ')
    return value ? `${item.question}\n${value}` : ''
  }).filter(Boolean)
}

function messageWithClarificationAnswers(
  message: string,
  refinement: ProjectResearchQuestionRefinement | null,
  answers: Record<number, ClarifyingAnswer>,
): string {
  const content = message.trim()
  if (!refinement) return content
  const blocks = clarificationAnswerBlocks(refinement, answers)
  if (blocks.length === 0) return content
  return [
    `My clarification answers:\n\n${blocks.join('\n\n')}`,
    ...(content ? [`Additional context:\n\n${content}`] : []),
  ].join('\n\n')
}

function visibleProcessingEvents(events: ProcessingEvent[] | undefined): ProcessingEvent[] {
  if (!events?.length) return []
  const terminalStages = new Set(
    events
      .filter(event => event.status === 'completed' || event.status === 'failed')
      .map(event => event.stage),
  )
  return events.filter(event => event.status !== 'running' || !terminalStages.has(event.stage))
}

function FinerRadar({ scores }: { scores: ProjectResearchQuestionRefinement['assessment']['finer'] }) {
  const entries = Object.entries(scores)
  const point = (index: number, radius: number) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / entries.length)
    return `${50 + Math.cos(angle) * radius},${50 + Math.sin(angle) * radius}`
  }
  const outline = entries.map((_, index) => point(index, 34)).join(' ')
  const value = entries.map(([, score], index) => point(index, 34 * score / 5)).join(' ')
  return (
    <svg viewBox="0 0 100 100" className="size-32 shrink-0" role="img" aria-label={`FINER scores: ${entries.map(([key, score]) => `${key} ${score} of 5`).join(', ')}`}>
      <polygon points={outline} fill="none" stroke="currentColor" strokeOpacity="0.25" />
      {entries.map((_, index) => <line key={index} x1="50" y1="50" x2={point(index, 34).split(',')[0]} y2={point(index, 34).split(',')[1]} stroke="currentColor" strokeOpacity="0.15" />)}
      <polygon points={value} fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.5" />
      {entries.map(([key], index) => {
        const [x, y] = point(index, 43).split(',')
        return <text key={key} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="currentColor">{key[0]?.toUpperCase()}</text>
      })}
    </svg>
  )
}

function copyDraft(draft: ResearchSetupDraft): ResearchSetupDraft {
  return { ...draft, execution: { ...draft.execution } }
}

function sameItems(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameFrameworkStructure(
  left: ProjectResearchQuestionRefinement,
  right: ProjectResearchQuestionRefinement,
) {
  return sameItems(left.scope.in, right.scope.in)
    && sameItems(left.scope.out, right.scope.out)
    && sameItems(left.sub_questions, right.sub_questions)
}

function matchesConfirmation(
  wording: string,
  refinement: ProjectResearchQuestionRefinement,
  confirmation: ProjectResearchQuestionAssessmentConfirmation,
) {
  return wording.trim() === confirmation.question.trim()
    && sameItems(refinement.scope.in, confirmation.scope.in)
    && sameItems(refinement.scope.out, confirmation.scope.out)
    && sameItems(refinement.sub_questions, confirmation.sub_questions)
}

function conversationMessages(session: ProjectResearchQuestionAssessmentSession): ConversationMessage[] {
  return session.messages.map(message => ({
    role: message.role,
    content: message.content,
    status: message.status,
    processingEvents: message.processing_events ?? [],
  }))
}

interface QuestionRefinementPanelProps {
  projectId: string
  thread: InquiryThread
  linkedDraftWorkflow: ProjectResearchWorkflow | null
  modelProviders: ModelProviderOut[]
  assessmentSession: ProjectResearchQuestionAssessmentSession | null
  canAct: boolean
  onChanged: () => Promise<void>
}

/**
 * A dedicated two-pane workspace: the conversation is continuous on one side,
 * while every model turn replaces the live structured framework on the other.
 */
export function QuestionRefinementPanel({ projectId, thread, linkedDraftWorkflow, modelProviders, assessmentSession, canAct, onChanged }: QuestionRefinementPanelProps) {
  const isHypothesis = thread.kind === 'hypothesis'
  const [draft, setDraft] = useState<ResearchSetupDraft>(() => copyDraft(researchSetupDraftFromWorkflow(linkedDraftWorkflow, thread.statement)))
  const [sessionWorkflowId, setSessionWorkflowId] = useState<string | null>(linkedDraftWorkflow?.id ?? null)
  const [refinement, setRefinement] = useState<ProjectResearchQuestionRefinement | null>(null)
  const [assessedFramework, setAssessedFramework] = useState<ProjectResearchQuestionRefinement | null>(null)
  const [assessmentBaseline, setAssessmentBaseline] = useState<ProjectResearchQuestionRefinement | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [clarifyingAnswers, setClarifyingAnswers] = useState<Record<number, ClarifyingAnswer>>({})
  const [composer, setComposer] = useState('')
  const [refining, setRefining] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [confirmationLookupLoading, setConfirmationLookupLoading] = useState(true)
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<ProjectResearchQuestionAssessmentConfirmation | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [confirmations, setConfirmations] = useState<ProjectResearchQuestionAssessmentConfirmation[]>([])
  const [threadRevisions, setThreadRevisions] = useState<InquiryThreadRevision[]>([])
  const conversationScrollRef = useRef<HTMLDivElement | null>(null)
  const followConversationRef = useRef(true)
  const activeMessageRef = useRef<string | null>(null)

  useEffect(() => {
    const workflowDraft = copyDraft(researchSetupDraftFromWorkflow(linkedDraftWorkflow, thread.statement))
    const initialDraft = assessmentSession?.recommended_question
      ? {
          ...workflowDraft,
          research_question: assessmentSession.recommended_question,
          research_context_version_id: assessmentSession.research_context_version_id ?? workflowDraft.research_context_version_id,
          question_refinement: assessmentSession.latest_refinement,
        }
      : workflowDraft
    setDraft(initialDraft)
    const initialRefinement = assessmentSession?.latest_refinement ?? initialDraft.question_refinement ?? null
    setRefinement(initialRefinement)
    setAssessedFramework(initialRefinement)
    setAssessmentBaseline(assessmentSession?.assessment_baseline ?? initialRefinement)
    setMessages(assessmentSession ? conversationMessages(assessmentSession) : [])
    setClarifyingAnswers({})
    setSessionWorkflowId(linkedDraftWorkflow?.id ?? null)
    setComposer('')
    setRefineError(null)
    setConfirming(false)
    setConfirmationLookupLoading(true)
    setConfirmedSnapshot(null)
    setHistoryOpen(false)
    setHistoryLoaded(false)
    setHistoryError(null)
    setConfirmations([])
    setThreadRevisions([])
    followConversationRef.current = true
    // A different Thread is a different assessment conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentSession?.id, projectId, thread.id])

  useEffect(() => {
    let cancelled = false
    setConfirmationLookupLoading(true)
    void projectResearchApi.questionAssessmentConfirmations(projectId, thread.id)
      .then(items => {
        if (cancelled) return
        setConfirmations(items)
        setConfirmedSnapshot(items[0] ?? null)
      })
      .catch(() => {
        // An explicit History open surfaces retrieval errors. Initial lookup
        // only establishes whether the working framework is already confirmed.
      })
      .finally(() => {
        if (!cancelled) setConfirmationLookupLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [assessmentSession?.id, projectId, thread.id])

  useEffect(() => {
    const fallback = defaultModelProvider(modelProviders, provider => structuredOutputProviderTypes.has(provider.provider_type))
    if (!fallback) return
    setDraft(current => current.execution.model_provider_id
      ? current
      : { ...current, execution: { model_provider_id: fallback.id, model_name: current.execution.model_name || (fallback.default_model ?? '') } })
  }, [modelProviders])

  useEffect(() => {
    const container = conversationScrollRef.current
    if (!container || !followConversationRef.current || typeof container.scrollTo !== 'function') return
    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
  }, [messages, refining])

  useEffect(() => {
    if (!refining) return
    let cancelled = false
    const poll = async () => {
      try {
        const session = await projectResearchApi.questionAssessment(projectId, thread.id)
        if (cancelled || !session || !activeMessageRef.current) return
        const latestUserMessage = [...session.messages].reverse().find(message => message.role === 'user')
        if (latestUserMessage?.content !== activeMessageRef.current) return
        setMessages(conversationMessages(session))
      } catch {
        // The foreground request remains authoritative. Polling only exposes
        // durable progress while that request is still running.
      }
    }
    const timer = window.setInterval(() => void poll(), 500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [projectId, refining, thread.id])

  async function persistConfirmedDraft(next: ResearchSetupDraft) {
    if (!canAct) return
    const workflow = await projectResearchApi.saveInitialIntakeDraft(projectId, {
      ...serializeResearchSetupDraft(next),
      thread_id: thread.id,
      ...(sessionWorkflowId ? { workflow_id: sessionWorkflowId } : {}),
    })
    setSessionWorkflowId(workflow.id)
  }

  async function sendMessage(message: string, options: { establishesAssessmentBaseline?: boolean } = {}) {
    const content = message.trim()
    if (!content || !draft.research_question.trim() || !draft.execution.model_provider_id || refining) return
    const userMessage: ConversationMessage = { role: 'user', content }
    const nextMessages = [...messages, userMessage]
    followConversationRef.current = true
    activeMessageRef.current = content
    setMessages(nextMessages)
    setComposer('')
    setRefining(true)
    setRefineError(null)
    try {
      const result = await projectResearchApi.refineQuestion(projectId, {
        thread_id: thread.id,
        research_question: draft.research_question.trim(),
        message: content,
        ...(options.establishesAssessmentBaseline ? { establish_assessment_baseline: true } : {}),
        execution: {
          model_provider_id: draft.execution.model_provider_id,
          ...(draft.execution.model_name.trim() ? { model_name: draft.execution.model_name.trim() } : {}),
        },
      })
      const recommendedQuestion = result.recommended_question?.trim() || draft.research_question.trim()
      const scores = Object.values(result.assessment.finer)
      const acceptable = isHypothesis || (result.assessment.answerable && scores.reduce((sum, score) => sum + score, 0) / scores.length >= 3)
      const nextDraft = {
        ...draft,
        research_question: recommendedQuestion,
        question_refine_skipped: !acceptable,
        question_refinement: result,
        research_context_version_id: result.research_context_version_id,
        query_strategy_id: '',
      }
      setDraft(nextDraft)
      setRefinement(result)
      setAssessedFramework(result)
      setAssessmentBaseline(result.assessment_session.assessment_baseline ?? result)
      setMessages(conversationMessages(result.assessment_session))
      setClarifyingAnswers({})
    } catch (error) {
      setRefineError(errMsg(error))
      void projectResearchApi.questionAssessment(projectId, thread.id).then(session => {
        if (!session) return
        setMessages(conversationMessages(session))
      }).catch(() => {})
    } finally {
      activeMessageRef.current = null
      setRefining(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    submitComposer()
  }

  function submitComposer() {
    void sendMessage(messageWithClarificationAnswers(composer, refinement, clarifyingAnswers))
  }

  function useSuggestedQuestion(question: string) {
    const next = { ...draft, research_question: question, question_refine_skipped: true, research_context_version_id: '', query_strategy_id: '' }
    setDraft(next)
    setComposer(`Use this wording and update the framework: ${question}`)
  }

  function editFramework(transform: (current: ProjectResearchQuestionRefinement) => ProjectResearchQuestionRefinement) {
    if (!refinement) return
    const next = transform(refinement)
    setRefinement(next)
    setDraft(current => ({
      ...current,
      question_refinement: next,
      research_context_version_id: '',
      query_strategy_id: '',
    }))
  }

  function updateScope(kind: 'in' | 'out', items: string[]) {
    editFramework(current => ({ ...current, scope: { ...current.scope, [kind]: items } }))
  }

  function updateSubQuestions(items: string[]) {
    editFramework(current => ({ ...current, sub_questions: items }))
  }

  async function reassessFrameworkChanges() {
    if (!refinement) return
    await sendMessage([
      'Reassess the current changed framework. Preserve deliberate user choices unless they create a researchability problem, and explain any recommended correction.',
      JSON.stringify({
        question: draft.research_question.trim(),
        in_scope: refinement.scope.in,
        out_of_scope: refinement.scope.out,
        sub_questions: refinement.sub_questions,
      }),
    ].join('\n\n'), { establishesAssessmentBaseline: true })
  }

  async function loadHistory() {
    if (historyLoading) return
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const [nextConfirmations, nextRevisions] = await Promise.all([
        projectResearchApi.questionAssessmentConfirmations(projectId, thread.id),
        inquiryApi.listRevisions(projectId, thread.id),
      ])
      setConfirmations(nextConfirmations)
      setConfirmedSnapshot(nextConfirmations[0] ?? null)
      setThreadRevisions(nextRevisions)
      setHistoryLoaded(true)
    } catch (error) {
      setHistoryError(errMsg(error))
    } finally {
      setHistoryLoading(false)
    }
  }

  async function toggleHistory() {
    const nextOpen = !historyOpen
    setHistoryOpen(nextOpen)
    if (nextOpen && !historyLoaded) await loadHistory()
  }

  function useConfirmationAsDraft(confirmation: ProjectResearchQuestionAssessmentConfirmation) {
    if (!refinement) return
    const next = {
      ...refinement,
      research_context_version_id: confirmation.id,
      recommended_question: confirmation.question,
      assessment: confirmation.assessment,
      scope: confirmation.scope,
      sub_questions: confirmation.sub_questions,
    }
    setRefinement(next)
    setDraft(current => ({
      ...current,
      research_question: confirmation.question,
      question_refinement: next,
      question_refine_skipped: true,
      research_context_version_id: '',
      query_strategy_id: '',
    }))
  }

  function useWordingAsDraft(statement: string) {
    setDraft(current => ({
      ...current,
      research_question: statement,
      question_refine_skipped: true,
      research_context_version_id: '',
      query_strategy_id: '',
    }))
  }

  function updateClarifyingAnswer(index: number, answer: ClarifyingAnswer) {
    setClarifyingAnswers(current => ({ ...current, [index]: answer }))
  }

  function submitClarifyingAnswers() {
    if (!refinement) return
    const answers = clarificationAnswerBlocks(refinement, clarifyingAnswers)
    if (answers.length === 0) return
    void sendMessage(messageWithClarificationAnswers(composer, refinement, clarifyingAnswers))
  }

  async function finishAssessment() {
    if (!refinement || confirming) return
    const finalStatement = draft.research_question.trim()
    setConfirming(true)

    if (finalStatement && finalStatement !== thread.statement.trim()) {
      try {
        await inquiryApi.reviseDefinition(projectId, thread.id, {
          revision_kind: 'semantic_change',
          structure_action: 'narrow',
          new_statement: finalStatement,
        })
      } catch (error) {
        toast.error(`Could not update the Inquiry wording: ${errMsg(error)}`)
        setConfirming(false)
        return
      }
    }

    let confirmationResult: ProjectResearchQuestionAssessmentConfirmationResponse
    try {
      confirmationResult = await projectResearchApi.confirmQuestionAssessment(projectId, {
        thread_id: thread.id,
        refinement: { ...refinement, recommended_question: finalStatement },
        manually_adjusted: frameworkManuallyEdited,
      })
    } catch (error) {
      toast.error(`Could not confirm this assessment: ${errMsg(error)}`)
      setConfirming(false)
      return
    }

    const { confirmation, ...confirmedRefinement } = confirmationResult
    const next = {
      ...draft,
      research_question: finalStatement,
      question_refine_skipped: false,
      question_refinement: confirmedRefinement,
      research_context_version_id: confirmation.id,
    }
    setDraft(next)
    setRefinement(confirmedRefinement)
    setAssessedFramework(confirmedRefinement)
    setConfirmedSnapshot(confirmation)
    setConfirmations(current => [confirmation, ...current.filter(item => item.id !== confirmation.id)])

    let followUpFailed = false
    try {
      await persistConfirmedDraft(next)
    } catch (error) {
      followUpFailed = true
      toast.error(`Assessment confirmed, but the research draft could not be saved: ${errMsg(error)}`)
    }

    try {
      await onChanged()
    } catch (error) {
      followUpFailed = true
      toast.error(`Assessment confirmed, but the page could not be refreshed: ${errMsg(error)}`)
    }

    try {
      setHistoryLoaded(false)
      if (historyOpen) await loadHistory()
    } finally {
      setConfirming(false)
    }

    if (!followUpFailed) {
      toast.success(isHypothesis ? 'Literature scope confirmed' : 'Research question confirmed')
    }
  }

  const assessedWording = refinement?.recommended_question?.trim() ?? ''
  const hasUnassessedChanges = Boolean(refinement && draft.research_question.trim() !== assessedWording)
  const hasReassessableChanges = Boolean(
    refinement
    && assessmentBaseline
    && (
      draft.research_question.trim() !== (assessmentBaseline.recommended_question?.trim() ?? '')
      || !sameFrameworkStructure(refinement, assessmentBaseline)
    ),
  )
  const frameworkManuallyEdited = Boolean(
    refinement
    && assessedFramework
    && !sameFrameworkStructure(refinement, assessedFramework),
  )
  const isCurrentConfirmed = Boolean(
    refinement
    && confirmedSnapshot
    && refinement.research_context_version_id === confirmedSnapshot.id
    && matchesConfirmation(draft.research_question, refinement, confirmedSnapshot),
  )
  const frameworkPassing = Boolean(refinement && !hasUnassessedChanges && (isHypothesis || !draft.question_refine_skipped))

  return (
    <div className="grid min-h-[680px] overflow-hidden rounded-lg border border-border bg-background xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]">
      <section className="min-w-0 border-b border-border xl:border-b-0 xl:border-r" aria-label="Structured assessment">
        <div className="border-b border-border p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Live framework</p>
              <h2 className="mt-1 text-lg font-semibold">{isHypothesis ? 'Assess inquiry scope' : 'Assess research question'}</h2>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => void toggleHistory()} aria-expanded={historyOpen}>
                <Clock3 className="size-4" />History
              </Button>
              {refinement
                ? <Badge variant={frameworkManuallyEdited ? 'warning' : frameworkPassing ? 'success' : 'warning'}>{frameworkManuallyEdited ? 'Manually adjusted' : frameworkPassing ? 'Ready to confirm' : hasUnassessedChanges ? 'Unassessed changes' : 'Needs discussion'}</Badge>
                : <Badge variant="outline">Not assessed</Badge>}
            </div>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {historyOpen && (
            <VersionHistory
              loading={historyLoading}
              error={historyError}
              confirmations={confirmations}
              revisions={threadRevisions}
              onUseConfirmation={useConfirmationAsDraft}
              onUseWording={useWordingAsDraft}
            />
          )}
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Current recommended wording</span>
            <Textarea
              aria-label="Current recommended wording"
              value={draft.research_question}
              rows={3}
              onChange={event => setDraft(current => ({
                ...current,
                research_question: event.target.value,
                question_refine_skipped: true,
                research_context_version_id: '',
                query_strategy_id: '',
              }))}
            />
            <span className="block text-xs text-muted-foreground">The conversation updates this wording automatically. You can also edit it directly, then ask the assistant to reassess.</span>
          </label>
          {hasUnassessedChanges && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/35 bg-warning/5 p-3">
              <p className="text-sm text-warning">The framework below belongs to the previous wording. These edits are temporary until reassessed.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={refining || !draft.research_question.trim() || !draft.execution.model_provider_id}
                onClick={() => void reassessFrameworkChanges()}
              >
                Assess changes
              </Button>
            </div>
          )}
          {hasReassessableChanges && !hasUnassessedChanges && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/25 bg-primary/5 p-3">
              <p className="text-sm text-muted-foreground">The wording, scope, or sub-questions changed since the last explicit assessment. You can reassess the current framework before confirming it.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={refining || !draft.execution.model_provider_id}
                onClick={() => void reassessFrameworkChanges()}
              >
                Reassess changes
              </Button>
            </div>
          )}

          {!refinement && (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Start the conversation to generate the answerability, FINER, scope, and sub-question framework.
            </div>
          )}

          {refinement && (
            <>
              {!isHypothesis && (
                <div className="rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <FinerRadar scores={refinement.assessment.finer} />
                    <div className="min-w-0 flex-1 space-y-3">
                      <Badge variant={refinement.assessment.answerable ? 'success' : 'destructive'}>
                        {refinement.assessment.answerable ? 'Answerable' : 'Not yet answerable'}
                      </Badge>
                      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                        {Object.entries(refinement.assessment.finer).map(([key, score]) => (
                          <span key={key} className="rounded bg-muted px-2 py-1 capitalize">{key} {score}/5</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  {refinement.assessment.issues.length > 0 && (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {refinement.assessment.issues.map(issue => <li key={issue}>{issue}</li>)}
                    </ul>
                  )}
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <EditableFrameworkList title="In scope" items={refinement.scope.in} empty="No inclusion boundaries yet" onChange={items => updateScope('in', items)} canEdit={canAct} />
                <EditableFrameworkList title="Out of scope" items={refinement.scope.out} empty="No exclusions yet" onChange={items => updateScope('out', items)} canEdit={canAct} />
              </div>
              <EditableFrameworkList title="Sub-questions" items={refinement.sub_questions} empty="No separate sub-questions yet" onChange={updateSubQuestions} canEdit={canAct} />

              {!isHypothesis && refinement.suggested_questions.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Alternative wording</p>
                  {refinement.suggested_questions.map(question => {
                    const selected = draft.research_question.trim() === question.trim()
                    return (
                      <button
                        key={question}
                        type="button"
                        aria-pressed={selected}
                        className={`flex w-full items-start gap-2 rounded-md border px-3 py-2.5 text-left text-sm ${selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary'}`}
                        onClick={() => useSuggestedQuestion(question)}
                      >
                        <Check className={`mt-0.5 size-4 shrink-0 ${selected ? 'text-primary' : 'invisible'}`} />
                        <span>{question}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button
              type="button"
              onClick={() => void finishAssessment()}
              disabled={!refinement || hasUnassessedChanges || isCurrentConfirmed || confirmationLookupLoading || confirming || !canAct}
            >
              {confirming
                ? <><Loader2 className="size-4 animate-spin" />Confirming…</>
                : isCurrentConfirmed
                  ? <><Check className="size-4" />Confirmed</>
                  : isHypothesis ? 'Confirm this scope' : 'Confirm research question'}
            </Button>
            <span className="text-xs text-muted-foreground">Confirmation writes the current wording back to this Inquiry Thread.</span>
          </div>
        </div>
      </section>

      <section className="flex min-h-[560px] min-w-0 flex-col bg-muted/10" aria-label="Assessment conversation">
        <div className="border-b border-border bg-background p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversation</p>
          <h2 className="mt-1 text-lg font-semibold">Discuss and refine</h2>
          <p className="mt-1 text-sm text-muted-foreground">Ask questions, explain your intent, or request a change. Each reply refreshes the framework beside it.</p>
        </div>

        <div
          ref={conversationScrollRef}
          role="log"
          aria-label="Assessment conversation messages"
          className="flex-1 space-y-4 overflow-y-auto p-5"
          onScroll={event => {
            const container = event.currentTarget
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
            followConversationRef.current = distanceFromBottom <= 80
          }}
        >
          <div className="mr-8 rounded-lg rounded-tl-sm border border-border bg-background p-3 text-sm">
            {isHypothesis
              ? 'I can help define the literature scope for this hypothesis. Tell me what evidence would support or challenge it.'
              : 'I can assess this question with the FINER framework and help make it researchable. Start with an assessment or tell me what outcome you have in mind.'}
          </div>
          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className="space-y-2">
              <div
                className={message.role === 'user'
                  ? 'ml-8 rounded-lg rounded-tr-sm bg-primary p-3 text-sm text-primary-foreground'
                  : 'mr-8 whitespace-pre-wrap rounded-lg rounded-tl-sm border border-border bg-background p-3 text-sm'}
              >
                {message.content}
                {message.status === 'failed' && <span className="mt-1 block text-xs opacity-70">This message was saved, but the assessment request failed.</span>}
              </div>
              {visibleProcessingEvents(message.processingEvents).map((event, eventIndex) => (
                <div
                  key={`${event.created_at}-${eventIndex}`}
                  className="mr-8 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                >
                  {event.status === 'running'
                    ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                    : event.status === 'failed'
                      ? <X className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                      : <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />}
                  <div>
                    <span className="font-medium text-foreground">System process · {event.status}</span>
                    <span className="mt-0.5 block">{event.message}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {refining && (
            <div className="mr-8 flex items-center gap-2 rounded-lg rounded-tl-sm border border-border bg-background p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Updating the assessment…
            </div>
          )}
          {refineError && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{refineError}</p>}
        </div>

        <form className="space-y-2 border-t border-border bg-background p-4" onSubmit={submit}>
          {messages.length === 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void sendMessage(isHypothesis ? 'Assess the literature scope for this hypothesis.' : 'Assess this research question and identify what needs clarification.')}
              disabled={refining || !draft.execution.model_provider_id}
            >
              Start assessment
            </Button>
          )}
          {!refining && refinement && refinement.clarifying_questions.length > 0 && (
            <div className="space-y-3 rounded-md border border-primary/25 bg-primary/5 p-3">
              <div>
                <p className="text-sm font-medium">Clarifying questions</p>
                <p className="text-xs text-muted-foreground">Select any suggested answers that apply, add your own, or answer naturally in the main message box.</p>
              </div>
              {clarifyingQuestionItems(refinement).map((item, index) => {
                const answer = clarifyingAnswers[index] ?? { selected: [], other: '' }
                const toggleOption = (option: string) => {
                  const selected = answer.selected.includes(option)
                    ? answer.selected.filter(value => value !== option)
                    : [...answer.selected, option]
                  updateClarifyingAnswer(index, { ...answer, selected })
                }
                return (
                  <div key={item.question} className="space-y-2 rounded-md border border-border bg-background p-3">
                    <p className="text-sm">
                      {item.question}
                      {item.options.length > 1 && <span className="ml-1 text-xs text-muted-foreground">(select all that apply)</span>}
                    </p>
                    {item.options.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {item.options.map(option => {
                          const selected = answer.selected.includes(option)
                          return (
                            <button
                              key={option}
                              type="button"
                              aria-pressed={selected}
                              className={`max-w-full whitespace-normal break-words rounded-xl border px-3 py-1.5 text-left text-xs leading-snug ${selected ? 'border-primary bg-primary/10 font-medium' : 'border-border hover:border-primary'}`}
                              onClick={() => toggleOption(option)}
                            >
                              {option}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    <Input
                      aria-label={`Answer: ${item.question}`}
                      value={answer.other}
                      placeholder={item.options.length ? 'Other — write your own answer' : 'Write your answer'}
                      onChange={event => updateClarifyingAnswer(index, { ...answer, other: event.target.value })}
                    />
                  </div>
                )
              })}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={submitClarifyingAnswers}
                disabled={refining || !Object.values(clarifyingAnswers).some(answer => answer.selected.length > 0 || answer.other.trim())}
              >
                Send clarification answers
              </Button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              aria-label="Message"
              value={composer}
              onChange={event => setComposer(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (composer.trim()) submitComposer()
                }
              }}
              placeholder="Discuss the question, answer a clarification, or request a framework change…"
              rows={3}
              className="min-h-[76px] resize-none"
              disabled={refining || !canAct}
            />
            <Button type="submit" size="icon" aria-label="Send message" disabled={refining || !composer.trim() || !draft.execution.model_provider_id || !canAct}>
              {refining ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </div>
          {!draft.execution.model_provider_id && <p className="text-xs text-destructive">Configure an enabled structured-output model provider before starting the assessment.</p>}
        </form>
      </section>
    </div>
  )
}

function EditableFrameworkList({
  title,
  items,
  empty,
  onChange,
  canEdit,
}: {
  title: string
  items: string[]
  empty: string
  onChange: (items: string[]) => void
  canEdit: boolean
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [adding, setAdding] = useState(false)
  const [newValue, setNewValue] = useState('')

  function beginEdit(index: number) {
    setEditingIndex(index)
    setEditingValue(items[index] ?? '')
  }

  function saveEdit() {
    if (editingIndex === null) return
    const value = editingValue.trim()
    onChange(value
      ? items.map((item, index) => index === editingIndex ? value : item)
      : items.filter((_, index) => index !== editingIndex))
    setEditingIndex(null)
    setEditingValue('')
  }

  function saveNew() {
    const value = newValue.trim()
    if (value && !items.includes(value) && items.length < 10) onChange([...items, value])
    setAdding(false)
    setNewValue('')
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {canEdit && items.length < 10 && !adding && (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" aria-label={`Add ${title} item`} onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />Add
          </Button>
        )}
      </div>
      {items.length > 0
        ? (
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {items.map((item, index) => (
              <li key={`${index}-${item}`} className="group relative flex min-h-8 items-start gap-2 overflow-hidden rounded px-1.5 py-1 hover:bg-muted/60">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true" />
                {editingIndex === index
                  ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <Input
                        autoFocus
                        aria-label={`Edit ${title} item ${index + 1}`}
                        value={editingValue}
                        maxLength={200}
                        onChange={event => setEditingValue(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') saveEdit()
                          if (event.key === 'Escape') setEditingIndex(null)
                        }}
                      />
                      <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Save ${title} item ${index + 1}`} onClick={saveEdit}><Check className="size-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Cancel editing ${title} item ${index + 1}`} onClick={() => setEditingIndex(null)}><X className="size-4" /></Button>
                    </div>
                  )
                  : (
                    <>
                      <span className="min-w-0 flex-1 py-0.5">{item}</span>
                      {canEdit && (
                        <span className="absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-muted via-muted/95 to-transparent pl-8 pr-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Edit ${title} item ${index + 1}`} onClick={() => beginEdit(index)}><Pencil className="size-3.5" /></Button>
                          <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" aria-label={`Delete ${title} item ${index + 1}`} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-3.5" /></Button>
                        </span>
                      )}
                    </>
                  )}
              </li>
            ))}
          </ul>
        )
        : <p className="mt-2 text-sm text-muted-foreground">{empty}</p>}
      {adding && (
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            autoFocus
            aria-label={`New ${title} item`}
            value={newValue}
            maxLength={200}
            placeholder={`Add to ${title.toLowerCase()}`}
            onChange={event => setNewValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') saveNew()
              if (event.key === 'Escape') setAdding(false)
            }}
          />
          <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Save new ${title} item`} onClick={saveNew}><Check className="size-4" /></Button>
          <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Cancel new ${title} item`} onClick={() => setAdding(false)}><X className="size-4" /></Button>
        </div>
      )}
    </div>
  )
}

function VersionHistory({
  loading,
  error,
  confirmations,
  revisions,
  onUseConfirmation,
  onUseWording,
}: {
  loading: boolean
  error: string | null
  confirmations: ProjectResearchQuestionAssessmentConfirmation[]
  revisions: InquiryThreadRevision[]
  onUseConfirmation: (confirmation: ProjectResearchQuestionAssessmentConfirmation) => void
  onUseWording: (statement: string) => void
}) {
  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/20 p-3" aria-label="Question version history">
      <div>
        <p className="text-sm font-medium">Version history</p>
        <p className="text-xs text-muted-foreground">Confirmed versions are immutable. Loading one creates a new working draft.</p>
      </div>
      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading history…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && confirmations.length === 0 && revisions.length === 0 && (
        <p className="text-sm text-muted-foreground">No earlier versions yet.</p>
      )}
      {confirmations.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Confirmed frameworks</p>
          {confirmations.map(item => (
            <div key={item.id} className="rounded border border-border bg-background p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{item.question}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Context v{item.version} · {formatVersionDate(item.created_at)}{item.manually_adjusted ? ' · Manually adjusted' : ''}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" onClick={() => onUseConfirmation(item)}>Use as draft</Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{item.scope.in.length} in scope · {item.scope.out.length} out of scope · {item.sub_questions.length} sub-questions</p>
            </div>
          ))}
        </div>
      )}
      {revisions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Inquiry wording</p>
          {revisions.map(item => (
            <div key={item.id} className="flex items-start justify-between gap-3 rounded border border-border bg-background p-3">
              <div>
                <p className="text-sm">{item.statement}</p>
                <p className="mt-1 text-xs text-muted-foreground">Thread v{item.version} · {formatVersionDate(item.created_at)}</p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => onUseWording(item.statement)}>Use wording</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatVersionDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString()
}
