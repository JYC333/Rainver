import {useCallback,useEffect,useRef,useState} from 'react'
import {GitBranch} from 'lucide-react'
import type {WorkspaceChangeEntry} from '@rainver/protocol'
import {agentWorkspacesApi,ApiRequestError} from '../../api/client'
import {Badge} from '../../components/ui/badge'
import {Button} from '../../components/ui/button'
import {useAppTranslation} from '../../i18n'
import {useConversationScope} from './ConversationScope'
import {WorkspaceChangeList} from '../runs/WorkspaceChangeList'

/**
 * Unfinished workspace work of the whole conversation that no loaded turn
 * summary already shows: earlier pages, failed turns without a reply,
 * retained generations and unadopted delegated results. One collapsed line.
 */
export function ConversationPendingWork({conversationId,presented,refreshToken,agentName}:{conversationId:string;presented:ReadonlySet<string>;refreshToken:string;agentName:(agentId:string|null)=>string|undefined}){
 const {t}=useAppTranslation(),scope=useConversationScope()
 const [items,setItems]=useState<WorkspaceChangeEntry[]>([])
 const [cursor,setCursor]=useState<string|null>(null)
 const [error,setError]=useState(false),[moreError,setMoreError]=useState(false),[loadingMore,setLoadingMore]=useState(false)
 // Continuation waits for the current first page: an older cursor never pages a newer read.
 const [ready,setReady]=useState(false)
 const [reload,setReload]=useState(0)
 const generation=useRef(0),more=useRef(false),shown=useRef<{conversationId:string;scope:unknown}|null>(null)
 const refresh=useCallback(()=>setReload(n=>n+1),[])
 // A refusal withdraws what was shown; any other failure is reported, not read as "nothing pending".
 const refused=(e:unknown)=>e instanceof ApiRequestError&&[401,403,404].includes(e.status)
 useEffect(()=>{
  const current=++generation.current
  // A new read supersedes any continuation still in flight: it can no longer
  // apply its page or hold the button disabled.
  more.current=false;setLoadingMore(false);setMoreError(false);setReady(false)
  // Another conversation or scope (Space, permission) never shows the previous one's work.
  if(shown.current&&(shown.current.conversationId!==conversationId||shown.current.scope!==scope)){setItems([]);setCursor(null)}
  shown.current={conversationId,scope}
  // Async so that even a synchronous client failure is a reported read failure,
  // never an error that takes the conversation down with it.
  void (async()=>agentWorkspacesApi.conversationChanges(conversationId,{},scope))().then(page=>{if(current===generation.current){setItems(page.items);setCursor(page.next_cursor);setError(false);setReady(true)}})
   .catch(e=>{if(current!==generation.current||scope.signal?.aborted)return
    if(refused(e)){setItems([]);setCursor(null);setError(false)}else setError(true)})
 },[conversationId,refreshToken,reload,scope])
 async function loadMore(){
  if(!cursor||!ready||more.current)return
  const current=generation.current;more.current=true;setLoadingMore(true);setMoreError(false)
  try{const page=await agentWorkspacesApi.conversationChanges(conversationId,{cursor},scope);if(current!==generation.current)return
   setItems(held=>[...held,...page.items.filter(item=>!held.some(h=>h.change.change_set_id===item.change.change_set_id))]);setCursor(page.next_cursor)}
  catch(e){if(current!==generation.current)return;if(refused(e)){setItems([]);setCursor(null)}else setMoreError(true)}
  finally{if(current===generation.current){more.current=false;setLoadingMore(false)}}
 }
 const remaining=items.filter(item=>!presented.has(item.change.change_set_id))
 // Later pages may still hold unfinished work even when all of this one is
 // already shown above: continue to it rather than reporting nothing.
 const exhausted=ready&&!remaining.length&&Boolean(cursor)&&!loadingMore&&!moreError&&!error
 useEffect(()=>{if(exhausted)void loadMore()},[exhausted,cursor])
 if(error)return <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{t('agent_workspaces_ui.turn_summary.pending_read_failed')}<Button size="sm" variant="ghost" onClick={refresh}>{t('workspace_ui.execution.refresh')}</Button></p>
 if(!remaining.length&&!(cursor&&moreError))return null
 const attention=remaining.some(item=>item.change.state==='blocked'||item.change.cleanup_state==='blocked')
 return <details className="w-full min-w-0 rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs" data-testid="conversation-pending-work">
  <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-1.5 [&::-webkit-details-marker]:hidden">
   <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true"/>
   <span className="font-medium">{t(cursor?'agent_workspaces_ui.turn_summary.pending_title_more':'agent_workspaces_ui.turn_summary.pending_title',{count:remaining.length})}</span>
   {attention&&<Badge variant="warning" role="status">{t('agent_workspaces_ui.turn_summary.status.attention')}</Badge>}
  </summary>
  <div className="mt-2 border-t border-border pt-2">
   {remaining.length>0&&<WorkspaceChangeList entries={remaining.map(item=>({change:item.change,runId:item.run.id,runSucceeded:item.run.status==='succeeded',agentLabel:agentName(item.run.agent_id)}))} onChanged={refresh} showRunLink/>}
   {cursor&&<div className="mt-2 flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" disabled={loadingMore||!ready} onClick={()=>void loadMore()}>{loadingMore?t('agent_workspaces_ui.loading'):t('agent_workspaces_ui.load_more')}</Button>
    {moreError&&<span role="alert" className="text-destructive">{t('agent_workspaces_ui.turn_summary.pending_read_failed')}</span>}
   </div>}
  </div>
 </details>
}
