import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Briefing, BriefingEvidence, BriefingHighlight } from '@rainver/protocol'
import { Card } from '../../../components/ui/card'
import { useAppTranslation } from '../../../i18n'

/**
 * One briefing as the server projected it for this reader. Scope-agnostic:
 * the caller decides where evidence opens. Every visible sentence carries its
 * citations; withheld and hidden parts are stated, never silently dropped.
 */
export function BriefingView({ briefing, evidenceHref }: { briefing: Briefing; evidenceHref: (evidence: BriefingEvidence) => string }) {
  const { t } = useAppTranslation()
  const evidence = new Map(briefing.evidence.map(entry => [entry.key, entry]))
  const context = new Map(briefing.context.map(entry => [entry.key, entry]))
  const refs = (keys: string[]) => <Refs keys={keys} evidence={evidence} context={context} evidenceHref={evidenceHref} />

  return (
    <div className="space-y-4" data-testid="briefing-view">
      <p className="text-xs text-muted-foreground">{t(`briefing.comparison.${briefing.comparison}`)}</p>
      {briefing.visibility === 'withheld' ? <Notice>{t('briefing.withheld')}</Notice> : null}
      {briefing.visibility === 'partial' ? <Notice>{t('briefing.partial', { count: briefing.hidden_units })}</Notice> : null}
      {briefing.context_outdated ? <Notice>{t('briefing.context_outdated')}</Notice> : null}
      {briefing.overview ? (
        <section aria-label={t('briefing.overview')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.overview')}</h3>
          <p className="text-sm leading-relaxed break-words">{briefing.overview.text} {refs(briefing.overview.refs)}</p>
        </section>
      ) : null}
      {briefing.highlights.length > 0 ? (
        <section aria-label={t('briefing.highlights')} className="space-y-3">
          <h3 className="text-sm font-semibold">{t('briefing.highlights')}</h3>
          {briefing.highlights.map((highlight, index) => <HighlightCard key={index} highlight={highlight} refs={refs} />)}
        </section>
      ) : null}
      {briefing.open_questions.length > 0 ? (
        <section aria-label={t('briefing.open_questions')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.open_questions')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {briefing.open_questions.map((question, index) => <li key={index} className="break-words">{question.text} {refs(question.refs)}</li>)}
          </ul>
        </section>
      ) : null}
      {briefing.evidence.length > 0 ? (
        <section aria-label={t('briefing.evidence')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.evidence')}</h3>
          <ol className="space-y-1 text-sm">
            {briefing.evidence.map(entry => (
              <li key={entry.key} id={`briefing-ref-${entry.key}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-xs text-muted-foreground">[{entry.key}]</span>
                <Link className="min-w-0 break-words underline-offset-2 hover:underline" to={evidenceHref(entry)}>{entry.title}</Link>
                <span className="text-xs text-muted-foreground">
                  {[entry.source_domain, t(`briefing.delta.${entry.delta_class}`), ...entry.lenses.map(lens => lens.label)].filter(Boolean).join(' · ')}
                </span>
                {entry.unverified ? <span className="rounded border border-amber-500/50 px-1 text-xs text-amber-700 dark:text-amber-400">{t('briefing.unverified_short')}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {briefing.context.length > 0 ? (
        <section aria-label={t('briefing.context')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.context')}</h3>
          <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {briefing.context.map(entry => <li key={entry.key} id={`briefing-ref-${entry.key}`}><span className="font-mono">[{entry.key}]</span> {entry.label}</li>)}
          </ul>
        </section>
      ) : null}
      <Coverage briefing={briefing} />
      {briefing.status === 'ready' && briefing.outcome === 'briefing' ? <p className="text-xs text-muted-foreground">{t('briefing.structure_note')}</p> : null}
    </div>
  )
}

function HighlightCard({ highlight, refs }: { highlight: BriefingHighlight; refs: (keys: string[]) => React.ReactNode }) {
  const { t } = useAppTranslation()
  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words text-sm font-medium">{highlight.title}</h4>
        <Tag>{t(`briefing.novelty.${highlight.novelty}`)}</Tag>
        <Tag>{t(`briefing.importance.${highlight.importance}`)}</Tag>
        <span className="text-xs text-muted-foreground">{t('briefing.sources', { count: highlight.source_domains })}</span>
      </div>
      <p className="text-sm break-words">{highlight.what_changed} {refs(highlight.refs)}</p>
      {highlight.rests_on_unverified ? <Notice>{t('briefing.unverified')}</Notice> : null}
      <ul className="space-y-1 text-sm">
        {highlight.statements.map((statement, index) => (
          <li key={index} className="break-words">
            <span className="mr-1 text-xs font-medium uppercase text-muted-foreground">{t(`briefing.statement.${statement.kind}`)}</span>
            {statement.text} {refs(statement.refs)}
          </li>
        ))}
      </ul>
      <p className="text-sm break-words"><span className="font-medium">{t('briefing.why')}: </span>{highlight.why_it_matters}</p>
      <p className="text-sm break-words">
        <span className="font-medium">{t('briefing.impact')}: </span>
        {highlight.impact.assessment === 'insufficient_context' ? <span className="text-muted-foreground">{t('briefing.impact_insufficient')} </span> : null}
        {highlight.impact.text} {refs(highlight.impact.context_refs)}
      </p>
      {highlight.contradictions ? <p className="text-sm break-words"><span className="font-medium">{t('briefing.contradictions')}: </span>{highlight.contradictions}</p> : null}
      <p className="text-xs text-muted-foreground">{t(`briefing.action.${highlight.suggested_action}`)}</p>
    </Card>
  )
}

function Refs({ keys, evidence, context, evidenceHref }: {
  keys: string[]
  evidence: Map<string, BriefingEvidence>
  context: Map<string, Briefing['context'][number]>
  evidenceHref: (evidence: BriefingEvidence) => string
}) {
  return (
    <span className="whitespace-nowrap text-xs">
      {keys.map(key => {
        const item = evidence.get(key)
        if (item) return <Link key={key} to={evidenceHref(item)} title={item.title} className="mr-0.5 inline-flex items-center font-mono text-primary underline-offset-2 hover:underline">[{key}]<ExternalLink className="ml-0.5 size-3" aria-hidden /></Link>
        const entry = context.get(key)
        return <a key={key} href={`#briefing-ref-${key}`} title={entry?.label} className="mr-0.5 font-mono text-muted-foreground">[{key}]</a>
      })}
    </span>
  )
}

function Coverage({ briefing }: { briefing: Briefing }) {
  const { t } = useAppTranslation()
  const c = briefing.coverage
  const lines = [
    t('briefing.coverage.included', { count: c.included }),
    c.merged_duplicates ? t('briefing.coverage.merged', { count: c.merged_duplicates }) : null,
    c.unchanged_since_previous ? t('briefing.coverage.unchanged', { count: c.unchanged_since_previous }) : null,
    c.not_ready ? t('briefing.coverage.not_ready', { count: c.not_ready }) : null,
    c.truncated ? t('briefing.coverage.truncated', { count: c.truncated }) : null,
    c.egress_refused ? t('briefing.coverage.egress_refused', { count: c.egress_refused }) : null,
    c.not_shared_with_audience ? t('briefing.coverage.not_shared', { count: c.not_shared_with_audience }) : null,
    c.background ? t('briefing.coverage.background', { count: c.background }) : null,
    c.context_changed ? t('briefing.coverage.context_changed') : null,
  ].filter(Boolean)
  return (
    <section aria-label={t('briefing.coverage.title')} className="rounded-md border border-border p-2 text-xs text-muted-foreground">
      <span className="font-medium">{t('briefing.coverage.title')}: </span>
      {lines.join(' · ')}{c.complete ? ` · ${t('briefing.coverage.complete')}` : ''}
    </section>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-border px-1.5 text-xs">{children}</span>
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{children}</p>
}
