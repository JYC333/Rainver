import {AgentWorkspaceItemSchema,type AgentWorkspaceDetail,type AgentWorkspaceItem,type AgentWorkspacePage,type AgentWorkspaceState} from '@rainver/protocol';
import {assertProjectReadable} from '../projects/access.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {contentReadSql} from '../access/contentAccessSql.js';
import {runBodyReadableSql} from '../runs/runBodyReadSql.js';
import {workspaceContributorsReadableSql} from './workspaceContributors.js';
import {currentRetention,decodeKeyset,encodeKeyset,readVisibleWorkspaceChanges,retentionView} from './workspaceReadModel.js';

/**
 * Project overview of Agent execution workspaces: one row per workspace
 * generation (each `execution_workspaces` row is one generation). It is a read
 * projection over the same authorities as the Run and conversation readers —
 * Project read, owned remote Hosts, readable conversation, visible unwithheld
 * Run body — and never registers or exposes a private worktree path.
 *
 * Visibility is applied per batch and per bound Run *before* anything is
 * aggregated or paged: a workspace's state, batch count, activity time, shown
 * Run and cursor derive only from what this reader may see, and a workspace
 * with no visible batch does not exist for them.
 */
const ACTIVE_RUN="('queued','running','cancelling','waiting_for_review','waiting_for_dependency')";
/** Running, unfinished or needing attention: the default view. Settled
 * outcomes — merged, adopted, unchanged, reclaimed, kept without merging, a
 * closed missing branch, and work whose branch is only kept for its private
 * snapshot baseline or a delegated child (shown on its own row) — are history. */
// Missing branches are historical records, even when their saved batch was never
// closed. A newer open batch invalidates the old assessment, as in currentRetention.
const MISSING=`(COALESCE(retention_json->>'state','')='missing'
 AND (open_work_at IS NULL OR retention_json->>'assessed_at' IS NULL
  OR open_work_at::timestamptz <= (retention_json->>'assessed_at')::timestamptz))`;
export const CURRENT=`(active OR any_blocked OR any_integrating OR cleanup_state='blocked'
 OR ((any_saved_open OR any_unsaved_open) AND NOT ${MISSING})
 OR COALESCE(retention_json->>'state','') IN ('blocked','held','reclaiming')
 OR (COALESCE(retention_json->>'state','')='retained' AND COALESCE(retention_json->>'reason','') NOT IN ('kept_without_merging','private_baseline','child_workspace_dependency')
   AND NOT (latest_state IN ('abandoned','integrated','no_changes') AND retention_json->>'reason' IN ('unpublished_changes','blocked_changes','unmerged_source'))))`;
export type Row={id:string;location_id:string|null;group_key:string;generation:number;owner_kind:'conversation'|'task'|'delegation';parent_workspace_id:string|null;latest_adopted:boolean;task_id:string|null;task_title:string|null;cleanup_state:string;retention_json:unknown;
 created_at:string;activity_key:string;activity_iso:string;folder_id:string|null;folder_name:string|null;host_name:string;host_status:string;
 shown_run_id:string;shown_run_status:string;agent_id:string|null;agent_name:string|null;session_id:string|null;session_title:string|null;room_id:string|null;
 batch_count:number;any_blocked:boolean;any_integrating:boolean;any_saved_open:boolean;any_unsaved_open:boolean;open_work_at:string|null;active:boolean;latest_state:string;latest_landing:string|null};

/** Conversation × repository; a workspace without either is its own group. */
export const GROUP_KEY=`CASE WHEN scoped.session_id IS NOT NULL AND scoped.location_id IS NOT NULL THEN 'c:'||scoped.session_id||':'||scoped.location_id ELSE 'w:'||scoped.id END`;
export function scopedSql(extra:string,columns=''){
 return `WITH visible AS (
  SELECT c.id,c.workspace_id,c.space_id,c.generation,c.sequence,c.state,c.base_commit,c.source_commit,c.updated_at,c.originating_run_id,c.verification_json->>'adoption_proof' AS adoption_proof
  FROM workspace_change_sets c
  JOIN execution_workspaces cw ON cw.id=c.workspace_id AND cw.space_id=c.space_id
  JOIN runs origin ON origin.id=c.originating_run_id AND origin.space_id=c.space_id
  WHERE c.space_id=$1 AND cw.project_id=$2 AND ${runBodyReadableSql('origin','$3')} AND ${workspaceContributorsReadableSql('c','$3')}
 ), bound AS (
  SELECT b.workspace_id,b.created_at,r.id,r.status,r.agent_id
  FROM execution_workspace_runs b JOIN execution_workspaces bw ON bw.id=b.workspace_id AND bw.space_id=b.space_id
  JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
  WHERE b.space_id=$1 AND bw.project_id=$2 AND ${runBodyReadableSql('r','$3')}
 ), scoped AS (
  SELECT w.id,w.workspace_location_id AS location_id,w.generation,w.owner_kind,w.parent_workspace_id,w.task_id,w.cleanup_state,w.retention_json,to_json(w.created_at)#>>'{}' AS created_at,
   l.project_folder_id AS folder_id,f.name AS folder_name,h.name AS host_name,h.status AS host_status,
   latest.state AS latest_state,latest.landing AS latest_landing,latest.adopted AS latest_adopted,
   COALESCE(lastrun.id,origin.id) AS shown_run_id,COALESCE(lastrun.status,origin.status) AS shown_run_status,
   COALESCE(lastrun.agent_id,origin.agent_id) AS agent_id,
   origin.session_id,s.title AS session_title,s.room_id,
   stats.batch_count,stats.any_blocked,stats.any_integrating,stats.any_saved_open,stats.any_unsaved_open,stats.open_work_at,stats.activity_at,
   EXISTS(SELECT 1 FROM bound active_run WHERE active_run.workspace_id=w.id AND active_run.status IN ${ACTIVE_RUN}) AS active
  FROM execution_workspaces w
  JOIN hosts h ON h.id=w.execution_host_id
  LEFT JOIN workspace_locations l ON l.id=w.workspace_location_id
  LEFT JOIN project_folders f ON f.id=l.project_folder_id AND f.space_id=w.space_id
  JOIN LATERAL (SELECT c.originating_run_id,c.state,c.state='no_changes' AND c.adoption_proof IS NOT NULL AS adopted,CASE WHEN c.state<>'integrated' THEN NULL WHEN w.parent_workspace_id IS NULL THEN 'target'
    WHEN EXISTS(SELECT 1 FROM workspace_change_sets adopter WHERE adopter.workspace_id=w.parent_workspace_id AND adopter.space_id=c.space_id
     AND jsonb_typeof(adopter.verification_json->'adopted_child_change_ids')='array' AND (adopter.verification_json->'adopted_child_change_ids') ? c.id) THEN 'parent'
    ELSE 'parent_unverified' END AS landing
   FROM visible c WHERE c.workspace_id=w.id ORDER BY c.generation DESC,c.sequence DESC LIMIT 1) latest ON true
  JOIN LATERAL (SELECT count(*)::int AS batch_count,COALESCE(bool_or(c.state='blocked'),false) AS any_blocked,
    COALESCE(bool_or(c.state IN ('ready','integrating')),false) AS any_integrating,
    -- Saved means a real difference: an open batch whose saved source equals its base holds nothing to merge.
    COALESCE(bool_or(c.state='open' AND c.source_commit IS NOT NULL AND c.source_commit IS DISTINCT FROM c.base_commit),false) AS any_saved_open,
    COALESCE(bool_or(c.state='open' AND c.source_commit IS NULL),false) AS any_unsaved_open,
    to_json(max(c.updated_at) FILTER (WHERE c.state='open'))#>>'{}' AS open_work_at,
    max(c.updated_at) AS activity_at
   FROM visible c WHERE c.workspace_id=w.id) stats ON true
  LEFT JOIN LATERAL (SELECT r.id,r.status,r.agent_id FROM bound r WHERE r.workspace_id=w.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) lastrun ON true
  JOIN runs origin ON origin.id=latest.originating_run_id AND origin.space_id=w.space_id
  LEFT JOIN sessions s ON s.id=origin.session_id AND s.space_id=origin.space_id
  WHERE w.space_id=$1 AND w.project_id=$2 AND (h.kind<>'remote' OR h.owner_user_id=$3)
 ) SELECT scoped.*,scoped.activity_at::text AS activity_key,to_json(scoped.activity_at)#>>'{}' AS activity_iso,
   a.name AS agent_name,t.title AS task_title,${GROUP_KEY} AS group_key${columns?`,${columns}`:''}
  FROM scoped
  LEFT JOIN agents a ON a.id=scoped.agent_id AND a.space_id=$1
  LEFT JOIN tasks t ON t.id=scoped.task_id AND t.space_id=$1 AND ${contentReadSql('task','t','$3')}
  WHERE ${extra}`;
}

/**
 * Live facts of this generation's Runs and batches first; the recorded
 * retention reading only explains what they leave open. A missing-branch
 * record is a reading taken at its assessment, so it never outranks a Run
 * working now, a batch merging or one blocked on a decision; it is not
 * applied at all to open work recorded after it (`currentRetention`), and a
 * closed missing record never outranks later saved or unsaved work.
 */
function workState(row:Row,retention:{state:string;reason:string}|undefined):AgentWorkspaceState{
 const retentionState=retention?.state;
 if(row.any_blocked||row.cleanup_state==='blocked'||retentionState==='blocked')return 'attention';
 if(row.active)return 'running';
 if(row.any_integrating)return 'integrating';
 if(retentionState==='missing'&&retention!.reason!=='missing_acknowledged')return 'missing';
 if(row.any_saved_open)return 'saved';
 if(row.any_unsaved_open)return 'unsaved';
 if(retentionState==='missing')return 'missing_closed';
 if(row.latest_state==='integrated')return row.latest_landing==='target'?'merged':row.latest_landing==='parent'?'adopted':'adoption_unverified';
 if(row.latest_state==='no_changes')return row.latest_adopted?'in_target':'no_changes';
 if(row.latest_state==='abandoned')return retention?.reason==='discarded'?'discarded':'kept';
 return 'idle';
}

export function itemFor(row:Row):AgentWorkspaceItem{
 // A missing reading older than this generation's newest open work is stale for it (`currentRetention`).
 const retention=currentRetention(retentionView(row.retention_json).retention,row.open_work_at);
 return AgentWorkspaceItemSchema.parse({
  workspace_id:row.id,generation:row.generation,owner_kind:row.owner_kind,parent_workspace_id:row.parent_workspace_id,work_state:workState(row,retention),
  folder:row.folder_id&&row.folder_name?{id:row.folder_id,name:row.folder_name}:null,
  host:{name:row.host_name,online:row.host_status==='online'},
  conversation:row.session_id?{id:row.session_id,title:row.session_title,room_id:row.room_id}:null,
  task:row.task_id&&row.task_title!==null?{id:row.task_id,title:row.task_title}:null,
  agent:row.agent_id&&row.agent_name!==null?{id:row.agent_id,name:row.agent_name}:null,
  run:{id:row.shown_run_id,status:row.shown_run_status},batch_count:row.batch_count,retention:retention??null,
  created_at:row.created_at,activity_at:row.activity_iso,
 });
}

export async function listAgentWorkspaces(db:Queryable,identity:{spaceId:string;userId:string},projectId:string,input:{view:'current'|'history'|'all';group?:string;cursor?:string;limit:number}):Promise<AgentWorkspacePage>{
 await assertProjectReadable(db,identity.spaceId,projectId,identity.userId);
 const params:unknown[]=[identity.spaceId,projectId,identity.userId];
 // `all` is one group's folded execution history: every visible generation of
 // that conversation x repository, whichever view its parent row is in.
 let extra=input.view==='all'?'true':input.view==='current'?CURRENT:`NOT ${CURRENT}`;
 if(input.group){params.push(input.group);extra+=` AND ${GROUP_KEY}=$${params.length}::text`;}
 if(input.cursor){const [key,id]=decodeKeyset(input.cursor,2);params.push(key,id);extra+=` AND (scoped.activity_at,scoped.id)<($${params.length-1}::timestamptz,$${params.length}::varchar)`;}
 // Every row here is already visible, so the page is full whenever more
 // visible rows exist, and the cursor names only a row this reader was shown.
 const rows=(await db.query<Row>(`${scopedSql(extra)} ORDER BY scoped.activity_at DESC,scoped.id DESC LIMIT ${input.limit+1}`,params)).rows;
 const page=rows.slice(0,input.limit),last=page.at(-1);
 return {items:page.map(itemFor),next_cursor:rows.length>input.limit&&last?encodeKeyset([last.activity_key,last.id]):null};
}

export async function agentWorkspaceDetail(db:Queryable,identity:{spaceId:string;userId:string},projectId:string,workspaceId:string,input:{cursor?:string;limit?:number}={}):Promise<AgentWorkspaceDetail>{
 await assertProjectReadable(db,identity.spaceId,projectId,identity.userId);
 const row=(await db.query<Row>(`${scopedSql('scoped.id=$4')} LIMIT 1`,[identity.spaceId,projectId,identity.userId,workspaceId])).rows[0];
 if(!row)throw new HttpError(404,'Workspace not found');
 const page=await readVisibleWorkspaceChanges(db,identity.spaceId,identity.userId,{where:'c.workspace_id=$2 AND w.project_id=$3',params:[workspaceId,projectId],limit:input.limit??50,cursor:input.cursor});
 return {workspace_id:workspaceId,items:page.entries.map(({change,run})=>({change,run})),next_cursor:page.next_cursor};
}
