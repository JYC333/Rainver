import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {dbPool,type Queryable} from '../routeUtils/common.js';
import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {PgTaskRepository} from '../tasks/repository.js';
import {BoardMutationError} from '../tasks/boardColumns.js';
import {TaskControlError} from '../tasks/controlErrors.js';
import {CompletionRequirementsUnmet} from './taskWriteEvents.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';

type Input=OperationInput<'task.place_in_space_board'>;
async function task(db:Queryable,id:string,actor:OperationActor,lock=false){
  const row=(await db.query<{id:string;project_id:string|null;board_id:string|null}>(`SELECT t.id,t.project_id,t.board_id FROM tasks t
    WHERE t.id=$1 AND t.space_id=$2 AND t.deleted_at IS NULL
    AND ${contentReadSql('task','t','$3')}
    AND ${contentAccessLevelSql({definition:contentResourceDefinition('task')!,alias:'t',userExpr:'$3'})}='full'
    ${lock?'FOR UPDATE OF t':''}`,[id,actor.space_id,actor.on_behalf_of_user_id])).rows[0];
  if(!row||row.project_id)throw hidden();
  return row;
}
async function authorize(db:Queryable,input:Input,actor:OperationActor){
  await task(db,input.task_id,actor);
  const {board_id:board,column_id:column}=input.changes;
  // Pin the destination before the Task, so a concurrent Board reparent cannot
  // turn this Space-only operation into a Project write.
  if(board||column){
    const destination=(await db.query(`SELECT b.id FROM boards b
      WHERE b.space_id=$1 AND b.project_id IS NULL AND b.deleted_at IS NULL AND b.status='active'
      AND ($2::varchar IS NULL OR b.id=$2)
      AND ($3::varchar IS NULL OR EXISTS(SELECT 1 FROM board_columns c WHERE c.space_id=b.space_id AND c.board_id=b.id AND c.id=$3 AND c.deleted_at IS NULL))
      FOR SHARE OF b`,[actor.space_id,board||null,column||null])).rows;
    if(destination.length!==1)throw hidden();
  }
  await task(db,input.task_id,actor,true);
}
class CompletionRefusal extends OperationBusinessError{
  constructor(private readonly refusal:CompletionRequirementsUnmet){super('operation_invalid_input',422,'tasks');}
  override body(id:string){const body=super.body(id);body.error.metadata={code:'completion_requirements_unmet',missing:this.refusal.missing,unacknowledged:this.refusal.unacknowledged};return body;}
}
export function taskSpacePlacementRegistration(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
  const pool=dbPool(config);
  return {
    definition:definitions.get('task.place_in_space_board')!,
    async resolve(db,raw,actor){const input=raw as Input;await task(db,input.task_id,actor);return {authority:`task:${input.task_id}`,targets:{task_id:input.task_id},resourceType:'task',resourceId:input.task_id};},
    authorize:(db,raw,actor)=>authorize(db,raw as Input,actor),
    async authorizeResult(db,raw,actor){await task(db,(raw as {task_id:string}).task_id,actor,true);},
    async execute(db,raw,actor){
      const input=raw as Input;
      const current=await task(db,input.task_id,actor,true);
      const changes={...input.changes};
      if(Object.hasOwn(changes,'board_id')&&changes.board_id!==current.board_id&&!Object.hasOwn(changes,'column_id'))changes.column_id=null;
      const updated=await new PgTaskRepository(pool).updateTask({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!},input.task_id,changes,undefined,db);
      return {task_id:updated.id,board_id:updated.board_id??null,column_id:updated.column_id??null,status:updated.status};
    },
    classifyError(error){
      if(error instanceof CompletionRequirementsUnmet)return new CompletionRefusal(error);
      if(error instanceof BoardMutationError&&error.statusCode===404)return hidden();
      if((error instanceof BoardMutationError||error instanceof TaskControlError)&&(error.statusCode===409||error.statusCode===422))return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode,'tasks');
      return undefined;
    },
  };
}
