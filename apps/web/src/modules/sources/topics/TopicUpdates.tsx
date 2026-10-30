import {ReadingStatusBadge} from '../../library/ReadingStatusBadge'
import {ReadingCard} from '../../library/ReadingCard'
import {useEffect,useRef,useState} from 'react'
import type {SourceGoalFeedbackRequest,SourceGoalFollowState} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Badge} from '../../../components/ui/badge'
import {Button} from '../../../components/ui/button'
import {EmptyState} from '../../../components/ui/empty-state'
import {Skeleton} from '../../../components/ui/skeleton'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {safeHttpUrl} from '../../../lib/safeHttpUrl'
import {AgentSearchProvenance} from '../../library/AgentSearchProvenance'
import {ReadingError} from '../../library/ReadingError'
import {readingHrefReturning} from '../../library/readingLinks'
import {useReading} from '../../library/useReading'
import {readingGoalPath} from '../sourceGoalNavigation'
import {feedbackKey} from './followOptions'
import {TopicLinkSummary} from './TopicLinkSummary'
import {TopicSelectionToggle} from './TopicSelectionToggle'

/** The topic's update stream: the canonical Reading API filtered to this topic,
 * important by default, with reading state and tightening-only feedback. */
export function TopicUpdates({spaceId,projectId,goalId,state,selection,onSelection,canManage,onFeedback,revision}:{revision:number;spaceId:string;projectId:string|null;goalId:string;state:SourceGoalFollowState|null|undefined;selection:'important'|'all';onSelection:(v:'important'|'all')=>void;canManage:boolean;onFeedback:()=>void}){
 const {t}=useAppTranslation()
 const feed=useReading(spaceId,projectId??undefined,'all','',30,{id:goalId,selection})
 // A newer topic state revalidates the loaded window in place (no flicker).
 const seen=useRef(revision)
 useEffect(()=>{if(seen.current===revision)return;seen.current=revision;if(!feed.busy)void feed.refresh()},[revision])
 const [pending,setPending]=useState<string|null>(null)
 const [failed,setFailed]=useState(false)
 const returnTo=`${readingGoalPath(projectId,goalId)}${selection==='all'?'?selection=all':''}`
 async function feedback(key:string,body:SourceGoalFeedbackRequest){
  if(pending)return;setPending(key);setFailed(false)
  try{await sourceGoalsApi.feedback(goalId,body,{spaceId});await feed.refresh();onFeedback()}catch{setFailed(true)}finally{setPending(null)}
 }
 const empty=()=>{
  if(state?.intent==='paused')return 'stopped'
  if(state?.phase==='preparing')return 'preparing'
  if(state?.phase==='first_collection')return 'first'
  if(selection==='important'&&(state?.results.items_total??0)>0)return 'importantNone'
  if(state?.results.last_outcome==='no_new')return 'noNew'
  return 'none'
 }
 return <section aria-labelledby="topic-updates" className="min-w-0 space-y-4">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="topic-updates" className="text-lg font-semibold">{t('topics.updates')}</h2><TopicSelectionToggle value={selection} onChange={onSelection}/></div>
  <p className="text-xs text-muted-foreground">{t(selection==='all'?'topics.allHint':'topics.importantHint')}</p>
  {failed&&<p role="alert" className="text-sm text-destructive">{t('topics.feedbackFailed')}</p>}
  {feed.error!=null&&<ReadingError error={feed.error} retry={()=>void feed.reload()}/>}
  {feed.loading&&!feed.page&&<div role="status" className="space-y-3"><span className="sr-only">{t('reading.loading')}</span><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/></div>}
  {feed.page&&(feed.page.items.length===0?<EmptyState title={t(`topics.empty.${empty()}`)}/>:<ul className="min-w-0 space-y-3">{feed.page.items.map(item=>{
   const link=item.topics.find(x=>x.goal_id===goalId)
   const read=item.read_status==='read'||item.read_status==='discussed'
   const origin=safeHttpUrl(item.source_uri)?new URL(item.source_uri!).origin:null
   const href=readingHrefReturning(item,returnTo)
   return <li key={item.key}><ReadingCard
    title={item.access_level==='full'?<SpaceLink className="hover:underline" to={href}>{item.title}</SpaceLink>:item.title}
    summary={item.summary ?? item.contributions.find(reason=>reason.summary)?.summary ?? null}
    metadata={<><AgentSearchProvenance value={item.result_provenance}/><ReadingStatusBadge item={item} topic={goalId}/>{item.topic_change&&<Badge variant="outline">{t('reading.topicChange')}</Badge>}{item.occurred_at&&<span>{t('reading.published')}: {formatDateTime(item.occurred_at)}</span>}</>}
    details={<>{link&&<TopicLinkSummary link={link}/>}</>}
    actions={<>
     {item.access_level==='full'?<Button size="sm" variant="outline" asChild><SpaceLink to={href}>{t('reading.open')}</SpaceLink></Button>:<span className="text-xs text-muted-foreground">{t('reading.summaryOnly')}</span>}
     <Button size="sm" variant="ghost" disabled={feed.busy||feed.loading} onClick={()=>void feed.change(item.source_item_id,{read_status:read?'unread':'read',...(item.topic_change?{topic_change_id:item.topic_change.id}:{})})}>{t(read?'reading.restore':'reading.markRead')}</Button>
     {canManage&&link&&link.selection_status!=='not_selected'&&<Button size="sm" variant="ghost" disabled={!!pending} onClick={()=>void feedback(`not_relevant:${item.source_item_id}`,{kind:'not_relevant',source_item_id:item.source_item_id,idempotency_key:`not_relevant:${item.source_item_id}`})}>{t('topics.notRelevant')}</Button>}
     {canManage&&origin&&<Button size="sm" variant="ghost" disabled={!!pending} onClick={()=>void feedback(`exclude_origin:${origin}`,{kind:'exclude_origin',origin,idempotency_key:feedbackKey('exclude_origin',origin)})}>{t('topics.hideSite')}</Button>}
    </>}
   /></li>})}</ul>)}
  {feed.page?.next_cursor&&<Button variant="outline" disabled={feed.loading||feed.busy} onClick={()=>void feed.more()}>{t('reading.more')}</Button>}
 </section>
}
