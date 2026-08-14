import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Search } from 'lucide-react'
import type { ModelProviderOut } from '../../api/client'
import type {
  CustomSourceCredentialDTO,
  ProjectResearchInitialIntakeInput,
  MaterializedResearchStrategy,
  ResearchProviderKey,
  ResearchQueryAttempt,
  ResearchQueryStrategy,
  ResearchSemanticConcept,
} from '../../types/api'
import { projectResearchApi, researchDiscoveryApi, sourcesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
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
  type ResearchSetupDraft,
} from './researchSetupDraft'
import { defaultModelProvider } from '../providers/defaultProvider'
import { errMsg } from '../../lib/utils'

interface ResearchSetupDialogProps {
  projectId?: string
  workflowId?: string | null
  // The Inquiry Thread this search is for — question/hypothesis definition
  // happens entirely on that Thread's own page now; this dialog only ever
  // configures how the search runs against whatever wording is confirmed
  // there.
  threadId: string
  open: boolean
  draft: ResearchSetupDraft
  busyAction: string | null
  modelProviders: ModelProviderOut[]
  canAct: boolean
  onOpenChange: (open: boolean) => void
  // `workflowId` here is this session's *effective* target — when the dialog
  // opened with no Workflow of its own, that's whichever one its own first
  // autosave created (see sessionWorkflowId below), so the caller reuses it
  // too instead of creating yet another draft Workflow for the same session.
  onSave: (config: ProjectResearchInitialIntakeInput, workflowId?: string | null) => Promise<boolean>
  onStart: (config: ProjectResearchInitialIntakeInput, workflowId?: string | null) => void | Promise<void>
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

const structuredOutputProviderTypes = new Set(['openai', 'openai_codex', 'anthropic', 'minimax', 'openrouter', 'deepseek', 'ollama', 'openai_compatible'])
const researchDiscoveryProviders: Array<{ key: ResearchProviderKey; label: string; note: string }> = [
  { key: 'arxiv', label: 'arXiv', note: 'Public academic API' },
  { key: 'openalex', label: 'OpenAlex', note: 'Public academic API' },
  { key: 'semantic_scholar', label: 'Semantic Scholar', note: 'Anonymous access; stricter shared rate limits' },
]

// Steps are freely navigable: an unfinished earlier step never blocks viewing
// a later one — only the specific gated actions (Discover/Start) stay locked.
const SETUP_STEPS = ['Sources', 'Initial import', 'Execution'] as const

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
  workflowId,
  threadId,
  open,
  draft: initialDraft,
  busyAction,
  modelProviders,
  canAct,
  onOpenChange,
  onSave,
  onStart,
}: ResearchSetupDialogProps) {
  const [draft, setDraft] = useState<ResearchSetupDraft>(() => copyDraft(initialDraft))
  // Only relevant when `workflowId` (the prop) is null: the Workflow this
  // session's own first autosave created, reused by every later autosave and
  // by the final Save/Start so one session never creates more than one draft
  // Workflow row. When `workflowId` is supplied, it always wins.
  const [sessionWorkflowId, setSessionWorkflowId] = useState<string | null>(null)
  const effectiveWorkflowId = workflowId ?? sessionWorkflowId
  const sessionScope = workflowId ?? 'new'
  const [engineResult, setEngineResult] = useState<ResearchQueryStrategy | null>(null)
  const [materializedResult, setMaterializedResult] = useState<MaterializedResearchStrategy | null>(null)
  const [selectedProviders, setSelectedProviders] = useState<ResearchProviderKey[]>([])
  const [evaluationProviders, setEvaluationProviders] = useState<ResearchProviderKey[]>(['arxiv', 'openalex'])
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
    // Restore the in-progress session unless the server-side draft changed
    // while the dialog was closed. This deliberately runs only on open: our
    // own actions (creating monitors, saving) refresh the parent draft
    // mid-flight, and a fingerprint change while the dialog is open must
    // never wipe the session — the persist effect below adopts the new
    // fingerprint instead.
    const session = loadResearchSetupSession(projectId, sessionScope)
    if (session && session.base_fingerprint === initialDraftFingerprint) {
      setDraft(copyDraft(session.draft))
      setStep(Number.isInteger(session.step) && session.step! >= 0 && session.step! <= 2 ? session.step! : 0)
      setSessionWorkflowId(session.workflow_id ?? null)
    } else {
      if (session) clearResearchSetupSession(projectId, sessionScope)
      setDraft(copyDraft(initialDraft))
      setStep(0)
      setSessionWorkflowId(null)
    }
    setEngineResult(null)
    setMaterializedResult(null)
    setSelectedProviders([])
    setEvaluationProviders(['arxiv', 'openalex'])
    setEngineError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, sessionScope])

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
    saveResearchSetupSession(projectId, sessionScope, {
      base_fingerprint: initialDraftFingerprint,
      draft,
      step,
      workflow_id: sessionWorkflowId,
    })
  }, [draft, initialDraftFingerprint, open, projectId, sessionScope, sessionWorkflowId, step])

  useEffect(() => {
    if (!open) return
    setEvaluationProviders(current => {
      if (!webCredentialId) return current.filter(provider => provider !== 'web_search')
      return current.includes('web_search') ? current : [...current, 'web_search']
    })
  }, [open, webCredentialId])

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
    const saved = await onSave(serializeResearchSetupDraft(draft), effectiveWorkflowId)
    if (saved) {
      clearResearchSetupSession(projectId, sessionScope)
      onOpenChange(false)
    }
  }

  async function startResearch() {
    if (!ready || !canAct || busyAction !== null || draft.question_refine_skipped) return
    clearResearchSetupSession(projectId, sessionScope)
    onOpenChange(false)
    onStart(serializeResearchSetupDraft(draft), effectiveWorkflowId)
  }

  /**
   * Milestones (Discover, materialize) are durably saved server-side:
   * browser storage alone is too fragile to be the only holder of them.
   * The toast tells the user their progress is now on the server.
   */
  function autoPersistDraft(next: ResearchSetupDraft) {
    if (!canAct) return
    void projectResearchApi.saveInitialIntakeDraft(projectId, {
      ...serializeResearchSetupDraft(next),
      ...(effectiveWorkflowId ? { workflow_id: effectiveWorkflowId } : {}),
    })
      .then((workflow) => {
        // Only the dialog's own session tracking, not the `workflowId` prop:
        // once this session's first autosave creates a Workflow, every later
        // autosave (and the final Save/Start) must land on that same row
        // instead of each creating its own new draft Workflow.
        if (!workflowId) setSessionWorkflowId(workflow.id)
        toast.success('Setup progress saved to the project')
      })
      .catch((error) => toast.error(`Setup progress could not be saved: ${errMsg(error)}`))
  }

  async function discoverSources() {
    if (!draft.research_context_version_id || engineBusy || evaluationProviders.length === 0) return
    setEngineBusy('search'); setEngineError(null)
    try {
      const result = await researchDiscoveryApi.evaluate({
        project_id: projectId,
        research_context_version_id: draft.research_context_version_id,
        providers: evaluationProviders,
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
              <DialogTitle>Set up initial material intake</DialogTitle>
              <DialogDescription>
                Researching: {draft.research_question || 'this Thread’s question'}. Evaluate provider-specific queries, then confirm the selected strategy and configure the one-time historical import.
              </DialogDescription>
            </DialogHeader>

            {draft.question_refine_skipped && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                <p>This question hasn&apos;t passed refinement yet — define and confirm it on the Thread&apos;s Inquiry page first.</p>
                <Button size="sm" variant="outline" asChild><Link to={`/projects/${projectId}/inquiry?thread=${threadId}`}>Refine in Inquiry</Link></Button>
              </div>
            )}

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
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">1. Evaluate provider queries</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Each provider starts with a recall-oriented query, then independently broadens or narrows it up to two times. The selected query is reused unchanged for import and ongoing monitoring.</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => void discoverSources()} disabled={Boolean(engineBusy) || evaluationProviders.length === 0 || draft.question_refine_skipped || !draft.research_context_version_id || !draft.execution.model_provider_id}>{engineBusy === 'search' ? 'Evaluating…' : engineResult ? 'Evaluate again' : 'Evaluate search coverage'}</Button>
                </div>
                <label className="block max-w-md space-y-1 text-xs"><span className="text-muted-foreground">Web search credential (optional)</span><Select options={[{ value: '', label: sourceCredentials.length ? 'Configured source providers only' : 'No managed web credential available' }, ...sourceCredentials.map(credential => ({ value: credential.id, label: credential.name }))]} value={webCredentialId} onChange={setWebCredentialId} ariaLabel="Web search credential" /><span className="block text-muted-foreground">When the planner selects current or general web evidence, this credential is injected only by the trusted fetch layer.</span></label>
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium">Providers to evaluate</legend>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {researchDiscoveryProviders.map(provider => {
                      const checked = evaluationProviders.includes(provider.key)
                      return (
                        <label key={provider.key} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${checked ? 'border-primary bg-primary/5' : 'border-border'}`}>
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={checked}
                            onChange={() => setEvaluationProviders(current => checked
                              ? current.filter(key => key !== provider.key)
                              : [...current, provider.key])}
                          />
                          <span className="min-w-0 text-xs"><span className="block font-medium">{provider.label}</span><span className="block text-muted-foreground">{provider.note}</span></span>
                        </label>
                      )
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">Semantic Scholar is opt-in because anonymous requests share a heavily rate-limited pool. A provider can still be excluded again after evaluation and before queries are confirmed.</p>
                </fieldset>
                {engineError && <p className="text-sm text-destructive">{engineError}</p>}
                {!engineResult && <div className="rounded-md border border-dashed border-border px-4 py-5 text-center"><Search className="mx-auto size-5 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No query evaluation yet</p><p className="mt-1 text-xs text-muted-foreground">Run evaluation after the question passes reassessment. Preview samples guide query width but are not imported yet.</p></div>}
                {engineResult && <div className="space-y-3">
                  {engineResult.provider_plans.map(plan => {
                    const selectable = plan.status === 'selected' && Boolean(plan.selected_attempt_id)
                    const selected = selectedProviders.includes(plan.provider_key)
                    const selectedAttempt = plan.attempts.find(attempt => attempt.id === plan.selected_attempt_id)
                    return <div key={plan.provider_key} className={`rounded-md border px-3 py-3 ${selected ? 'border-primary bg-primary/5' : 'border-border'}`}>
                      <div className="flex w-full items-center justify-between gap-3">
                        <label className={`flex flex-1 items-center justify-between gap-3 text-left ${selectable && !draft.query_strategy_id ? 'cursor-pointer' : 'cursor-default'}`}>
                          <span className="flex items-center gap-2"><input type="checkbox" checked={selected} disabled={!selectable || Boolean(draft.query_strategy_id)} onChange={() => setSelectedProviders(current => selected ? current.filter(key => key !== plan.provider_key) : [...current, plan.provider_key])} /><span className="font-medium capitalize">{plan.provider_key.replace(/_/g, ' ')}</span></span>
                          <Badge variant={selected ? 'success' : plan.status === 'failed' ? 'destructive' : plan.status === 'unavailable' ? 'warning' : 'outline'}>{selected ? 'Selected' : plan.status.replace(/_/g, ' ')}</Badge>
                        </label>
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

              {step === 1 && <section className="space-y-3 rounded-md border border-border bg-muted/10 p-4">
                <div>
                  <h3 className="text-sm font-semibold">2. Initial material import</h3>
                  <p className="mt-1 text-xs text-muted-foreground">The date range and item limit apply only to this one-time import that seeds the project corpus. After you approve the initial results, monitors keep scanning on schedule and new matches are screened automatically — without this limit.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">History scope</span><Select options={[{ value: 'bounded_range', label: 'Date range' }, { value: 'all_available', label: 'All available history' }]} value={draft.history_mode} onChange={value => setDraft(current => ({ ...current, history_mode: value as ResearchSetupDraft['history_mode'] }))} ariaLabel="History scope" /></label>
                  {draft.history_mode === 'bounded_range' && <label className="space-y-1 text-xs"><span className="text-muted-foreground">From</span><DatePicker value={draft.from} onChange={value => setDraft(current => ({ ...current, from: value }))} ariaLabel="History from" /></label>}
                  {draft.history_mode === 'bounded_range' && <label className="space-y-1 text-xs"><span className="text-muted-foreground">To</span><DatePicker value={draft.to} onChange={value => setDraft(current => ({ ...current, to: value }))} ariaLabel="History to" /></label>}
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Max items</span><Input type="number" min={1} max={10000} value={draft.max_items} onChange={event => setDraft(current => ({ ...current, max_items: event.target.value }))} /><span className="block text-muted-foreground">Budget for this initial import only, shared across all selected monitors. Ongoing monitoring is not limited by it.</span></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Monitoring field</span><Select options={[{ value: 'submittedDate', label: 'First published' }, { value: 'lastUpdatedDate', label: 'Last updated' }]} value={draft.monitoring_field} onChange={value => setDraft(current => ({ ...current, monitoring_field: value as ResearchSetupDraft['monitoring_field'] }))} ariaLabel="Monitoring field" /><span className="block text-muted-foreground">Choose whether scans follow an item's first publication or its latest update.</span></label>
                </div>
                <p className="text-xs text-muted-foreground">{historyLabel(draft)} · Up to {draft.max_items} items.</p>
              </section>}

              {step === 2 && <section className="space-y-3 rounded-md border border-border bg-muted/10 p-4">
                <div>
                  <h3 className="text-sm font-semibold">3. Managed research execution</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Auto Research runs through the server-managed Model Provider API. The system creates and maintains the research agent and runtime profile automatically.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Model provider</span><Select options={[{ value: '', label: selectableProviders.length ? 'Select provider' : 'No structured-output provider available' }, ...selectableProviders.map(provider => ({ value: provider.id, label: `${provider.name}${provider.is_default ? ' (default)' : ''}` }))]} value={draft.execution.model_provider_id} onChange={value => setDraft(current => ({ ...current, execution: { model_provider_id: value, model_name: selectableProviders.find(provider => provider.id === value)?.default_model ?? '' } }))} ariaLabel="Model provider" /></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Model (optional)</span><Input value={draft.execution.model_name} onChange={event => setDraft(current => ({ ...current, execution: { ...current.execution, model_name: event.target.value } }))} placeholder="Provider default" /></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">Report depth</span><Select options={[{ value: 'quick', label: 'Quick brief' }, { value: 'full', label: 'Full report' }]} value={draft.report_depth} onChange={value => setDraft(current => ({ ...current, report_depth: value as ResearchSetupDraft['report_depth'] }))} ariaLabel="Report depth" /></label>
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
              <Button type="button" onClick={() => void startResearch()} disabled={!ready || !canAct || busyAction !== null || draft.question_refine_skipped}>
                {busyAction === 'start-initial-intake' ? 'Starting…' : 'Start initial research'}
              </Button>
            </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
