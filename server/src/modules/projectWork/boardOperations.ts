import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {resolveAgentActorId} from '../../db/actorResolver.js';
import {dbPool,HttpError,type Queryable} from '../routeUtils/common.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {PgTaskRepository} from '../tasks/repository.js';
import {BoardMutationError,readProjectColumns,selectBoardColumn} from '../tasks/boardColumns.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {configureProjectBoard} from './boardConfiguration.js';
import {CompletionRequirementsUnmet} from './taskWriteEvents.js';

type Configure=OperationInput<'board.configure'>;
type Move=OperationInput<'task.move_to_column'>;
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
class CompletionRefusal extends OperationBusinessError {
  constructor(private readonly missing:string[],private readonly unacknowledged:string[]){super('operation_invalid_input',422,'tasks');}
  override body(id:string){const b=super.body(id);b.error.metadata={code:'completion_requirements_unmet',missing:this.missing,unacknowledged:this.unacknowledged};return b;}
}
async function project(db:Queryable,input:Configure|Move,actor:OperationActor){
  let id=input.project_id;
  if(actor.run_id){
    const run=(await db.query<{project_id:string|null}>('SELECT project_id FROM runs WHERE id=$1 AND space_id=$2',[actor.run_id,actor.space_id])).rows[0];
    if(!run?.project_id || id && id!==run.project_id)throw hidden();id=run.project_id;
  }
  if('task_id' in input){
    const row=(await db.query<{project_id:string|null}>('SELECT project_id FROM tasks WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[input.task_id,actor.space_id])).rows[0];
    if(!row?.project_id || id && row.project_id!==id)throw hidden();id=row.project_id;
  }
  if(!id)throw new OperationError('operation_invalid_input',422);
  return id;
}
async function authority(db:Queryable,id:string,actor:OperationActor,taskId?:string){
  const person=identity(actor);
  await assertProjectWriter(db,person.spaceId,id,person.userId,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,person.spaceId,id);}
  catch(error){if(error instanceof HttpError&&error.statusCode===409)throw new OperationBusinessError('operation_conflict',409,'board');throw error;}
  await assertProjectWriterForMutation(db,person.spaceId,id,person.userId);
  if(taskId){
    const task=(await db.query<{status:string}>(`SELECT t.status FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.project_id=$3 AND t.deleted_at IS NULL
      AND ${contentReadSql('task','t','$4')} AND ${contentAccessLevelSql({definition:contentResourceDefinition('task')!,alias:'t',userExpr:'$4'})}='full' FOR UPDATE OF t`,[taskId,person.spaceId,id,person.userId])).rows[0];
    if(!task)throw hidden();return task;
  }
}
export function boardOperationRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const pool=dbPool(config);
  return (['board.configure','task.move_to_column'] as const).map(id=>({
    definition:definitions.get(id)!,
    async resolve(db,raw,actor){
      const input=raw as Configure|Move,p=await project(db,input,actor);
      return {authority:actor.run_id?`project:${p}:run:${actor.run_id}`:`project:${p}`,targets:{project_id:p,...('task_id' in input?{task_id:input.task_id}:{})},resourceType:id==='board.configure'?'project':'task',resourceId:'task_id' in input?input.task_id:p};
    },
    normalizeInput(raw,scope){return {...raw as Configure|Move,project_id:(scope.targets as {project_id:string}).project_id};},
    async authorize(db,raw,actor){
      const input=raw as Configure|Move;
      if(actor.principal.kind==='agent'&&(!input.reason || 'override_completion' in input&&input.override_completion))throw new OperationError('operation_invalid_input',422);
      await authority(db,input.project_id!,actor,'task_id' in input?input.task_id:undefined);
    },
    async authorizeResult(db,raw,actor){const result=raw as {project_id:string;task_id?:string};await authority(db,result.project_id,actor,result.task_id);},
    async execute(db,raw,actor){
      const input=raw as Configure|Move,p=input.project_id!,person=identity(actor);
      // The actor is resolved from the actual Agent, never the responsible person.
      const origin=actor.principal.kind==='agent'?{actorId:await resolveAgentActorId(db,actor.space_id,actor.agent_id!),runId:actor.run_id!,projectId:p,reason:input.reason!}:undefined;
      if(id==='board.configure'){
        const {project_id:_project,reason:_reason,...configuration}=input as Configure;
        await configureProjectBoard(pool,person,p,configuration,origin,db);
        const layout=await readProjectColumns(db,person.spaceId,p);
        return {project_id:p,columns:layout.columns,columns_revision:layout.revision};
      }
      const move=input as Move,column=await selectBoardColumn(db,person.spaceId,p,{column_key:move.column_key,columns_revision:move.columns_revision}),current=await authority(db,p,actor,move.task_id);
      const task=await new PgTaskRepository(pool).updateTask(person,move.task_id,{
        status:current!.status==='blocked'&&column.status_key==='in_progress'?'blocked':column.status_key,
        board_id:column.board_id,column_id:column.board_id?column.key:null,override_completion:move.override_completion,
      },origin,db);
      return {project_id:p,task_id:task.id,status:task.status,column_id:task.column_id??null};
    },
    classifyError(error){
      if(error instanceof BoardMutationError && error.statusCode===404)return hidden();
      if(error instanceof CompletionRequirementsUnmet)return new CompletionRefusal(error.missing,error.unacknowledged);
      if(error instanceof BoardMutationError&&(error.statusCode===409||error.statusCode===422))return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode,'board');
      return undefined;
    },
  }));
}
