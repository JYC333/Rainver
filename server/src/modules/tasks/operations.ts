import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {TASK_CREATE_HUMAN_FIELDS,TASK_UPDATE_AGENT_FIELDS} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {resolveAgentActorId} from '../../db/actorResolver.js';
import {dbPool,type Queryable} from '../routeUtils/common.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,lockAgentRunProjectBeforeActor,ProjectArchivedMutationError} from '../projects/access.js';
import {RunBudgetExceededError,RunBudgetSourceReferenceError} from '../runs/budgetEnforcement.js';
import {RunCreateValidationError} from '../runs/runRepositoryTypes.js';
import {OperationError,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {BoardMutationError,readProjectColumns} from './boardColumns.js';
import {TaskControlError} from './controlErrors.js';
import {InquiryMutationError} from '../inquiry/operationErrors.js';
import {PgTaskRepository} from './repository.js';
import {authorizeTaskClosure,lockBoardFolder,lockTaskWriteClosure} from './taskReferenceLocks.js';
import {countTasksCreatedInTurn,lockTurnFanOutForTransaction,TASK_FAN_OUT_PER_TURN} from './turnFanOut.js';

export const TASK_OPERATIONS=['task.create','task.update','task.evaluation.record','task.plan.request','task.run.create','board.create','board.update'] as const;
type Id=typeof TASK_OPERATIONS[number];
type Input<I extends Id>=OperationInput<I>;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const conflict=()=>new OperationError('operation_conflict',409,false,'tasks');
const invalid=()=>new OperationError('operation_invalid_input',422,false,'tasks');

class TaskFanOutLimit extends OperationError {
  constructor(){super('operation_limit_exceeded',429,false,'tasks');}
  override body(requestId:string){const b=super.body(requestId);b.error.message=`This turn already created ${TASK_FAN_OUT_PER_TURN} Tasks. Continue in the next turn, or tell the user what is left to create.`;b.error.metadata={code:'task_fan_out_limit',limit:TASK_FAN_OUT_PER_TURN};return b;}
}

/** Active-Project write gate: read/writer first, then the aggregate row lock, then writer under that lock. */
async function projectGate(db:Queryable,a:OperationActor,projectId:string){
  const p=person(a);
  await assertProjectWriter(db,p.spaceId,projectId,p.userId,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,p.spaceId,projectId);}
  catch(e){if(e instanceof ProjectArchivedMutationError)throw conflict();throw e;}
  await assertProjectWriterForMutation(db,p.spaceId,projectId,p.userId);
}
/** A Task the caller can fully access (the level every Task writer requires). */
async function fullTask(db:Queryable,a:OperationActor,taskId:string,lock=false){
  const row=(await db.query<{id:string;project_id:string|null;task_role:string;status:string}>(`SELECT t.id,t.project_id,t.task_role,t.status FROM tasks t
    WHERE t.id=$1 AND t.space_id=$2 AND t.deleted_at IS NULL AND ${contentReadSql('task','t','$3')}
    AND ${contentAccessLevelSql({definition:contentResourceDefinition('task')!,alias:'t',userExpr:'$3'})}='full'
    ${lock?'FOR UPDATE OF t':''}`,[taskId,a.space_id,a.on_behalf_of_user_id])).rows[0];
  if(!row)throw hidden();
  return row;
}
/** Project → Task; a Task that changed Project between discovery and lock is a conflict. */
async function lockTask(db:Queryable,a:OperationActor,taskId:string,extraProject?:string|null){
  const observed=await fullTask(db,a,taskId);
  for(const p of [...new Set([observed.project_id,extraProject??null].filter((v):v is string=>!!v))].sort())await projectGate(db,a,p);
  const current=await fullTask(db,a,taskId,true);
  if(current.project_id!==observed.project_id)throw conflict();
  return current;
}
async function runProject(db:Queryable,a:OperationActor){
  const run=(await db.query<{project_id:string|null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2',[a.run_id,a.space_id])).rows[0];
  if(!run?.project_id)throw hidden();
  return run.project_id;
}

function classify(e:unknown){
  if(e instanceof BoardMutationError&&e.statusCode===404)return hidden();
  if(e instanceof TaskControlError||e instanceof InquiryMutationError||e instanceof BoardMutationError||e instanceof ProjectArchivedMutationError||e instanceof RunCreateValidationError||e instanceof RunBudgetExceededError||e instanceof RunBudgetSourceReferenceError)
    return markedRefusal(e as Error&{statusCode:number},'tasks');
  return undefined;
}

export function taskOperationRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const pool=dbPool(config);
  const repo=()=>new PgTaskRepository(pool,config);
  const taskScope=(id:string):ResolvedOperation=>({authority:`task:${id}`,targets:{task_id:id},resourceType:'task',resourceId:id});
  // An Agent's Task command acts only in its Run's Project: locked before the core pins person and Run
  // (Project → person → Run, as the same Run's releases lock); projectGate repeats every check under it.
  const agentProjectFirst={lockBeforeActor:(db:Queryable,_raw:unknown,a:OperationActor)=>lockAgentRunProjectBeforeActor(db,a)};
  const registrations:Record<Id,Omit<OperationRegistration,'definition'>>={
    'task.create':{
      ...agentProjectFirst,
      successStatus:201,
      // A person's create is placed by the core (Project Space, or Personal Space without a Project).
      userContentCreation:true,
      async resolve(db,raw,a){
        const input=raw as Input<'task.create'>;
        if(a.principal.kind==='agent'){
          // The Project is the Run's own; an input Project is only a statement to check.
          const p=await runProject(db,a);if(input.project_id&&input.project_id!==p)throw hidden();
          return {authority:`project:${p}:run:${a.run_id}`,targets:{project_id:p},resourceType:'project',resourceId:p};
        }
        // The core's access-owned placement (ADR 0013 decision 3) already chose
        // this person's Space: the Project's, or their Personal Space without one.
        const p=input.project_id??null;
        return p?{authority:`project:${p}`,targets:{project_id:p},resourceType:'project',resourceId:p}:{authority:`space:${a.space_id}`,targets:{project_id:null},resourceType:'space',resourceId:a.space_id};
      },
      async authorize(db,raw,a,scope){
        const input=raw as Input<'task.create'>,p=(scope.targets as {project_id:string|null}).project_id;
        if(a.principal.kind==='agent'&&TASK_CREATE_HUMAN_FIELDS.some(f=>Object.hasOwn(input,f)))throw invalid();
        if(a.principal.kind==='agent'){if(p)await projectGate(db,a,p);await lockTurnFanOutForTransaction(db,a.run_id!);}
        // A person's references: the canonical writer's own closure, here with writer authority.
        else await authorizeTaskClosure(()=>lockTaskWriteClosure(db,person(a),{projectId:p,body:input,writerAuthority:true}));
      },
      async authorizeResult(db,raw,a){
        const out=raw as {task_id:string;project_id:string|null};
        if(!(await db.query(`SELECT t.id FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.deleted_at IS NULL AND ${contentReadSql('task','t','$3')}`,[out.task_id,a.space_id,a.on_behalf_of_user_id])).rows.length)throw hidden();
        if(a.principal.kind==='agent'&&out.project_id!==await runProject(db,a))throw hidden();
      },
      async execute(db,raw,a,){
        const {required_outputs,...input}=raw as Input<'task.create'>,p=person(a);
        let created;
        if(a.principal.kind==='agent'){
          const project=await runProject(db,a);
          // Counted under the turn fan-out lock the follow-up reconciler also holds.
          if(await countTasksCreatedInTurn(db,a.space_id,a.run_id!)>=TASK_FAN_OUT_PER_TURN)throw new TaskFanOutLimit();
          // The person owns the Task and its access; task.created is attributed to the Agent.
          created=await repo().createTask(p,{
            project_id:project,title:input.title,description:input.description??null,
            acceptance_criteria_json:input.acceptance_criteria_json??null,definition_of_done:input.definition_of_done??null,
            required_outputs_json:required_outputs??null,priority:input.priority,risk_level:input.risk_level,
            due_at:input.due_at??null,start_after:input.start_after??null,visibility:'space_shared',
            source_run_id:a.run_id,links:input.links,board_column:input.board_column,
          },db,await resolveAgentActorId(db,a.space_id,a.agent_id!));
        }else{
          const project=input.project_id??null;
          created=await repo().createTask(p,{...input,project_id:project,...(required_outputs!==undefined?{required_outputs_json:required_outputs}:{}),
            visibility:project?'space_shared':'private'},db);
        }
        return {task_id:created.id,space_id:created.space_id,project_id:created.project_id??null,title:created.title,status:created.status,column_id:created.column_id??null};
      },
    },
    'task.update':{
      ...agentProjectFirst,
      // One editor for PATCH and the Agent tool. An Agent edits only the text of a
      // Task in its own Run's Project; unavailable targets use the hidden 404.
      async resolve(db,raw,a){
        const id=(raw as Input<'task.update'>).task_id;
        if(a.principal.kind!=='agent'){await fullTask(db,a,id);return taskScope(id);}
        const project=await runProject(db,a);
        const row=await fullTask(db,a,id);
        if(row.project_id!==project)throw hidden();
        return {...taskScope(id),authority:`task:${id}:run:${a.run_id}`};
      },
      async authorize(db,raw,a,scope){
        const {task_id,...changes}=raw as Input<'task.update'>;
        if(a.principal.kind==='agent'){
          if(Object.keys(changes).some(f=>!(TASK_UPDATE_AGENT_FIELDS as readonly string[]).includes(f)))throw invalid();
          const project = await runProject(db,a);
          if((await lockTask(db,a,task_id)).project_id!==project)throw hidden();
          scope.policyFacts = {...scope.policyFacts, gmail_write_project_id: project};
        }
        // The canonical writer's closure (it runs again, re-entrantly, in execute); PATCH never places.
        await authorizeTaskClosure(()=>lockTaskWriteClosure(db,person(a),{taskId:task_id,body:{...changes,board_id:undefined,column_id:undefined},writerAuthority:true}));
      },
      async authorizeResult(db,raw,a){
        const row=await fullTask(db,a,(raw as {task_id:string}).task_id);
        if(a.principal.kind==='agent'&&row.project_id!==await runProject(db,a))throw hidden();
      },
      async execute(db,raw,a){
        const {task_id,...changes}=raw as Input<'task.update'>;
        // An Agent's edit is attributed to it in the same transaction's task.content_changed event.
        const agentContext=a.principal.kind==='agent'?{actorId:await resolveAgentActorId(db,a.space_id,a.agent_id!),runId:a.run_id!,projectId:await runProject(db,a)}:undefined;
        const updated=await repo().updateTask(person(a),task_id,changes,agentContext,db,{publicPatch:true});
        return {task_id:updated.id,project_id:updated.project_id??null,status:updated.status,title:updated.title,description:updated.description??null};
      },
    },
    'task.evaluation.record':{
      successStatus:201,
      async resolve(db,raw,a){const id=(raw as Input<'task.evaluation.record'>).task_id;await fullTask(db,a,id);return taskScope(id);},
      async authorize(db,raw,a){await lockTask(db,a,(raw as Input<'task.evaluation.record'>).task_id);},
      async authorizeResult(db,raw,a){await fullTask(db,a,(raw as {task_id:string}).task_id);},
      async execute(db,raw,a){
        const {task_id,...body}=raw as Input<'task.evaluation.record'>;
        const row=await repo().createTaskEvaluation(person(a),task_id,body,db) as {id:string;task_id:string;run_id:string|null;recommendation:string|null};
        return {evaluation_id:row.id,task_id:row.task_id,run_id:row.run_id??null,recommendation:row.recommendation??null};
      },
    },
    'task.plan.request':{
      successStatus:202,
      async resolve(db,raw,a){const id=(raw as Input<'task.plan.request'>).task_id;await fullTask(db,a,id);return taskScope(id);},
      async authorize(db,raw,a){await lockTask(db,a,(raw as Input<'task.plan.request'>).task_id);},
      async authorizeResult(db,raw,a){await fullTask(db,a,(raw as {task_id:string}).task_id);},
      async execute(db,raw,a){
        const {task_id,...body}=raw as Input<'task.plan.request'>;
        const run=await repo().requestPlanningRun(person(a),task_id,body,db);
        return {run_id:String(run.id),task_id,status:String(run.status)};
      },
    },
    'task.run.create':{
      successStatus:201,
      async resolve(db,raw,a){const id=(raw as Input<'task.run.create'>).task_id;await fullTask(db,a,id);return taskScope(id);},
      async authorize(db,raw,a){await lockTask(db,a,(raw as Input<'task.run.create'>).task_id);},
      async authorizeResult(db,raw,a){await fullTask(db,a,(raw as {task_id:string}).task_id);},
      async execute(db,raw,a){
        // Role and parent Run are server-owned: a person's Task Run is always the primary role.
        const {task_id,...body}=raw as Input<'task.run.create'>;
        const run=await repo().createTaskRun(person(a),task_id,body,db);
        return {run_id:String(run.id),task_id,status:String(run.status)};
      },
    },
    'board.create':{
      successStatus:201,
      userContentCreation:true,
      async resolve(_db,raw,a){
        const p=(raw as Input<'board.create'>).project_id??null;
        return p?{authority:`project:${p}`,targets:{project_id:p},resourceType:'project',resourceId:p}:{authority:`space:${a.space_id}`,targets:{project_id:null},resourceType:'space',resourceId:a.space_id};
      },
      async authorize(db,raw,a,scope){
        const input=raw as Input<'board.create'>,p=(scope.targets as {project_id:string|null}).project_id;
        if(p)await projectGate(db,a,p);
        await authorizeTaskClosure(()=>lockBoardFolder(db,person(a),p,input.project_folder_id));
      },
      async execute(db,raw,a,){
        const input=raw as Input<'board.create'>;
        const board=await repo().createBoard(person(a),{...input,project_id:input.project_id??null},db);
        return {board_id:String(board.id),space_id:a.space_id,project_id:(board.project_id as string|null)??null,status:String(board.status)};
      },
    },
    'board.update':{
      async resolve(db,raw,a){
        const input=raw as Input<'board.update'>,id=input.board_id;
        // Only the exact delete command can discover a Board it already deleted:
        // a lost response replays its receipt after authority is checked again.
        if(!(await db.query(`SELECT id FROM boards WHERE space_id=$1 AND id=$2${input.deleted?'':' AND deleted_at IS NULL'}`,[a.space_id,id])).rows.length)throw hidden();
        return {authority:`board:${id}`,targets:{board_id:id},resourceType:'board',resourceId:id};
      },
      async authorize(db,raw,a){
        const input=raw as Input<'board.update'>;
        type Row={project_id:string|null;project_folder_id:string|null;status:string;sort_order:number|null;deleted_at:Date|null};
        const read=async(lock:boolean)=>(await db.query<Row>(`SELECT project_id,project_folder_id,status,sort_order,deleted_at FROM boards WHERE space_id=$1 AND id=$2${input.deleted?'':' AND deleted_at IS NULL'}${lock?' FOR UPDATE':''}`,[a.space_id,input.board_id])).rows[0];
        const observed=await read(false);if(!observed)throw hidden();
        if(observed.deleted_at){
          // Replay discovery of a committed delete: the retained Project's current writer
          // authority is required; a fresh delete of a deleted Board is refused in execute.
          if(observed.project_id)await projectGate(db,a,observed.project_id);
          const current=await read(true);
          if(!current||current.project_id!==observed.project_id)throw conflict();
          return;
        }
        const target=Object.hasOwn(input,'project_id')?input.project_id??null:observed.project_id;
        // Both sides of a move are written: each Project is gated, in id order (as updateBoard always did).
        for(const p of [...new Set([observed.project_id,target].filter((v):v is string=>!!v))].sort())await projectGate(db,a,p);
        const current=await read(true);
        if(!current||current.deleted_at||current.project_id!==observed.project_id)throw conflict();
        const moving=target!==current.project_id;
        // The Board's Folder stays inside its Project: a named Folder, or the kept one on a move.
        const named=Object.hasOwn(input,'project_folder_id');
        const folder=named?input.project_folder_id??null:moving?current.project_folder_id:null;
        // A kept Folder outside the destination is a stale placement to clear, not an unknown row.
        await authorizeTaskClosure(()=>lockBoardFolder(db,person(a),target,folder,{named}));
        const selecting=moving||input.deleted===true||Object.hasOwn(input,'status')&&input.status!==current.status||Object.hasOwn(input,'sort_order')&&input.sort_order!==current.sort_order;
        if(!selecting)return;
        // A Project Board's columns are revision-bearing (board.configure): a change that can
        // select another active Board is made against each affected Project's current revision.
        const revision=async(p:string)=>(await readProjectColumns(db,a.space_id,p)).revision;
        const primary=current.project_id??target;
        if(primary&&input.columns_revision!==await revision(primary))throw conflict();
        if(current.project_id&&target&&moving&&input.target_columns_revision!==await revision(target))throw conflict();
      },
      async execute(db,raw,a){
        const {board_id,deleted,columns_revision:_revision,target_columns_revision:_target,...changes}=raw as Input<'board.update'>;
        if((await db.query<{deleted_at:Date|null}>('SELECT deleted_at FROM boards WHERE space_id=$1 AND id=$2',[a.space_id,board_id])).rows[0]?.deleted_at)throw hidden();
        const board=await repo().updateBoard(person(a),board_id,{...changes,...(deleted?{deleted_at:new Date().toISOString()}:{})},db)
          ?? (await db.query<{id:string;project_id:string|null;status:string}>('SELECT id,project_id,status FROM boards WHERE space_id=$1 AND id=$2',[a.space_id,board_id])).rows[0];
        return {board_id,space_id:a.space_id,project_id:(board.project_id as string|null)??null,status:String(board.status)};
      },
    },
  };
  return TASK_OPERATIONS.map(id=>({definition:definitions.get(id)!,classifyError:classify,...registrations[id]}));
}
