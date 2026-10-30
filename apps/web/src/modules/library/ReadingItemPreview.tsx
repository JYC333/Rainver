import type { ReadingItem } from '@rainver/protocol'
import { useAppTranslation } from '../../i18n'
import { SpaceLink } from '../../core/spaceNav'
import { TopicLinkSummary } from '../sources/topics/TopicLinkSummary'

/** Only the current authorized list payload is used; no parallel document fetch. */
export function ReadingItemPreview({ item, href, onOpen }: { item: ReadingItem | null; href: string; onOpen: () => void }) {
  const { t } = useAppTranslation()
  return <aside aria-label={t('reading.itemPreview')} className="reading-item-preview self-start rounded-xl border border-border bg-card p-4">
    <h2 className="mb-3 text-sm font-medium">{t('reading.itemPreview')}</h2>
    {!item ? <p className="text-sm text-muted-foreground">{t('reading.choosePreview')}</p> : <>
      <h3 className="break-words text-base font-semibold">{item.title}</h3>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{item.summary ?? item.contributions.find(reason => reason.summary)?.summary ?? t('reading.noPreviewSummary')}</p>
      <div className="mt-4 space-y-2">{item.topics.map(link => <TopicLinkSummary key={link.goal_id} link={link} showTopic compact />)}</div>
      <ul className="mt-4 space-y-2 text-xs text-muted-foreground">{item.contributions.map(reason => <li key={reason.delivery_id}>{reason.rationale ?? reason.summary}</li>)}</ul>
      {item.source_uri && <p className="mt-3 break-all text-xs text-muted-foreground">{item.source_uri}</p>}
      {item.access_level === 'full' ? <SpaceLink className="mt-4 inline-flex min-h-9 items-center text-sm text-primary underline" to={href} onClick={onOpen}>{t('reading.openPreviewArticle')}</SpaceLink>
        : <p className="mt-4 text-xs text-muted-foreground">{t('reading.previewSummaryOnly')}</p>}
    </>}
  </aside>
}
