import {useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import type {SourceGoalDetail} from '@rainver/protocol'
import {projectReadingApi} from '../../../api/client'
import {useAppTranslation} from '../../../i18n'
import {Button} from '../../../components/ui/button'
import {Select} from '../../../components/ui/select'
import {ReadingItemCard} from '../../library/ReadingItemCard'
import {useReading} from '../../library/useReading'
import {useReadingAction} from './useReadingResource'
import {DeepReadRequest} from './DeepReadRequest'
import {ReadingFeedback} from './ReadingFeedback'
import {projectReaderHref} from './ProjectComposition'
import {topicTitle} from '../../sources/topics/topicTitle'
export function ProjectMaterials({space,project,user,goals}:{space:string;project:string;user:string;goals:SourceGoalDetail['goal'][]}){
 const {t}=useAppTranslation();const [params,setParams]=useSearchParams();const [deep,setDeep]=useState<string|null>(null);const action=useReadingAction();const view=params.get('view')==='read'?'read':params.get('view')==='pending'?'pending':'all',topic=params.get('topic')??'',favorite=params.get('favorite')==='only'
 const feed=useReading(space,project,view,'',30,topic?{id:topic,selection:'all'}:undefined,'newest',favorite?'only':undefined)
 const change=(key:string,value:string)=>{const next=new URLSearchParams(params);if(value)next.set(key,value);else next.delete(key);setParams(next)}
 const back=`/projects/${project}/sources?${params}`
 return <section className="space-y-4" aria-label={t('projectReading.materials')}><div className="flex flex-wrap gap-2"><Select ariaLabel={t('projectReading.filterTopic')} value={topic} onChange={v=>change('topic',v)} options={[{value:'',label:t('projectReading.allTopics')},...goals.map(g=>({value:g.id,label:topicTitle(g)}))]}/><Select ariaLabel={t('projectReading.filterRead')} value={view} onChange={v=>change('view',v)} options={['all','pending','read'].map(v=>({value:v,label:t(`reading.${v}`)}))}/><Button size="sm" variant={favorite?'secondary':'outline'} aria-pressed={favorite} onClick={()=>change('favorite',favorite?'':'only')}>{t('projectReading.favorites')}</Button><Button size="sm" variant="ghost" onClick={()=>void feed.refresh()}>{t('reading.refresh')}</Button></div>
 <p className="text-sm text-muted-foreground">{t('projectReading.materialHint')}</p><ReadingFeedback error={feed.error??action.error} loading={feed.loading} retry={feed.reload}/>
 {!feed.loading&&feed.page?.items.length===0&&<p className="text-sm">{t('projectReading.noMaterials')}</p>}
 <ul className="space-y-3">{!action.denied&&feed.page?.items.map(item=><li key={item.key}><ReadingItemCard item={item} href={`${projectReaderHref(project,item.source_item_id,back)}&original=1`} busy={feed.busy||action.busy} onStateChange={field=>void feed.change(item.source_item_id,{[field]:field==='dismissed'?!item.dismissed:item.read_status==='read'?'unread':'read'})} extraActions={item.access_level==='full'&&<><Button size="sm" variant="ghost" aria-pressed={!!item.favorite} disabled={action.busy} onClick={()=>void action.run(()=>projectReadingApi.favorite(space,project,item.source_item_id,!item.favorite),()=>void feed.refresh())}>{t(item.favorite?'projectReading.unfavorite':'projectReading.favorite')}</Button><Button size="sm" variant="outline" disabled={action.busy} onClick={()=>setDeep(item.source_item_id)}>{t('projectReading.request')}</Button></>}/></li>)}</ul>
 {feed.page?.next_cursor&&<Button variant="outline" disabled={feed.loading} onClick={()=>void feed.more()}>{t('reading.moreVersions')}</Button>}
 {deep&&<DeepReadRequest space={space} project={project} user={user} item={deep} onClose={()=>setDeep(null)} onStarted={()=>{setDeep(null);change('tab','deep')}}/>}
 </section>
}
