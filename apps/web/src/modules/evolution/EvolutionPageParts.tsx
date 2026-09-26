import { useEffect, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useAppTranslation, type Locale } from '../../i18n'
import { errMsg } from '../../lib/utils'
import type {
  EvolutionExperience,
  EvolutionProposal,
  EvolutionRunListItem,
  EvolutionSelectorDecision,
  EvolutionSignal,
  EvolutionStrategy,
  EvolutionSummaryOut,
  EvolutionTarget,
  EvolutionTargetCreateBody,
  EvolutionTargetUpdateBody,
  EvolutionValidationResult,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { EvolutionStatusBadge } from './EvolutionStatusBadge'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { Skeleton } from '../../components/ui/skeleton'
import { Textarea } from '../../components/ui/textarea'

export const EMPTY_SUMMARY: EvolutionSummaryOut = {
  active_targets: 0,
  signals_collected: 0,
  pending_proposals: 0,
  recent_runs: 0,
}

const SIGNAL_TYPE_VALUES = [
  'runtime_failure', 'adapter_failed', 'tool_error', 'validation_failure',
  'run_validation_failed', 'proposal_rejected', 'stable_preference_missed',
  'prompt_gap', 'user_repeated_same_correction', 'capability_gap',
  'policy_boundary', 'memory_health', 'retrieval_gap', 'review_requested',
]

const RISK_LEVEL_VALUES = ['low', 'medium', 'high', 'critical']
export type DetailTab = 'definition' | 'signals' | 'strategies' | 'decisions' | 'experiences' | 'runs' | 'proposals' | 'validation'
export type TargetDialogMode = 'create' | 'copy' | 'edit'
export type TargetListTab = 'active' | 'archived'

const TARGET_TYPE_VALUES = ['agent_version', 'capability', 'runtime_skill_binding', 'memory', 'knowledge', 'workflow', 'project_folder', 'system']
const TARGET_STATUS_VALUES = ['active', 'paused', 'archived']
const DEFAULT_ENGINE_POLICY = {
  max_strategy_risk: 'medium',
  allow_direct_apply: false,
  allowed_strategy_categories: ['repair', 'optimize', 'maintain', 'harden', 'review', 'innovate'],
}
const DEFAULT_VALIDATION = {
  window: '14d',
  metrics: [{
    id: 'target_signal_count',
    label: 'Target signal count',
    evaluator: 'count_signals',
    source: 'signals',
    signal_type: 'run_validation_failed',
    goal: { direction: 'decrease', threshold: 0 },
  }],
}

export function fmt(dt: string | null | undefined, locale: Locale) {
  return dt ? new Date(dt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') : '-'
}

function formatCount(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale).format(value)
}

export function shortId(id: string | null | undefined) {
  return id ? `${id.slice(0, 8)}...` : '-'
}

export function displayTargetName(row: { target_name?: string | null; capability_key?: string | null; target_id?: string | null; id?: string | null }) {
  return row.target_name ?? row.capability_key ?? shortId(row.target_id ?? row.id)
}

function displaySignalType(signalType: string, t: ReturnType<typeof useAppTranslation>['t']) {
  return SIGNAL_TYPE_VALUES.includes(signalType)
    ? t('evolution.signal_type.' + signalType)
    : signalType
}

function jsonText(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseJsonObject(text: string, errorMessage: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // handled below
  }
  throw new Error(errorMessage)
}

function stringListFromText(text: string) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

export function riskVariant(risk: string): 'default' | 'secondary' | 'muted' | 'destructive' {
  if (risk === 'critical') return 'destructive'
  if (risk === 'high') return 'default'
  if (risk === 'medium') return 'secondary'
  return 'muted'
}

export function OverviewCards({ summary }: { summary: EvolutionSummaryOut }) {
  const { t, locale } = useAppTranslation()
  const cards = [
    { label: t('evolution.targets'), value: summary.active_targets, empty: t('evolution.no_targets') },
    { label: t('evolution.signals'), value: summary.signals_collected, empty: t('evolution.no_signals') },
    { label: t('evolution.pending_proposals'), value: summary.pending_proposals, empty: t('evolution.no_pending_proposals') },
    { label: t('evolution.runs'), value: summary.recent_runs, empty: t('evolution.no_runs') },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(card => (
        <Card key={card.label} className="mb-0 p-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{card.label}</div>
          <div className="mt-2 text-2xl font-semibold leading-none" style={{ fontFamily: 'var(--font-mono)' }}>{formatCount(card.value, locale)}</div>
          <div className="mt-1 text-xs text-muted-foreground">{card.value === 0 ? card.empty : t('evolution.current_space_short')}</div>
        </Card>
      ))}
    </div>
  )
}
export function SectionCard({ title, count, children }: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  const { locale } = useAppTranslation()
  return (
    <Card className="mb-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle className="mb-0">{title}</CardTitle>
        {count !== undefined && (
          <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
            {new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(count)}
          </span>
        )}
      </div>
      {children}
    </Card>
  )
}

export function TargetList({
  targets,
  selectedTargetId,
  onSelect,
  onConfigure,
  emptyTitle = 'No targets.',
  emptyDescription = 'Registered improvement targets appear here.',
}: {
  targets: EvolutionTarget[]
  selectedTargetId: string | null
  onSelect: (targetId: string) => void
  onConfigure: (target: EvolutionTarget) => void
  emptyTitle?: string
  emptyDescription?: string
}) {
  const { t, locale } = useAppTranslation()
  if (targets.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
      />
    )
  }
  return (
    <div className="space-y-2">
      {targets.map(target => {
        const selected = selectedTargetId === target.id
        return (
          <button
            key={target.id}
            type="button"
            onClick={() => onSelect(target.id)}
            aria-pressed={selected}
            className={[
              'w-full rounded-md border p-3 text-left transition-colors',
              selected ? 'border-primary bg-accent/50' : 'border-border hover:bg-accent/40',
            ].join(' ')}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate text-sm font-medium text-foreground">{target.target_name ?? target.capability_key ?? shortId(target.id)}</span>
              <EvolutionStatusBadge status={target.enabled ? target.status : 'disabled'} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="secondary">{t('evolution.target_type.' + target.target_type, { defaultValue: target.target_type })}</Badge>
              <Badge variant={riskVariant(target.risk_level)}>{t('evolution.risk.' + target.risk_level, { defaultValue: target.risk_level })}</Badge>
              <Badge variant="outline">{t('evolution.signal_count', { count: formatCount(target.recent_signal_count, locale) })}</Badge>
            </div>
            <p className="mt-2 truncate text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
              {target.capability_key ?? target.target_ref_id ?? target.id}
            </p>
            <div className="mt-3 flex justify-end">
              <span
                role="button"
                tabIndex={0}
                onClick={event => {
                  event.stopPropagation()
                  onConfigure(target)
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    onConfigure(target)
                  }
                }}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t('evolution.edit')}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function EvolutionSignalsList({ signals, loading }: { signals: EvolutionSignal[]; loading?: boolean }) {
  const { t, locale } = useAppTranslation()
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  if (signals.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_signals_title')}
        description={t('evolution.no_signals_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {signals.map(signal => (
        <div key={signal.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{displaySignalType(signal.signal_type, t)}</Badge>
            <Badge variant={riskVariant(signal.severity)}>{t('evolution.risk.' + signal.severity, { defaultValue: signal.severity })}</Badge>
            <span className="text-sm font-medium text-foreground">{displayTargetName(signal)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{signal.signal_type}</p>
          <p className="mt-2 text-sm text-muted-foreground">{signal.summary ?? t('evolution.no_summary')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('evolution.evidence_source', { source: signal.source_type })}{signal.source_id ? ' ' + shortId(signal.source_id) : ''} - {fmt(signal.created_at, locale)}
          </p>
        </div>
      ))}
    </div>
  )
}

export function EvolutionRunsList({ runs }: { runs: EvolutionRunListItem[] }) {
  const { t, locale } = useAppTranslation()
  if (runs.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_runs_title')}
        description={t('evolution.no_runs_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {runs.map(run => (
        <div key={run.run_id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <EvolutionStatusBadge status={run.status} />
              <Badge variant="outline">{run.engine ?? t('evolution.unknown_engine')}</Badge>
              {run.strategy_key && <Badge variant="secondary">{run.strategy_key}</Badge>}
              <span className="font-mono text-xs text-muted-foreground">{shortId(run.run_id)}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{displayTargetName(run)}</p>
            <p className="text-xs text-muted-foreground">
              {t('evolution.run_timing', { created: fmt(run.created_at, locale), started: fmt(run.started_at, locale), artifacts: formatCount(run.artifact_count, locale) })}
            </p>

          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to={`/runs/${run.run_id}`}>{t('evolution.open_run')}</Link>
          </Button>
        </div>
      ))}
    </div>
  )
}

export function EvolutionProposalsList({ proposals }: { proposals: EvolutionProposal[] }) {
  const { t, locale } = useAppTranslation()
  if (proposals.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_pending_proposals_title')}
        description={t('evolution.no_pending_proposals_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {proposals.map(proposal => (
        <div key={proposal.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{proposal.proposal_type}</Badge>
            <EvolutionStatusBadge status={proposal.status} />
            <Link to={`/proposals/${proposal.id}`} className="text-sm font-medium text-accent-foreground hover:underline">
              {displayTargetName(proposal)}
            </Link>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{proposal.summary ?? t('evolution.no_summary')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('evolution.created_at', { date: fmt(proposal.created_at, locale) })}</p>
        </div>
      ))}
    </div>
  )
}

export function EvolutionStrategiesList({ strategies }: { strategies: EvolutionStrategy[] }) {
  const { t, locale } = useAppTranslation()
  if (strategies.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_strategies_title')}
        description={t('evolution.no_strategies_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {strategies.map(strategy => (
        <div key={strategy.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{strategy.category}</Badge>
            <Badge variant={riskVariant(strategy.risk_level)}>{t('evolution.risk.' + strategy.risk_level, { defaultValue: strategy.risk_level })}</Badge>
            <EvolutionStatusBadge status={strategy.status} />
            <span className="text-sm font-medium text-foreground">{strategy.name}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{strategy.strategy_key}</p>
          <p className="mt-2 text-sm text-muted-foreground">{strategy.description ?? t('evolution.no_description')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline">{t('evolution.target_type.' + strategy.target_type, { defaultValue: strategy.target_type })}</Badge>
            <Badge variant="outline">{t('evolution.confidence_value', { value: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(strategy.confidence_score) })}</Badge>
            <Badge variant="outline">{t('evolution.success_value', { count: formatCount(strategy.success_count, locale) })}</Badge>
            <Badge variant="outline">{t('evolution.failure_value', { count: formatCount(strategy.failure_count, locale) })}</Badge>
          </div>
        </div>
      ))}
    </div>
  )
}

export function EvolutionSelectorDecisionsList({ decisions }: { decisions: EvolutionSelectorDecision[] }) {
  const { t, locale } = useAppTranslation()
  if (decisions.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_decisions_title')}
        description={t('evolution.no_decisions_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {decisions.map(decision => (
        <div key={decision.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{decision.selected_strategy_key ?? 'no_strategy'}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{shortId(decision.id)}</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{decision.decision_reason ?? t('evolution.no_decision_reason')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('evolution.decision_counts', { candidates: formatCount(decision.candidate_strategy_ids.length, locale), evidence: formatCount(decision.input_signal_ids.length, locale), date: fmt(decision.created_at, locale) })}
          </p>
          {decision.run_id && (
            <Link to={`/runs/${decision.run_id}`} className="mt-1 inline-block text-xs text-accent-foreground hover:underline">
              {t('evolution.run_record', { id: shortId(decision.run_id) })}
            </Link>
          )}
        </div>
      ))}
    </div>
  )
}

export function EvolutionExperiencesList({ experiences }: { experiences: EvolutionExperience[] }) {
  const { t, locale } = useAppTranslation()
  if (experiences.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_experiences_title')}
        description={t('evolution.no_experiences_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {experiences.map(experience => (
        <div key={experience.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <EvolutionStatusBadge status={experience.outcome_status} />
            <Badge variant="secondary">{experience.strategy_key ?? 'unknown_strategy'}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{experience.experience_key}</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{experience.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('evolution.experience_summary', { confidence: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(experience.confidence_score), evidence: formatCount(experience.trigger_signals.length, locale), date: fmt(experience.created_at, locale) })}
          </p>
        </div>
      ))}
    </div>
  )
}

export function EvolutionValidationPanel({ results }: { results: EvolutionValidationResult[] }) {
  const { t, locale } = useAppTranslation()
  if (results.length === 0) {
    return (
      <EmptyState
        title={t('evolution.no_validation_title')}
        description={t('evolution.no_validation_description')}
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {results.map(result => (
        <div key={`${result.target_id}-${result.metric_id}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">{result.label}</p>
              <Badge variant="outline">{result.evaluator}</Badge>
              <EvolutionStatusBadge status={result.status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{result.metric_id}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('evolution.validation_window_sample', { window: result.window ?? t('evolution.all'), sample: formatCount(result.sample_size, locale) })}
              {result.numerator_count !== null && result.denominator_count !== null
                ? ` - ${result.numerator_count}/${result.denominator_count}`
                : ''}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-sm" style={{ fontFamily: 'var(--font-mono)' }}>
              {result.value === null || result.value === undefined ? t('evolution.no_data_yet') : typeof result.value === 'number' ? new Intl.NumberFormat(locale).format(result.value) : String(result.value)}
            </p>
            <p className="text-xs text-muted-foreground">{fmt(result.updated_at, locale)}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

export function TargetConfigDialog({
  open,
  mode,
  target,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  mode: TargetDialogMode
  target: EvolutionTarget | null
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (body: EvolutionTargetCreateBody | EvolutionTargetUpdateBody, mode: TargetDialogMode) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const isEdit = mode === 'edit'
  const isCopy = mode === 'copy'
  const [targetName, setTargetName] = useState('')
  const [targetType, setTargetType] = useState('agent_version')
  const [targetRefType, setTargetRefType] = useState('capability')
  const [targetRefId, setTargetRefId] = useState('')
  const [capabilityKey, setCapabilityKey] = useState('')
  const [riskLevel, setRiskLevel] = useState('medium')
  const [status, setStatus] = useState('active')
  const [enabled, setEnabled] = useState('true')
  const [purpose, setPurpose] = useState('')
  const [constraints, setConstraints] = useState('')
  const [enginePolicyJson, setEnginePolicyJson] = useState(jsonText(DEFAULT_ENGINE_POLICY))
  const [validationJson, setValidationJson] = useState(jsonText(DEFAULT_VALIDATION))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const meta = target?.metadata_json ?? {}
    const nextName = target ? (target.target_name || '') : ''
    setTargetName(mode === 'copy' && nextName ? t('evolution.copy_name', { name: nextName }) : nextName)
    setTargetType(target?.target_type ?? 'agent_version')
    setTargetRefType(target?.target_ref_type ?? 'capability')
    setTargetRefId(target?.target_ref_id ?? '')
    setCapabilityKey(target?.capability_key ?? '')
    setRiskLevel(target?.risk_level ?? 'medium')
    setStatus(isCopy ? 'active' : target?.status ?? 'active')
    setEnabled(String(isCopy ? true : target?.enabled ?? true))
    setPurpose(typeof meta.purpose === 'string' ? meta.purpose : '')
    setConstraints(Array.isArray(meta.constraints) ? meta.constraints.filter(item => typeof item === 'string').join('\n') : '')
    setEnginePolicyJson(jsonText(target?.engine_policy_json && Object.keys(target.engine_policy_json).length > 0 ? target.engine_policy_json : DEFAULT_ENGINE_POLICY))
    setValidationJson(jsonText(meta.validation ?? DEFAULT_VALIDATION))
    setError(null)
  }, [mode, open, target])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      const enginePolicy = parseJsonObject(enginePolicyJson, t('evolution.engine_policy_json_invalid'))
      const validation = parseJsonObject(validationJson, t('evolution.validation_json_invalid'))
      const metadata: Record<string, unknown> = { ...(target?.metadata_json ?? {}) }
      metadata.validation = validation
      if (isCopy) {
        metadata.origin = {
          type: 'clone',
          source_target_id: target?.id ?? null,
        }
      }
      const constraintRows = stringListFromText(constraints)
      if (constraintRows.length > 0) metadata.constraints = constraintRows
      else delete metadata.constraints
      if (isEdit) {
        await onSubmit({
          target_type: targetType,
          target_ref_type: targetRefType.trim() || null,
          target_ref_id: targetRefId.trim() || null,
          capability_key: capabilityKey.trim() || null,
          risk_level: riskLevel,
          enabled: enabled === 'true',
          status,
          target_name: targetName,
          purpose,
          engine_policy_json: enginePolicy,
          metadata_json: metadata,
        }, mode)
      } else {
        await onSubmit({
          target_type: targetType,
          target_ref_type: targetRefType.trim() || null,
          target_ref_id: targetRefId.trim() || null,
          capability_key: capabilityKey.trim() || null,
          risk_level: riskLevel,
          enabled: enabled === 'true',
          status,
          target_name: targetName,
          purpose,
          engine_policy_json: enginePolicy,
          metadata_json: metadata,
        }, mode)
      }
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCopy ? t('evolution.copy_target') : isEdit ? t('evolution.edit_target') : t('evolution.new_target')}</DialogTitle>
          <DialogDescription>
            {t('evolution.target_dialog_description')}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('evolution.name')}</Label>
              <Input value={targetName} onChange={event => setTargetName(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('evolution.target_type_label')}</Label>
              <Select value={targetType} onChange={setTargetType} options={TARGET_TYPE_VALUES.map(value => ({ value, label: t('evolution.target_type.' + value) }))} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('evolution.capability_key')}</Label>
              <Input value={capabilityKey} onChange={event => setCapabilityKey(event.target.value)} />
            </div>
            <p className="self-end rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{t('evolution.object_reference_hint')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t('evolution.risk_level')}</Label>
              <Select value={riskLevel} onChange={setRiskLevel} options={RISK_LEVEL_VALUES.map(value => ({ value, label: t('evolution.risk.' + value) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('evolution.status_label')}</Label>
              <Select value={status} onChange={setStatus} options={TARGET_STATUS_VALUES.map(value => ({ value, label: t('evolution.status.' + value) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('evolution.enabled_label')}</Label>
              <Select value={enabled} onChange={setEnabled} options={[{ value: 'true', label: t('evolution.enabled') }, { value: 'false', label: t('evolution.disabled') }]} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('evolution.purpose')}</Label>
            <Textarea value={purpose} onChange={event => setPurpose(event.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('evolution.constraints')}</Label>
            <Textarea value={constraints} onChange={event => setConstraints(event.target.value)} rows={5} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('evolution.engine_policy_json')}</Label>
              <Textarea value={enginePolicyJson} onChange={event => setEnginePolicyJson(event.target.value)} rows={9} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('evolution.validation_json')}</Label>
              <Textarea value={validationJson} onChange={event => setValidationJson(event.target.value)} rows={9} className="font-mono text-xs" />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('evolution.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {isEdit ? t('evolution.save_target') : t('evolution.create_target')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TargetDefinition({ target }: { target: EvolutionTarget }) {
  const { t, locale } = useAppTranslation()
  const enginePolicy = target.engine_policy_json ?? {}
  const maxStrategyRisk = typeof enginePolicy.max_strategy_risk === 'string' ? enginePolicy.max_strategy_risk : target.risk_level
  const agentId = typeof target.metadata_json.agent_id === 'string' ? target.metadata_json.agent_id : null
  const rows = [
    { label: t('evolution.scope'), value: target.scope ?? '-', mono: false },
    { label: t('evolution.type'), value: t('evolution.target_type.' + target.target_type, { defaultValue: target.target_type }), mono: false },
    { label: t('evolution.reference'), value: target.target_ref_id ?? '-', mono: true },
    { label: t('evolution.capability'), value: target.capability_key ?? '-', mono: true },
    { label: t('evolution.current_version'), value: target.current_version ?? target.current_version_id ?? '-', mono: false },
    { label: 'agent_id', value: agentId ?? '-', mono: true },
    { label: t('evolution.last_run'), value: fmt(target.last_run_at, locale), mono: false },
  ]
  return (
    <div className="space-y-4">
      {target.purpose && <p className="text-sm text-muted-foreground">{target.purpose}</p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('evolution.selected_strategy')}</div>
          <div className="mt-1 text-sm text-foreground" style={{ fontFamily: 'var(--font-mono)' }}>EvolutionSelector</div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('evolution.risk_level')}</div>
          <div className="mt-1 text-sm text-foreground">{t('evolution.risk.' + maxStrategyRisk, { defaultValue: maxStrategyRisk })}</div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('evolution.evidence')}</div>
          <div className="mt-1 text-sm text-foreground">{t('evolution.target_evidence_description')}</div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('evolution.output')}</div>
          <div className="mt-1 text-sm text-foreground">{t('evolution.pending_plan_artifact')}</div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map(({ label, value, mono }) => (
          <div key={label} className="rounded-md border border-border p-3">
            <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
            <div className="mt-1 break-words text-sm text-foreground" style={{ fontFamily: mono ? 'var(--font-mono)' : undefined }}>
              {value}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
          {JSON.stringify(target.engine_policy_json ?? {}, null, 2)}
        </pre>
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
          {JSON.stringify(target.metadata_json ?? {}, null, 2)}
        </pre>
      </div>
    </div>
  )
}

export function SignalDialog({
  open,
  target,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  target: EvolutionTarget | null
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (body: {
    signal_type: string
    source_type: string
    source_id?: string | null
    severity: string
    summary?: string | null
    payload_json: Record<string, unknown>
  }) => void
}) {
  const { t } = useAppTranslation()
  const [signalType, setSignalType] = useState(SIGNAL_TYPE_VALUES[0])
  const [severity, setSeverity] = useState('medium')
  const [summary, setSummary] = useState('')

  useEffect(() => {
    if (!open) {
      setSignalType(SIGNAL_TYPE_VALUES[0])
      setSeverity('medium')
      setSummary('')
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('evolution.record_signal')}</DialogTitle>
          <DialogDescription>
            {t('evolution.signal_dialog_description')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault()
            onSubmit({
              signal_type: signalType,
              source_type: 'manual',
              source_id: null,
              severity,
              summary: summary.trim() || null,
              payload_json: {},
            })
          }}
        >
          <div className="space-y-1.5">
            <Label>{t('evolution.target')}</Label>
            <Input value={target ? displayTargetName(target) : ''} disabled />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('evolution.evidence_type')}</Label>
              <Select value={signalType} onChange={setSignalType} options={SIGNAL_TYPE_VALUES.map(value => ({ value, label: t('evolution.signal_type.' + value) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('evolution.severity')}</Label>
              <Select value={severity} onChange={setSeverity} options={RISK_LEVEL_VALUES.map(value => ({ value, label: t('evolution.risk.' + value) }))} />
            </div>
          </div>
          <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{t('evolution.manual_signal_hint')}</p>
          <div className="space-y-1.5">
            <Label>{t('evolution.summary')}</Label>
            <Textarea value={summary} onChange={event => setSummary(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('evolution.cancel')}
            </Button>
            <Button type="submit" disabled={saving || !target}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t('evolution.save_signal')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
