import { useEffect, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
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
import { Badge, StatusBadge } from '../../components/ui/badge'
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

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  runtime_failure: '运行失败',
  adapter_failed: '适配器失败',
  tool_error: '工具错误',
  validation_failure: '验证失败',
  run_validation_failed: '运行验证失败',
  proposal_rejected: '改进被拒绝',
  stable_preference_missed: '稳定偏好遗漏',
  prompt_gap: '提示资产缺口',
  user_repeated_same_correction: '重复修正',
  capability_gap: '能力缺口',
  policy_boundary: '策略边界',
  memory_health: '记忆健康',
  retrieval_gap: '检索缺口',
  review_requested: '请求审核',
}

const SIGNAL_TYPES = Object.entries(SIGNAL_TYPE_LABELS).map(([value, label]) => ({ value, label }))

const SIGNAL_SEVERITIES = ['low', 'medium', 'high', 'critical'].map(value => ({ value, label: value }))
export type DetailTab = 'definition' | 'signals' | 'strategies' | 'decisions' | 'experiences' | 'runs' | 'proposals' | 'validation'
export type TargetDialogMode = 'create' | 'copy' | 'edit'
export type TargetListTab = 'active' | 'archived'

const TARGET_TYPES = ['agent_version', 'capability', 'runtime_skill_binding', 'memory', 'knowledge', 'workflow', 'project_folder', 'system'].map(value => ({ value, label: value }))
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'].map(value => ({ value, label: value }))
const TARGET_STATUSES = ['active', 'paused', 'archived'].map(value => ({ value, label: value }))
const ENABLED_OPTIONS = [
  { value: 'true', label: 'Enabled' },
  { value: 'false', label: 'Disabled' },
]
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

export function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '-'
}

export function shortId(id: string | null | undefined) {
  return id ? `${id.slice(0, 8)}...` : '-'
}

export function displayTargetName(row: { target_name?: string | null; capability_key?: string | null; target_id?: string | null; id?: string | null }) {
  return row.target_name ?? row.capability_key ?? shortId(row.target_id ?? row.id)
}

function displaySignalType(signalType: string) {
  return SIGNAL_TYPE_LABELS[signalType] ?? signalType
}

function jsonText(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // handled below
  }
  throw new Error(`${label} must be a JSON object.`)
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
  const cards = [
    { label: '改进目标', value: summary.active_targets, empty: '暂无改进目标' },
    { label: '触发信号', value: summary.signals_collected, empty: '暂无触发信号' },
    { label: '待审核改进', value: summary.pending_proposals, empty: '暂无待审核改进' },
    { label: '运行记录', value: summary.recent_runs, empty: '暂无运行记录' },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(card => (
        <Card key={card.label} className="mb-0 p-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{card.label}</div>
          <div className="mt-2 text-2xl font-semibold leading-none" style={{ fontFamily: 'var(--font-mono)' }}>{card.value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{card.value === 0 ? card.empty : '当前空间'}</div>
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
  return (
    <Card className="mb-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle className="mb-0">{title}</CardTitle>
        {count !== undefined && (
          <span className="text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>
            {String(count).padStart(2, '0')}
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
              <StatusBadge status={target.enabled ? target.status : 'disabled'} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="secondary">{target.target_type}</Badge>
              <Badge variant={riskVariant(target.risk_level)}>{target.risk_level}</Badge>
              <Badge variant="outline">{target.recent_signal_count} 触发信号</Badge>
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
                编辑
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function EvolutionSignalsList({ signals, loading }: { signals: EvolutionSignal[]; loading?: boolean }) {
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
        title="暂无触发信号。"
        description="这个目标的类型化证据会显示在这里。"
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {signals.map(signal => (
        <div key={signal.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{displaySignalType(signal.signal_type)}</Badge>
            <Badge variant={riskVariant(signal.severity)}>{signal.severity}</Badge>
            <span className="text-sm font-medium text-foreground">{displayTargetName(signal)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{signal.signal_type}</p>
          <p className="mt-2 text-sm text-muted-foreground">{signal.summary ?? 'No summary provided.'}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            证据 {signal.source_type}{signal.source_id ? ` ${shortId(signal.source_id)}` : ''} - {fmt(signal.created_at)}
          </p>
        </div>
      ))}
    </div>
  )
}

export function EvolutionRunsList({ runs }: { runs: EvolutionRunListItem[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="暂无运行记录。"
        description="自进化运行会显示在这里。"
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {runs.map(run => (
        <div key={run.run_id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={run.status} />
              <Badge variant="outline">{run.engine ?? 'unknown engine'}</Badge>
              {run.strategy_key && <Badge variant="secondary">{run.strategy_key}</Badge>}
              <span className="font-mono text-xs text-muted-foreground">{shortId(run.run_id)}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{displayTargetName(run)}</p>
            <p className="text-xs text-muted-foreground">
              创建 {fmt(run.created_at)} - 启动 {fmt(run.started_at)} - artifact {run.artifact_count}
            </p>

          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to={`/runs/${run.run_id}`}>打开运行</Link>
          </Button>
        </div>
      ))}
    </div>
  )
}

export function EvolutionProposalsList({ proposals }: { proposals: EvolutionProposal[] }) {
  if (proposals.length === 0) {
    return (
      <EmptyState
        title="暂无待审核改进。"
        description="通过 proposal 边界创建的改进会显示在这里。"
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {proposals.map(proposal => (
        <div key={proposal.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{proposal.proposal_type}</Badge>
            <StatusBadge status={proposal.status} />
            <Link to={`/proposals/${proposal.id}`} className="text-sm font-medium text-accent-foreground hover:underline">
              {displayTargetName(proposal)}
            </Link>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{proposal.summary ?? '暂无摘要。'}</p>
          <p className="mt-1 text-xs text-muted-foreground">创建 {fmt(proposal.created_at)}</p>
        </div>
      ))}
    </div>
  )
}

export function EvolutionStrategiesList({ strategies }: { strategies: EvolutionStrategy[] }) {
  if (strategies.length === 0) {
    return (
      <EmptyState
        title="暂无可用策略。"
        description="内置或空间级 EvolutionStrategy 会显示在这里。"
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {strategies.map(strategy => (
        <div key={strategy.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{strategy.category}</Badge>
            <Badge variant={riskVariant(strategy.risk_level)}>{strategy.risk_level}</Badge>
            <StatusBadge status={strategy.status} />
            <span className="text-sm font-medium text-foreground">{strategy.name}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{strategy.strategy_key}</p>
          <p className="mt-2 text-sm text-muted-foreground">{strategy.description ?? '暂无描述。'}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline">{strategy.target_type}</Badge>
            <Badge variant="outline">confidence {strategy.confidence_score.toFixed(2)}</Badge>
            <Badge variant="outline">success {strategy.success_count}</Badge>
            <Badge variant="outline">failure {strategy.failure_count}</Badge>
          </div>
        </div>
      ))}
    </div>
  )
}

export function EvolutionSelectorDecisionsList({ decisions }: { decisions: EvolutionSelectorDecision[] }) {
  if (decisions.length === 0) {
    return (
      <EmptyState
        title="暂无选择记录。"
        description="EvolutionSelector 选择策略后的审计记录会显示在这里。"
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
          <p className="mt-2 text-sm text-muted-foreground">{decision.decision_reason ?? '暂无选择理由。'}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            候选 {decision.candidate_strategy_ids.length} - 证据 {decision.input_signal_ids.length} - {fmt(decision.created_at)}
          </p>
          {decision.run_id && (
            <Link to={`/runs/${decision.run_id}`} className="mt-1 inline-block text-xs text-accent-foreground hover:underline">
              运行记录 {shortId(decision.run_id)}
            </Link>
          )}
        </div>
      ))}
    </div>
  )
}

export function EvolutionExperiencesList({ experiences }: { experiences: EvolutionExperience[] }) {
  if (experiences.length === 0) {
    return (
      <EmptyState
        title="暂无验证经验。"
        description="EvolutionSolidifier 固化后的验证经验会显示在这里。"
      />
    )
  }
  return (
    <div className="divide-y divide-border">
      {experiences.map(experience => (
        <div key={experience.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={experience.outcome_status} />
            <Badge variant="secondary">{experience.strategy_key ?? 'unknown_strategy'}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{experience.experience_key}</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{experience.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            confidence {experience.confidence_score.toFixed(2)} - 证据 {experience.trigger_signals.length} - {fmt(experience.created_at)}
          </p>
        </div>
      ))}
    </div>
  )
}

export function EvolutionValidationPanel({ results }: { results: EvolutionValidationResult[] }) {
  if (results.length === 0) {
    return (
      <EmptyState
        title="No validation configured for this target."
        description="Configured evaluator results appear here."
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
              <StatusBadge status={result.status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground" style={{ fontFamily: 'var(--font-mono)' }}>{result.metric_id}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              window {result.window ?? 'all'} - sample {result.sample_size}
              {result.numerator_count !== null && result.denominator_count !== null
                ? ` - ${result.numerator_count}/${result.denominator_count}`
                : ''}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-sm" style={{ fontFamily: 'var(--font-mono)' }}>
              {result.value === null || result.value === undefined ? 'No data yet' : String(result.value)}
            </p>
            <p className="text-xs text-muted-foreground">{fmt(result.updated_at)}</p>
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
    setTargetName(mode === 'copy' && nextName ? `${nextName} copy` : nextName)
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
      const enginePolicy = parseJsonObject(enginePolicyJson, 'Engine policy')
      const validation = parseJsonObject(validationJson, 'Validation')
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
          <DialogTitle>{isCopy ? '复制改进目标' : isEdit ? '编辑改进目标' : '新建改进目标'}</DialogTitle>
          <DialogDescription>
            配置自进化可以审计的目标、风险级别和验证策略。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={targetName} onChange={event => setTargetName(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>目标类型</Label>
              <Select value={targetType} onChange={setTargetType} options={TARGET_TYPES} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>能力 key</Label>
              <Input value={capabilityKey} onChange={event => setCapabilityKey(event.target.value)} />
            </div>
            <p className="self-end rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">对象引用由已选择的能力或服务端上下文绑定，不在普通表单中粘贴内部标识符。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>风险级别</Label>
              <Select value={riskLevel} onChange={setRiskLevel} options={RISK_LEVELS} />
            </div>
            <div className="space-y-1.5">
              <Label>状态</Label>
              <Select value={status} onChange={setStatus} options={TARGET_STATUSES} />
            </div>
            <div className="space-y-1.5">
              <Label>启用</Label>
              <Select value={enabled} onChange={setEnabled} options={ENABLED_OPTIONS} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>目的</Label>
            <Textarea value={purpose} onChange={event => setPurpose(event.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label>约束</Label>
            <Textarea value={constraints} onChange={event => setConstraints(event.target.value)} rows={5} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label>策略边界 JSON</Label>
              <Textarea value={enginePolicyJson} onChange={event => setEnginePolicyJson(event.target.value)} rows={9} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label>验证 JSON</Label>
              <Textarea value={validationJson} onChange={event => setValidationJson(event.target.value)} rows={9} className="font-mono text-xs" />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {isEdit ? '保存目标' : '创建目标'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TargetDefinition({ target }: { target: EvolutionTarget }) {
  const enginePolicy = target.engine_policy_json ?? {}
  const maxStrategyRisk = typeof enginePolicy.max_strategy_risk === 'string' ? enginePolicy.max_strategy_risk : target.risk_level
  const agentId = typeof target.metadata_json.agent_id === 'string' ? target.metadata_json.agent_id : null
  const rows = [
    ['范围', target.scope ?? '-'],
    ['类型', target.target_type],
    ['引用', target.target_ref_id ?? '-'],
    ['能力', target.capability_key ?? '-'],
    ['当前版本', target.current_version ?? target.current_version_id ?? '-'],
    ['agent_id', agentId ?? '-'],
    ['最近运行', fmt(target.last_run_at)],
  ]
  return (
    <div className="space-y-4">
      {target.purpose && <p className="text-sm text-muted-foreground">{target.purpose}</p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">选择的策略</div>
          <div className="mt-1 text-sm text-foreground" style={{ fontFamily: 'var(--font-mono)' }}>EvolutionSelector</div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">风险级别</div>
          <div className="mt-1 text-sm text-foreground">{maxStrategyRisk}</div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">证据</div>
          <div className="mt-1 text-sm text-foreground">目标 metadata + 触发信号</div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">输出</div>
          <div className="mt-1 text-sm text-foreground">待审核 plan artifact</div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-md border border-border p-3">
            <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
            <div className="mt-1 break-words text-sm text-foreground" style={{ fontFamily: label === '引用' || label === '能力' || label === 'agent_id' ? 'var(--font-mono)' : undefined }}>
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
  const [signalType, setSignalType] = useState(SIGNAL_TYPES[0].value)
  const [severity, setSeverity] = useState('medium')
  const [summary, setSummary] = useState('')

  useEffect(() => {
    if (!open) {
      setSignalType(SIGNAL_TYPES[0].value)
      setSeverity('medium')
      setSummary('')
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>记录触发信号</DialogTitle>
          <DialogDescription>
            触发信号是目标的类型化证据，不是自动写入或自动应用。
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
            <Label>改进目标</Label>
            <Input value={target ? displayTargetName(target) : ''} disabled />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>证据类型</Label>
              <Select value={signalType} onChange={setSignalType} options={SIGNAL_TYPES} />
            </div>
            <div className="space-y-1.5">
              <Label>严重性</Label>
              <Select value={severity} onChange={setSeverity} options={SIGNAL_SEVERITIES} />
            </div>
          </div>
          <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">手动信号由当前目标和提交人提供来源上下文；自动采集的信号由服务端附加不可编辑的来源引用。</p>
          <div className="space-y-1.5">
            <Label>摘要</Label>
            <Textarea value={summary} onChange={event => setSummary(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !target}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              保存信号
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
