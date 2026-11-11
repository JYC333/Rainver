import {AgentWorkspaceGroupSchema,type AgentWorkspaceGroup,type AgentWorkspaceGroupPage,type AgentWorkspaceItem,type AgentWorkspaceState,type AgentWorkspaceUnconfirmed} from '@rainver/protocol';
import {assertProjectReadable} from '../projects/access.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {runBodyReadableSql} from '../runs/runBodyReadSql.js';
import {workspaceContributorsReadableSql} from './workspaceContributors.js';
import {CURRENT,GROUP_KEY,itemFor,scopedSql,type Row} from './workspaceOverview.js';

/**
 * The default Agent workspaces overview: one entry per conversation ×
 * repository, aggregated on the server from the same visibility-filtered rows
 * as the per-generation list (`scopedSql`): Project read, owned remote Hosts,
 * readable conversation and unwithheld Run bodies, all applied before any
 * grouping, counting or paging. A group therefore exists, is current, and is
 * paged only by what this reader may see; delegated children join their
 * coordinator's conversation group through their own visible Run, so neither
 * paging nor the coordinator's view hides them.
 *
 * Saved work is folded away only by an exact commit match with work that
 * provably reached the target (published from a root workspace, or a recorded
 * target adoption proof) or another unconfirmed batch at the same commit. A
 * child adopted into a parent batch proves only that the parent carries it, so
 * the parent's unpublished work at that commit stays listed. Nothing is
 * inferred from diff sizes or from a missing state. A batch is read only when
 * every Run that contributed to it is readable (workspaceContributors).
 */
const URGENT:AgentWorkspaceState[]=['attention','missing','running','integrating','saved','unsaved','adoption_unverified'];
const UNCONFIRMED_LIMIT=20;

type Batch={id:string;workspace_id:string;generation:number;state:'open'|'ready'|'integrating'|'blocked'|'integrated'|'no_changes'|'abandoned';
 base_commit:string|null;source_commit:string|null;activity_iso:string;owner_kind:'conversation'|'task'|'delegation';
 landing:'target'|'parent'|'parent_unverified'|null;adoption_proof:boolean;target_proof:boolean;discarded:boolean;run_id:string;run_status:string;agent_id:string|null;agent_name:string|null};

function encodeGroupCursor(activity:string,key:string){return Buffer.from(JSON.stringify([activity,key])).toString('base64url');}
function decodeGroupCursor(cursor:string):[string,string]{
 try{
  const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
  if(Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='string'&&v.length>0&&v.length<=128))return [value[0],value[1]];
 }catch{/* fall through */}
 throw new HttpError(422,'Invalid cursor');
}

export async function listAgentWorkspaceGroups(db:Queryable,identity:{spaceId:string;userId:string},projectId:string,input:{view:'current'|'history';cursor?:string;limit:number}):Promise<AgentWorkspaceGroupPage>{
 await assertProjectReadable(db,identity.spaceId,projectId,identity.userId);
 const params:unknown[]=[identity.spaceId,projectId,identity.userId];
 let keyset='';
 if(input.cursor){const [activity,key]=decodeGroupCursor(input.cursor);params.push(activity,key);keyset=`WHERE (g.activity_at,g.group_key)<($4::timestamptz,$5::text)`;}
 // A group is current while any of its visible generations is (CURRENT).
 const groups=(await db.query<{group_key:string;activity_key:string}>(`SELECT * FROM (
   SELECT x.group_key,max(x.activity_at) AS activity_at,max(x.activity_at)::text AS activity_key,bool_or(x.is_current) AS is_current
   FROM (${scopedSql('true',`(${CURRENT}) AS is_current`)}) x GROUP BY x.group_key) g
  ${keyset}${keyset?' AND':'WHERE'} g.is_current=${input.view==='current'?'true':'false'}
  ORDER BY g.activity_at DESC,g.group_key DESC LIMIT ${input.limit+1}`,params)).rows;
 const page=groups.slice(0,input.limit),last=page.at(-1);
 if(!page.length)return {items:[],next_cursor:null};
 const keys=page.map(g=>g.group_key);
 const members=(await db.query<Row>(`${scopedSql(`${GROUP_KEY}=ANY($4::text[])`)} ORDER BY scoped.activity_at DESC,scoped.id DESC`,[identity.spaceId,projectId,identity.userId,keys])).rows;
 const batches=await visibleBatches(db,identity,projectId,members.map(m=>m.id));
 const byGroup=new Map<string,Row[]>();
 for(const m of members)byGroup.set(m.group_key,[...(byGroup.get(m.group_key)??[]),m]);
 const items=page.flatMap(g=>{const rows=byGroup.get(g.group_key);return rows?.length?[groupFor(g.group_key,rows,batches)]:[];});
 return {items,next_cursor:groups.length>input.limit&&last?encodeGroupCursor(last.activity_key,last.group_key):null};
}

/** Every batch of the given (already visible) workspaces whose origin and contributing Runs this reader may read. */
async function visibleBatches(db:Queryable,identity:{spaceId:string;userId:string},projectId:string,workspaceIds:string[]):Promise<Batch[]>{
 if(!workspaceIds.length)return [];
 return (await db.query<Batch>(`SELECT c.id,c.workspace_id,c.generation,c.state,c.base_commit,c.source_commit,to_json(c.updated_at)#>>'{}' AS activity_iso,w.owner_kind,
   c.verification_json ? 'adoption_proof' AS adoption_proof,
   COALESCE(c.verification_json->'closure_review'->>'disposition','')='discard_requested' OR COALESCE(w.retention_json->>'reason','')='discarded' AS discarded,
   CASE WHEN c.state<>'integrated' THEN NULL WHEN w.parent_workspace_id IS NULL THEN 'target'
    WHEN EXISTS(SELECT 1 FROM workspace_change_sets adopter WHERE adopter.workspace_id=w.parent_workspace_id AND adopter.space_id=c.space_id
     AND jsonb_typeof(adopter.verification_json->'adopted_child_change_ids')='array' AND (adopter.verification_json->'adopted_child_change_ids') ? c.id) THEN 'parent'
    ELSE 'parent_unverified' END AS landing,
   -- Proof that this exact source reached the shared target: published from a
   -- root workspace, or closed by an adoption proof against the target
   -- (target paths match, or the adopting parent published it). Landing in a
   -- parent batch proves nothing about the target.
   ((c.state='integrated' AND w.parent_workspace_id IS NULL)
    OR (c.state='no_changes' AND ((w.parent_workspace_id IS NULL AND c.verification_json->>'adoption_proof'='target_paths_match')
     OR (c.verification_json->>'adoption_proof'='published_parent_paths' AND EXISTS(SELECT 1 FROM workspace_change_sets pub JOIN execution_workspaces pw ON pw.id=pub.workspace_id AND pw.space_id=pub.space_id
      WHERE pub.id=c.verification_json->>'adopted_by_change_id' AND pub.space_id=c.space_id AND pub.state='integrated' AND pw.parent_workspace_id IS NULL))))) AS target_proof,
   origin.id AS run_id,origin.status AS run_status,origin.agent_id,a.name AS agent_name
  FROM workspace_change_sets c
  JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id JOIN hosts h ON h.id=w.execution_host_id
  JOIN runs origin ON origin.id=c.originating_run_id AND origin.space_id=c.space_id
  LEFT JOIN agents a ON a.id=origin.agent_id AND a.space_id=c.space_id
  WHERE c.space_id=$1 AND w.project_id=$2 AND c.workspace_id=ANY($4::varchar[]) AND (h.kind<>'remote' OR h.owner_user_id=$3) AND ${runBodyReadableSql('origin','$3')}
   AND ${workspaceContributorsReadableSql('c','$3')}
  ORDER BY c.updated_at DESC,c.id DESC`,[identity.spaceId,projectId,identity.userId,workspaceIds])).rows;
}

const saved=(b:Batch)=>b.source_commit!==null&&b.source_commit!==b.base_commit;

function groupFor(key:string,rows:Row[],allBatches:Batch[]):AgentWorkspaceGroup{
 const items=rows.map(itemFor);
 // The session's current workspace is chosen by generation, never by activity:
 // a late update of an older generation (a reclaim, a closure) must not take
 // its place. Activity only orders groups and picks the latest result.
 const current=currentWorkspace(items);
 const ids=new Set(items.map(i=>i.workspace_id));
 const batches=allBatches.filter(b=>ids.has(b.workspace_id));
 const working=new Set(items.filter(i=>i.work_state==='running'||i.work_state==='integrating').map(i=>i.workspace_id));
 // Exact commits that provably reached the target. A child adopted into its
 // parent's still-open batch is not such proof: it would fold away the very
 // parent work that carries it (and a child forked from the parent's unpublished
 // checkpoint shares that commit), so only target proofs count here.
 const landed=new Set(batches.filter(b=>b.source_commit&&b.target_proof).map(b=>b.source_commit!));
 const candidates:Array<{batch:Batch;reason:AgentWorkspaceUnconfirmed['reason']}>=[];
 for(const b of batches){
  if(b.state==='open'&&saved(b)&&!working.has(b.workspace_id))candidates.push({batch:b,reason:'saved_not_merged'});
  else if(b.state==='abandoned'&&saved(b)&&!b.discarded)candidates.push({batch:b,reason:'kept_without_merging'});
  else if(b.state==='integrated'&&b.landing==='parent_unverified')candidates.push({batch:b,reason:'adoption_unverified'});
 }
 let proven=0;const byCommit=new Map<string,Array<{batch:Batch;reason:AgentWorkspaceUnconfirmed['reason']}>>(),order:string[]=[];
 for(const c of candidates){
  if(c.batch.source_commit&&landed.has(c.batch.source_commit)){proven++;continue;}
  const commitKey=c.batch.source_commit??`batch:${c.batch.id}`;
  if(!byCommit.has(commitKey)){byCommit.set(commitKey,[]);order.push(commitKey);}
  byCommit.get(commitKey)!.push(c);
 }
 const unconfirmed=order.map(k=>{const same=byCommit.get(k)!,{batch,reason}=same[0]!;return {
  change_set_id:batch.id,workspace_id:batch.workspace_id,generation:batch.generation,owner_kind:batch.owner_kind,reason,source_commit:batch.source_commit,
  same_commit_count:same.length-1,agent:batch.agent_id&&batch.agent_name!==null?{id:batch.agent_id,name:batch.agent_name}:null,
  run:{id:batch.run_id,status:batch.run_status},activity_at:batch.activity_iso};});
 const result=batches.find(b=>['integrated','ready','integrating','blocked'].includes(b.state)||(b.state==='open'&&saved(b))||(b.state==='no_changes'&&b.adoption_proof));
 const state=URGENT.find(s=>items.some(i=>i.work_state===s))??current.work_state;
 const count=(fn:(i:AgentWorkspaceItem)=>boolean)=>items.filter(fn).length;
 const issues=([
  ['attention',count(i=>i.work_state==='attention')],['missing',count(i=>i.work_state==='missing')],
  ['cleanup_blocked',rows.filter(r=>r.cleanup_state==='blocked').length],['unconfirmed',unconfirmed.length],
  ['host_offline',current.host.online?0:1],
 ] as const).filter(([,n])=>n>0).map(([kind,n])=>({kind,count:n}));
 const withConversation=items.find(i=>i.conversation)?.conversation??null;
 return AgentWorkspaceGroupSchema.parse({
  group_key:key,conversation:withConversation,task:items.find(i=>i.task)?.task??null,folder:current.folder,host:current.host,
  work_state:state,current,
  latest_result:result?{change_set_id:result.id,workspace_id:result.workspace_id,state:result.state,landing:result.landing,source_commit:result.source_commit,
   agent:result.agent_id&&result.agent_name!==null?{id:result.agent_id,name:result.agent_name}:null,run:{id:result.run_id,status:result.run_status},activity_at:result.activity_iso}:null,
  issues,unconfirmed:unconfirmed.slice(0,UNCONFIRMED_LIMIT),unconfirmed_more:unconfirmed.length>UNCONFIRMED_LIMIT,proven_duplicates:proven,
  workspace_count:items.length,delegation_count:count(i=>i.owner_kind==='delegation'),batch_count:items.reduce((n,i)=>n+i.batch_count,0),
  activity_at:items.reduce((a,i)=>Date.parse(i.activity_at)>Date.parse(a)?i.activity_at:a,items[0]!.activity_at),
 });
}

/** Conversation-owned before Task-owned, then the highest generation; a group of only delegations shows its newest. */
export function currentWorkspace(items:AgentWorkspaceItem[]):AgentWorkspaceItem{
 const rank=(i:AgentWorkspaceItem)=>i.owner_kind==='conversation'?2:i.owner_kind==='task'?1:0;
 return items.reduce((best,i)=>rank(i)>rank(best)||(rank(i)===rank(best)&&rank(i)>0&&i.generation>best.generation)?i:best,items[0]!);
}
