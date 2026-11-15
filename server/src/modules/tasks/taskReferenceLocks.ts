import {HttpError,type Queryable} from '../routeUtils/common.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {lockActivePerson} from '../access/activePerson.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {TaskControlError} from './controlErrors.js';
import {OperationError} from '../systemActions/operations/errors.js';

/**
 * The Task write closure: the one place every Task create/update writer
 * (`PgTaskRepository.createTask`/`updateTask`, and the core entries that
 * authorize before calling them) finds and locks what the write names.
 *
 * Discovery reads, unlocked, the rows the write references and the Projects
 * their access is decided in; then everything is locked in one order:
 *
 *   Projects (written ones `FOR UPDATE` with writer authority, and the
 *   Projects an Agent, a parent Task or its Folder is read through
 *   `FOR SHARE`, all in id order) → the writer's `project_members` rows in
 *   those read-through Projects → Folders → each assignee/claimer (users
 *   before memberships, the `lockActivePerson` order) → Agents (then the
 *   writer's grants on them) → Board → Tasks (the edited Task and a new
 *   parent's whole ancestry in id order, then the writer's grants on the
 *   parent).
 *
 * Each lock is a `FOR SHARE` re-read of the row its own writer changes first:
 * membership writers take the Project row (`lockProjectAudienceForChange`)
 * before `project_members`; content sharing updates the entity row before
 * its grants; Folder archive, account disable, Space exit, Agent
 * status/share, Board archive/delete and Task reparent/delete update the row
 * itself. So a writer either committed before the read and is seen, or waits
 * for this write to commit. A reference whose access moved to a Project that
 * was not locked is refused (409) after the locks — never a lock taken late,
 * never a deadlock left to the retry path. The core already holds the
 * writer's own user and Space membership; a Space's oversight mode is fixed
 * when it is created.
 */
export interface TaskWriter {spaceId:string;userId:string}
export interface TaskWriteRequest {
  /** The edited Task; absent for a new Task. */
  taskId?:string;
  /** A new Task's Project (an edit's comes from `body.project_id` or the Task). */
  projectId?:string|null;
  /** The fields as the canonical writer will store them. */
  body:Record<string,unknown>;
  /** Check Project writer authority under the lock (every edit and every person entry). */
  writerAuthority:boolean;
  /** A destination Board the body names only through its column (Space placement). */
  boardId?:string|null;
  /** A Space-only command: a Task that moved into a Project meanwhile is not its target (hidden, not a conflict). */
  standaloneOnly?:boolean;
  /**
   * A new Task's Folder need only be in its Project, whatever its status: the
   * follow-up Task writer's existing contract (`followUpTask.ts`). Still
   * share-held; every other entry requires an active Folder.
   */
  folderAnyStatus?:boolean;
}

const hidden=()=>new HttpError(404,'Not found');
const invalid=(message:string)=>new TaskControlError(422,message);
const conflict=(message:string)=>new TaskControlError(409,message);
const ids=(values:readonly (string|null|undefined)[])=>[...new Set(values.filter((v):v is string=>!!v))].sort();
const named=(body:Record<string,unknown>,key:string)=>typeof body[key]==='string'&&body[key]?body[key] as string:null;
const same=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const MAX_DEPTH=256;
const STALE_TASK_FOLDER="The Task's Project Folder is not in the Project it moves to; clear or reselect it";

/** The ancestors of `start` (itself first), stopping at `stopAt`, a root, or a revisit. */
async function ancestry(db:Queryable,spaceId:string,start:string,stopAt:string){
  const rows=(await db.query<{id:string;depth:number}>(`WITH RECURSIVE chain(id,parent,depth,seen) AS (
      SELECT id,parent_task_id,1,ARRAY[id]::varchar[] FROM tasks WHERE id=$1 AND space_id=$2
      UNION ALL
      SELECT t.id,t.parent_task_id,c.depth+1,c.seen||t.id FROM chain c JOIN tasks t ON t.id=c.parent AND t.space_id=$2
       WHERE c.id<>$3 AND NOT t.id=ANY(c.seen) AND c.depth<$4)
    SELECT id,depth FROM chain ORDER BY depth`,[start,spaceId,stopAt,MAX_DEPTH+1])).rows;
  return rows.map(r=>r.id);
}

type Scope={project_id:string|null;project_folder_id:string|null;folder_project_id:string|null};
/** Where a referenced Task's access is decided: its Project and its Folder's Project. */
async function taskScope(db:Queryable,spaceId:string,id:string):Promise<Scope|null>{
  return (await db.query<Scope>(`SELECT t.project_id,t.project_folder_id,f.project_id AS folder_project_id FROM tasks t
    LEFT JOIN project_folders f ON f.id=t.project_folder_id AND f.space_id=t.space_id
    WHERE t.id=$1 AND t.space_id=$2`,[id,spaceId])).rows[0]??null;
}
type Edited={id:string;project_id:string|null;project_folder_id:string|null};
async function readEdited(db:Queryable,w:TaskWriter,id:string,lock:boolean):Promise<Edited|null>{
  return (await db.query<Edited>(`SELECT t.id,t.project_id,t.project_folder_id FROM tasks t
    WHERE t.id=$1 AND t.space_id=$2 AND t.deleted_at IS NULL AND ${contentReadSql('task','t','$3')}
    AND ${contentAccessLevelSql({definition:contentResourceDefinition('task')!,alias:'t',userExpr:'$3'})}='full'
    ${lock?'FOR UPDATE OF t':''}`,[id,w.spaceId,w.userId])).rows[0]??null;
}
/** The writer's grant rows on a referenced resource, held after the resource row (the sharing writer's order). */
async function holdGrants(db:Queryable,w:TaskWriter,resourceType:'agent'|'task',id:string){
  await db.query(`SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type=$2 AND resource_id=$3 AND grantee_user_id=$4 AND revoked_at IS NULL ORDER BY id FOR SHARE`,[w.spaceId,resourceType,id,w.userId]);
}

type FolderRef={id:string;/** The Project it must be active in; null when it is only held for a reference's access. */ placedIn:string|null;named:boolean;stale:string;anyStatus?:boolean};
/** Folder → people → Agents → Board, each re-read under its share lock (the closure's middle). */
async function lockReferenceRows(db:Queryable,w:TaskWriter,refs:{folders:FolderRef[];users:string[];agents:Map<string,{project_id:string|null;access_project_id:string|null}>;board:{id:string;project:string|null}|null}){
  const s=w.spaceId;
  for(const id of ids(refs.folders.map(f=>f.id))){
    const row=(await db.query<{project_id:string;status:string}>('SELECT project_id,status FROM project_folders WHERE id=$1 AND space_id=$2 FOR SHARE',[id,s])).rows[0];
    for(const f of refs.folders.filter(f=>f.id===id&&f.placedIn)){
      // A named Folder elsewhere is not the writer's to reach; a kept one is a placement to clear.
      if(!row||(row.status!=='active'&&!f.anyStatus)||row.project_id!==f.placedIn)throw f.named?hidden():conflict(f.stale);
    }
  }
  for(const user of ids(refs.users)){
    try{await lockActivePerson(db,s,user);}catch(e){if(e instanceof HttpError)throw hidden();throw e;}
  }
  for(const agent of ids([...refs.agents.keys()])){
    const row=(await db.query<{project_id:string|null;access_project_id:string|null}>(`SELECT a.project_id,a.access_project_id FROM agents a WHERE a.space_id=$1 AND a.id=$2 AND a.status='active' AND a.agent_kind<>'system_assistant'
      AND ${contentReadSql('agent','a','$3')} FOR SHARE OF a`,[s,agent,w.userId])).rows[0];
    if(!row)throw hidden();
    if(row.project_id!==refs.agents.get(agent)!.project_id||row.access_project_id!==refs.agents.get(agent)!.access_project_id)throw conflict('The assigned Agent moved to another Project; read it again');
    await holdGrants(db,w,'agent',agent);
  }
  if(refs.board&&!(await db.query("SELECT id FROM boards WHERE space_id=$1 AND id=$2 AND deleted_at IS NULL AND status='active' AND project_id IS NOT DISTINCT FROM $3::varchar FOR SHARE",[s,refs.board.id,refs.board.project])).rows.length)throw hidden();
}

/**
 * Lock a Task write's whole reference closure (see the module comment).
 * Returns the edited Task as locked, or null for a new Task. Re-entrant in
 * one transaction: an entry that authorizes with it and then calls the
 * canonical writer, which runs it again, re-reads rows it already holds.
 */
export async function lockTaskWriteClosure(db:Queryable,w:TaskWriter,req:TaskWriteRequest):Promise<Edited|null>{
  const s=w.spaceId,body=req.body;
  // 1. Discovery, unlocked.
  const observed=req.taskId?await readEdited(db,w,req.taskId,false):null;
  if(req.taskId&&!observed)throw hidden();
  const target=observed?(Object.hasOwn(body,'project_id')?named(body,'project_id'):observed.project_id):(req.projectId??null);
  const moving=!!observed&&target!==observed.project_id;
  // The Folder the Task ends up in: the named one, or the kept one when its Project changes.
  const folderNamed=Object.hasOwn(body,'project_folder_id');
  const folder=folderNamed?named(body,'project_folder_id'):moving?observed!.project_folder_id:null;
  if(folder&&!target)throw folderNamed?invalid('A Project Folder needs the Task to be in its Project'):conflict(STALE_TASK_FOLDER);
  const parent=named(body,'parent_task_id');
  if(observed&&parent===observed.id)throw invalid('A task cannot be its own parent');
  const agents=new Map<string,{project_id:string|null;access_project_id:string|null}>();
  for(const id of ids([named(body,'assigned_agent_id'),named(body,'claimed_by_agent_id')])){
    const row=(await db.query<{project_id:string|null;access_project_id:string|null}>('SELECT project_id,access_project_id FROM agents WHERE id=$1 AND space_id=$2',[id,s])).rows[0];
    if(!row)throw hidden();
    agents.set(id,row);
  }
  const parentScope=parent?await taskScope(db,s,parent):null;
  if(parent&&!parentScope)throw hidden();
  const chain=observed&&parent?await ancestry(db,s,parent,observed.id):[];
  // 2. Projects, written and read-through, in one id order.
  const writes=ids(observed?[observed.project_id,target]:[target]);
  const reads=ids([...[...agents.values()].flatMap(a=>[a.project_id,a.access_project_id]),parentScope?.project_id,parentScope?.folder_project_id]).filter(p=>!writes.includes(p));
  if(req.writerAuthority)for(const p of writes)await assertProjectWriter(db,s,p,w.userId,{allowArchived:true});
  for(const p of ids([...writes,...reads])){
    if(writes.includes(p))await lockActiveProjectForMutation(db,s,p);
    else await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[p,s]);
  }
  if(req.writerAuthority)for(const p of writes)await assertProjectWriterForMutation(db,s,p,w.userId);
  if(reads.length)await db.query("SELECT id FROM project_members WHERE space_id=$1 AND project_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE",[s,reads,w.userId]);
  // 3. Folder → people → Agents → Board.
  const board=named(body,'board_id')??req.boardId??null;
  await lockReferenceRows(db,w,{
    folders:[...(folder?[{id:folder,placedIn:target,named:folderNamed,stale:STALE_TASK_FOLDER,anyStatus:!observed&&!!req.folderAnyStatus}]:[]),
      ...(parentScope?.project_folder_id?[{id:parentScope.project_folder_id,placedIn:null,named:false,stale:''}]:[])],
    users:[named(body,'assigned_user_id'),named(body,'claimed_by_user_id')].filter((v):v is string=>!!v),
    agents,board:board?{id:board,project:target}:null,
  });
  // 4. Tasks: the edited Task and a new parent's ancestry, in id order.
  let edited:Edited|null=null;
  if(observed){
    for(const id of ids([observed.id,...chain])){
      if(id===observed.id){edited=await readEdited(db,w,id,true);if(!edited)throw hidden();}
      else await db.query('SELECT id FROM tasks WHERE id=$1 AND space_id=$2 FOR SHARE',[id,s]);
    }
    if(edited!.project_id!==observed.project_id)throw req.standaloneOnly?hidden():conflict('Task Project changed; reload before editing');
    if(moving&&!folderNamed&&edited!.project_folder_id!==observed.project_folder_id)throw conflict(STALE_TASK_FOLDER);
  }else if(parent){
    await db.query('SELECT id FROM tasks WHERE id=$1 AND space_id=$2 FOR SHARE',[parent,s]);
  }
  if(parent){
    // The parent is the writer's to reference: readable, live, and still decided where it was discovered.
    if(!(await db.query(`SELECT t.id FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.deleted_at IS NULL AND ${contentReadSql('task','t','$3')}`,[parent,s,w.userId])).rows.length)throw hidden();
    const now=await taskScope(db,s,parent);
    if(now?.project_id!==parentScope!.project_id||now?.project_folder_id!==parentScope!.project_folder_id)throw conflict('The parent Task moved; read it again');
    await holdGrants(db,w,'task',parent);
    if(observed){
      const walked=await ancestry(db,s,parent,observed.id);
      if(walked.includes(observed.id))throw invalid('A Task cannot move under its own subtask');
      if(walked.length>MAX_DEPTH)throw invalid('The Task hierarchy is too deep');
      if(!same(walked,chain))throw conflict('The parent Task hierarchy changed; read it again');
    }
  }
  return edited;
}

/** A Board's Folder: active in the Board's Project and share-held, by the closure's Folder step. */
export async function lockBoardFolder(db:Queryable,w:TaskWriter,projectId:string|null,folder:string|null|undefined,options:{named:boolean}={named:true}){
  if(!folder)return;
  const stale="The Board's Project Folder is not in its destination Project; clear or reselect it";
  if(!projectId)throw options.named?invalid('A Project Folder needs a Project'):conflict(stale);
  await lockReferenceRows(db,w,{folders:[{id:folder,placedIn:projectId,named:options.named,stale}],users:[],agents:new Map(),board:null});
}

/**
 * The recipient of an Agent handoff, share-held before the Task is locked so
 * the handoff's own checks decide on rows that cannot change until commit.
 * A person is held as an active account and active Space member (the
 * `lockActivePerson` fence, which the account-disable writer's `users` update
 * meets); one who is not is refused by the handoff's own recipient check, the
 * same 422 as any other person who cannot take the Task on.
 */
export async function holdHandoffRecipient(db:Queryable,spaceId:string,to:{kind:'user'|'agent';id:string}|null|undefined){
  if(!to)return;
  if(to.kind==='user'){
    try{await lockActivePerson(db,spaceId,to.id);}
    catch(e){if(!(e instanceof HttpError&&e.statusCode===403))throw e;}
  }else await db.query('SELECT id FROM agents WHERE space_id=$1 AND id=$2 FOR SHARE',[spaceId,to.id]);
}

/**
 * For a core entry's authorize step, which runs before the business outcome:
 * the closure's refusals as the canonical conflict/invalid-input errors (an
 * unreachable reference is already the hidden 404).
 */
export async function authorizeTaskClosure<T>(lock:()=>Promise<T>):Promise<T>{
  try{return await lock();}
  catch(e){
    // TaskControlError, and the Project archive fence (ProjectArchivedMutationError).
    if(e instanceof HttpError&&(e.statusCode===409||e.statusCode===422))
      throw new OperationError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode,false,'tasks');
    throw e;
  }
}
