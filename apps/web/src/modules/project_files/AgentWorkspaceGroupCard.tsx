import {useCallback,useEffect,useRef,useState} from 'react'
import {ChevronDown,ChevronRight} from 'lucide-react'
import type {AgentWorkspaceGroup,AgentWorkspaceItem} from '@rainver/protocol'
import {agentWorkspacesApi} from '../../api/client'
import {Badge} from '../../components/ui/badge'
import {Button} from '../../components/ui/button'
import {Card} from '../../components/ui/card'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {formatDateTime} from '../../i18n/format'
import {useProjectLiveRefresh} from '../../hooks/useProjectLiveRefresh'
import {STATE_VARIANT,WorkspaceRow,failureKind,groupDelegations,readLoadedPages,type LoadError} from './AgentWorkspaceRow'

type Result=NonNullable<AgentWorkspaceGroup['latest_result']>
function resultKind(result:Result){
 if(result.state==='integrated')return result.landing==='target'?'merged':result.landing==='parent'?'adopted':'adoption_unverified'
 if(result.state==='open')return 'saved'
 if(result.state==='no_changes')return 'in_target'
 if(result.state==='blocked')return 'attention'
 return 'integrating'
}
const short=(commit:string|null)=>commit?commit.slice(0,7):null

/**
 * One conversation × repository in Files & Code › Agent workspaces: its state,
 * latest result and open problems first; saved work without proof that it
 * landed stays listed; delegations, batches, older generations and reclaims
 * are folded into the execution history, read from the server per group.
 */
export function AgentWorkspaceGroupCard({projectId,group,onChanged}:{projectId:string;group:AgentWorkspaceGroup;onChanged:()=>void}){
 const {t}=useAppTranslation()
 const [open,setOpen]=useState(false)
 const current=group.current
 const title=group.conversation?.title||group.task?.title||t(`agent_workspaces_ui.owner.${current.owner_kind}`)
 const conversationHref=group.conversation?.room_id?`/rooms/${encodeURIComponent(group.conversation.room_id)}?conversation=${encodeURIComponent(group.conversation.id)}`:null
 const result=group.latest_result
 return <Card className="space-y-3 p-3 sm:p-4" data-testid={`agent-workspace-group-${group.group_key}`}>
  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
   <div className="min-w-0 flex-1 space-y-1">
    <p className="break-words text-sm font-medium">{title}</p>
    <p className="break-words text-xs text-muted-foreground">
     {[current.agent?.name,group.folder?.name,t('agent_workspaces_ui.updated',{time:formatDateTime(group.activity_at,{fallback:''})})].filter(Boolean).join(' · ')}
    </p>
   </div>
   <Badge variant={STATE_VARIANT[group.work_state]}>{t(`agent_workspaces_ui.state.${group.work_state}`)}</Badge>
  </div>
  {result&&<p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground" data-testid="agent-workspace-latest-result">
   <span className="font-medium text-foreground">{t('agent_workspaces_ui.group.latest')}</span>
   <span>{t(`agent_workspaces_ui.state.${resultKind(result)}`)}</span>
   {short(result.source_commit)&&<code className="rounded bg-muted px-1 font-mono text-[11px] text-foreground">{short(result.source_commit)}</code>}
   {result.agent&&<span>· {result.agent.name}</span>}
   <span>· {formatDateTime(result.activity_at,{fallback:''})}</span>
  </p>}
  {(group.issues.length>0||!group.host.online)&&<div className="flex flex-wrap gap-1.5">
   {group.issues.map(issue=><Badge key={issue.kind} variant={issue.kind==='host_offline'?'outline':'warning'}>{issue.kind==='host_offline'?t('agent_workspaces_ui.host_offline',{host:group.host.name}):t(`agent_workspaces_ui.group.issue.${issue.kind}`,{count:issue.count})}</Badge>)}
  </div>}
  {group.unconfirmed.length>0&&<section className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5" aria-label={t('agent_workspaces_ui.group.unconfirmed.title',{count:group.unconfirmed.length})}>
   <div className="space-y-0.5">
    <p className="text-xs font-medium">{t('agent_workspaces_ui.group.unconfirmed.title',{count:group.unconfirmed.length})}</p>
    <p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.group.unconfirmed.note')}</p>
   </div>
   <ul className="space-y-1.5">
    {group.unconfirmed.map(entry=><li key={entry.change_set_id} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
     <span className="font-medium">{t(`agent_workspaces_ui.group.unconfirmed.reason.${entry.reason}`)}</span>
     {short(entry.source_commit)&&<code className="rounded bg-background px-1 font-mono text-[11px]">{short(entry.source_commit)}</code>}
     <span className="text-muted-foreground">{[entry.agent?.name,entry.owner_kind==='delegation'?t('agent_workspaces_ui.owner.delegation'):null,formatDateTime(entry.activity_at,{fallback:''})].filter(Boolean).join(' · ')}</span>
     {entry.same_commit_count>0&&<Badge variant="outline">{t('agent_workspaces_ui.group.unconfirmed.same_commit',{count:entry.same_commit_count})}</Badge>}
     <SpaceLink className="text-primary underline-offset-2 hover:underline" to={`/runs/${entry.run.id}`}>{t('agent_workspaces_ui.open_run')}</SpaceLink>
    </li>)}
   </ul>
   {group.unconfirmed_more&&<p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.group.unconfirmed.more')}</p>}
  </section>}
  {group.proven_duplicates>0&&<p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.group.proven_duplicates',{count:group.proven_duplicates})}</p>}
  <div className="flex flex-wrap gap-2">
   <Button size="sm" variant="outline" className="gap-1" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
    {open?<ChevronDown className="size-3.5" aria-hidden="true"/>:<ChevronRight className="size-3.5" aria-hidden="true"/>}
    {t('agent_workspaces_ui.group.history',{workspaces:t('agent_workspaces_ui.group.workspaces',{count:group.workspace_count}),batches:t('agent_workspaces_ui.group.batches',{count:group.batch_count})})}
   </Button>
   {conversationHref&&<Button size="sm" variant="ghost" asChild><SpaceLink to={conversationHref}>{t('agent_workspaces_ui.open_conversation')}</SpaceLink></Button>}
   {group.task&&<Button size="sm" variant="ghost" asChild><SpaceLink to={`/projects/${projectId}/tasks/${group.task.id}`}>{t('agent_workspaces_ui.open_task')}</SpaceLink></Button>}
   <Button size="sm" variant="ghost" asChild><SpaceLink to={`/runs/${current.run.id}`}>{t('agent_workspaces_ui.open_run')}</SpaceLink></Button>
  </div>
  {open&&<GroupHistory projectId={projectId} groupKey={group.group_key} delegations={group.delegation_count} onChanged={onChanged}/>}
 </Card>
}

/** Every visible generation of the group (view=all), paged by the server. */
function GroupHistory({projectId,groupKey,delegations,onChanged}:{projectId:string;groupKey:string;delegations:number;onChanged:()=>void}){
 const {t}=useAppTranslation()
 const [items,setItems]=useState<AgentWorkspaceItem[]>([])
 const [cursor,setCursor]=useState<string|null>(null)
 const [loading,setLoading]=useState(true),[error,setError]=useState<LoadError|null>(null),[moreError,setMoreError]=useState(false)
 const [reload,setReload]=useState(0)
 const request=useRef(0),pages=useRef(1),busy=useRef(false)
 const read=useCallback((next?:string)=>agentWorkspacesApi.list(projectId,{view:'all',group:groupKey,...(next?{cursor:next}:{})}),[projectId,groupKey])
 useEffect(()=>{
  const current=++request.current;pages.current=1;busy.current=true;setLoading(true);setError(null);setMoreError(false)
  read().then(page=>{if(current!==request.current)return;setItems(page.items);setCursor(page.next_cursor)})
   .catch(e=>{if(current!==request.current)return;setItems([]);setCursor(null);setError(failureKind(e))})
   .finally(()=>{if(current===request.current){busy.current=false;setLoading(false)}})
  return()=>{request.current+=1}
 },[read,reload])
 const quiet=useCallback(async()=>{
  if(busy.current)return
  const current=request.current,depth=pages.current
  try{const page=await readLoadedPages(read,depth,item=>item.workspace_id);if(current!==request.current||depth!==pages.current)return;setItems(page.items);setCursor(page.next_cursor)}
  catch(e){if(current===request.current&&failureKind(e)==='denied'){setItems([]);setCursor(null);setError('denied')}}
 },[read])
 useProjectLiveRefresh(projectId,quiet,error!=='denied')
 async function more(){
  if(!cursor||busy.current)return
  const current=request.current;busy.current=true;setLoading(true);setMoreError(false)
  try{const page=await read(cursor);if(current!==request.current)return;setItems(held=>[...held,...page.items.filter(item=>!held.some(h=>h.workspace_id===item.workspace_id))]);setCursor(page.next_cursor);pages.current+=1}
  catch(e){if(current!==request.current)return;if(failureKind(e)==='denied'){setItems([]);setCursor(null);setError('denied')}else setMoreError(true)}
  finally{if(current===request.current){busy.current=false;setLoading(false)}}
 }
 const changed=()=>{setReload(n=>n+1);onChanged()}
 return <div className="space-y-2 border-t border-border pt-3" data-testid={`agent-workspace-history-${groupKey}`}>
  <p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.group.history_note',{count:delegations})}</p>
  {loading&&items.length===0?<p role="status" className="text-xs text-muted-foreground">{t('agent_workspaces_ui.loading')}</p>
   :error?<div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">{t(`agent_workspaces_ui.error.${error}.title`)}{error==='failed'&&<Button size="sm" variant="outline" onClick={()=>setReload(n=>n+1)}>{t('agent_workspaces_ui.retry')}</Button>}</div>
   :<div className="space-y-2">
    {groupDelegations(items).map(({item,children})=><WorkspaceRow key={item.workspace_id} projectId={projectId} item={item} nested onChanged={changed}>
     {children.length>0&&<div className="space-y-2 border-l border-border pl-3" data-testid={`agent-workspace-delegations-${item.workspace_id}`}>
      <p className="text-xs text-muted-foreground">{t('agent_workspaces_ui.delegated_group',{count:children.length})}</p>
      {children.map(child=><WorkspaceRow key={child.workspace_id} projectId={projectId} item={child} nested onChanged={changed}/>)}
     </div>}
    </WorkspaceRow>)}
    {cursor&&<div className="flex flex-wrap items-center gap-2">
     <Button size="sm" variant="outline" disabled={loading} onClick={()=>void more()}>{loading?t('agent_workspaces_ui.loading'):t('agent_workspaces_ui.load_more')}</Button>
     {moreError&&<span role="alert" className="text-xs text-destructive">{t('agent_workspaces_ui.error.failed.title')}</span>}
    </div>}
   </div>}
 </div>
}
