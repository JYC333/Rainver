import {useCallback,useEffect,useRef,useState} from 'react'
import {useParams,useSearchParams} from 'react-router-dom'
import {ArrowLeft,Loader2} from 'lucide-react'
import type {AgentWorkspaceDetail,AgentWorkspaceItem,AgentWorkspaceState} from '@rainver/protocol'
import {agentWorkspacesApi,ApiRequestError} from '../../api/client'
import {Badge,type BadgeProps} from '../../components/ui/badge'
import {Button} from '../../components/ui/button'
import {Card} from '../../components/ui/card'
import {EmptyState} from '../../components/ui/empty-state'
import {Tabs,TabsList,TabsTrigger} from '../../components/ui/tabs'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {formatDateTime} from '../../i18n/format'
import {WorkspaceChangeList} from '../runs/WorkspaceChangeList'

type View='current'|'history'
type LoadError='denied'|'failed'
const STATE_VARIANT:Record<AgentWorkspaceState,BadgeProps['variant']>={attention:'warning',running:'default',integrating:'default',saved:'secondary',unsaved:'secondary',merged:'success',adopted:'success',adoption_unverified:'muted',no_changes:'muted',kept:'muted',idle:'muted'}

function failureKind(error:unknown):LoadError{return error instanceof ApiRequestError&&[401,403,404].includes(error.status)?'denied':'failed'}

/**
 * Files & Code › Agent workspaces. A read overview of the Project's isolated
 * Agent workspaces: which conversation or Task each belongs to, its work and
 * merge state, and retention. Private worktrees are never registered as
 * Project Folders or browsed here; reclaimed trees are reported as reclaimed.
 */
export default function ProjectAgentWorkspacesPage(){
 const {t}=useAppTranslation()
 const {projectId=''}=useParams<{projectId:string}>()
 const [params,setParams]=useSearchParams()
 const view:View=params.get('view')==='history'?'history':'current'
 const [items,setItems]=useState<AgentWorkspaceItem[]>([])
 const [cursor,setCursor]=useState<string|null>(null)
 const [loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false)
 const [error,setError]=useState<LoadError|null>(null),[moreError,setMoreError]=useState(false)
 const [reload,setReload]=useState(0)
 const request=useRef(0),more=useRef(false),shown=useRef<string|null>(null)
 useEffect(()=>{
  const current=++request.current
  // A new read supersedes any continuation in flight; another view or Project
  // never keeps the previous list or its cursor.
  more.current=false;setLoadingMore(false);setLoading(true);setError(null);setMoreError(false)
  const key=`${projectId}|${view}`
  if(shown.current!==null&&shown.current!==key){setItems([]);setCursor(null)}
  shown.current=key
  agentWorkspacesApi.list(projectId,{view}).then(page=>{if(current!==request.current)return;setItems(page.items);setCursor(page.next_cursor)})
   .catch(e=>{if(current!==request.current)return;setItems([]);setCursor(null);setError(failureKind(e))})
   .finally(()=>{if(current===request.current)setLoading(false)})
 },[projectId,view,reload])
 async function loadMore(){
  // Only from a settled first page: an older cursor never pages a newer read.
  if(!cursor||loading||more.current)return
  const current=request.current;more.current=true;setLoadingMore(true);setMoreError(false)
  try{const page=await agentWorkspacesApi.list(projectId,{view,cursor});if(current!==request.current)return;setItems(held=>[...held,...page.items.filter(item=>!held.some(h=>h.workspace_id===item.workspace_id))]);setCursor(page.next_cursor)}
  catch(e){if(current!==request.current)return;if(failureKind(e)==='denied'){setItems([]);setCursor(null);setError('denied')}else setMoreError(true)}
  finally{if(current===request.current){more.current=false;setLoadingMore(false)}}
 }
 return <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
  <Button size="sm" variant="ghost" className="-ml-2 gap-1.5" asChild><SpaceLink to={`/projects/${projectId}/files`}><ArrowLeft className="size-3.5" aria-hidden="true"/>{t('agent_workspaces_ui.back')}</SpaceLink></Button>
  <div className="space-y-1">
   <h1 className="text-xl font-semibold">{t('agent_workspaces_ui.title')}</h1>
   <p className="text-sm text-muted-foreground">{t('agent_workspaces_ui.description')}</p>
  </div>
  <Tabs value={view} onValueChange={value=>{const next=new URLSearchParams(params);if(value==='history')next.set('view','history');else next.delete('view');setParams(next,{replace:true})}}>
   <TabsList>
    <TabsTrigger value="current">{t('agent_workspaces_ui.view.current')}</TabsTrigger>
    <TabsTrigger value="history">{t('agent_workspaces_ui.view.history')}</TabsTrigger>
   </TabsList>
  </Tabs>
  {loading&&items.length===0?<p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true"/>{t('agent_workspaces_ui.loading')}</p>
   :error?<EmptyState title={t(`agent_workspaces_ui.error.${error}.title`)} description={t(`agent_workspaces_ui.error.${error}.description`)} action={error==='failed'?<Button size="sm" variant="outline" onClick={()=>setReload(n=>n+1)}>{t('agent_workspaces_ui.retry')}</Button>:undefined}/>
   :items.length===0&&!cursor?<EmptyState title={t(`agent_workspaces_ui.empty.${view}.title`)} description={t(`agent_workspaces_ui.empty.${view}.description`)} action={view==='current'?<Button size="sm" variant="outline" onClick={()=>setParams({view:'history'},{replace:true})}>{t('agent_workspaces_ui.view.history')}</Button>:undefined}/>
   :<div className="space-y-3" aria-busy={loading}>
    {items.length===0&&<p role="status" className="text-sm text-muted-foreground">{t('agent_workspaces_ui.more_available')}</p>}
    {items.map(item=><WorkspaceRow key={item.workspace_id} projectId={projectId} item={item} onChanged={()=>setReload(n=>n+1)}/>)}
    {cursor&&<div className="flex flex-wrap items-center justify-center gap-2 pt-1">
     <Button size="sm" variant="outline" disabled={loadingMore||loading} onClick={()=>void loadMore()}>{loadingMore?t('agent_workspaces_ui.loading'):t('agent_workspaces_ui.load_more')}</Button>
     {moreError&&<span role="alert" className="text-xs text-destructive">{t('agent_workspaces_ui.error.failed.title')}</span>}
    </div>}
   </div>}
 </div>
}

function WorkspaceRow({projectId,item,onChanged}:{projectId:string;item:AgentWorkspaceItem;onChanged:()=>void}){
 const {t}=useAppTranslation()
 const [open,setOpen]=useState(false)
 const [detail,setDetail]=useState<AgentWorkspaceDetail|null>(null),[detailError,setDetailError]=useState<LoadError|null>(null),[detailLoading,setDetailLoading]=useState(false)
 const [moreError,setMoreError]=useState(false)
 const [refresh,setRefresh]=useState(0)
 const loadDetail=useCallback(async(cursor?:string)=>{
  setDetailLoading(true);setDetailError(null);setMoreError(false)
  try{const page=await agentWorkspacesApi.detail(projectId,item.workspace_id,cursor?{cursor}:{})
   setDetail(held=>cursor&&held?{...page,items:[...held.items,...page.items.filter(entry=>!held.items.some(h=>h.change.change_set_id===entry.change.change_set_id))]}:page)}
  catch(e){const kind=failureKind(e);if(cursor&&kind==='failed')setMoreError(true);else{setDetail(null);setDetailError(kind)}}
  finally{setDetailLoading(false)}
 },[projectId,item.workspace_id])
 useEffect(()=>{if(open)void loadDetail()},[open,refresh,loadDetail])
 const title=item.conversation?.title||item.task?.title||t(`agent_workspaces_ui.owner.${item.owner_kind}`)
 const conversationHref=item.conversation?.room_id?`/rooms/${encodeURIComponent(item.conversation.room_id)}?conversation=${encodeURIComponent(item.conversation.id)}`:null
 return <Card className="space-y-2 p-3 sm:p-4" data-testid={`agent-workspace-${item.workspace_id}`}>
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
   {item.retention&&<span>{t(`workspace_ui.execution.retention.state.${item.retention.state}`,{time:formatDateTime(item.retention.state==='reclaimed'?item.retention.reclaimed_at:item.retention.state==='held'?item.retention.hold_until:item.retention.reclaim_after,{fallback:''})})}</span>}
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
     <WorkspaceChangeList entries={detail.items.map(entry=>({change:entry.change,runId:entry.run.id,runSucceeded:entry.run.status==='succeeded'}))} onChanged={()=>{setRefresh(n=>n+1);onChanged()}} showRunLink/>
     {detail.next_cursor&&<div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={detailLoading} onClick={()=>void loadDetail(detail.next_cursor!)}>{detailLoading?t('agent_workspaces_ui.loading'):t('agent_workspaces_ui.load_more')}</Button>
      {moreError&&<span role="alert" className="text-xs text-destructive">{t('agent_workspaces_ui.error.failed.title')}</span>}
     </div>}
     {item.retention?.state==='reclaimed'&&<p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.reclaimed_note')}</p>}
    </>}
  </div>}
 </Card>
}
