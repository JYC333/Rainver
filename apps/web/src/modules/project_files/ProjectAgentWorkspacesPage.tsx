import {useCallback,useEffect,useRef,useState} from 'react'
import {useParams,useSearchParams} from 'react-router-dom'
import {ArrowLeft,Loader2} from 'lucide-react'
import type {AgentWorkspaceGroup} from '@rainver/protocol'
import {agentWorkspacesApi} from '../../api/client'
import {Button} from '../../components/ui/button'
import {EmptyState} from '../../components/ui/empty-state'
import {Tabs,TabsList,TabsTrigger} from '../../components/ui/tabs'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {useProjectLiveRefresh} from '../../hooks/useProjectLiveRefresh'
import {AgentWorkspaceGroupCard} from './AgentWorkspaceGroupCard'
import {failureKind,readLoadedPages,type LoadError} from './AgentWorkspaceRow'

type View='current'|'history'

/**
 * Files & Code › Agent workspaces. A read overview of the Project's isolated
 * Agent work, one entry per conversation × repository aggregated on the
 * server: current state, latest result and what still needs a decision. The
 * per-generation execution history (delegations, batches, older generations,
 * reclaims) is folded inside each entry. Private worktrees are never
 * registered as Project Folders or browsed here.
 */
export default function ProjectAgentWorkspacesPage(){
 const {t}=useAppTranslation()
 const {projectId=''}=useParams<{projectId:string}>()
 const [params,setParams]=useSearchParams()
 const view:View=params.get('view')==='history'?'history':'current'
 const [items,setItems]=useState<AgentWorkspaceGroup[]>([])
 const [cursor,setCursor]=useState<string|null>(null)
 const [loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false)
 const [error,setError]=useState<LoadError|null>(null),[moreError,setMoreError]=useState(false)
 const [reload,setReload]=useState(0)
 const request=useRef(0),more=useRef(false),shown=useRef<string|null>(null),pages=useRef(1),initial=useRef(true),owed=useRef(false)
 useEffect(()=>{
  const current=++request.current
  // A new read supersedes any continuation in flight; another view or Project
  // never keeps the previous list or its cursor.
  pages.current=1;initial.current=true;more.current=false;setLoadingMore(false);setLoading(true);setError(null);setMoreError(false)
  const key=`${projectId}|${view}`
  if(shown.current!==null&&shown.current!==key){setItems([]);setCursor(null)}
  shown.current=key
  agentWorkspacesApi.groups(projectId,{view}).then(page=>{if(current!==request.current)return;setItems(page.items);setCursor(page.next_cursor)})
   .catch(e=>{if(current!==request.current)return;setItems([]);setCursor(null);setError(failureKind(e))})
   .finally(()=>{if(current===request.current){initial.current=false;setLoading(false);if(owed.current){owed.current=false;void quietRefresh()}}})
  return()=>{request.current+=1}
 },[projectId,view,reload])
 const quietRefresh=useCallback(async()=>{
  if(initial.current||more.current){owed.current=true;return}
  const current=request.current,depth=pages.current
  try{
   const page=await readLoadedPages(cursor=>agentWorkspacesApi.groups(projectId,{view,...(cursor?{cursor}:{})}),depth,item=>item.group_key)
   if(current!==request.current||more.current||depth!==pages.current){owed.current=true;return}
   setItems(page.items);setCursor(page.next_cursor);setError(null)
  }catch(e){if(current===request.current&&failureKind(e)==='denied'){setItems([]);setCursor(null);setError('denied')}}
 },[projectId,view])
 useProjectLiveRefresh(projectId,quietRefresh,error!=='denied')
 async function loadMore(){
  // Only from a settled first page: an older cursor never pages a newer read.
  if(!cursor||loading||more.current)return
  const current=request.current;more.current=true;setLoadingMore(true);setMoreError(false)
  try{const page=await agentWorkspacesApi.groups(projectId,{view,cursor});if(current!==request.current)return;setItems(held=>[...held,...page.items.filter(item=>!held.some(h=>h.group_key===item.group_key))]);setCursor(page.next_cursor);pages.current+=1}
  catch(e){if(current!==request.current)return;if(failureKind(e)==='denied'){setItems([]);setCursor(null);setError('denied')}else setMoreError(true)}
  finally{if(current===request.current){more.current=false;setLoadingMore(false);if(owed.current){owed.current=false;void quietRefresh()}}}
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
  {view==='history'&&<p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.history_note')}</p>}
  {loading&&items.length===0?<p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true"/>{t('agent_workspaces_ui.loading')}</p>
   :error?<EmptyState title={t(`agent_workspaces_ui.error.${error}.title`)} description={t(`agent_workspaces_ui.error.${error}.description`)} action={error==='failed'?<Button size="sm" variant="outline" onClick={()=>setReload(n=>n+1)}>{t('agent_workspaces_ui.retry')}</Button>:undefined}/>
   :items.length===0&&!cursor?<EmptyState title={t(`agent_workspaces_ui.empty.${view}.title`)} description={t(`agent_workspaces_ui.empty.${view}.description`)} action={view==='current'?<Button size="sm" variant="outline" onClick={()=>setParams({view:'history'},{replace:true})}>{t('agent_workspaces_ui.view.history')}</Button>:undefined}/>
   :<div className="space-y-3" aria-busy={loading}>
    {items.length===0&&<p role="status" className="text-sm text-muted-foreground">{t('agent_workspaces_ui.more_available')}</p>}
    {items.map(group=><AgentWorkspaceGroupCard key={group.group_key} projectId={projectId} group={group} onChanged={()=>setReload(n=>n+1)}/>)}
    {cursor&&<div className="flex flex-wrap items-center justify-center gap-2 pt-1">
     <Button size="sm" variant="outline" disabled={loadingMore||loading} onClick={()=>void loadMore()}>{loadingMore?t('agent_workspaces_ui.loading'):t('agent_workspaces_ui.load_more')}</Button>
     {moreError&&<span role="alert" className="text-xs text-destructive">{t('agent_workspaces_ui.error.failed.title')}</span>}
    </div>}
   </div>}
 </div>
}
