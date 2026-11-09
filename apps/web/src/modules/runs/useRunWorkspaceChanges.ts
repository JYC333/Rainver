import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {WorkspaceChangeView} from '@rainver/protocol'
import {ApiRequestError,runsApi,type RequestOptions} from '../../api/client'
import type {Run} from '../../types/api'
import {errMsg} from '../../lib/utils'
import {TERMINAL_CHANGE_STATES,type WorkspaceChangeEntryView} from './WorkspaceChangeList'

const POLL_MS=3000,MAX_POLLS=120,FORCED_POLLS=5

export function workspaceEnabled(run:Run){return run.contract_snapshot_json?.execution_workspace_version===1||Boolean(run.workspace_changes?.length)}

/** Work whose server facts can still change without a person acting. */
export function workspaceChangePending(c:WorkspaceChangeView){
 return ['ready','integrating'].includes(c.state)||c.state==='open'&&!c.source_commit&&c.workspace_state!=='blocked'
  ||TERMINAL_CHANGE_STATES.includes(c.state)&&['pending','running','retry_wait'].includes(c.cleanup_state)||c.retention?.state==='reclaiming'
}

/**
 * Each Run's bound batches, read through that Run and refreshed while they can
 * still change. A read failure is reported as such: it is never shown as "no
 * changes". The first Run listed keeps a batch several Runs share.
 */
export function useRunWorkspaceChanges(runs:readonly Run[],scope:RequestOptions){
 const enabledRuns=useMemo(()=>runs.filter(workspaceEnabled),[runs])
 const key=enabledRuns.map(run=>run.id).join(',')
 const [byRun,setByRun]=useState<Record<string,WorkspaceChangeView[]>>({})
 const [error,setError]=useState<string|null>(null)
 const [loaded,setLoaded]=useState(false)
 const [refresh,setRefresh]=useState(0)
 const forced=useRef(0)
 const shownKey=useRef<string|null>(null)
 const runsRef=useRef(enabledRuns);runsRef.current=enabledRuns
 useEffect(()=>{
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined,attempts=0
  const current=runsRef.current
  // A different set of Runs starts over; a refresh of the same set keeps the
  // stable frame (and an open summary) while it reads again.
  if(shownKey.current!==key){
   shownKey.current=key
   setByRun(Object.fromEntries(current.map(run=>[run.id,run.workspace_changes??[]])));setError(null);setLoaded(current.length===0)
  }
  if(!current.length)return
  async function load(){
   const results=await Promise.all(current.map(async run=>{
    try{return {id:run.id,changes:(await runsApi.get(run.id,scope)).workspace_changes??[],error:null as string|null,denied:false}}
    catch(e){return {id:run.id,changes:null,error:errMsg(e),denied:e instanceof ApiRequestError&&[401,403,404].includes(e.status)}}
   }))
   if(cancelled||scope.signal?.aborted)return
   setByRun(held=>Object.fromEntries(current.map(run=>{
    const result=results.find(r=>r.id===run.id)!
    // Never keep data after a refusal; keep the last read after a transient error.
    return [run.id,result.changes??(result.denied?[]:held[run.id]??[])]
   })))
   const failure=results.find(r=>r.error)
   setError(failure?.error??null);setLoaded(true)
   const pending=forced.current>0||results.some(r=>r.changes?.some(workspaceChangePending))
   if(forced.current>0)forced.current-=1
   if(pending&&++attempts<MAX_POLLS)timer=setTimeout(()=>void load(),POLL_MS)
  }
  void load()
  return()=>{cancelled=true;if(timer)clearTimeout(timer)}
 },[key,refresh,scope])
 const entries=useMemo(()=>{
  const seen=new Set<string>(),out:WorkspaceChangeEntryView[]=[]
  for(const run of enabledRuns)for(const change of byRun[run.id]??[]){
   if(seen.has(change.change_set_id))continue
   seen.add(change.change_set_id);out.push({change,runId:run.id,runSucceeded:run.status==='succeeded'})
  }
  return out
 },[byRun,enabledRuns])
 const reload=useCallback(()=>{forced.current=FORCED_POLLS;setRefresh(n=>n+1)},[])
 return {entries,error,loaded,reload,enabled:enabledRuns.length>0}
}
