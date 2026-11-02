import type {ReactNode} from 'react'
import type {ReadingItem} from '@rainver/protocol'
import {ReadingCard} from './ReadingCard'
import {ReadingStatusBadge} from './ReadingStatusBadge'
import {AgentSearchProvenance} from './AgentSearchProvenance'
import {TopicLinkSummary} from '../sources/topics/TopicLinkSummary'
import {Badge} from '../../components/ui/badge'
import {Button} from '../../components/ui/button'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {formatCalendarDay,formatDateTime} from '../../i18n/format'

/** One Source material presentation for Reading and Following. Lists own state and navigation. */
export function ReadingItemCard({item,href,compact=false,topicId,busy,onOpen,onPreview,onStateChange,extraDetails,extraActions}:{item:ReadingItem;href:string;compact?:boolean;topicId?:string;busy:boolean;onOpen?:()=>void;onPreview?:()=>void;onStateChange:(field:'read_status'|'dismissed')=>void;extraDetails?:ReactNode;extraActions?:ReactNode}){
 const {t}=useAppTranslation()
 return <ReadingCard compact={compact} progress={item.reading_progress}
 title={item.access_level==='full'?<SpaceLink data-reader-link className="hover:underline" to={href} onClick={onOpen}>{item.title}</SpaceLink>:item.title}
        summary={item.summary ?? item.contributions.find(reason => reason.summary)?.summary ?? null}
        metadata={<><AgentSearchProvenance value={item.result_provenance}/><ReadingStatusBadge item={item} topic={topicId}/>{item.dismissed && <Badge variant="muted">{t('reading.setAside')}</Badge>}{item.contributions.length === 0 && <Badge variant="outline">{t('reading.materialOnly')}</Badge>}{item.topic_change&&<Badge variant="outline">{t('reading.topicChange')}</Badge>}{item.occurred_at&&<span className="basis-full whitespace-nowrap sm:basis-auto">{t('reading.published')}: {formatDateTime(item.occurred_at)}</span>}</>}
        topics={<>{item.topics.filter(link => !topicId || link.goal_id === topicId).map(link => <TopicLinkSummary key={link.goal_id} link={link} showTopic compact />)}</>}
        details={<><ul className="space-y-3">{item.contributions.map(reason => <li key={reason.delivery_id} className="space-y-1 break-words text-sm">
          <p className="font-medium">{reason.project_id ? <SpaceLink className="hover:underline" to={`/projects/${reason.project_id}/sources`}>{reason.project_name}</SpaceLink> : t(reason.section === 'serendipity' ? 'reading.discovery' : 'reading.personalRecommendation')}</p>
          {reason.rationale && <p className="text-muted-foreground">{reason.rationale}</p>}
          <p className="text-xs text-muted-foreground">{reason.digest_date ? <SpaceLink className="underline" to={reason.project_id ? `/projects/${reason.project_id}/sources?tab=digest&date=${reason.digest_date}` : `/library/digests?date=${reason.digest_date}`}>{t('reading.edition')}: {formatCalendarDay(reason.digest_date, {year:'numeric',month:'short',day:'numeric'})} · {reason.timezone}</SpaceLink> : t('reading.initial')} · {t('reading.available')}: {formatDateTime(reason.available_at)}</p>
        </li>)}</ul>
        {item.topics.filter(link => !topicId || link.goal_id === topicId).map(link => <TopicLinkSummary key={link.goal_id} link={link} />)}
        {item.material_links.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{t('reading.materialLinks')}</summary><ul>{item.material_links.map(link => <li key={`${link.kind}:${link.reference_id}`}><SpaceLink className="underline" to={`/projects/${link.project_id}/sources?view=all`}>{t(`reading.link_${link.kind}`)}</SpaceLink></li>)}</ul></details>}
        {extraDetails}</>}
 actions={<>
  {item.access_level!=='full'&&<span className="text-xs text-muted-foreground">{t('reading.summaryOnly')}</span>}
  {onPreview&&<Button size="sm" variant="ghost" className="reading-preview-trigger" onClick={onPreview} aria-label={t('reading.previewItem',{title:item.title})}>{t('reading.itemPreview')}</Button>}
  {extraActions}
  <Button size="sm" variant="ghost" disabled={busy} onClick={()=>onStateChange('read_status')}>{t(item.read_status==='read'||item.read_status==='discussed'?'reading.restore':'reading.markRead')}</Button>
  <Button size="sm" variant="ghost" disabled={busy} onClick={()=>onStateChange('dismissed')}>{t(item.dismissed?'reading.restoreQueue':'reading.dismiss')}</Button>
 </>}/>
}
