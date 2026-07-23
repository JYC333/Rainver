import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Edit2, Search } from 'lucide-react'
import type { ModelProviderOut } from '../../api/client'
import type {
  CustomSourceCredentialDTO,
  ProjectResearchInitialIntakeInput,
  ProjectResearchQuestionRefinement,
  MaterializedResearchStrategy,
  ResearchProviderKey,
  ResearchQueryAttempt,
  ResearchQueryStrategy,
  ResearchSemanticConcept,
} from '../../types/api'
import { projectResearchApi, researchDiscoveryApi, sourcesApi } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { DatePicker } from '../../components/ui/date-picker'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import {
  clearResearchSetupSession,
  loadResearchSetupSession,
  saveResearchSetupSession,
  serializeResearchSetupDraft,
  type ResearchClarifyingAnswer,
  type ResearchSetupDraft,
} from './researchSetupDraft'
import { defaultModelProvider } from '../providers/defaultProvider'
import { errMsg } from '../../lib/utils'

interface ResearchSetupDialogProps {
  projectId?: string
  open: boolean
  draft: ResearchSetupDraft
  busyAction: string | null
  modelProviders: ModelProviderOut[]
  canAct: boolean
  onOpenChange: (open: boolean) => void
  onSave: (config: ProjectResearchInitialIntakeInput) => Promise<boolean>
  onRefineQuestion: (input: { research_question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; execution: { model_provider_id?: string; model_name?: string } }) => Promise<ProjectResearchQuestionRefinement>
  onStart: (config: ProjectResearchInitialIntakeInput) => void | Promise<void>
  onEditQuestion: () => void
}

function copyDraft(draft: ResearchSetupDraft): ResearchSetupDraft {
  return {
    ...draft,
    execution: { ...draft.execution },
  }
}

function draftFingerprint(draft: ResearchSetupDraft): string {
  return JSON.stringify(draft)
}

function historyLabel(draft: ResearchSetupDraft): string {
  return draft.history_mode === 'all_available'
    ? 'All available history'
    : draft.from && draft.to
      ? `${draft.from} to ${draft.to}`
      : 'Date range not set'
}

const structuredOutputProviderTypes = new Set(['openai', 'openrouter', 'other', 'anthropic', 'ollama'])

// Steps are freely navigable: an unfinished earlier step never blocks viewing
// a later one — only the specific gated actions (Discover/Start) stay locked.
const SETUP_STEPS = ['Question', 'Sources', 'Initial import', 'Execution'] as const

type ClarifyingQuestion = ProjectResearchQuestionRefinement['clarifying_questions'][number]

/** Sessions persisted before the structured-options contract stored plain strings. */
function clarifyingQuestionItems(refinement: ProjectResearchQuestionRefinement): ClarifyingQuestion[] {
  return refinement.clarifying_questions.map(item =>
    typeof item === 'string' ? { question: item, options: [], allow_multiple: false } : item,
  )
}

function normalizeClarifyingAnswer(value: unknown): ResearchClarifyingAnswer {
  if (typeof value === 'string') return { selected: [], other: value }
  const record = (value ?? {}) as Partial<ResearchClarifyingAnswer>
  return {
    selected: Array.isArray(record.selected) ? record.selected.filter((item): item is string => typeof item === 'string') : [],
    other: typeof record.other === 'string' ? record.other : '',
  }
}

function clarifyingAnswerText(value: ResearchClarifyingAnswer): string {
  return [...value.selected, value.other.trim()].filter(Boolean).join('; ')
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

// Every provider compiles the same semantic_query into its own boolean-query
// dialect (arxiv's `all:"..." AND (... OR ...)`, plain keyword strings for
// openalex/semantic_scholar, ...). Rendering the shared semantic_query
// structure instead of the compiled string avoids one fragile parser per
// provider syntax and reads the same regardless of which provider ran it.
function SemanticQueryColumns({ query }: { query: ResearchQueryAttempt['semantic_query'] }) {
  // core and qualifiers combine with different boolean operators (core is
  // OR'd into one topic clause, qualifiers are AND'd on top of it — see
  // providers/arxiv.ts) and must stay visually separate: merging them under
  // one "must match" label hides that dropping the one AND'd qualifier (not
  // any of the OR'd topic terms) is what swings the hit count the most.
  const columns: Array<{ key: string; title: string; concepts: ResearchSemanticConcept[] }> = [
    { key: 'topic', title: 'Topic (any of)', concepts: query.core },
    { key: 'broaden', title: 'Broadens with (any of)', concepts: query.expansions },
    { key: 'required', title: 'Required (all of)', concepts: query.qualifiers },
    { key: 'exclude', title: 'Excludes (none of)', concepts: query.exclusions },
  ].filter(column => column.concepts.length > 0)
  if (columns.length === 0) return null
  return (
    <div className="mt-1.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {columns.map(column => (
        <div key={column.key} className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{column.title}</p>
          <ul className="space-y-1">
            {column.concepts.map((concept, index) => (
              <li key={`${column.key}-${index}`} className="rounded border border-border bg-background/60 px-1.5 py-1 font-mono text-xs">
                {concept.value}
                {concept.synonyms.length > 0 && <span className="block text-[11px] text-muted-foreground">or: {concept.synonyms.join(', ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function researchSetupDraftIsReady(draft: ResearchSetupDraft): boolean {
  const maxItems = Number(draft.max_items)
  return Boolean(
    draft.research_question.trim()
      && Boolean(draft.query_strategy_id)
      && (draft.history_mode === 'all_available' || (draft.from && draft.to))
      && Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= 10000
      && Boolean(draft.execution.model_provider_id),
  )
}

export function ResearchSetupDialog({
  projectId = 'project-1',
  open,
  draft: initialDraft,
  busyAction,
  modelProviders,
  canAct,
  onOpenChange,
  onSave,
  onRefineQuestion,
  onStart,
  onEditQuestion,
}: ResearchSetupDialogProps) {
  const [draft, setDraft] = useState<ResearchSetupDraft>(() => copyDraft(initialDraft))
  const [refinement, setRefinement] = useState<ProjectResearchQuestionRefinement | null>(null)
  const [refinementHistory, setRefinementHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [clarifyingAnswers, setClarifyingAnswers] = useState<Record<number, ResearchClarifyingAnswer>>({})
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [engineResult, setEngineResult] = useState<ResearchQueryStrategy | null>(null)
  const [materializedResult, setMaterializedResult] = useState<MaterializedResearchStrategy | null>(null)
  const [selectedProviders, setSelectedProviders] = useState<ResearchProviderKey[]>([])
  const [engineBusy, setEngineBusy] = useState<'search' | 'create' | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [retryingProvider, setRetryingProvider] = useState<ResearchProviderKey | null>(null)
  const [sourceCredentials, setSourceCredentials] = useState<CustomSourceCredentialDTO[]>([])
  const [webCredentialId, setWebCredentialId] = useState('')
  const [step, setStep] = useState(0)
  const initialDraftFingerprint = draftFingerprint(initialDraft)

  const ready = researchSetupDraftIsReady(draft)
  const maxItemsValue = Number(draft.max_items)
  const stepComplete = [
    Boolean(draft.research_question.trim()) && !draft.question_refine_skipped,
    Boolean(draft.query_strategy_id),
    (draft.history_mode === 'all_available' || Boolean(draft.from && draft.to)) && Number.isInteger(maxItemsValue) && maxItemsValue >= 1 && maxItemsValue <= 10000,
    Boolean(draft.execution.model_provider_id),
  ]
  // Progress is cumulative: a later step only ticks once every earlier step is
  // also satisfied, so a green check never appears ahead of unfinished work.
  const stepTicked = stepComplete.map((_, index) => stepComplete.slice(0, index + 1).every(Boolean))
  const selectableProviders = modelProviders.filter(provider => provider.enabled && structuredOutputProviderTypes.has(provider.provider_type))

  useEffect(() => {
    if (!open) return
    // Restore the in-progress session (refined question, assessment,
    // clarification history) unless the server-side draft changed while the
    // dialog was closed. This deliberately runs only on open: our own actions
    // (creating monitors, saving) refresh the parent draft mid-flight, and a
    // fingerprint change while the dialog is open must never wipe the session
    // — the persist effect below adopts the new fingerprint instead.
    const session = loadResearchSetupSession(projectId)
    if (session && session.base_fingerprint === initialDraftFingerprint) {
      setDraft(copyDraft(session.draft))
      setRefinement(session.refinement)
      setRefinementHistory(session.refinement_history)
      setClarifyingAnswers(Object.fromEntries(Object.entries(session.clarifying_answers ?? {}).map(([key, value]) => [key, normalizeClarifyingAnswer(value)])))
      setStep(Number.isInteger(session.step) && session.step! >= 0 && session.step! <= 3 ? session.step! : 0)
    } else {
      if (session) clearResearchSetupSession(projectId)
      setDraft(copyDraft(initialDraft))
      // The last assessment is durable in the server-side draft; a fresh
      // browser still starts from it instead of an empty card.
      setRefinement(initialDraft.question_refinement ?? null)
      setRefinementHistory([])
      setClarifyingAnswers({})
      setStep(0)
    }
    setRefineError(null)
    setEngineResult(null)
    setMaterializedResult(null)
    setSelectedProviders([])
    setEngineError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId])

  useEffect(() => {
    if (!open) return
    // The space default provider (and its default model) is preselected so a
    // configured space needs no manual provider picking in this dialog.
    const fallback = defaultModelProvider(modelProviders, provider => structuredOutputProviderTypes.has(provider.provider_type))
    if (!fallback) return
    setDraft(current => current.execution.model_provider_id
      ? current
      : { ...current, execution: { model_provider_id: fallback.id, model_name: current.execution.model_name || (fallback.default_model ?? '') } })
  }, [modelProviders, open])

  useEffect(() => {
    if (!open) return
    saveResearchSetupSession(projectId, {
      base_fingerprint: initialDraftFingerprint,
      draft,
      refinement,
      refinement_history: refinementHistory,
      clarifying_answers: clarifyingAnswers,
      step,
    })
  }, [clarifyingAnswers, draft, initialDraftFingerprint, open, projectId, refinement, refinementHistory, step])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void sourcesApi.customSourceCredentials().then(items => {
      if (!cancelled) setSourceCredentials(items)
    }).catch(() => {
      if (!cancelled) setSourceCredentials([])
    })
    return () => { cancelled = true }
  }, [open])

  async function saveDraft() {
    if (!ready || !canAct || busyAction !== null) return
    const saved = await onSave(serializeResearchSetupDraft(draft))
    if (saved) {
      clearResearchSetupSession(projectId)
      onOpenChange(false)
    }
  }

  function startResearch() {
    if (!ready || !canAct || busyAction !== null || draft.question_refine_skipped) return
    clearResearchSetupSession(projectId)
    onOpenChange(false)
    onStart(serializeResearchSetupDraft(draft))
  }

  function editQuestion() {
    onOpenChange(false)
    onEditQuestion()
  }

  async function refineQuestion() {
    if (!draft.research_question.trim() || !draft.execution.model_provider_id || refining || refinementHistory.length >= 4) return
    const answered = refinement
      ? clarifyingQuestionItems(refinement).map((item, index) => ({
          question: item.question,
          answer: clarifyingAnswerText(normalizeClarifyingAnswer(clarifyingAnswers[index])),
        })).filter(item => item.answer)
      : []
    const history = refinement && answered.length
      ? [...refinementHistory,
          { role: 'assistant' as const, content: JSON.stringify(refinement) },
          { role: 'user' as const, content: JSON.stringify({ clarifications: answered }) }]
      : refinementHistory
    setRefining(true)
    setRefineError(null)
    try {
      const result = await onRefineQuestion({
        research_question: draft.research_question.trim(),
        history,
        execution: {
          model_provider_id: draft.execution.model_provider_id,
          ...(draft.execution.model_name.trim() ? { model_name: draft.execution.model_name.trim() } : {}),
        },
      })
      const scores = Object.values(result.assessment.finer)
      const acceptable = result.assessment.answerable && scores.reduce((sum, score) => sum + score, 0) / scores.length >= 3
      const next = {
        ...draft,
        question_refine_skipped: !acceptable,
        question_refinement: result,
        research_context_version_id: result.research_context_version_id,
        query_strategy_id: '',
      }
      setDraft(next)
      setRefinement(result)
      setRefinementHistory(history)
      setClarifyingAnswers({})
      autoPersistDraft(next)
    } catch (error) {
      setRefineError(errMsg(error))
    } finally {
      setRefining(false)
    }
  }

  /**
   * Milestones (assessment, adoption, Next) are durably saved server-side:
   * browser storage alone is too fragile to be the only holder of a passed
   * refinement. The toast tells the user their progress is now on the server.
   */
  function autoPersistDraft(next: ResearchSetupDraft) {
    if (!canAct) return
    void projectResearchApi.saveInitialIntakeDraft(projectId, serializeResearchSetupDraft(next))
      .then(() => toast.success('Setup progress saved to the project'))
      .catch((error) => toast.error(`Setup progress could not be saved: ${errMsg(error)}`))
  }

  function adoptQuestion(question: string) {
    const next = {
      ...draft,
      research_question: question,
      question_refine_skipped: true,
      research_context_version_id: '',
      query_strategy_id: '',
      question_refinement: null,
    }
    setDraft(next)
    setEngineResult(null)
    setMaterializedResult(null)
    autoPersistDraft(next)
    toast.info('Suggested question adopted. Answer any clarifying questions, then reassess it.')
  }

  function updateClarifyingAnswer(index: number, answer: ResearchClarifyingAnswer) {
    setClarifyingAnswers(current => ({ ...current, [index]: answer }))
    setDraft(current => ({
      ...current,
      question_refine_skipped: true,
      research_context_version_id: '',
      query_strategy_id: '',
    }))
    setEngineResult(null)
    setMaterializedResult(null)
  }

  async function discoverSources() {
    if (!draft.research_context_version_id || engineBusy) return
    setEngineBusy('search'); setEngineError(null)
    try {
      const providers: ResearchProviderKey[] = ['arxiv', 'openalex', 'semantic_scholar', ...(webCredentialId ? ['web_search' as const] : [])]
      const result = await researchDiscoveryApi.evaluate({
        project_id: projectId,
        research_context_version_id: draft.research_context_version_id,
        providers,
        candidate_budget: Math.max(50, Math.min(1000, Number(draft.max_items) || 1000)),
        execution: { model_provider_id: draft.execution.model_provider_id || undefined, model_name: draft.execution.model_name.trim() || undefined },
        ...(webCredentialId ? { credentials: { web_search: webCredentialId } } : {}),
      })
      setEngineResult(result.strategy)
      setMaterializedResult(null)
      setSelectedProviders(result.strategy.provider_plans.filter(plan => plan.status === 'selected').map(plan => plan.provider_key))
      setDraft(current => ({ ...current, query_strategy_id: '' }))
    } catch (error) { setEngineError(errMsg(error)) } finally { setEngineBusy(null) }
  }

  async function retryProvider(providerKey: ResearchProviderKey) {
    if (!engineResult || retryingProvider || engineBusy) return
    setRetryingProvider(providerKey); setEngineError(null)
    try {
      const result = await researchDiscoveryApi.retryProvider(engineResult.id, providerKey, {
        project_id: projectId,
        execution: { model_provider_id: draft.execution.model_provider_id || undefined, model_name: draft.execution.model_name.trim() || undefined },
        ...(webCredentialId ? { credentials: { web_search: webCredentialId } } : {}),
      })
      setEngineResult(result.strategy)
      setSelectedProviders(current => {
        const stillSelected = result.strategy.provider_plans.find(plan => plan.provider_key === providerKey)?.status === 'selected'
        return stillSelected ? [...new Set([...current, providerKey])] : current.filter(key => key !== providerKey)
      })
    } catch (error) { setEngineError(errMsg(error)) } finally { setRetryingProvider(null) }
  }

  async function createSuggestedMonitors() {
    if (!engineResult || selectedProviders.length === 0 || engineBusy) return
    setEngineBusy('create'); setEngineError(null)
    try {
      const result = await researchDiscoveryApi.materialize(engineResult.id, {
        provider_keys: selectedProviders,
        ...(webCredentialId ? { credentials: { web_search: webCredentialId } } : {}),
      })
      setMaterializedResult(result)
      setDraft(current => ({ ...current, query_strategy_id: result.query_strategy_id }))
    } catch (error) { setEngineError(errMsg(error)) } finally { setEngineBusy(null) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
            <DialogHeader>
              <DialogTitle>Set up initial literature intake</DialogTitle>
              <DialogDescription>
                Assess the research definition, evaluate provider-specific queries, then confirm the selected strategy and configure the one-time historical import.
              </DialogDescription>
            </DialogHeader>

            <nav aria-label="Setup steps" className="my-3 flex flex-wrap items-center gap-1.5">
              {SETUP_STEPS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  aria-current={step === index ? 'step' : undefined}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${step === index ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground hover:border-primary hover:text-foreground'}`}
                  onClick={() => setStep(index)}
                >
                  <span className={`flex size-4 items-center justify-center rounded-full text-[10px] ${stepTicked[index] ? 'bg-success text-success-foreground' : 'bg-muted'}`}>
                    {stepTicked[index] ? <Check className="size-3" /> : index + 1}
                  </span>
                  {label}
                </button>
              ))}
            </nav>

            <div className="space-y-4">
              {step === 0 && <section className="space-y-3 rounded-md border border-border bg-muted/10 p-4">
                <div>
                  <h3 className="text-sm font-semibold">1. Refine the research question</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Assess answerability and FINER quality before spending the intake budget. Starting requires a passing question: reassess with your answers or adopt a suggested rewrite.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(10rem,1fr)_minmax(12rem,1fr)]">
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Candidate question</span><Input value={draft.research_question} onChange={event => { setDraft(current => ({ ...current, research_question: event.target.value, question_refine_skipped: true, research_context_version_id: '', query_strategy_id: '' })); setRefinement(null); setRefinementHistory([]); setClarifyingAnswers({}); setEngineResult(null); setMaterializedResult(null) }} /></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Report depth</span><Select options={[{ value: 'quick', label: 'Quick brief' }, { value: 'full', label: 'Full report' }]} value={draft.report_depth} onChange={value => setDraft(current => ({ ...current, report_depth: value as ResearchSetupDraft['report_depth'] }))} ariaLabel="Report depth" /></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Assessment provider</span><Select options={[{ value: '', label: selectableProviders.length ? 'Select provider' : 'No structured-output provider available' }, ...selectableProviders.map(provider => ({ value: provider.id, label: `${provider.name}${provider.is_default ? ' (default)' : ''}` }))]} value={draft.execution.model_provider_id} onChange={value => setDraft(current => ({ ...current, execution: { model_provider_id: value, model_name: selectableProviders.find(provider => provider.id === value)?.default_model ?? '' } }))} ariaLabel="Assessment provider" /></label>
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" onClick={() => void refineQuestion()} disabled={refining || !draft.research_question.trim() || !draft.execution.model_provider_id || refinementHistory.length >= 4}>{refining ? 'Assessing…' : refinement ? 'Reassess with answers' : 'Assess question'}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={editQuestion}><Edit2 className="size-3.5" />Edit project focus</Button>
                  {draft.question_refine_skipped && <Badge variant="warning">Refinement not passed</Badge>}
                </div>
                {refineError && <p className="text-sm text-destructive">{refineError}</p>}
                {refinement && (
                  <div className="space-y-3 rounded-md border border-border bg-background p-3">
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <FinerRadar scores={refinement.assessment.finer} />
                      <div className="flex flex-1 flex-wrap items-center gap-2">
                        <Badge variant={refinement.assessment.answerable ? 'success' : 'destructive'}>{refinement.assessment.answerable ? 'Answerable' : 'Not yet answerable'}</Badge>
                        {Object.entries(refinement.assessment.finer).map(([key, score]) => <span key={key} className="rounded bg-muted px-2 py-1 capitalize">{key} {score}/5</span>)}
                      </div>
                    </div>
                    {refinement.assessment.issues.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{refinement.assessment.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
                    <div className="space-y-2">
                      <p className="text-xs font-medium">Suggested questions</p>
                      {refinement.suggested_questions.map(question => {
                        const adopted = draft.research_question === question
                        return (
                          <button key={question} type="button" aria-pressed={adopted} className={`flex w-full items-start gap-2 rounded border px-3 py-2 text-left text-xs ${adopted ? 'border-primary bg-primary/5' : 'border-border hover:border-primary'}`} onClick={() => adoptQuestion(question)}>
                            <Check className={`mt-0.5 size-3.5 shrink-0 ${adopted ? 'text-primary' : 'invisible'}`} />
                            <span>{question}</span>
                          </button>
                        )
                      })}
                    </div>
                    {(refinement.scope.in.length > 0 || refinement.scope.out.length > 0 || refinement.sub_questions.length > 0) && (
                      <div className="grid gap-2 rounded border border-border bg-muted/20 p-3 text-xs md:grid-cols-3">
                        <div><p className="font-medium">Include</p><p className="mt-1 text-muted-foreground">{refinement.scope.in.join(' · ') || 'No additional inclusion boundary'}</p></div>
                        <div><p className="font-medium">Exclude</p><p className="mt-1 text-muted-foreground">{refinement.scope.out.join(' · ') || 'No explicit exclusions'}</p></div>
                        <div><p className="font-medium">Sub-questions</p><p className="mt-1 text-muted-foreground">{refinement.sub_questions.join(' · ') || 'No separate sub-questions'}</p></div>
                      </div>
                    )}
                    {refinement.clarifying_questions.length > 0 && refinementHistory.length < 4 && <div className="space-y-3">
                      {clarifyingQuestionItems(refinement).map((item, index) => {
                        const answer = normalizeClarifyingAnswer(clarifyingAnswers[index])
                        const toggleOption = (option: string) => {
                          const value = normalizeClarifyingAnswer(clarifyingAnswers[index])
                          const selected = value.selected.includes(option)
                            ? value.selected.filter(entry => entry !== option)
                            : item.allow_multiple ? [...value.selected, option] : [option]
                          updateClarifyingAnswer(index, { ...value, selected })
                        }
                        return (
                          <div key={item.question} className="space-y-1.5 text-xs">
                            <p>{item.question}{item.allow_multiple && <span className="ml-1 text-muted-foreground">(select all that apply)</span>}</p>
                            {item.options.length > 0 && <div className="flex flex-wrap gap-1.5">
                              {item.options.map(option => {
                                const selected = answer.selected.includes(option)
                                return <button key={option} type="button" aria-pressed={selected} className={`rounded-full border px-2.5 py-1 ${selected ? 'border-primary bg-primary/10 font-medium' : 'border-border hover:border-primary'}`} onClick={() => toggleOption(option)}>{option}</button>
                              })}
                            </div>}
                            <Input
                              value={answer.other}
                              placeholder={item.options.length ? 'Other — add your own answer' : 'Type your answer'}
                              onChange={event => updateClarifyingAnswer(index, { ...answer, other: event.target.value })}
                            />
                          </div>
                        )
                      })}
                    </div>}
                  </div>
                )}
              </section>}
              {step === 1 && <section className="space-y-3 rounded-md border border-border bg-muted/10 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">2. Evaluate provider queries</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Each provider starts with a recall-oriented query, then independently broadens or narrows it up to two times. The selected query is reused unchanged for import and ongoing monitoring.</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => void discoverSources()} disabled={Boolean(engineBusy) || draft.question_refine_skipped || !draft.research_context_version_id || !draft.execution.model_provider_id}>{engineBusy === 'search' ? 'Evaluating…' : engineResult ? 'Evaluate again' : 'Evaluate search coverage'}</Button>
                </div>
                <label className="block max-w-md space-y-1 text-xs"><span className="text-muted-foreground">Web search credential (optional)</span><Select options={[{ value: '', label: sourceCredentials.length ? 'Academic sources only unless web is available' : 'No managed web credential available' }, ...sourceCredentials.map(credential => ({ value: credential.id, label: credential.name }))]} value={webCredentialId} onChange={setWebCredentialId} ariaLabel="Web search credential" /><span className="block text-muted-foreground">When the planner selects current or general web evidence, this credential is injected only by the trusted fetch layer.</span></label>
                {engineError && <p className="text-sm text-destructive">{engineError}</p>}
                {!engineResult && <div className="rounded-md border border-dashed border-border px-4 py-5 text-center"><Search className="mx-auto size-5 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No query evaluation yet</p><p className="mt-1 text-xs text-muted-foreground">Run evaluation after the question passes reassessment. Preview samples guide query width but are not imported yet.</p></div>}
                {engineResult && <div className="space-y-3">
                  {engineResult.provider_plans.map(plan => {
                    const selectable = plan.status === 'selected' && Boolean(plan.selected_attempt_id)
                    const selected = selectedProviders.includes(plan.provider_key)
                    const selectedAttempt = plan.attempts.find(attempt => attempt.id === plan.selected_attempt_id)
                    return <div key={plan.provider_key} className={`rounded-md border px-3 py-3 ${selected ? 'border-primary bg-primary/5' : 'border-border'}`}>
                      <div className="flex w-full items-center justify-between gap-3">
                        <button type="button" disabled={!selectable} className="flex flex-1 items-center justify-between gap-3 text-left disabled:cursor-default" onClick={() => setSelectedProviders(current => selected ? current.filter(key => key !== plan.provider_key) : [...current, plan.provider_key])}>
                          <span className="font-medium capitalize">{plan.provider_key.replace(/_/g, ' ')}</span>
                          <Badge variant={selected ? 'success' : plan.status === 'failed' ? 'destructive' : plan.status === 'unavailable' ? 'warning' : 'outline'}>{selected ? 'Selected' : plan.status.replace(/_/g, ' ')}</Badge>
                        </button>
                        {(plan.status === 'unavailable' || plan.status === 'selected') && !draft.query_strategy_id && (
                          <Button type="button" size="sm" variant="outline" disabled={retryingProvider !== null || Boolean(engineBusy)} onClick={() => void retryProvider(plan.provider_key)} title={plan.status === 'selected' ? 'Keep adjusting from the selected query' : 'Retry this provider'}>
                            {retryingProvider === plan.provider_key ? 'Retrying…' : plan.status === 'selected' ? 'Retry / iterate' : 'Retry'}
                          </Button>
                        )}
                      </div>
                      {plan.coverage_warning && <p className="mt-2 rounded border border-warning/40 bg-warning/5 px-2 py-1.5 text-xs text-warning">Coverage warning: {plan.coverage_warning}</p>}
                      {selectedAttempt && <div className="mt-2 text-xs">
                        <span className="text-muted-foreground">Selected query</span>
                        <SemanticQueryColumns query={selectedAttempt.semantic_query} />
                      </div>}
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-muted-foreground">View {plan.attempts.length} evaluation attempt{plan.attempts.length === 1 ? '' : 's'}</summary>
                        <div className="mt-2 space-y-1.5">
                        {plan.attempts.map(attempt => <div key={attempt.id} className={`rounded border px-2 py-1.5 text-xs ${attempt.id === plan.selected_attempt_id ? 'border-success/50 bg-success/5' : 'border-border bg-background/40'}`}>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={attempt.id === plan.selected_attempt_id ? 'success' : 'outline'}>{attempt.round > 0 ? `Retry ${attempt.round} · ` : ''}L{attempt.sequence} · {attempt.direction}</Badge>
                            {attempt.id === plan.selected_attempt_id && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success"><Check className="size-3" />Selected</span>}
                          </div>
                          <SemanticQueryColumns query={attempt.semantic_query} />
                          <p className="mt-1 text-muted-foreground">{attempt.observation ? `${attempt.observation.provider_hit_count.toLocaleString()} provider hits · ${Math.round(attempt.observation.relevance_rate * 100)}% preview relevance · ${attempt.decision ?? 'observed'}` : `No observation · ${attempt.error_class ?? 'provider unavailable'}`}</p>
                          {attempt.decision_reason && <p className="mt-1 text-muted-foreground">{attempt.decision_reason}</p>}
                          {attempt.observation?.samples.length ? <p className="mt-1 truncate text-muted-foreground">Samples: {attempt.observation.samples.slice(0, 3).map(sample => sample.title).join(' · ')}</p> : null}
                        </div>)}
                        </div>
                      </details>
                      {selectedAttempt && <p className="mt-2 text-xs text-muted-foreground">Selected fingerprint {selectedAttempt.compiled_query.fingerprint.slice(0, 12)}…</p>}
                    </div>
                  })}
                  <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Provider counts are independent estimates and may overlap · strategy {engineResult.id.slice(0, 8)}</p><Button type="button" size="sm" onClick={() => void createSuggestedMonitors()} disabled={Boolean(engineBusy) || selectedProviders.length === 0 || Boolean(draft.query_strategy_id)}>{engineBusy === 'create' ? 'Creating…' : draft.query_strategy_id ? 'Sources ready' : 'Confirm selected queries'}</Button></div>
                </div>}
                {materializedResult && <div className="space-y-2">{materializedResult.sources.map(source => <div key={source.source_channel_id} className="flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm"><Badge variant="success">Ready</Badge><span className="truncate capitalize">{source.provider_key.replace(/_/g, ' ')} · query {source.query_fingerprint.slice(0, 12)}…</span></div>)}</div>}
                {!materializedResult && draft.query_strategy_id && <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm"><Badge variant="success">Ready</Badge><span>Materialized query strategy {draft.query_strategy_id.slice(0, 8)}</span></div>}
              </section>}

              {step === 2 && <section className="space-y-3 rounded-md border border-border bg-muted/10 p-4">
                <div>
                  <h3 className="text-sm font-semibold">3. Initial literature import</h3>
                  <p className="mt-1 text-xs text-muted-foreground">The date range and item limit apply only to this one-time import that seeds the project corpus. After you approve the initial results, monitors keep scanning on schedule and new matches are screened automatically — without this limit.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">History scope</span><Select options={[{ value: 'bounded_range', label: 'Date range' }, { value: 'all_available', label: 'All available history' }]} value={draft.history_mode} onChange={value => setDraft(current => ({ ...current, history_mode: value as ResearchSetupDraft['history_mode'] }))} ariaLabel="History scope" /></label>
                  {draft.history_mode === 'bounded_range' && <label className="space-y-1 text-xs"><span className="text-muted-foreground">From</span><DatePicker value={draft.from} onChange={value => setDraft(current => ({ ...current, from: value }))} ariaLabel="History from" /></label>}
                  {draft.history_mode === 'bounded_range' && <label className="space-y-1 text-xs"><span className="text-muted-foreground">To</span><DatePicker value={draft.to} onChange={value => setDraft(current => ({ ...current, to: value }))} ariaLabel="History to" /></label>}
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Max items</span><Input type="number" min={1} max={10000} value={draft.max_items} onChange={event => setDraft(current => ({ ...current, max_items: event.target.value }))} /><span className="block text-muted-foreground">Budget for this initial import only, shared across all selected monitors. Ongoing monitoring is not limited by it.</span></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Monitoring field</span><Select options={[{ value: 'submittedDate', label: 'Submission date' }, { value: 'lastUpdatedDate', label: 'Last update date' }]} value={draft.monitoring_field} onChange={value => setDraft(current => ({ ...current, monitoring_field: value as ResearchSetupDraft['monitoring_field'] }))} ariaLabel="Monitoring field" /><span className="block text-muted-foreground">Choose whether scans follow a paper's first submission or its latest revision.</span></label>
                </div>
                <p className="text-xs text-muted-foreground">{historyLabel(draft)} · Up to {draft.max_items} items.</p>
              </section>}

              {step === 3 && <section className="space-y-3 rounded-md border border-border bg-muted/10 p-4">
                <div>
                  <h3 className="text-sm font-semibold">4. Managed research execution</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Auto Research runs through the server-managed Model Provider API. The system creates and maintains the research agent and runtime profile automatically.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Model provider</span><Select options={[{ value: '', label: selectableProviders.length ? 'Select provider' : 'No structured-output provider available' }, ...selectableProviders.map(provider => ({ value: provider.id, label: `${provider.name}${provider.is_default ? ' (default)' : ''}` }))]} value={draft.execution.model_provider_id} onChange={value => setDraft(current => ({ ...current, execution: { model_provider_id: value, model_name: selectableProviders.find(provider => provider.id === value)?.default_model ?? '' } }))} ariaLabel="Model provider" /></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Model (optional)</span><Input value={draft.execution.model_name} onChange={event => setDraft(current => ({ ...current, execution: { ...current.execution, model_name: event.target.value } }))} placeholder="Provider default" /></label>
                </div>
                <p className="text-xs text-muted-foreground">Choose a model that reliably produces strict JSON. Weaker instruction-following models commonly fail screening or synthesis validation.</p>
              </section>}
            </div>

            <DialogFooter>
              <div className="mr-auto flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={step === 0} onClick={() => setStep(current => Math.max(0, current - 1))}>Back</Button>
                <Button type="button" size="sm" variant="outline" disabled={step === SETUP_STEPS.length - 1} onClick={() => { autoPersistDraft(draft); setStep(current => Math.min(SETUP_STEPS.length - 1, current + 1)) }}>Next</Button>
                {draft.question_refine_skipped && <p className="max-w-xs text-left text-xs text-destructive">The question has not passed refinement; discovery and start stay locked until it does.</p>}
              </div>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={!ready || !canAct || busyAction !== null}>
                {busyAction === 'save-initial-intake' ? 'Saving…' : 'Save setup'}
              </Button>
              <Button type="button" onClick={startResearch} disabled={!ready || !canAct || busyAction !== null || draft.question_refine_skipped}>
                {busyAction === 'start-initial-intake' ? 'Starting…' : 'Start initial research'}
              </Button>
            </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
