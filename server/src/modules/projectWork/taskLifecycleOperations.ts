import {missingTaskTarget} from './taskTargetDiscovery.js';
import {randomUUID} from 'node:crypto';
import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {resolveAgentActorId} from '../../db/actorResolver.js';
import {dbPool,HttpError,type Queryable} from '../routeUtils/common.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {PgTaskRepository} from '../tasks/repository.js';
import {deleteTask} from '../tasks/deleteTask.js';
import {TaskControlError} from '../tasks/controlErrors.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {completeTask,reportOnTask,handoffTask,requestTaskReview,setTaskStatus,type AgentActionContext} from './taskActions.js';
import {CompletionRequirementsUnmet} from './taskWriteEvents.js';

export const TASK_LIFECYCLE_OPERATIONS=['task.set_status','task.delete','task.report','task.complete','task.request_review','task.handoff'] as const;
type Id=typeof TASK_LIFECYCLE_OPERATIONS[number];
type Input=OperationInput<Id>;
type Task={id:string;project_id:string|null;status:string};
class CompletionRefusal extends OperationBusinessError {
  constructor(private readonly missing:string[],private readonly unacknowledged:string[]){super('operation_invalid_input',422,'tasks');}
  override body(id:string){const b=super.body(id);b.error.metadata={code:'completion_requirements_unmet',missing:this.missing,unacknowledged:this.unacknowledged};return b;}
}
async function readTask(db:Queryable,id:string,actor:OperationActor,deleted:boolean,lock=false,discoveryOperation?:Id):Promise<Task>{
  const row=(await db.query<Task>(`SELECT t.id,t.project_id,t.status FROM tasks t
    WHERE t.id=$1 AND t.space_id=$2 ${deleted?'':'AND t.deleted_at IS NULL'}
    AND ${contentReadSql('task','t','$3')}
    AND ${contentAccessLevelSql({definition:contentResourceDefinition('task')!,alias:'t',userExpr:'$3'})}='full'
    ${lock?'FOR UPDATE OF t':''}`,[id,actor.space_id,actor.on_behalf_of_user_id])).rows[0];
  if(!row){if(discoveryOperation)return missingTaskTarget(db,id,actor,discoveryOperation);throw hidden();}
  if(actor.run_id){
    const run=(await db.query<{project_id:string|null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2',[actor.run_id,actor.space_id])).rows[0];
    if(!run?.project_id || run.project_id!==row.project_id)throw hidden();
  }
  return row;
}
async function authorizeTask(db:Queryable,id:string,actor:OperationActor,deleted:boolean){
  const observed=await readTask(db,id,actor,deleted);
  if(observed.project_id){
    await assertProjectWriter(db,actor.space_id,observed.project_id,actor.on_behalf_of_user_id!,{allowArchived:true});
    try{await lockActiveProjectForMutation(db,actor.space_id,observed.project_id);}
    catch(e){if(e instanceof HttpError&&e.statusCode===409)throw new OperationError('operation_conflict',409);throw e;}
    await assertProjectWriterForMutation(db,actor.space_id,observed.project_id,actor.on_behalf_of_user_id!);
  }
  const current=await readTask(db,id,actor,deleted,true);
  if(current.project_id!==observed.project_id)throw new OperationError('operation_conflict',409);
  return current;
}
export function taskLifecycleRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const pool=dbPool(config);
  return TASK_LIFECYCLE_OPERATIONS.map(id=>({
    definition:definitions.get(id)!,
    async resolve(db,raw,actor){
      const t=await readTask(db,(raw as Input).task_id,actor,id==='task.delete',false,id);
      return {authority:`task:${t.id}${actor.run_id?`:run:${actor.run_id}`:''}`,targets:{task_id:t.id},resourceType:'task',resourceId:t.id};
    },
    async authorize(db,raw,actor){
      const input=raw as Input;
      if(actor.principal.kind==='agent'){
        if((id==='task.set_status'||id==='task.delete')&& !('reason' in input&&input.reason))throw new OperationError('operation_invalid_input',422);
        if('override_completion' in input&&input.override_completion || 'blocked_reason' in input&&input.blocked_reason)throw new OperationError('operation_invalid_input',422);
      }
      await authorizeTask(db,input.task_id,actor,id==='task.delete');
    },
    async authorizeResult(db,raw,actor){await authorizeTask(db,(raw as {task_id:string}).task_id,actor,id==='task.delete');},
    async execute(db,raw,actor){
      const input=raw as Input,identity={spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!};
      const t=await readTask(db,input.task_id,actor,id==='task.delete');
      const agent=actor.principal.kind==='agent';
      const actorId=agent?await resolveAgentActorId(db,actor.space_id,actor.agent_id!):null;
      if(id==='task.delete'){
        const reason=(input as OperationInput<'task.delete'>).reason;
        return deleteTask(pool,identity,t.id,agent?{actorId:actorId!,runId:actor.run_id!,projectId:t.project_id!,reason:reason!}:undefined,db);
      }
      if(!agent){
        // Existing human status writer retains completion acknowledgement and Space-only Tasks.
        const status=input as OperationInput<'task.set_status'>;
        const updated=await new PgTaskRepository(pool).updateTask(identity,t.id,{status:status.status,...(status.blocked_reason!==undefined?{blocked_reason:status.blocked_reason}:{}),override_completion:status.override_completion},undefined,db);
        return {task_id:updated.id,status:updated.status};
      }
      // Core owns transport replay. This key identifies the domain event chain only.
      const context:AgentActionContext={spaceId:actor.space_id,actorId:actorId!,agentId:actor.agent_id,runId:actor.run_id!,
        instructedByUserId:identity.userId,projectId:t.project_id!,idempotencyKey:randomUUID()};
      switch(id){
        case 'task.set_status':{const status=input as OperationInput<'task.set_status'>;const result=await setTaskStatus(pool,context,{...status,reason:status.reason!},db);return {task_id:result.task_id,status:result.status};}
        case 'task.report':return reportOnTask(db,context,input as OperationInput<'task.report'>);
        case 'task.complete':return completeTask(db,context,input as OperationInput<'task.complete'>);
        case 'task.request_review':return requestTaskReview(db,context,input as OperationInput<'task.request_review'>);
        case 'task.handoff':return {...await handoffTask(db,context,input as OperationInput<'task.handoff'>),released:(input as OperationInput<'task.handoff'>).to===null};
      }
    },
    classifyError(e){
      if(e instanceof CompletionRequirementsUnmet)return new CompletionRefusal(e.missing,e.unacknowledged);
      if(e instanceof TaskControlError && (e.statusCode===409 || e.statusCode===422))return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode,'tasks');
      return undefined;
    },
  }));
}
