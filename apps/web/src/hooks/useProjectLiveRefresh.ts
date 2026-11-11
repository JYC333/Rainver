import {useEffect,useRef} from 'react'
import {useParams} from 'react-router-dom'
import {projectsApi,ApiRequestError} from '../api/client'
import {registerInMemoryResidue,sessionEpoch} from '../lib/sessionResidue'

type Entry={listeners:Set<()=>void>;close:()=>void}
const entries=new Map<string,Entry>()
registerInMemoryResidue(()=>{for(const e of entries.values())e.close();entries.clear()})

/** One SSE connection per visible Project/tab shared by navigation, Pulse,
 * Board and workspaces. Bursts collapse into one invalidation. No data polling;
 * reconnect/foreground entry do one catch-up read instead of replaying events. */
function subscribe(key:string,project:string,space:string|undefined,listener:()=>void){
 let entry=entries.get(key)
 if(!entry){
  const listeners=new Set<()=>void>();let closed=false,denied=false,controller:AbortController|undefined
  let retry:ReturnType<typeof setTimeout>|undefined,flush:ReturnType<typeof setTimeout>|undefined,failures=0
  const invalidate=()=>{if(!closed&&document.visibilityState==='visible'&&!flush)flush=setTimeout(()=>{flush=undefined;for(const read of listeners)read()},150)}
  const connect=async()=>{
   if(closed||denied||document.visibilityState!=='visible')return
   controller?.abort();const current=new AbortController();controller=current
   try{await projectsApi.streamUpdates(project,frame=>{
     if(closed||current.signal.aborted)return
     failures=0;invalidate()
     if(frame.type==='denied'){denied=true;current.abort()}
   },{spaceId:space,signal:current.signal})}
   catch(error){
    if(closed||current.signal.aborted)return
    if(error instanceof ApiRequestError&&[401,403,404].includes(error.status)){denied=true;invalidate();return}
    const backoff=Math.min(60000,1000*2**Math.min(failures++,6))
    retry=setTimeout(()=>{retry=undefined;void connect()},backoff*(0.75+Math.random()*0.5))
   }
  }
  const foreground=()=>{
   if(document.visibilityState!=='visible'){controller?.abort();if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);retry=undefined;flush=undefined;return}
   invalidate()
   if(!controller||controller.signal.aborted){void connect()}
  }
  const focus=()=>{if(document.visibilityState==='visible')invalidate()}
  document.addEventListener('visibilitychange',foreground);window.addEventListener('focus',focus)
  entry={listeners,close:()=>{closed=true;controller?.abort();if(retry)clearTimeout(retry);if(flush)clearTimeout(flush);document.removeEventListener('visibilitychange',foreground);window.removeEventListener('focus',focus)}}
  entries.set(key,entry);void connect()
 }
 entry.listeners.add(listener)
 return()=>{entry.listeners.delete(listener);if(!entry.listeners.size){entry.close();if(entries.get(key)===entry)entries.delete(key)}}
}

export function useProjectLiveRefresh(projectId:string,refresh:()=>void|Promise<void>,enabled=true){
 const {spaceId}=useParams<{spaceId:string}>(),epoch=sessionEpoch()
 const latest=useRef(refresh);latest.current=refresh
 useEffect(()=>{
  if(!enabled||!projectId)return
  let alive=true,running=false,owed=false
  const read=async()=>{
   if(!alive)return
   if(running){owed=true;return}
   running=true
   do{owed=false;try{await latest.current()}catch{/* The read surface owns errors. */}}while(alive&&owed)
   running=false
  }
  const stop=subscribe(`${epoch}:${spaceId??''}:${projectId}`,projectId,spaceId,()=>{void read()})
  return()=>{alive=false;stop()}
 },[projectId,spaceId,epoch,enabled])
}
