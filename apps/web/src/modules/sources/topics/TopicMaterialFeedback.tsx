import {useEffect,useRef,useState} from 'react'
import type {ReadingItem,SourceGoalFeedbackRequest} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {useAppTranslation} from '../../../i18n'
import {safeHttpUrl} from '../../../lib/safeHttpUrl'
import {sessionEpoch} from '../../../lib/sessionResidue'
import {feedbackKey} from './followOptions'

/** Topic-specific feedback stays with material in the filtered Reading list. */
export function TopicMaterialFeedback({spaceId,goalId,item,onSaved}:{spaceId:string;goalId:string;item:ReadingItem;onSaved:()=>void|Promise<void>}){
 const {t}=useAppTranslation(),link=item.topics.find(l=>l.goal_id===goalId)
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 const controller=useRef<AbortController|null>(null),lock=useRef(false)
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort()},[])
 const url=safeHttpUrl(item.source_uri),origin=url?new URL(url).origin:null
 async function submit(body:SourceGoalFeedbackRequest){
  const owner=controller.current,epoch=sessionEpoch();if(lock.current||!owner||owner.signal.aborted)return
  lock.current=true;setBusy(true);setFailed(false)
  try{await sourceGoalsApi.feedback(goalId,body,{spaceId,signal:owner.signal});if(!owner.signal.aborted&&sessionEpoch()===epoch)await onSaved()}
  catch{if(!owner.signal.aborted&&sessionEpoch()===epoch)setFailed(true)}
  finally{lock.current=false;if(!owner.signal.aborted&&sessionEpoch()===epoch)setBusy(false)}
 }
 return <div className="space-y-2">{failed&&<p role="alert" className="text-sm text-destructive">{t('topics.feedbackFailed')}</p>}<div className="flex flex-wrap gap-2">
  {link&&link.selection_status!=='not_selected'&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void submit({kind:'not_relevant',source_item_id:item.source_item_id,idempotency_key:`not_relevant:${item.source_item_id}`})}>{t('topics.notRelevant')}</Button>}
  {origin&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void submit({kind:'exclude_origin',origin,idempotency_key:feedbackKey('exclude_origin',origin)})}>{t('topics.hideSite')}</Button>}
 </div></div>
}
