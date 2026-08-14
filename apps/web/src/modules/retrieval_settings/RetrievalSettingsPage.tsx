import { useCallback, useEffect, useState } from 'react'
import { Database, FileCode2, Search, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { artifactsApi, providersApi, spacesApi, type ModelProviderOut, type ProviderTaskPolicyOut } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { SpaceLink as Link } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import type {
  ContextOpsReviewMode,
  ContextOpsScanMode,
  MemberRole,
  RetrievalCalibrationMechanic,
  RetrievalRankingMechanicState,
  RetrievalRuntimeRankingConfig,
  RetrievalSearchMode,
  RetrievalToolMode,
  SpaceRetrievalSettings,
  Artifact,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Badge } from '../../components/ui/badge'
import ProviderSelector from '../providers/ProviderSelector'
import { promptLibraryPath } from '../prompts/paths'

const SEARCH_MODE_OPTIONS: Array<{ value: RetrievalSearchMode; label: string }> = [
  { value: 'exact', label: 'Exact' },
  { value: 'lexical', label: 'Lexical' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'hybrid_rerank', label: 'Hybrid + rerank' },
]

const RETRIEVAL_TOOL_MODE_OPTIONS: Array<{ value: RetrievalToolMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'manual_tool_only', label: 'Manual tools' },
  { value: 'preflight_search', label: 'Preflight search' },
  { value: 'preflight_brief', label: 'Preflight brief' },
]

const CONTEXT_OPS_REVIEW_MODE_OPTIONS: Array<{ value: ContextOpsReviewMode; label: string }> = [
  { value: 'private_only', label: 'Private only' },
  { value: 'admins', label: 'Owners + admins' },
  { value: 'members', label: 'Space members' },
]

const CONTEXT_OPS_SCAN_MODE_OPTIONS: Array<{ value: ContextOpsScanMode; label: string }> = [
  { value: 'admins', label: 'Owners + admins' },
  { value: 'members', label: 'Space members' },
]

const RANKING_MECHANICS: Array<{ mechanic: RetrievalCalibrationMechanic; label: string }> = [
  { mechanic: 'visible_edge_backlink', label: 'Visible-edge backlink' },
  { mechanic: 'candidate_owned_salience', label: 'Candidate salience' },
  { mechanic: 'richer_dedup', label: 'Richer dedup' },
  { mechanic: 'autocut', label: 'Autocut' },
]

const RANKING_STATE_OPTIONS: Array<{ value: RetrievalRankingMechanicState; label: string }> = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'adopted', label: 'Adopted' },
  { value: 'shipped', label: 'Shipped' },
]

function defaultRankingConfig(): RetrievalRuntimeRankingConfig {
  const mechanic = () => ({
    state: 'disabled' as RetrievalRankingMechanicState,
    calibration_artifact_id: null,
    shipped_at: null,
    eval_gate: { status: 'not_run' as const, metric: null, value: null, threshold: 0, checked_at: null },
  })
  return {
    version: 1,
    eval_gate: { min_primary_metric_delta: 0, required_evidence_artifacts: 1 },
    mechanics: {
      visible_edge_backlink: mechanic(),
      candidate_owned_salience: mechanic(),
      richer_dedup: mechanic(),
      autocut: mechanic(),
      semantic_results_cache: mechanic(),
    },
  }
}

function withRankingConfigDefaults(settings: SpaceRetrievalSettings): SpaceRetrievalSettings {
  return { ...settings, ranking_config: settings.ranking_config ?? defaultRankingConfig() }
}

const RETRIEVAL_TASKS = [
  {
    task: 'retrieval_embedding',
    label: 'Embeddings',
    detail: 'Retrieval-only provider used by hybrid search and query embedding cache.',
    kind: 'embedding',
  },
  {
    task: 'retrieval_rerank',
    label: 'Native reranker',
    detail: 'Retrieval-only provider used when hybrid_rerank runs native rerank.',
    kind: 'rerank',
  },
  {
    task: 'retrieval_query_rewrite',
    label: 'Query rewrite',
    detail: 'Chat provider used before search when query rewrite is enabled.',
    kind: 'chat',
  },
  {
    task: 'retrieval_synthesis',
    label: 'Context Brief synthesis',
    detail: 'Chat provider used to synthesize cited Context Brief answers.',
    kind: 'chat',
  },
] as const

type RetrievalTask = typeof RETRIEVAL_TASKS[number]['task']
type RetrievalTaskKind = typeof RETRIEVAL_TASKS[number]['kind']
type TaskSelection = { provider_id: string; model: string } | null
type TaskSelections = Partial<Record<RetrievalTask, TaskSelection>>
type TaskPolicyMap = Partial<Record<RetrievalTask, ProviderTaskPolicyOut>>

function embeddingProviderFilter(provider: ModelProviderOut): string | null {
  return ['openai', 'openrouter', 'ollama', 'zeroentropy', 'cohere', 'openai_compatible'].includes(provider.provider_type)
    ? null
    : 'no embeddings endpoint'
}

function rerankProviderFilter(provider: ModelProviderOut): string | null {
  return provider.provider_type === 'zeroentropy' || provider.provider_type === 'cohere' ? null : 'no native rerank endpoint'
}

function chatProviderFilter(provider: ModelProviderOut): string | null {
  return ['openai', 'anthropic', 'minimax', 'openrouter', 'deepseek', 'ollama', 'openai_compatible'].includes(provider.provider_type)
    ? null
    : 'not a chat provider'
}

function providerFilterFor(kind: RetrievalTaskKind): ((provider: ModelProviderOut) => string | null) | undefined {
  if (kind === 'embedding') return embeddingProviderFilter
  if (kind === 'rerank') return rerankProviderFilter
  if (kind === 'chat') return chatProviderFilter
  return undefined
}

function defaultModelForTask(kind: RetrievalTaskKind, provider: ModelProviderOut): string | null | undefined {
  if (kind === 'embedding' && provider.provider_type === 'zeroentropy') return 'zembed-1'
  if (kind === 'embedding' && provider.provider_type === 'cohere') return 'embed-v4.0'
  if (kind === 'rerank' && provider.provider_type === 'zeroentropy') return 'zerank-2'
  if (kind === 'rerank' && provider.provider_type === 'cohere') return 'rerank-v4.0-pro'
  return provider.default_model
}

function canManageSpace(role: MemberRole | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

function Toggle({
  checked,
  disabled,
  label,
  detail,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  detail: string
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-muted',
        ].join(' ')}
        aria-pressed={checked}
      >
        <span
          className={[
            'inline-block size-4 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          ].join(' ')}
        />
      </button>
    </div>
  )
}

function TaskPolicyEditor({
  task,
  label,
  detail,
  kind,
  value,
  policy,
  saving,
  readOnly,
  onChange,
  onSave,
}: {
  task: RetrievalTask
  label: string
  detail: string
  kind: RetrievalTaskKind
  value: TaskSelection
  policy: ProviderTaskPolicyOut | undefined
  saving: boolean
  readOnly: boolean
  onChange: (task: RetrievalTask, value: TaskSelection) => void
  onSave: (task: RetrievalTask) => void
}) {
  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-muted-foreground">{detail}</div>
        </div>
        <Badge variant={policy?.enabled ? 'default' : 'muted'}>
          {policy?.enabled ? 'Configured' : 'Space default'}
        </Badge>
      </div>
      <ProviderSelector
        value={value}
        onChange={next => onChange(task, next)}
        emptyLabel="Use space default"
        providerFilter={providerFilterFor(kind)}
        defaultModelForProvider={provider => defaultModelForTask(kind, provider)}
        disabled={readOnly}
      />
      {kind === 'embedding' && (
        <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Database className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The space dimension setting is applied to provider requests when supported and used to
            validate stored vectors. Changing it requeues this space's embeddings.
          </span>
        </div>
      )}
      {kind === 'rerank' && (
        <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Search className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Native rerank uses a provider rerank endpoint. Chat-only providers are kept out of this slot.
          </span>
        </div>
      )}
      {kind === 'chat' && (
        <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Search className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {task === 'retrieval_query_rewrite'
              ? 'Query rewrite uses a normal chat provider plus the registry prompt linked below.'
              : 'Context Brief synthesis uses a normal chat provider and only sees revalidated sources.'}
          </span>
        </div>
      )}
      {!readOnly && (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => onSave(task)}>
            {saving ? 'Saving...' : 'Save model'}
          </Button>
        </div>
      )}
    </div>
  )
}

export default function RetrievalSettingsPage() {
  const { activeSpaceId, activeSpaceName, spaces } = useSpace()
  const activeSpace = spaces.find(s => s.id === activeSpaceId)
  const manageable = canManageSpace(activeSpace?.role)
  const readOnly = !manageable
  const waitingForSpace = Boolean(activeSpaceId && !activeSpace && spaces.length === 0)

  const [settings, setSettings] = useState<SpaceRetrievalSettings | null>(null)
  const [taskPolicies, setTaskPolicies] = useState<TaskPolicyMap>({})
  const [taskSelections, setTaskSelections] = useState<TaskSelections>({})
  const [taskSaving, setTaskSaving] = useState<Partial<Record<RetrievalTask, boolean>>>({})
  const [maxResults, setMaxResults] = useState('50')
  const [embeddingDimensions, setEmbeddingDimensions] = useState('2560')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [calibrationArtifacts, setCalibrationArtifacts] = useState<Artifact[]>([])

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setSettings(null)
      setTaskPolicies({})
      setTaskSelections({})
      return
    }
    setLoading(true)
    try {
      const [next, policies, artifacts] = await Promise.all([
        spacesApi.getRetrievalSettings(activeSpaceId),
        providersApi.taskPolicies().catch(error => {
          toast.error(errMsg(error))
          return []
        }),
        artifactsApi.list({ limit: 200 }).then(page => page.items).catch(() => []),
      ])
      const policyMap = Object.fromEntries(
        RETRIEVAL_TASKS
          .map(({ task }) => [task, policies.find(policy => policy.task === task)] as const)
          .filter((entry): entry is readonly [RetrievalTask, ProviderTaskPolicyOut] => Boolean(entry[1])),
      ) as TaskPolicyMap
      const selections = Object.fromEntries(
        RETRIEVAL_TASKS.map(({ task }) => {
          const entry = policyMap[task]?.chain?.[0]
          return [task, entry ? { provider_id: entry.provider_id, model: entry.model ?? '' } : null]
        }),
      ) as TaskSelections
      setSettings(withRankingConfigDefaults(next))
      setTaskPolicies(policyMap)
      setTaskSelections(selections)
      setMaxResults(String(next.max_results_default))
      setEmbeddingDimensions(String(next.embedding_dimensions))
      setCalibrationArtifacts(artifacts)
    } catch (error) {
      toast.error(errMsg(error))
      setSettings(null)
      setTaskPolicies({})
      setTaskSelections({})
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId])

  useEffect(() => { void load() }, [load])

  function patch<K extends keyof SpaceRetrievalSettings>(key: K, value: SpaceRetrievalSettings[K]) {
    setSettings(current => current ? { ...current, [key]: value } : current)
  }

  function patchRankingConfig(mutator: (config: RetrievalRuntimeRankingConfig) => RetrievalRuntimeRankingConfig) {
    setSettings(current => current ? { ...current, ranking_config: mutator(current.ranking_config) } : current)
  }

  function setRankingGate<K extends keyof RetrievalRuntimeRankingConfig['eval_gate']>(
    key: K,
    value: RetrievalRuntimeRankingConfig['eval_gate'][K],
  ) {
    patchRankingConfig(config => ({
      ...config,
      eval_gate: { ...config.eval_gate, [key]: value },
    }))
  }

  function patchMechanic(
    mechanic: RetrievalCalibrationMechanic,
    patchValue: Partial<RetrievalRuntimeRankingConfig['mechanics'][RetrievalCalibrationMechanic]>,
  ) {
    patchRankingConfig(config => ({
      ...config,
      mechanics: {
        ...config.mechanics,
        [mechanic]: {
          ...config.mechanics[mechanic],
          ...patchValue,
        },
      },
    }))
  }

  function setQueryRewriteEnabled(value: boolean) {
    setSettings(current => current
      ? { ...current, query_rewrite_enabled: value, query_rewrite_default: value ? current.query_rewrite_default : false }
      : current)
  }

  function setTaskSelection(task: RetrievalTask, value: TaskSelection) {
    setTaskSelections(current => ({ ...current, [task]: value }))
  }

  function setSavedTaskPolicy(task: RetrievalTask, policy: ProviderTaskPolicyOut | null) {
    setTaskPolicies(current => {
      const next = { ...current }
      if (policy) next[task] = policy
      else delete next[task]
      return next
    })
    setTaskSelections(current => {
      const entry = policy?.chain?.[0]
      return {
        ...current,
        [task]: entry ? { provider_id: entry.provider_id, model: entry.model ?? '' } : null,
      }
    })
  }

  async function saveTaskPolicy(task: RetrievalTask, run: () => Promise<void>) {
    setTaskSaving(current => ({ ...current, [task]: true }))
    try {
      await run()
      toast.success('Model setting saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setTaskSaving(current => ({ ...current, [task]: false }))
    }
  }

  async function saveTaskModel(task: RetrievalTask) {
    if (!manageable) return
    const value = taskSelections[task] ?? null
    const policy = taskPolicies[task]
    await saveTaskPolicy(task, async () => {
      if (value?.provider_id) {
        const updated = await providersApi.putTaskPolicy(task, {
          enabled: true,
          chain: [{ provider_id: value.provider_id, model: value.model || null }],
        })
        setSavedTaskPolicy(task, updated)
        return
      }

      if (policy) {
        await providersApi.deleteTaskPolicy(task)
      }
      setSavedTaskPolicy(task, null)
    })
  }

  async function save() {
    if (!activeSpaceId || !settings || !manageable) return
    const parsedMax = Number(maxResults)
    const parsedDimensions = Number(embeddingDimensions)
    if (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 50) {
      toast.error('Default results must be between 1 and 50')
      return
    }
    if (!Number.isInteger(parsedDimensions) || parsedDimensions < 64 || parsedDimensions > 4096) {
      toast.error('Embedding dimensions must be between 64 and 4096')
      return
    }
    setSaving(true)
    try {
      const updated = await spacesApi.updateRetrievalSettings(activeSpaceId, {
        default_search_mode: settings.default_search_mode,
        rerank_enabled: settings.rerank_enabled,
        query_rewrite_enabled: settings.query_rewrite_enabled,
        query_rewrite_default: settings.query_rewrite_default,
        use_query_cache: settings.use_query_cache,
        include_trace: settings.include_trace,
        external_egress_enabled: settings.external_egress_enabled,
        retrieval_tool_mode: settings.retrieval_tool_mode,
        context_ops_review_mode: settings.context_ops_review_mode,
        context_ops_scan_mode: settings.context_ops_scan_mode,
        embedding_dimensions: parsedDimensions,
        max_results_default: parsedMax,
        ranking_config: settings.ranking_config,
      })
      setSettings(updated)
      setMaxResults(String(updated.max_results_default))
      setEmbeddingDimensions(String(updated.embedding_dimensions))
      toast.success('Retrieval settings saved')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSaving(false)
    }
  }

  const title = activeSpaceName ?? activeSpace?.name ?? 'Space'

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Search className="size-5 text-accent-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Retrieval Settings</h1>
          <p className="text-sm text-muted-foreground truncate">
            Search defaults for {title}.
          </p>
        </div>
      </div>

      {waitingForSpace ? (
        <Card>
          <CardTitle>Loading space</CardTitle>
          <p className="text-sm text-muted-foreground">Loading space permissions...</p>
        </Card>
      ) : !activeSpaceId ? (
        <Card>
          <CardTitle>Select a space</CardTitle>
          <p className="text-sm text-muted-foreground">Retrieval settings are space-scoped.</p>
        </Card>
      ) : loading || !settings ? (
        <Card>
          <CardTitle>Loading</CardTitle>
          <p className="text-sm text-muted-foreground">Loading retrieval settings...</p>
        </Card>
      ) : (
        <>
          {readOnly && (
            <Card>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="size-3.5" /> Read-only
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                You can view this space's retrieval models and prompt asset references. Only owners or admins can change them.
              </p>
            </Card>
          )}

          <Card>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="size-3.5" /> Search defaults
            </CardTitle>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px_180px]">
              <div className="space-y-1.5">
                <Label>Default mode</Label>
                <Select
                  value={settings.default_search_mode}
                  options={SEARCH_MODE_OPTIONS}
                  disabled={readOnly || saving}
                  onChange={value => patch('default_search_mode', value as RetrievalSearchMode)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Default results</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={maxResults}
                  disabled={readOnly || saving}
                  onChange={event => setMaxResults(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Embedding dimensions</Label>
                <Input
                  type="number"
                  min={64}
                  max={4096}
                  value={embeddingDimensions}
                  disabled={readOnly || saving}
                  onChange={event => setEmbeddingDimensions(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">Cohere embed-v4 supports 1536, 1024, 512, or 256 dimensions.</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="muted">exact</Badge>
              <Badge variant="muted">lexical</Badge>
              <Badge variant="muted">vector</Badge>
              <Badge variant="muted">rerank</Badge>
            </div>
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="size-3.5" /> Ranking mechanics
            </CardTitle>
            <div className="grid gap-3 md:grid-cols-[180px_180px]">
              <div className="space-y-1.5">
                <Label>Minimum eval delta</Label>
                <Input
                  type="number"
                  step="0.001"
                  value={String(settings.ranking_config.eval_gate.min_primary_metric_delta)}
                  disabled={readOnly || saving}
                  onChange={event => setRankingGate('min_primary_metric_delta', Number(event.target.value) || 0)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Evidence artifacts</Label>
                <Input
                  type="number"
                  min={0}
                  max={12}
                  value={String(settings.ranking_config.eval_gate.required_evidence_artifacts)}
                  disabled={readOnly || saving}
                  onChange={event => setRankingGate('required_evidence_artifacts', Math.max(0, Math.min(12, Math.trunc(Number(event.target.value) || 0))))}
                />
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {RANKING_MECHANICS.map(({ mechanic, label }) => {
                const cfg = settings.ranking_config.mechanics[mechanic]
                return (
                  <div key={mechanic} className="rounded-md border border-border p-3">
                    <div className="grid gap-3 lg:grid-cols-[minmax(160px,1fr)_150px_minmax(220px,1.4fr)_minmax(160px,0.8fr)] lg:items-end">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">{label}</div>
                        <div className="truncate text-xs text-muted-foreground">{mechanic}</div>
                      </div>
                      <div className="space-y-1.5">
                        <Label>State</Label>
                        <Select
                          value={cfg.state}
                          options={RANKING_STATE_OPTIONS}
                          disabled={readOnly || saving}
                          onChange={value => patchMechanic(mechanic, { state: value as RetrievalRankingMechanicState })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Calibration evidence</Label>
                        <Select
                          value={cfg.calibration_artifact_id ?? ''}
                          disabled={readOnly || saving}
                          onChange={value => patchMechanic(mechanic, { calibration_artifact_id: value || null })}
                          options={[{ value: '', label: 'No calibration evidence' }, ...calibrationArtifacts.map(artifact => ({ value: artifact.id, label: artifact.title || artifact.artifact_type }))]}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={cfg.eval_gate.status === 'passed' ? 'success' : cfg.eval_gate.status === 'failed' ? 'destructive' : 'muted'}>
                          {cfg.eval_gate.status}
                        </Badge>
                        {cfg.eval_gate.metric && (
                          <Badge variant="outline">{cfg.eval_gate.metric}: {cfg.eval_gate.value ?? '—'}</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-3.5" /> Models
            </CardTitle>
            <div className="space-y-3">
              {RETRIEVAL_TASKS.map(item => (
                <TaskPolicyEditor
                  key={item.task}
                  task={item.task}
                  label={item.label}
                  detail={item.detail}
                  kind={item.kind}
                  value={taskSelections[item.task] ?? null}
                  policy={taskPolicies[item.task]}
                  saving={Boolean(taskSaving[item.task])}
                  readOnly={readOnly}
                  onChange={setTaskSelection}
                  onSave={task => { void saveTaskModel(task) }}
                />
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <Search className="size-3.5" /> Provider stages
            </CardTitle>
            <div className="space-y-3">
              <Toggle
                checked={settings.external_egress_enabled}
                disabled={readOnly || saving}
                label="Allow external egress"
                detail="Allows retrieval embeddings, query rewrite, rerank, and Context Brief synthesis to send visible content to configured providers."
                onChange={value => patch('external_egress_enabled', value)}
              />
              <div className="rounded-md border border-border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">Managed-run retrieval policy</div>
                    <div className="text-xs text-muted-foreground">
                      Controls governed retrieval.search / retrieval.brief access for managed runs under the instructing user's visibility.
                    </div>
                  </div>
                  <Select
                    value={settings.retrieval_tool_mode}
                    options={RETRIEVAL_TOOL_MODE_OPTIONS}
                    disabled={readOnly || saving}
                    onChange={value => patch('retrieval_tool_mode', value as RetrievalToolMode)}
                  />
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">Context Ops review</div>
                    <div className="text-xs text-muted-foreground">
                      Controls who can open Context Ops shared review data and accept explicit space_ops packets. Private packets remain creator-only.
                    </div>
                  </div>
                  <Select
                    value={settings.context_ops_review_mode}
                    options={CONTEXT_OPS_REVIEW_MODE_OPTIONS}
                    disabled={readOnly || saving}
                    onChange={value => patch('context_ops_review_mode', value as ContextOpsReviewMode)}
                  />
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">Context Ops scan initiation</div>
                    <div className="text-xs text-muted-foreground">
                      Controls who can start retrieval diagnostics and maintenance scans. Reindex stays owner/admin-only.
                    </div>
                  </div>
                  <Select
                    value={settings.context_ops_scan_mode}
                    options={CONTEXT_OPS_SCAN_MODE_OPTIONS}
                    disabled={readOnly || saving}
                    onChange={value => patch('context_ops_scan_mode', value as ContextOpsScanMode)}
                  />
                </div>
              </div>
              <Toggle
                checked={settings.rerank_enabled}
                disabled={readOnly || saving}
                label="Enable reranker"
                detail="Allows hybrid_rerank searches to call the retrieval_rerank provider task."
                onChange={value => patch('rerank_enabled', value)}
              />
              <Toggle
                checked={settings.query_rewrite_enabled}
                disabled={readOnly || saving}
                label="Enable query rewrite"
                detail="Allows rewrite-enabled searches to call the retrieval_query_rewrite provider task."
                onChange={setQueryRewriteEnabled}
              />
              <Toggle
                checked={settings.query_rewrite_default}
                disabled={readOnly || saving || !settings.query_rewrite_enabled}
                label="Rewrite by default"
                detail="Runs query rewrite when a search request does not override rewrite."
                onChange={value => patch('query_rewrite_default', value)}
              />
            </div>
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <FileCode2 className="size-3.5" /> Retrieval prompts
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Prompt text, versions, evaluation, and deployment are managed through the centralized registry.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                { key: 'retrieval.query_rewrite', label: 'Query rewrite' },
                { key: 'retrieval.rerank', label: 'Rerank' },
                { key: 'retrieval.synthesis', label: 'Context Brief synthesis' },
              ].map(prompt => (
                <Button key={prompt.key} asChild variant="outline" size="sm" className="justify-start overflow-hidden">
                  <Link to={promptLibraryPath(prompt.key)}>
                    <span className="truncate">{prompt.label}</span>
                  </Link>
                </Button>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle>Execution</CardTitle>
            <div className="space-y-3">
              <Toggle
                checked={settings.use_query_cache}
                disabled={readOnly || saving}
                label="Use query embedding cache"
                detail="Reuses cached query embeddings for hybrid search."
                onChange={value => patch('use_query_cache', value)}
              />
              <Toggle
                checked={settings.include_trace}
                disabled={readOnly || saving}
                label="Include diagnostic trace"
                detail="Returns aggregate arm counts in retrieval responses."
                onChange={value => patch('include_trace', value)}
              />
            </div>
          </Card>

          {!readOnly && (
            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving...' : 'Save retrieval settings'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
