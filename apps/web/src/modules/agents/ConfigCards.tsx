import { Check, X, Inbox, FileOutput, Clock, ShieldCheck } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import {
  inputCards, outputCards, safetySummary, scheduleSummary,
  OUTPUT_MODE_LABEL,
} from './policyMap'

/** Minimal shape shared by AgentVersionOut and AgentTemplateVersionOut. */
export interface VersionLike {
  context_policy_json?: unknown
  memory_policy_json?: unknown
  output_policy_json?: unknown
  tool_policy_json?: unknown
  risk_level?: 'low' | 'medium' | 'high' | 'critical'
  max_run_time_seconds?: number
  schedule_config_json?: unknown
  schedule_defaults_json?: unknown
}

function Row({ enabled, label, detail }: { enabled: boolean; label: string; detail?: string }) {
  return (
    <div className={`flex items-start gap-2.5 py-2 ${enabled ? '' : 'opacity-45'}`}>
      <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${enabled ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'}`}>
        {enabled ? <Check className="size-3" /> : <X className="size-3" />}
      </span>
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  )
}

export function InputsView({ version }: { version: VersionLike }) {
  const cards = inputCards(version)
  const anyEnabled = cards.some(c => c.enabled)
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-sm font-medium"><Inbox className="size-4" /> Inputs</div>
      {!anyEnabled && <p className="text-xs text-muted-foreground">This agent reads no durable inputs (session-only or empty context).</p>}
      <div className="divide-y divide-border">
        {cards.map(c => <Row key={c.key} enabled={c.enabled} label={c.label} detail={c.detail} />)}
      </div>
    </div>
  )
}

export function OutputsView({ version }: { version: VersionLike }) {
  const cards = outputCards(version)
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-sm font-medium"><FileOutput className="size-4" /> Allowed outputs</div>
      <p className="text-xs text-muted-foreground mb-2">This agent can create the following. The model selects which to emit per run; durable changes are proposal-only.</p>
      {cards.length === 0 ? (
        <p className="text-xs text-muted-foreground">No output types are allowed.</p>
      ) : (
        <div className="space-y-2">
          {cards.map(c => (
            <div key={c.key} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
              <span className="text-sm">{c.label}</span>
              <Badge variant={c.alwaysReview || c.mode === 'review' ? 'warning' : c.mode === 'artifact' ? 'secondary' : 'success'}>
                {c.alwaysReview ? 'Always review' : OUTPUT_MODE_LABEL[c.mode]}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ScheduleView({ version }: { version: VersionLike }) {
  const sched = scheduleSummary(version)
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-sm font-medium"><Clock className="size-4" /> Schedule</div>
      <div className="flex items-center gap-2">
        <span className="text-sm">{sched.label}</span>
        {sched.kind !== 'manual' && (
          <Badge variant={sched.enabled ? 'success' : 'muted'}>{sched.enabled ? 'Enabled' : 'Paused'}</Badge>
        )}
        {sched.timezone && <span className="text-xs text-muted-foreground">{sched.timezone}</span>}
      </div>
      {sched.manualRunAllowed && <p className="text-xs text-muted-foreground mt-1">Manual runs allowed.</p>}
    </div>
  )
}

export function SafetyView({ version }: { version: VersionLike }) {
  const s = safetySummary(version)
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-sm font-medium"><ShieldCheck className="size-4" /> Review &amp; safety</div>
      <p className="text-xs text-muted-foreground mb-3">Review posture: <Badge variant="secondary">{s.posture}</Badge></p>
      <p className="text-xs text-muted-foreground mb-3">
        Run constraints: risk <span className="font-medium text-foreground">{version.risk_level ?? 'medium'}</span> · maximum duration <span className="font-medium text-foreground">{version.max_run_time_seconds ?? 300}s</span>.
      </p>
      <p className="text-xs font-medium text-foreground">This agent can</p>
      <ul className="mt-1 mb-3 space-y-0.5">
        {s.can.length ? s.can.map((c, i) => <li key={i} className="text-sm text-foreground">· {c}</li>)
          : <li className="text-sm text-muted-foreground">· nothing configured</li>}
      </ul>
      <p className="text-xs font-medium text-foreground">This agent cannot</p>
      <ul className="mt-1 space-y-0.5">
        {s.cannot.map((c, i) => <li key={i} className="text-sm text-muted-foreground">· {c}</li>)}
      </ul>
    </div>
  )
}
