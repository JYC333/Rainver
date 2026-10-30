import {useEffect,useRef,useState} from 'react'
import type {SourceGoalDetail} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {useAppTranslation} from '../../../i18n'
import {sessionEpoch} from '../../../lib/sessionResidue'

/** Collection is queued, not completed, when admission returns. Refreshing the
 * topic status remains a separate read-only action. */
export function TopicCheckButton({goal,spaceId,busy,act}:{goal:SourceGoalDetail['goal'];spaceId:string;busy:boolean;act:(action:()=>Promise<unknown>)=>Promise<void>}){
 const {t}=useAppTranslation()
 const scope=`${spaceId}:${goal.id}:${goal.active_version_id??'legacy'}`
 const current=useRef(scope);current.current=scope
 const owner=useRef<AbortController|null>(null)
 const [notice,setNotice]=useState<{scope:string;key:string}|null>(null)
 useEffect(()=>{const controller=new AbortController();owner.current=controller;return()=>{controller.abort();if(owner.current===controller)owner.current=null}},[scope])
 const collecting=(goal.follow_state?.collections?.queued??0)+(goal.follow_state?.collections?.running??0)>0
 const stopped=goal.status!=='running'||goal.compatibility_json?.execution_mode==='manual'
 function check(){
  const controller=owner.current,epoch=sessionEpoch();if(!controller||controller.signal.aborted)return
  setNotice(null)
  void act(async()=>{
   const result=await sourceGoalsApi.check(goal.id,{expected_version_id:goal.active_version_id},{spaceId,signal:controller.signal})
   if(!controller.signal.aborted&&owner.current===controller&&current.current===scope&&sessionEpoch()===epoch)setNotice({scope,key:result.status==='queued'?'checkQueued':'checkAlreadyRunning'})
  })
 }
 return <div className="space-y-1">
  <Button size="sm" variant="outline" disabled={busy||stopped||collecting} onClick={check}>{t(`sourceGoals.${collecting?'checkInProgress':'checkNow'}`)}</Button>
  <p className="text-xs text-muted-foreground">{t(`sourceGoals.${stopped?'checkStopped':'checkHint'}`)}</p>
  {notice?.scope===scope&&<p role="status" className="text-xs text-muted-foreground">{t(`sourceGoals.${notice.key}`)}</p>}
 </div>
}
