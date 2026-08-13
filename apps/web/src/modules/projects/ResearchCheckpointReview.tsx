import { useState } from 'react'
import { ExternalLink, FileCheck2, Lightbulb, RefreshCw, ShieldCheck } from 'lucide-react'
import type { ProjectResearchCheckpoint, ProjectResearchCheckpointReview } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

interface ResearchCheckpointReviewProps {
  checkpoint: ProjectResearchCheckpoint
  onDecide: (decision: 'approved' | 'rejected') => void
  onRefresh?: () => void
  refreshing?: boolean
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function fallbackReview(checkpoint: ProjectResearchCheckpoint): ProjectResearchCheckpointReview {
  const machine = checkpoint.machine_result_json ?? {}
  const screening = checkpoint.checkpoint_type === 'screening_gate'
  const empty = screening && numberValue(machine.total) === 0
  return {
    type: screening ? 'screening' : 'ideas',
    title: screening ? 'Screening results' : 'Idea candidates',
    description: screening
      ? 'Review the AI triage for this intake batch before it enters the evidence matrix and synthesis.'
      : 'Review the generated research directions before they become part of the project’s working plan.',
    decision_scope: 'batch',
    decision_help: screening
      ? empty
        ? 'No material matched this search window. Revise the search query or date range and rescan before continuing.'
        : 'Approve accepts this batch as screened. Reject keeps the research paused so the search or screening criteria can be revised.'
      : 'Approve accepts the complete idea batch. Reject keeps the candidates out of the formal research outputs.',
    summary: screening
      ? {
          total: numberValue(machine.total),
          relevant: numberValue(machine.relevant),
          maybe: numberValue(machine.maybe),
          excluded: numberValue(machine.excluded),
          missing_full_text: numberValue(machine.missing_full_text),
          evidence_count: numberValue(machine.evidence_count),
          failed_items: numberValue(machine.failed_items),
          processing_status: empty ? 'empty' : undefined,
          partial: machine.partial === true,
          coverage_degraded: machine.coverage_degraded === true,
          deferred_source_count: Array.isArray(machine.deferred_sources) ? machine.deferred_sources.length : 0,
        }
      : { total: numberValue(machine.idea_count) },
    items: [],
    item_count: screening ? numberValue(machine.total) : numberValue(machine.idea_count),
    displayed_item_count: 0,
    truncated: false,
  }
}

function recommendationLabel(value: string | undefined): string {
  switch (value) {
    case 'relevant': return 'Relevant'
    case 'maybe': return 'Maybe'
    case 'not_relevant': return 'Excluded'
    default: return 'Unreviewed'
  }
}

function recommendationVariant(value: string | undefined): 'success' | 'warning' | 'muted' | 'outline' {
  switch (value) {
    case 'relevant': return 'success'
    case 'maybe': return 'warning'
    case 'not_relevant': return 'muted'
    default: return 'outline'
  }
}

function formatConfidence(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return `${Math.round(value * 100)}% confidence`
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : null
}

function formatTokens(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Not reported' : value.toLocaleString()
}

function formatCost(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Not reported' : `$${value.toFixed(4)}`
}

function SummaryMetric({ label, value, tone = 'default' }: { label: string; value: number | string; tone?: 'default' | 'success' | 'warning' | 'muted' }) {
  return (
    <div className="rounded border border-border bg-background px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</p>
    </div>
  )
}

function ReviewImpactSummary({ review }: { review: ProjectResearchCheckpointReview }) {
  const usage = review.usage
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded border border-border bg-muted/20 p-3">
        <p className="text-xs font-semibold">Processing usage</p>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Agent runs: {usage?.completed_agent_run_count ?? 0} completed / {usage?.agent_run_count ?? 0} total</span>
          <span>Input tokens: {formatTokens(usage?.input_tokens)}</span>
          <span>Output tokens: {formatTokens(usage?.output_tokens)}</span>
          <span>Estimated cost: {formatCost(usage?.estimated_cost_usd)}</span>
        </div>
        {usage?.model_names && usage.model_names.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">Model: {usage.model_names.join(', ')}</p>
        )}
      </div>
      <div className="rounded border border-border bg-muted/20 p-3">
        <p className="text-xs font-semibold">After approval</p>
        <p className="mt-1 text-xs text-muted-foreground">{review.next_step?.description ?? review.decision_help}</p>
      </div>
    </div>
  )
}

function ScreeningReview({ review, onRefresh, refreshing }: { review: ProjectResearchCheckpointReview; onRefresh?: () => void; refreshing?: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const visibleItems = showAll ? review.items : review.items.slice(0, 8)
  const summary = review.summary
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <SummaryMetric label="Items" value={summary.total ?? review.item_count} />
        <SummaryMetric label="Classified" value={summary.classified ?? 0} />
        <SummaryMetric label="Relevant" value={summary.relevant ?? 0} tone="success" />
        <SummaryMetric label="Maybe" value={summary.maybe ?? 0} tone="warning" />
        <SummaryMetric label="Excluded" value={summary.excluded ?? 0} tone="muted" />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(summary.unclassified ?? 0) > 0 && <Badge variant="warning">{summary.unclassified} not classified</Badge>}
        {summary.processing_status === 'complete' && <Badge variant="success">Screening complete</Badge>}
        {/* Reads as a fault ("missing") when it is usually a setting: a source
            captured reference_only never fetches full text, so screening works
            from the abstract by design. State the fact, not a blame. */}
        <span>{summary.missing_full_text ?? 0} screened on abstract only</span>
        <span>{summary.evidence_count ?? 0} evidence records</span>
        {(summary.failed_items ?? 0) > 0 && <span className="text-destructive">{summary.failed_items} failed</span>}
        {summary.partial === true && <Badge variant="warning">Partial intake</Badge>}
        {summary.coverage_degraded === true && (
          <Badge variant="warning">
            {summary.deferred_source_count ?? 1} source{summary.deferred_source_count === 1 ? '' : 's'} retrying
          </Badge>
        )}
      </div>
      {summary.coverage_degraded === true && (
        <div role="status" className="rounded border border-warning/35 bg-warning/5 p-3 text-xs text-warning">
          Some source history is temporarily unavailable and is retrying in the background. You can continue with the material already collected; recovered items will be added to screening or a later monitoring update.
        </div>
      )}
      {summary.processing_status === 'incomplete' && (
        <div className="flex items-center justify-between gap-3 rounded border border-warning/35 bg-warning/5 p-3 text-xs text-warning">
          <span>AI screening is still in progress. Approval will be enabled after all {summary.total ?? review.item_count} items have a classification.</span>
          {onRefresh && (
            <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh} className="shrink-0">
              <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing…' : 'Refresh progress'}
            </Button>
          )}
        </div>
      )}
      {summary.processing_status === 'empty' && (
        <div role="alert" className="rounded border border-warning/35 bg-warning/5 p-3 text-xs text-warning">
          No material matched this search window, so there is nothing to screen. Synthesis is paused. Revise the search query or date range, then use “Rescan empty windows” to try again.
        </div>
      )}
      {(summary.total ?? 0) > 0 && (summary.relevant ?? 0) + (summary.maybe ?? 0) === 0 && (
        <div className="rounded border border-warning/35 bg-warning/5 p-3 text-xs text-warning">
          No material is currently eligible for the evidence matrix. Approve only if an empty result is intentional; otherwise reject this batch and revise the search or screening criteria.
        </div>
      )}
      <div className="rounded border border-border bg-muted/20 p-3">
        <p className="text-xs font-semibold">What you are deciding</p>
        <p className="mt-1 text-xs text-muted-foreground">{review.decision_help}</p>
      </div>
      {review.items.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold">Optional item details</p>
              <p className="text-xs text-muted-foreground">The decision is for the batch; inspect individual items only when the summary shows an anomaly.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowDetails(value => !value)}>
              {showDetails ? 'Hide details' : 'View sample items'}
            </Button>
          </div>
          {showDetails && <div className="space-y-2">
            <div className="text-right text-xs text-muted-foreground">Showing {visibleItems.length} of {review.item_count}</div>
            {visibleItems.map(item => {
              const date = formatDate(item.occurred_at)
              return (
                <div key={item.source_item_id ?? `${item.title}-${item.external_id ?? ''}`} className="rounded border border-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[item.author, item.external_id, date].filter(Boolean).join(' · ') || 'Source item'}
                      </p>
                    </div>
                    <Badge variant={recommendationVariant(item.recommendation)}>{recommendationLabel(item.recommendation)}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {formatConfidence(item.confidence) && <span>{formatConfidence(item.confidence)}</span>}
                    {item.human_triage && <span>Project status: {item.human_triage}</span>}
                    <span>Full text: {item.full_text_status === 'available' ? 'available' : 'not available'}</span>
                    <span>Evidence: {item.evidence_available ? 'available' : 'not extracted'}</span>
                    {item.source_uri && (
                      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={item.source_uri} target="_blank" rel="noreferrer">
                        Open source <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  {item.reason && <p className="mt-2 text-xs text-muted-foreground">Why: {item.reason}</p>}
                </div>
              )
            })}
            {(review.truncated || visibleItems.length < review.items.length) && (
            <Button size="sm" variant="outline" onClick={() => setShowAll(value => !value)}>
              {showAll ? 'Show fewer items' : `Show all ${review.items.length} items`}
            </Button>
            )}
          </div>}
        </div>
      ) : (
        <div className="rounded border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          The batch summary is ready, but the item list is still being prepared. Refresh this Project before deciding.
        </div>
      )}
    </div>
  )
}

function IdeaReview({ review }: { review: ProjectResearchCheckpointReview }) {
  const [showAll, setShowAll] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const visibleItems = showAll ? review.items : review.items.slice(0, 6)
  return (
    <div className="space-y-3">
      <div className="rounded border border-border bg-muted/20 p-3">
        <p className="text-xs font-semibold">What you are deciding</p>
        <p className="mt-1 text-xs text-muted-foreground">{review.decision_help}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold">Generated ideas</p>
        <span className="text-xs text-muted-foreground">{review.item_count} candidates</span>
      </div>
      {review.items.length > 0 ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Detailed ideas are optional for this batch decision.</p>
            <Button size="sm" variant="outline" onClick={() => setShowDetails(value => !value)}>
              {showDetails ? 'Hide details' : 'View idea details'}
            </Button>
          </div>
          {showDetails && visibleItems.map(item => (
        <div key={item.title} className="rounded border border-border bg-background p-3">
          <p className="text-sm font-medium">{item.title}</p>
          {item.problem && <p className="mt-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">Problem:</span> {item.problem}</p>}
          {item.novelty && <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium text-foreground">Novelty:</span> {item.novelty}</p>}
          {item.testability && <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium text-foreground">Testability:</span> {item.testability}</p>}
          <p className="mt-2 text-xs text-muted-foreground">{item.reference_count ?? 0} supporting references</p>
        </div>
          ))}
          {showDetails && visibleItems.length < review.items.length && (
            <Button size="sm" variant="outline" onClick={() => setShowAll(value => !value)}>
              {showAll ? 'Show fewer ideas' : `Show all ${review.items.length} available ideas`}
            </Button>
          )}
        </>
      ) : (
        <div className="rounded border border-border bg-muted/20 p-3 text-xs text-muted-foreground">The idea list is still being prepared. Refresh this project before deciding.</div>
      )}
    </div>
  )
}

export function ResearchCheckpointReview({ checkpoint, onDecide, onRefresh, refreshing }: ResearchCheckpointReviewProps) {
  const review = checkpoint.review ?? fallbackReview(checkpoint)
  const screening = review.type === 'screening'
  const screeningIncomplete = screening && review.summary.processing_status === 'incomplete'
  const screeningEmpty = screening && review.summary.processing_status === 'empty'
  return (
    <div className="rounded border border-border bg-background p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 rounded border border-primary/25 bg-primary/5 p-1.5 text-primary">
            {screening ? <FileCheck2 className="size-4" /> : <Lightbulb className="size-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">{review.title}</h4>
              <Badge variant="warning">Batch review</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{review.description}</p>
          </div>
        </div>
        <ShieldCheck className="size-4 shrink-0 text-warning" />
      </div>
      <ReviewImpactSummary review={review} />
      {screening ? <ScreeningReview review={review} onRefresh={onRefresh} refreshing={refreshing} /> : <IdeaReview review={review} />}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        <Button size="sm" variant="outline" onClick={() => onDecide('rejected')}>Reject and revise</Button>
        <Button
          size="sm"
          disabled={screeningIncomplete || screeningEmpty}
          title={screeningIncomplete
            ? 'Wait for AI screening to classify every item'
            : screeningEmpty ? 'No material matched this search window; rescan before continuing' : undefined}
          onClick={() => onDecide('approved')}
        >
          {screening ? 'Approve screening' : 'Approve ideas'}
        </Button>
      </div>
    </div>
  )
}
