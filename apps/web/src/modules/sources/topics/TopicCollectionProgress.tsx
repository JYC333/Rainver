import {useEffect,useRef,useState} from 'react'
import type {RunTurn,SourceGoalDetail} from '@rainver/protocol'
import {ApiRequestError,runsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {SpaceLink} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {formatRelativeTime} from '../../../i18n/format'

const ACTIVE=['queued','running','waiting_for_review','waiting_for_dependency','cancelling','validating']
type CollectionRun=NonNullable<SourceGoalDetail['native_runs']>[number]
/** Never subscribe using an inaccessible collection's private Run identifier. */
export function activeCollectionRun(detail:SourceGoalDetail):CollectionRun|undefined{
 const visible=new Set<string>()
 for(const audit of detail.runs){
  const binding=detail.bindings.find(b=>b.id===audit.binding_id)
  if(!binding||'unavailable'in binding)continue
  const result=audit.result_json as {native_run_id?:unknown}|null
  if(typeof result?.native_run_id==='string')visible.add(result.native_run_id)
 }
 for(const preview of detail.previews)for(const source of preview.result_json.contributions){
  if(source.status!=='unavailable'&&typeof source.run_id==='string')visible.add(source.run_id)
 }
 return detail.native_runs?.find(run=>visible.has(run.id)&&ACTIVE.includes(run.phase??run.status))
}

/** Compact live view over the existing authorized Run-turn SSE. Neither a
 * heartbeat nor silence is evidence that the Agent is making progress or stuck. */
export function TopicCollectionProgress({run,spaceId,onReload}:{run:CollectionRun;spaceId:string;onReload:()=>Promise<void>}){
 const {t}=useAppTranslation()
 const [turn,setTurn]=useState<RunTurn|null>(null)
 const [connection,setConnection]=useState<'connecting'|'live'|'retrying'|'denied'>('connecting')
 const [lastActivity,setLastActivity]=useState<number|null>(null)
 const [now,setNow]=useState(Date.now)
 const [stopping,setStopping]=useState(false)
 const [stopError,setStopError]=useState(false)
 const reload=useRef(onReload);reload.current=onReload
 useEffect(()=>{
  const controller=new AbortController();let retry:ReturnType<typeof setTimeout>|undefined
  let fingerprint:string|undefined;let settled=false
  setTurn(null);setLastActivity(null);setConnection('connecting')
  const connect=async()=>{
   try{
    await runsApi.streamTurn(run.id,{spaceId,signal:controller.signal,onTurn:next=>{
     if(controller.signal.aborted||next.run_id!==run.id)return
     const signature=JSON.stringify([next.cursor,next.state,next.blocked_on,next.parts])
     if(signature!==fingerprint){
      setLastActivity(fingerprint===undefined?(next.updated_at?Date.parse(next.updated_at):null):Date.now())
      fingerprint=signature
     }
     setTurn(next);setConnection('live')
     if(next.state==='done'||next.state==='failed'){settled=true;void reload.current().catch(()=>{})}
    }})
    if(!controller.signal.aborted&&!settled){setConnection('retrying');retry=setTimeout(()=>void connect(),5000)}
   }catch(error){
    if(controller.signal.aborted||settled)return
    if(error instanceof ApiRequestError&&[401,403,404].includes(error.status)){
     setTurn(null);setLastActivity(null);setConnection('denied');return
    }
    setConnection('retrying');retry=setTimeout(()=>void connect(),5000)
   }
  }
  void connect()
  return()=>{controller.abort();clearTimeout(retry)}
 },[run.id,spaceId])
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer)},[])
 const tools=turn?.parts.filter(p=>p.type==='tool_call')??[]
 const latestText=turn?.parts.filter(p=>p.type==='text'&&p.text.trim()).slice(-1)[0]
 const waiting=turn?.state==='blocked'||['waiting_for_review','waiting_for_dependency'].includes(run.status)
 const phase=turn?.state==='failed'?'failed':turn?.state==='done'||run.phase==='validating'?'saving':run.status==='cancelling'?'stopping':waiting?'waiting':run.status==='queued'&&!turn?.parts.length?'queued':'working'
 const quiet=phase==='working'&&lastActivity!==null&&now-lastActivity>=5*60_000
 async function stop(){
  setStopping(true);setStopError(false)
  try{await runsApi.stop(run.id,{spaceId});await reload.current()}
  catch{setStopError(true)}finally{setStopping(false)}
 }
 return <section aria-label={t('topics.collectionProgress.title')} className="space-y-2 border-t border-border pt-3 text-sm">
  <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="font-medium">{t(`topics.collectionProgress.${phase}`)}</p><div className="flex flex-wrap gap-2">
   <Button size="sm" variant="ghost" asChild><SpaceLink to={`/runs/${run.id}`}>{t('topics.openExecution')}</SpaceLink></Button>
   {!['saving','failed'].includes(phase)&&connection!=='denied'&&<Button size="sm" variant="outline" disabled={stopping||phase==='stopping'} onClick={()=>void stop()}>{t(`topics.collectionProgress.${stopping||phase==='stopping'?'stopping':'stop'}`)}</Button>}
  </div></div>
  {connection==='denied'?<p className="text-muted-foreground">{t('topics.collectionProgress.denied')}</p>:<>
   {tools.length>0&&<><p className="text-xs text-muted-foreground">{t('topics.collectionProgress.tools',{completed:tools.filter(p=>p.status==='succeeded').length,count:tools.length})}</p><ul className="space-y-1">{tools.slice(-2).map(tool=><li key={tool.index} className="flex min-w-0 gap-2"><span className="min-w-0 truncate" title={tool.name}>{tool.name}</span><span className="shrink-0 text-xs text-muted-foreground">{t(`topics.collectionProgress.tool.${tool.status}`)}</span></li>)}</ul></>}
   {latestText?.type==='text'&&<p className="line-clamp-3 break-words text-muted-foreground">{latestText.text.slice(-600)}</p>}
   {lastActivity!==null&&<p className="text-xs text-muted-foreground">{t('topics.collectionProgress.lastActivity',{time:formatRelativeTime(lastActivity,new Date(now))})}</p>}
   {quiet&&<p className="text-xs text-muted-foreground">{t('topics.collectionProgress.quiet')}</p>}
   {(connection==='retrying'||connection==='connecting')&&<p className="text-xs text-muted-foreground">{t(`topics.collectionProgress.${connection}`)}</p>}
  </>}
  {stopError&&<p role="alert" className="text-destructive">{t('topics.collectionProgress.stopError')}</p>}
 </section>
}
