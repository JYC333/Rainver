import { Activity, Edit2, History, Play, Search, Settings2 } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import type { SourceChannel } from '../../types/api'
import type { ResearchSetupDraft } from './researchSetupDraft'

interface ResearchSetupSummaryProps {
  draft: ResearchSetupDraft
  sourceChannels: SourceChannel[]
  saved: boolean
  busyAction: string | null
  canAct: boolean
  onEdit: () => void
  onStart: () => void
}

function historyLabel(draft: ResearchSetupDraft): string {
  return draft.history_mode === 'all_available'
    ? 'All available history'
    : draft.from && draft.to
      ? `${draft.from} to ${draft.to}`
      : 'Date range not configured'
}

function executionLabel(draft: ResearchSetupDraft): string {
  return draft.execution.model_provider_id ? 'Managed API · provider selected' : 'Managed API not configured'
}

export function ResearchSetupSummary({ draft, sourceChannels, saved, busyAction, canAct, onEdit, onStart }: ResearchSetupSummaryProps) {
  void sourceChannels
  return (
    <section className="rounded-lg border border-border bg-card p-4 lg:p-5" aria-label="Initial literature intake setup">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Initial literature intake</h2>
            <Badge variant={saved ? 'success' : 'muted'}>{saved ? 'Setup saved' : 'Not configured'}</Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Choose the monitors and one-time history import that seed this project. After review, the same monitors continue collecting new literature.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onEdit} disabled={!canAct || busyAction !== null}>
            <Edit2 className="size-3.5" />
            {saved ? 'Edit intake setup' : 'Set up intake'}
          </Button>
          <Button size="sm" onClick={onStart} disabled={!saved || !canAct || busyAction !== null}>
            <Play className="size-3.5" />
            {busyAction === 'start-initial-intake' ? 'Starting…' : 'Start initial research'}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border bg-muted/10 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Search className="size-3.5" />Literature monitors</div>
          <p className="mt-2 line-clamp-2 text-sm font-medium">{saved ? (draft.query_strategy_id ? `Adaptive strategy ${draft.query_strategy_id.slice(0, 8)}` : 'Search strategy not ready') : 'Evaluate provider coverage'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{saved && draft.query_strategy_id ? 'Materialized provider queries' : 'No query strategy selected'}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/10 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><History className="size-3.5" />Initial history</div>
          <p className="mt-2 text-sm font-medium">{saved ? historyLabel(draft) : 'Historical import scope'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{saved ? `Up to ${draft.max_items} items` : 'Not configured'}</p>
        </div>
        <div className="rounded-md border border-border bg-muted/10 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Settings2 className="size-3.5" />Managed execution</div>
          <p className="mt-2 text-sm font-medium">{saved ? executionLabel(draft) : 'Managed API provider'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{saved ? 'Ready to start' : 'Not configured'}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Activity className="size-3.5" />
        {saved ? 'Saving updates the intake setup. Starting creates the one-time literature operation.' : 'Save this setup before starting initial research.'}
      </div>
    </section>
  )
}
