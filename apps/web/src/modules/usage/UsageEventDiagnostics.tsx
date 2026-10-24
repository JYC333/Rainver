import type { UsageEventDTO, UsageTotals } from '@rainver/protocol'
import i18n, { useAppTranslation } from '../../i18n'
import { formatNumber } from '../../i18n/format'

export function requestCountLabel(totals: Pick<UsageTotals, 'request_count' | 'unknown_request_count_events'>): string {
  if (!totals.unknown_request_count_events) return formatNumber(totals.request_count)
  return totals.request_count > 0 ? `≥ ${formatNumber(totals.request_count)}` : i18n.t('workspace_ui.usage.diagnostics.unknown')
}

/** A diagnostic estimate is shown separately from cumulative measured usage. */
export function UsageEventDiagnostics({ event }: { event: UsageEventDTO }) {
  const { t } = useAppTranslation()
  const value = event.metadata.cli_usage
  const diagnostics = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const number = (key: string) => {
    const candidate = diagnostics[key]
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? formatNumber(candidate) : t('workspace_ui.usage.diagnostics.unknown')
  }
  const known = event.request_count_known ?? event.execution_channel !== 'local_cli'
  const rows: Array<[string, string]> = [
    ['processed_input', formatNumber(event.input_tokens + event.cache_creation_input_tokens + event.cache_read_input_tokens)],
    ['uncached_input', formatNumber(event.input_tokens)],
    ['cache_read', formatNumber(event.cache_read_input_tokens)],
    ['cache_write', formatNumber(event.cache_creation_input_tokens)],
    ['output', formatNumber(event.output_tokens)],
    ['model_calls', known ? formatNumber(event.request_count) : t('workspace_ui.usage.diagnostics.unknown')],
  ]
  if (event.execution_channel === 'local_cli') {
    rows.push(['acp_turns', number('acp_turns')], ['occupancy', `${number('occupancy_used')} / ${number('occupancy_size')}`])
    if (diagnostics.usage_scope === 'last_model_request') {
      // codex-acp reports its last model request, not the turn; the buckets above are a lower bound.
      rows.push(['usage_scope', t('workspace_ui.usage.diagnostics.scope_last_model_request')])
    }
    if (typeof diagnostics.usage_updates === 'number') {
      rows.push(['usage_updates', number('usage_updates')], ['usage_updates_used_total', number('usage_updates_used_total')])
    }
    if (typeof diagnostics.resumed_session === 'boolean') {
      rows.push(['session', t(diagnostics.resumed_session ? 'workspace_ui.usage.diagnostics.session_resumed' : 'workspace_ui.usage.diagnostics.session_fresh')])
    }
    const purpose = event.dimensions.run_purpose
    if (purpose === 'task' || purpose === 'delegation' || purpose === 'handoff') {
      rows.push(['purpose', t(`workspace_ui.usage.diagnostics.purpose_${purpose}`)])
    }
    const outcome = event.dimensions.run_outcome
    if (outcome === 'succeeded' || outcome === 'failed') rows.push(['outcome', t(`workspace_ui.usage.diagnostics.outcome_${outcome}`)])
    const attempt = event.dimensions.run_attempt_number
    if (typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0) rows.push(['attempt', formatNumber(attempt)])
    if (typeof diagnostics.estimated_total === 'number') {
      rows.push(['estimated_total', number('estimated_total')])
      for (const key of ['instructions', 'current_input', 'history', 'checkpoint_tail', 'skills', 'attachments', 'retrieval', 'tool_results']) {
        if (typeof diagnostics[`estimate_${key}`] === 'number') rows.push([`estimate_${key}`, number(`estimate_${key}`)])
      }
    }
  }
  return (
    <details className="mt-2 max-w-sm text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t('workspace_ui.usage.diagnostics.title')}</summary>
      <p className="my-2 text-muted-foreground">{t('workspace_ui.usage.diagnostics.explanation')}</p>
      <dl className="space-y-1">
        {rows.map(([key, value]) => <div key={key} className="flex justify-between gap-4"><dt>{t(`workspace_ui.usage.diagnostics.${key}`)}</dt><dd className="font-mono">{value}</dd></div>)}
      </dl>
    </details>
  )
}
