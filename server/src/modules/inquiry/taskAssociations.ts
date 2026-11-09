import {InquiryMutationError,InquiryTaskFanOutError} from "./operationErrors.js";
import {runInheritedReadSql} from "../access/contentAccessSql.js";
import {countTasksCreatedInTurn,lockTurnFanOutForTransaction,TASK_FAN_OUT_PER_TURN} from "../tasks/turnFanOut.js";
import { ProblemTaskLinkRequestSchema, ProblemWorkRequestSchema } from '@rainver/protocol';
import { resolveAgentActorId, resolveUserActorId } from '../../db/actorResolver.js';
import { HttpError, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { PgTaskRepository } from '../tasks/repository.js';
import { linkTaskEntities, requireProjectTask } from '../projectWork/taskActions.js';
import { assertProjectReadable } from '../projects/access.js';
import { referenceReadableSql } from './problemReferences.js';
import { assertThreadReadable, threadReadableSql } from './threadAccess.js';
import { lockProblem, problemCommandKey, replayProblemCommand, saveProblemCommand } from './problemFacts.js';
import { type ThreadEventProvenance } from './threadWorkEvents.js';
import { InquiryProblemEngineService } from './problemEngineService.js';

/** Long-lived Task links reuse task_entity_links, not a second progress model. */
export class InquiryTaskAssociationService {
 constructor(private readonly pool:Queryable){}
 private async assertRun(db:Queryable,identity:SpaceUserIdentity,project:string,source?:ThreadEventProvenance){
  if(!source?.runId)return;
  const row=await db.query(`SELECT r.id FROM runs r WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3 AND r.instructed_by_user_id=$4 AND r.agent_id IS NOT DISTINCT FROM $5::varchar AND ${runInheritedReadSql('r.id','r.space_id','$4')}`,[source.runId,identity.spaceId,project,identity.userId,source.agentId??null]);
  if(!row.rowCount)throw new HttpError(404,'Originating Project Run not found');
 }
 private async assertTask(db:Queryable,identity:SpaceUserIdentity,project:string,id:string){
  const result=await db.query<{id:string;status:string;title:string}>(`SELECT t.id,t.status,t.title FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.project_id=$3 AND t.deleted_at IS NULL AND ${referenceReadableSql("jsonb_build_object('type','task','id',t.id)",'$4','t.space_id','t.project_id')}`,[id,identity.spaceId,project,identity.userId]);
  if(!result.rows[0])throw new HttpError(404,'Task not found');return result.rows[0];
 }
 private async assertLink(db:Queryable,identity:SpaceUserIdentity,project:string,thread:string,task:string){
  await assertProjectReadable(db,identity.spaceId,project,identity.userId);
  await assertThreadReadable(db,identity,project,thread,'read_content');
  const row=await this.assertTask(db,identity,project,task);
  if(!(await db.query(`SELECT id FROM task_entity_links WHERE space_id=$1 AND task_id=$2 AND entity_type='inquiry_thread' AND entity_id=$3`,[identity.spaceId,task,thread])).rowCount)throw new HttpError(404,'Task association not found');
  return row;
 }
 async link(identity:SpaceUserIdentity,project:string,thread:string,body:unknown,provenance?:ThreadEventProvenance,trustedCall?:string){
  const parsed=ProblemTaskLinkRequestSchema.safeParse(body);if(!parsed.success)throw new InquiryMutationError(422,parsed.error.message);const input=parsed.data;
  return withQueryableTransaction(this.pool,async db=>{
   await lockProblem(db,identity,project,thread);
   await this.assertRun(db,identity,project,provenance);
   const key=problemCommandKey(identity,`task-link:${input.idempotency_key}`,provenance,trustedCall&&`task-link:${trustedCall}`);
   const replay=await replayProblemCommand(db,identity.spaceId,thread,key,input);
   if(replay){await this.assertTask(db,identity,project,String(replay.task_id));return replay;}
   const actorId=provenance?.agentId?await resolveAgentActorId(db,identity.spaceId,provenance.agentId):await resolveUserActorId(db,identity.spaceId,identity.userId);
   if(input.task?.project_id && input.task.project_id!==project)throw new InquiryMutationError(422,'Task must belong to this Project');
   if(input.task && provenance?.runId){
    await lockTurnFanOutForTransaction(db,provenance.runId);
    if(await countTasksCreatedInTurn(db,identity.spaceId,provenance.runId)>=TASK_FAN_OUT_PER_TURN)throw new InquiryTaskFanOutError();
   }
   let created:Awaited<ReturnType<PgTaskRepository["createTask"]>>|null=null;
   if(input.task){
    // The repository stores the request's `required_outputs` as the column the
    // completion gate reads; passing it through unmapped silently drops it.
    const {required_outputs,...task}=input.task;
    created=await new PgTaskRepository(this.pool).createTask(identity,{...task,required_outputs_json:required_outputs??null,links:(task.links??[]).filter(link=>!(link.entity_type==="inquiry_thread"&&link.entity_id===thread&&link.role===input.role)),project_id:project,...(provenance?.runId?{source_run_id:provenance.runId,visibility:"space_shared"}:{})},db,provenance?.agentId?actorId:undefined);
   }
   const taskId=created?.id??input.task_id!;
   await this.assertTask(db,identity,project,taskId);
   await requireProjectTask(db,identity.spaceId,taskId,identity.userId,project,{lock:true});
   const exists=(await db.query(`SELECT id FROM task_entity_links WHERE space_id=$1 AND task_id=$2 AND entity_type='inquiry_thread' AND entity_id=$3 AND role=$4`,[identity.spaceId,taskId,thread,input.role])).rowCount!==0;
   await linkTaskEntities(db,{spaceId:identity.spaceId,actorId,instructedByUserId:identity.userId,runId:provenance?.runId,reason:input.reason},taskId,[{entity_type:'inquiry_thread',entity_id:thread,role:input.role}]);
   const result={task_id:taskId,thread_id:thread,role:input.role,created:!!created,linked:!!created||!exists};
   await saveProblemCommand(db,identity,project,thread,key,input,result);return result;
  });
 }
 async tasks(identity:SpaceUserIdentity,project:string,thread:string,after?:string){
  await assertProjectReadable(this.pool,identity.spaceId,project,identity.userId);await assertThreadReadable(this.pool,identity,project,thread,'read_content');
  const rows=await this.pool.query(`SELECT t.id,t.title,t.status,array_agg(l.role ORDER BY l.role) AS roles FROM task_entity_links l JOIN tasks t ON t.id=l.task_id AND t.space_id=l.space_id WHERE l.space_id=$1 AND l.entity_type='inquiry_thread' AND l.entity_id=$2 AND t.project_id=$3 AND t.deleted_at IS NULL AND ($5::varchar IS NULL OR t.id>$5) AND ${referenceReadableSql("jsonb_build_object('type','task','id',t.id)",'$4','t.space_id','t.project_id')} GROUP BY t.id ORDER BY t.id LIMIT 51`,[identity.spaceId,thread,project,identity.userId,after??null]);
  return {items:rows.rows.slice(0,50),next_cursor:rows.rows.length>50?String(rows.rows[49]!.id):null};
 }
 async threads(identity:SpaceUserIdentity,task:string,after?:string){
  const t=await new PgTaskRepository(this.pool).findReadableTask(identity,task);if(!t?.project_id)throw new HttpError(404,'Project Task not found');
  await assertProjectReadable(this.pool,identity.spaceId,t.project_id,identity.userId);await this.assertTask(this.pool,identity,t.project_id,task);
  const rows=await this.pool.query(`SELECT so.id,left(q.statement,500) AS statement,q.lifecycle_status,array_agg(l.role ORDER BY l.role) AS roles FROM task_entity_links l JOIN inquiry_threads q ON q.object_id=l.entity_id AND q.space_id=l.space_id JOIN space_objects so ON so.id=q.object_id AND so.space_id=q.space_id WHERE l.space_id=$1 AND l.task_id=$2 AND l.entity_type='inquiry_thread' AND q.project_id=$3 AND ($5::varchar IS NULL OR so.id>$5) AND ${threadReadableSql('so','$4','read_content')} GROUP BY so.id,q.statement,q.lifecycle_status ORDER BY so.id LIMIT 51`,[identity.spaceId,task,t.project_id,identity.userId,after??null]);
  return {items:rows.rows.slice(0,50),next_cursor:rows.rows.length>50?String(rows.rows[49]!.id):null};
 }
 async result(identity:SpaceUserIdentity,project:string,thread:string,task:string){
  const row=await this.assertLink(this.pool,identity,project,thread,task);
  const artifacts=await this.pool.query(`SELECT a.id,ta.role FROM task_artifacts ta JOIN artifacts a ON a.id=ta.artifact_id AND a.space_id=ta.space_id WHERE ta.space_id=$1 AND ta.task_id=$2 AND ${referenceReadableSql("jsonb_build_object('type','artifact','id',a.id)",'$4','a.space_id','$3::varchar')} ORDER BY a.id LIMIT 51`,[identity.spaceId,task,project,identity.userId]);
  return {task_id:row.id,status:row.status,task_work_path:`/tasks/${row.id}`,artifacts:artifacts.rows.slice(0,50),artifacts_truncated:artifacts.rows.length>50};
 }
 async referenceResult(identity:SpaceUserIdentity,project:string,thread:string,task:string,body:unknown,provenance?:ThreadEventProvenance,trustedCall?:string){
  const parsed=ProblemWorkRequestSchema.safeParse(body);if(!parsed.success)throw new InquiryMutationError(422,parsed.error.message);const input=parsed.data;
  if(input.work_kind!=='reference_result')throw new InquiryMutationError(422,'Use reference_result to collect Task results; judgment is separate');
  return withQueryableTransaction(this.pool,async db=>{
   await lockProblem(db,identity,project,thread);await this.assertRun(db,identity,project,provenance);await this.assertLink(db,identity,project,thread,task);
   for(const ref of input.output_refs.filter(r=>r.type==='artifact')){
    if(!(await db.query(`SELECT id FROM task_artifacts WHERE space_id=$1 AND task_id=$2 AND artifact_id=$3`,[identity.spaceId,task,ref.id])).rowCount)throw new InquiryMutationError(422,'Task result outputs must be linked to this Task');
   }
   return new InquiryProblemEngineService(db).recordWork(identity,project,thread,{...input,input_refs:[...input.input_refs.filter(r=>r.type!=='task'||r.id!==task),{type:'task',id:task}]},provenance,undefined,trustedCall&&`task-result:${trustedCall}`);
  });
 }
}
