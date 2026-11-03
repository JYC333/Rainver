import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Briefing, BriefingEvidence, BriefingHighlight } from '@rainver/protocol'
import { Card } from '../../../components/ui/card'
import { useAppTranslation } from '../../../i18n'
import { BriefingText } from './BriefingCitations'

/**
 * One briefing as the server projected it for this reader. Scope-agnostic:
 * the caller decides where evidence opens. Every visible sentence carries its
 * citations; withheld and hidden parts are stated, never silently dropped.
 */
export function BriefingView({ briefing, evidenceHref, highlightActions, evidenceScopeTitle }: {
  briefing: Briefing
  evidenceHref: (evidence: BriefingEvidence) => string
  /** A single-topic surface supplies its authorized structured short title. */
  evidenceScopeTitle?: string
  /** Explicit actions on one highlight (follow-up, adoption), when the surface offers them. */
  highlightActions?: (highlight: Briefing['highlights'][number]) => React.ReactNode
}) {
  const { t } = useAppTranslation()
  const evidence = new Map(briefing.evidence.map(entry => [entry.key, entry]))
  const context = new Map(briefing.context.map(entry => [entry.key, entry]))
  const text = (value: string, keys: string[] = []) => <BriefingText text={value} keys={keys} evidence={evidence} context={context} evidenceHref={evidenceHref}/>

  return (
    <div className="space-y-4" data-testid="briefing-view">
      <p className="text-xs text-muted-foreground">{t(`briefing.comparison.${briefing.comparison}`)}</p>
      {briefing.visibility === 'withheld' ? <Notice>{t('briefing.withheld')}</Notice> : null}
      {briefing.visibility === 'partial' ? <Notice>{t('briefing.partial', { count: briefing.hidden_units })}</Notice> : null}
      {briefing.context_outdated ? <Notice>{t('briefing.context_outdated')}</Notice> : null}
      {briefing.overview ? (
        <section aria-label={t('briefing.overview')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.overview')}</h3>
          <p className="text-sm leading-relaxed break-words">{text(briefing.overview.text, briefing.overview.refs)}</p>
        </section>
      ) : null}
      {briefing.highlights.length > 0 ? (
        <section aria-label={t('briefing.highlights')} className="space-y-3">
          <h3 className="text-sm font-semibold">{t('briefing.highlights')}</h3>
          {briefing.highlights.map(highlight => <HighlightCard key={`${briefing.id}:${highlight.index}`} highlight={highlight} text={text} personal={briefing.scope_type === 'personal'} actions={highlightActions?.(highlight)} />)}
        </section>
      ) : null}
      {briefing.open_questions.length > 0 ? (
        <section aria-label={t('briefing.open_questions')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.open_questions')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {briefing.open_questions.map((question, index) => <li key={index} className="break-words">{text(question.text, question.refs)}</li>)}
          </ul>
        </section>
      ) : null}
      {briefing.evidence.length > 0 ? (
        <section aria-label={t('briefing.evidence')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t('briefing.evidence')}</h3>
          <ol className="space-y-1 text-sm">
            {briefing.evidence.map(entry => (
              <li key={entry.key} id={`briefing-ref-${entry.key}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-xs text-muted-foreground">{entry.key.replace(/^S/, '')}.</span>
                <Link className="min-w-0 break-words underline-offset-2 hover:underline" to={evidenceHref(entry)}>{entry.title}</Link>
                <span className="text-xs text-muted-foreground">
                  {[entry.source_domain, t(`briefing.delta.${entry.delta_class}`), ...(evidenceScopeTitle ? [evidenceScopeTitle] : entry.lenses.map(lens => lens.label))].filter(Boolean).join(' · ')}
                </span>
                {entry.unverified ? <span className="rounded border border-amber-500/50 px-1 text-xs text-amber-700 dark:text-amber-400">{t('briefing.unverified_short')}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {briefing.context.length > 0 ? (
        <section aria-label={t(briefing.scope_type === 'personal' ? 'briefing.context_personal' : 'briefing.context')} className="space-y-1">
          <h3 className="text-sm font-semibold">{t(briefing.scope_type === 'personal' ? 'briefing.context_personal' : 'briefing.context')}</h3>
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

function HighlightCard({ highlight, text, personal, actions }: { highlight: BriefingHighlight; text: (value: string, keys?: string[]) => React.ReactNode; personal: boolean; actions?: React.ReactNode }) {
  const { t } = useAppTranslation()
  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words text-sm font-medium">{text(highlight.title)}</h4>
        <Tag>{t(`briefing.novelty.${highlight.novelty}`)}</Tag>
        <Tag>{t(`briefing.importance.${highlight.importance}`)}</Tag>
        <span className="text-xs text-muted-foreground">{t('briefing.sources', { count: highlight.source_domains })}</span>
      </div>
      <p className="text-sm break-words">{text(highlight.what_changed, highlight.refs)}</p>
      {highlight.rests_on_unverified ? <Notice>{t('briefing.unverified')}</Notice> : null}
      <ul className="space-y-1 text-sm">
        {highlight.statements.map((statement, index) => (
          <li key={index} className="break-words">
            <span className="mr-1 text-xs font-medium uppercase text-muted-foreground">{t(`briefing.statement.${statement.kind}`)}</span>
            {text(statement.text, statement.refs)}
          </li>
        ))}
      </ul>
      <p className="text-sm break-words"><span className="font-medium">{t('briefing.why')}: </span>{text(highlight.why_it_matters)}</p>
      <p className="text-sm break-words">
        <span className="font-medium">{t(personal ? 'briefing.impact_personal' : 'briefing.impact')}: </span>
        {highlight.impact.assessment === 'insufficient_context' ? <span className="text-muted-foreground">{t('briefing.impact_insufficient')} </span> : null}
        {text(highlight.impact.text, highlight.impact.context_refs)}
      </p>
      {highlight.contradictions ? <p className="text-sm break-words"><span className="font-medium">{t('briefing.contradictions')}: </span>{text(highlight.contradictions)}</p> : null}
      <p className="text-xs text-muted-foreground">{t(`briefing.action.${highlight.suggested_action}`)}</p>
      {actions}
    </Card>
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
