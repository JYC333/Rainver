import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react'
import type {AgentWorkspaceDetail,AgentWorkspaceItem,AgentWorkspaceState} from '@rainver/protocol'
import {agentWorkspacesApi,ApiRequestError} from '../../api/client'
import {Badge,type BadgeProps} from '../../components/ui/badge'
import {Button} from '../../components/ui/button'
import {Card} from '../../components/ui/card'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {formatDateTime} from '../../i18n/format'
import {useProjectLiveRefresh} from '../../hooks/useProjectLiveRefresh'
import {WorkspaceChangeList,workspaceRunActive} from '../runs/WorkspaceChangeList'

/** One workspace generation in an Agent workspaces execution history, with its batches on demand. */
export type LoadError='denied'|'failed'
export const STATE_VARIANT:Record<AgentWorkspaceState,BadgeProps['variant']>={attention:'warning',missing:'warning',running:'default',integrating:'default',saved:'secondary',unsaved:'secondary',merged:'success',adopted:'success',in_target:'success',adoption_unverified:'muted',no_changes:'muted',kept:'muted',discarded:'muted',missing_closed:'muted',idle:'muted'}

export function failureKind(error:unknown):LoadError{return error instanceof ApiRequestError&&[401,403,404].includes(error.status)?'denied':'failed'}

/** Delegated workspaces are shown under the main workspace they were forked from
 * when both are on the loaded pages; otherwise they stay visible on their own,
 * so paging or a parent in another view never hides unfinished delegated work. */
export function groupDelegations(items:AgentWorkspaceItem[]){
 const byId=new Map(items.map(i=>[i.workspace_id,i])),children=new Map<string,AgentWorkspaceItem[]>()
 const rootOf=(item:AgentWorkspaceItem):string|null=>{
  let parent=item.parent_workspace_id,depth=0
  while(parent&&depth++<20){const p=byId.get(parent);if(!p)return null;if(!p.parent_workspace_id)return p.workspace_id;parent=p.parent_workspace_id}
  return null
 }
 for(const item of items){const root=item.parent_workspace_id?rootOf(item):null;if(root)children.set(root,[...(children.get(root)??[]),item])}
 const nested=new Set([...children.values()].flat().map(i=>i.workspace_id))
 return items.filter(i=>!nested.has(i.workspace_id)).map(item=>({item,children:children.get(item.workspace_id)??[]}))
}

export function WorkspaceRow({projectId,item,onChanged,nested=false,children}:{projectId:string;item:AgentWorkspaceItem;onChanged:()=>void;nested?:boolean;children?:ReactNode}){
 const {t}=useAppTranslation()
 const [open,setOpen]=useState(false)
 const [detail,setDetail]=useState<AgentWorkspaceDetail|null>(null),[detailError,setDetailError]=useState<LoadError|null>(null),[detailLoading,setDetailLoading]=useState(false)
 const [moreError,setMoreError]=useState(false)
 const [refresh,setRefresh]=useState(0)
 const detailRequest=useRef(0),detailPages=useRef(1),detailBusy=useRef(false),detailOwed=useRef(false),refreshDetail=useRef(()=>{})
 const loadDetail=useCallback(async(cursor?:string)=>{
  const current=++detailRequest.current;detailBusy.current=true;if(!cursor)detailPages.current=1
  setDetailLoading(true);setDetailError(null);setMoreError(false)
  try{const page=await agentWorkspacesApi.detail(projectId,item.workspace_id,cursor?{cursor}:{})
   if(current!==detailRequest.current)return
   if(cursor)detailPages.current+=1
   setDetail(held=>cursor&&held?{...page,items:[...held.items,...page.items.filter(entry=>!held.items.some(h=>h.change.change_set_id===entry.change.change_set_id))]}:page)}
  catch(e){if(current!==detailRequest.current)return;const kind=failureKind(e);if(cursor&&kind==='failed')setMoreError(true);else{setDetail(null);setDetailError(kind)}}
  finally{if(current===detailRequest.current){detailBusy.current=false;setDetailLoading(false);if(detailOwed.current){detailOwed.current=false;refreshDetail.current()}}}
 },[projectId,item.workspace_id])
 useEffect(()=>{if(open)void loadDetail();return()=>{detailRequest.current+=1;detailBusy.current=false}},[open,refresh,loadDetail])
 const quietDetail=useCallback(async()=>{
  if(detailBusy.current){detailOwed.current=true;return}
  const current=detailRequest.current,depth=detailPages.current
  try{
   const page=await readLoadedPages(cursor=>agentWorkspacesApi.detail(projectId,item.workspace_id,cursor?{cursor}:{}),depth,entry=>entry.change.change_set_id)
   if(current!==detailRequest.current)return
   setDetail({workspace_id:item.workspace_id,...page});setDetailError(null)
  }catch(e){if(current===detailRequest.current&&failureKind(e)==='denied'){setDetail(null);setDetailError('denied')}}
 },[projectId,item.workspace_id])
 refreshDetail.current=()=>{void quietDetail()}
 useProjectLiveRefresh(projectId,quietDetail,open&&detailError!=='denied')
 const title=item.conversation?.title||item.task?.title||t(`agent_workspaces_ui.owner.${item.owner_kind}`)
 const conversationHref=item.conversation?.room_id?`/rooms/${encodeURIComponent(item.conversation.room_id)}?conversation=${encodeURIComponent(item.conversation.id)}`:null
 const Shell=nested?'div':Card
 return <Shell className={nested?'space-y-2 border-t border-border pt-2':'space-y-2 p-3 sm:p-4'} data-testid={`agent-workspace-${item.workspace_id}`}>
  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
   <div className="min-w-0 flex-1 space-y-1">
    <p className="break-words text-sm font-medium">{title}</p>
    <p className="break-words text-xs text-muted-foreground">
     {[item.agent?.name,item.folder?.name,t('agent_workspaces_ui.updated',{time:formatDateTime(item.activity_at,{fallback:''})})].filter(Boolean).join(' · ')}
    </p>
   </div>
   <Badge variant={STATE_VARIANT[item.work_state]}>{t(`agent_workspaces_ui.state.${item.work_state}`)}</Badge>
  </div>
  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
   {item.owner_kind==='delegation'&&<Badge variant="outline">{t('agent_workspaces_ui.owner.delegation')}</Badge>}
   {!item.host.online&&<Badge variant="outline">{t('agent_workspaces_ui.host_offline',{host:item.host.name})}</Badge>}
   {item.retention&&<span>{t(item.retention.state==='reclaimed'&&item.retention.reason==='discarded'?'workspace_ui.execution.retention.state.discarded':item.retention.state==='missing'&&item.retention.reason==='missing_acknowledged'?'agent_workspaces_ui.state.missing_closed':`workspace_ui.execution.retention.state.${item.retention.state}`,{time:formatDateTime(item.retention.state==='reclaimed'?item.retention.reclaimed_at:item.retention.state==='held'?item.retention.hold_until:item.retention.reclaim_after,{fallback:''})})}</span>}
  </div>
  <div className="flex flex-wrap gap-2">
   <Button size="sm" variant="outline" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{t(open?'agent_workspaces_ui.hide_details':'agent_workspaces_ui.details')}</Button>
   {conversationHref&&<Button size="sm" variant="ghost" asChild><SpaceLink to={conversationHref}>{t('agent_workspaces_ui.open_conversation')}</SpaceLink></Button>}
   {item.task&&<Button size="sm" variant="ghost" asChild><SpaceLink to={`/projects/${projectId}/tasks/${item.task.id}`}>{t('agent_workspaces_ui.open_task')}</SpaceLink></Button>}
   <Button size="sm" variant="ghost" asChild><SpaceLink to={`/runs/${item.run.id}`}>{t('agent_workspaces_ui.open_run')}</SpaceLink></Button>
  </div>
  {open&&<div className="space-y-3 border-t border-border pt-3">
   {detailLoading&&!detail?<p role="status" className="text-xs text-muted-foreground">{t('agent_workspaces_ui.loading')}</p>
    :detailError?<div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">{t(`agent_workspaces_ui.error.${detailError}.title`)}{detailError==='failed'&&<Button size="sm" variant="outline" onClick={()=>setRefresh(n=>n+1)}>{t('agent_workspaces_ui.retry')}</Button>}</div>
    :detail&&detail.items.length===0&&!detail.next_cursor?<p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.no_visible_batches')}</p>
    :detail&&<>
     <WorkspaceChangeList entries={detail.items.map(entry=>({change:entry.change,runId:entry.run.id,runSucceeded:entry.run.status==='succeeded',runActive:workspaceRunActive(entry.run.status)}))} onChanged={()=>{setRefresh(n=>n+1);onChanged()}} showRunLink/>
     {detail.next_cursor&&<div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={detailLoading} onClick={()=>void loadDetail(detail.next_cursor!)}>{detailLoading?t('agent_workspaces_ui.loading'):t('agent_workspaces_ui.load_more')}</Button>
      {moreError&&<span role="alert" className="text-xs text-destructive">{t('agent_workspaces_ui.error.failed.title')}</span>}
     </div>}
     {item.retention?.state==='reclaimed'&&<p className="text-xs text-muted-foreground">{t(item.retention.reason==='discarded'?'agent_workspaces_ui.discarded_note':'agent_workspaces_ui.reclaimed_note')}</p>}
    </>}
  </div>}
  {children}
 </Shell>
}

export async function readLoadedPages<T>(read:(cursor?:string)=>Promise<{items:T[];next_cursor:string|null}>,depth:number,id:(item:T)=>string){
 const items:T[]=[],seen=new Set<string>();let cursor:string|undefined
 for(let n=0;n<depth;n++){
  const page=await read(cursor);for(const item of page.items)if(!seen.has(id(item))){seen.add(id(item));items.push(item)}
  if(!page.next_cursor)return {items,next_cursor:null}
  cursor=page.next_cursor
 }
 return {items,next_cursor:cursor??null}
}
