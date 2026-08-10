import { ArrowRight } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { ProjectResearchScanSummary } from '../../types/api'

interface ResearchScanTimelineProps {
  projectId: string
  summaries: ProjectResearchScanSummary[]
  monitoringActive: boolean
}

function dateLabel(value: string): string {
  // scan_date is a UTC calendar day; format it as-is so the label never
  // shifts a day in negative-offset timezones.
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}

function summaryLabel(summary: ProjectResearchScanSummary): string {
  if (summary.integrity_alerts.length > 0) return `${summary.integrity_alerts.length} publication integrity alert${summary.integrity_alerts.length === 1 ? '' : 's'}`
  if (summary.new_item_count === 0) return 'No new material'
  const parts = [`${summary.new_item_count} new`, `${summary.relevant_count} relevant`]
  if (summary.maybe_count > 0) parts.push(`${summary.maybe_count} maybe`)
  if (summary.relevant_count + summary.maybe_count === 0) return `${summary.new_item_count} new · no relevant updates`
  return parts.join(' · ')
}

export function ResearchScanTimeline({ projectId, summaries, monitoringActive }: ResearchScanTimelineProps) {
  if (!monitoringActive && summaries.length === 0) return null
  return (
    <section aria-labelledby="research-scan-timeline-title" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="research-scan-timeline-title" className="text-sm font-semibold">Monitoring updates</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Only completed scans appear here; a missing day means no scan was recorded.</p>
        </div>
      </div>
      {summaries.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No monitoring scan has completed yet.</p>
      ) : (
        <ol className="mt-3 divide-y divide-border/70">
          {summaries.slice(0, 10).map(summary => (
            <li key={`${summary.workflow_id}:${summary.scan_date}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0">
              <time className="w-14 shrink-0 font-medium" dateTime={summary.scan_date}>{dateLabel(summary.scan_date)}</time>
              <div className="min-w-0 flex-1">
                <span className={summary.integrity_alerts.length || summary.contradicts_count ? 'font-medium text-destructive' : 'text-muted-foreground'}>{summaryLabel(summary)}</span>
                {summary.integrity_alerts.map(alert => <p key={alert.id} className="mt-1 text-xs text-destructive">
                  {alert.event_type.replace(/_/g, ' ')} · DOI {alert.doi}
                </p>)}
                {summary.comparisons.filter(item => item.stance === 'contradicts').slice(0, 2).map(item => <p key={item.source_item_id} className="mt-1 line-clamp-2 text-xs text-destructive">
                  Contradiction · {item.detail}
                </p>)}
                {summary.new_item_count > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">{summary.supports_count} supports</span>
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">{summary.contradicts_count} contradicts</span>
                    <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-700 dark:text-blue-300">{summary.new_direction_count} new directions</span>
                  </div>
                )}
              </div>
              <Link className="inline-flex items-center gap-1 text-xs font-medium text-accent-foreground hover:underline" to={`/projects/${projectId}/research`}>
                View update <ArrowRight className="size-3" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
