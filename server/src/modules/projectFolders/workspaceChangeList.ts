import {WorkspaceChangeListInputSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectReadable} from '../projects/access.js';
import {PgRunRepository} from '../runs/repository.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {readVisibleWorkspaceChanges} from './workspaceReadModel.js';
import {authorizedWorkspaceChange} from './workspaceOperations.js';

const ACTIVE_RUN="('queued','running','cancelling','waiting_for_review','waiting_for_dependency')";
/** Unfinished: an open/owed batch, blocked cleanup, or a branch removed outside Rainver without proof. */
const UNFINISHED=`(c.state IN ('open','ready','integrating','blocked') OR w.cleanup_state='blocked' OR (COALESCE(w.retention_json->>'state','')='missing' AND COALESCE(w.retention_json->>'reason','')='branch_missing'))`;
/** A conversation's own generations and every delegated workspace forked below them, at any depth. */
const CONVERSATION_TREE=`w.id IN (WITH RECURSIVE tree AS (SELECT t.id FROM execution_workspaces t WHERE t.space_id=$1 AND t.owner_kind='conversation' AND t.session_id=$3
  UNION SELECT e.id FROM execution_workspaces e JOIN tree ON e.parent_workspace_id=tree.id WHERE e.space_id=$1) SELECT id FROM tree)`;

interface Scope {projectId:string;sessionId:string|null;agent:boolean;userId:string}

/** The caller's Project, conversation and visibility; an Agent is bound to its Run. */
async function listScope(db:Queryable,actor:OperationActor,input:ReturnType<typeof WorkspaceChangeListInputSchema.parse>):Promise<Scope>{
 const userId=actor.on_behalf_of_user_id;
 if(!userId)throw hidden();
 if(actor.run_id){
  const run=await new PgRunRepository(db).getVisibleRun(actor.space_id,userId,actor.run_id);
  if(!run||!run.project_id||bodyWithheld(run.effective_access_level))throw hidden();
  if(input.project_id&&input.project_id!==run.project_id)throw hidden();
  await assertProjectReadable(db,actor.space_id,run.project_id,userId);
  if(input.scope==='conversation'&&!run.session_id)throw new OperationBusinessError('operation_invalid_input',422,'workspaces');
  return {projectId:run.project_id,sessionId:run.session_id??null,agent:true,userId};
 }
 if(!input.project_id||input.scope!=='project')throw new OperationBusinessError('operation_invalid_input',422,'workspaces');
 await assertProjectReadable(db,actor.space_id,input.project_id,userId);
 return {projectId:input.project_id,sessionId:null,agent:false,userId};
}

/**
 * Active management (`workspace.change.list`): the same visible batches as the
 * Agent workspaces overview — Project read, current remote-Host ownership and
 * the origin Run's unwithheld body, applied before paging — so hidden rows never
 * use up a page and the cursor only names a row this caller was shown.
 * An Agent sees its own conversation tree in full; other conversations of the
 * Project only as metadata (no summary) and only for Runs the same person
 * instructed. Closing stays `workspace.change.abandon`; an Agent's `closable`
 * comes from the same authorizer, so a listed closable row is one it may close.
 */
export async function listWorkspaceChanges(db:Queryable,actor:OperationActor,raw:unknown){
 const input=WorkspaceChangeListInputSchema.parse(raw);
 const scope=await listScope(db,actor,input);
 const clauses=['w.project_id=$2'],params:unknown[]=[scope.projectId];
 if(input.scope==='conversation'){params.push(scope.sessionId);clauses.push(CONVERSATION_TREE);}
 else if(scope.agent){params.push(scope.userId);clauses.push(`origin.instructed_by_user_id=$${params.length+1}`);}
 if(input.view==='unfinished')clauses.push(UNFINISHED);
 const page=await readVisibleWorkspaceChanges(db,actor.space_id,scope.userId,{where:clauses.join(' AND '),params,limit:input.limit,cursor:input.cursor??null});
 const ids=page.entries.map(e=>e.change.change_set_id);
 const facts=new Map((await db.query<{id:string;session_id:string|null;active_run:boolean;pending_checkpoint:boolean;exhausted:boolean}>(`SELECT c.id,
   CASE WHEN w.owner_kind='conversation' THEN w.session_id ELSE (WITH RECURSIVE up AS (SELECT p.id,p.parent_workspace_id,p.session_id,p.owner_kind FROM execution_workspaces p WHERE p.id=w.parent_workspace_id
     UNION SELECT q.id,q.parent_workspace_id,q.session_id,q.owner_kind FROM execution_workspaces q JOIN up ON q.id=up.parent_workspace_id) SELECT session_id FROM up WHERE owner_kind='conversation' LIMIT 1) END AS session_id,
   EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.change_set_id=c.id AND r.status IN ${ACTIVE_RUN}) AS active_run,
   EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_state NOT IN ('saved','blocked')) AS pending_checkpoint,
   COALESCE(c.verification_json->'checkpoint_recovery'->>'state','')='exhausted' AS exhausted
  FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id WHERE c.space_id=$1 AND c.id=ANY($2::varchar[])`,[actor.space_id,ids])).rows.map(r=>[r.id,r]));
 // An Agent's `closable` is decided by the very authorizer `workspace.change.abandon` uses.
 const closeAuthorized=new Map<string,boolean>();
 if(scope.agent)for(const id of ids)closeAuthorized.set(id,await authorizedWorkspaceChange(db,id,actor,false,true,true,true).then(()=>true,()=>false));
 const items=page.entries.map(({change,run})=>{
  const f=facts.get(change.change_set_id);
  const same=Boolean(scope.sessionId&&f?.session_id===scope.sessionId);
  const saved=Boolean(change.source_commit&&change.source_commit!==change.base_commit);
  const blocker=!['open','ready','blocked'].includes(change.state)?'not_open'
   :change.integration_status&&!['conflict','verification_failed','failed','superseded'].includes(change.integration_status)?'integration_active'
   :f?.active_run?'run_active'
   :f?.pending_checkpoint&&!f.exhausted?'checkpoint_pending'
   :scope.agent&&!closeAuthorized.get(change.change_set_id)?'requires_person'
   :scope.agent&&change.state==='open'&&saved?'review_required'
   :null;
  return {change_set_id:change.change_set_id,revision:change.revision,state:change.state,workspace_id:change.workspace_id,generation:change.generation,
   owner_kind:change.parent_workspace_id?'delegation':'conversation',parent_workspace_id:change.parent_workspace_id,
   conversation_id:scope.agent&&!same?null:f?.session_id??null,same_conversation:same,run_id:run.id,run_status:run.status,
   summary:scope.agent&&!same?null:change.summary,saved_difference:saved,integration_id:change.integration_id,integration_status:change.integration_status,
   retention_state:change.retention?.state??null,retention_reason:change.retention?.reason??null,closable:blocker===null&&change.can_manage,close_blocker:blocker??(change.can_manage?null:'project_write_required')};
 });
 return {items,next_cursor:page.next_cursor};
}

export function workspaceChangeListRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {definition:definitions.get('workspace.change.list')!,readKind:'metadata',
  async resolve(db,raw,actor){const input=WorkspaceChangeListInputSchema.parse(raw);const scope=await listScope(db,actor,input);return {authority:`project:${scope.projectId}`,targets:{project_id:scope.projectId},resourceType:'project',resourceId:scope.projectId};},
  async authorize(db,raw,actor){await listScope(db,actor,WorkspaceChangeListInputSchema.parse(raw));},
  execute:(db,raw,actor)=>listWorkspaceChanges(db,actor,raw),
 };
}
