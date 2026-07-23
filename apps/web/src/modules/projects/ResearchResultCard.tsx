import { AlertTriangle, ArrowRight, CheckCircle2, LoaderCircle } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { ResearchResultAction, ResearchResultState } from './researchResultState'

interface ResearchResultCardProps {
  state: ResearchResultState
  projectId: string
  busy: boolean
  running?: {
    percent: number
    detail: string
    steps: Array<{ title: string; status: string }>
  } | null
  onAction: (action: ResearchResultAction) => void
}

const toneClasses: Record<ResearchResultState['kind'], string> = {
  setup: 'border-border bg-card',
  question_drift: 'border-warning/50 bg-warning/5',
  checkpoint: 'border-warning/50 bg-warning/5',
  failure: 'border-destructive/45 bg-destructive/5',
  running: 'border-primary/35 bg-primary/5',
  monitoring_update: 'border-success/35 bg-success/5',
  monitoring: 'border-success/35 bg-success/5',
  completed: 'border-success/35 bg-success/5',
}

function actionHref(action: ResearchResultAction, state: ResearchResultState, projectId: string): string | null {
  if (action === 'open_report' && state.latestReport) return `/projects/${projectId}/research/reports/${state.latestReport.id}`
  if (action === 'view_corpus') return `/projects/${projectId}/sources`
  return null
}

function StateIcon({ kind }: { kind: ResearchResultState['kind'] }) {
  if (kind === 'failure' || kind === 'question_drift') return <AlertTriangle className="size-5" />
  if (kind === 'running') return <LoaderCircle className="size-5 animate-spin" />
  return <CheckCircle2 className="size-5" />
}

export function ResearchResultCard({ state, projectId, busy, running, onAction }: ResearchResultCardProps) {
  const renderAction = (action: NonNullable<ResearchResultState['primaryAction']>, primary: boolean) => {
    const href = actionHref(action.key, state, projectId)
    if (href) {
      return (
        <Button key={action.key} size="sm" variant={primary ? 'default' : 'outline'} asChild>
          <Link to={href}>{action.label}<ArrowRight className="size-3.5" /></Link>
        </Button>
      )
    }
    return (
      <Button key={action.key} size="sm" variant={primary ? 'default' : 'outline'} onClick={() => onAction(action.key)} disabled={busy}>
        {action.label}
      </Button>
    )
  }

  return (
    <section aria-label="Current research result" className={`rounded-lg border p-4 lg:p-5 ${toneClasses[state.kind]}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <StateIcon kind={state.kind} />
            {state.eyebrow}
          </div>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">{state.conclusion}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{state.detail}</p>
        </div>
        {(state.primaryAction || state.secondaryAction) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {state.primaryAction && renderAction(state.primaryAction, true)}
            {state.secondaryAction && renderAction(state.secondaryAction, false)}
          </div>
        )}
      </div>

      <dl className="mt-4 flex flex-wrap gap-2">
        {state.metrics.map(metric => (
          <div key={metric.label} className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{metric.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold whitespace-nowrap">{metric.value}</dd>
          </div>
        ))}
      </dl>

      {state.kind === 'running' && running && (
        <div className="mt-4 border-t border-border/70 pt-4">
          <div className="h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={running.percent}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${running.percent}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{running.detail}</p>
          <div className="mt-3 grid gap-2 md:grid-cols-5" aria-label="Research progress steps">
            {running.steps.map((step, index) => (
              <div key={`${index}:${step.title}`} className="flex items-center gap-2 text-xs leading-5">
                <span className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${step.status === 'done' ? 'border-success/50 bg-success/10 text-success' : step.status === 'failed' ? 'border-destructive/50 bg-destructive/10 text-destructive' : step.status === 'blocked' ? 'border-warning/50 bg-warning/10 text-warning' : step.status === 'active' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                  {step.status === 'done' ? '✓' : step.status === 'failed' ? '×' : index + 1}
                </span>
                <span className={['active', 'blocked', 'failed'].includes(step.status) ? 'font-medium text-foreground' : 'text-muted-foreground'}>{step.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {state.kind === 'failure' && state.failure && (
        <div className="mt-4 border-t border-destructive/20 pt-3">
          <p className="text-sm">{state.failure.suggestion}</p>
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Technical details</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded border border-border bg-background/80 p-2 font-mono text-[11px] whitespace-pre-wrap">{state.failure.technical}</pre>
          </details>
        </div>
      )}

      {state.notices.length > 0 && (
        <div className="mt-4 space-y-1.5 border-t border-border/70 pt-3" aria-label="Other research updates">
          {state.notices.map(notice => <p key={notice} className="text-xs text-muted-foreground">• {notice}</p>)}
        </div>
      )}
      {state.latestReport && state.kind !== 'running' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Latest report</Badge>
          <span>Research report · {state.latestReport.status.replace('_', ' ')}</span>
        </div>
      )}
    </section>
  )
}
