import {randomUUID} from 'node:crypto';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {referenceReadableSql} from './problemReferences.js';
import {lockProblem,refreshProblem} from './problemFacts.js';
import {recordThreadWorkEvent} from './threadWorkEvents.js';
import {appendProjectWorkEvent} from '../projectWork/eventWriter.js';

/** The single Thread-link fact writer, inside the canonical Task link transaction.
 * No Task repository/service dependency or independent transaction lifecycle. */
export async function linkTaskToProblem(db:Queryable,context:{spaceId:string;actorId:string;instructedByUserId:string;runId?:string|null;reason?:string},taskId:string,link:{entity_id:string;role:string}):Promise<void>{
 const identity={spaceId:context.spaceId,userId:context.instructedByUserId};
 const task=(await db.query<{project_id:string}>(`SELECT t.project_id FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.deleted_at IS NULL AND ${referenceReadableSql("jsonb_build_object('type','task','id',t.id)",'$3','t.space_id','t.project_id')}`,[taskId,context.spaceId,context.instructedByUserId])).rows[0];
 if(!task?.project_id)throw new HttpError(404,'Readable Project Task not found');
 // Project → Thread locks serialize all entry points with lifecycle and round writes.
 const problem=await lockProblem(db,identity,task.project_id,link.entity_id);
 const current=await db.query(`SELECT t.id FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.project_id=$3 AND t.deleted_at IS NULL AND ${referenceReadableSql("jsonb_build_object('type','task','id',t.id)",'$4','t.space_id','t.project_id')} FOR KEY SHARE OF t`,[taskId,context.spaceId,task.project_id,context.instructedByUserId]);
 if(!current.rowCount)throw new HttpError(409,'Task scope or access changed; reload before linking');
 const inserted=await db.query<{id:string}>(`INSERT INTO task_entity_links(id,space_id,task_id,entity_type,entity_id,role,created_by_actor_id,created_at) VALUES($1,$2,$3,'inquiry_thread',$4,$5,$6,now()) ON CONFLICT DO NOTHING RETURNING id`,[randomUUID(),context.spaceId,taskId,link.entity_id,link.role,context.actorId]);
 if(!inserted.rowCount)return;
 const edge=inserted.rows[0]!.id;
 await refreshProblem(db,context.spaceId,link.entity_id);
 const actor=(await db.query<{agent_id:string|null}>(`SELECT agent_id FROM actors WHERE id=$1 AND space_id=$2`,[context.actorId,context.spaceId])).rows[0];
 if(!actor)throw new HttpError(422,'Link actor must belong to this Space');
 await recordThreadWorkEvent(db,{spaceId:context.spaceId,projectId:task.project_id,threadId:link.entity_id,userId:context.instructedByUserId,eventKind:'thread.work_recorded',occurredAt:new Date().toISOString(),idempotencySuffix:`task-link:${edge}`,data:{statement:problem.statement,work_kind:'link_task',task_id:taskId,role:link.role,summary:context.reason??'Linked a Task to this problem',reference_refs:[{type:'task',id:taskId}]},provenance:{runId:context.runId,agentId:actor.agent_id}});
 await appendProjectWorkEvent(db,{spaceId:context.spaceId,projectId:task.project_id,eventKind:'task.entity_linked',subjectType:'task',subjectId:taskId,actorId:context.actorId,runId:context.runId??null,idempotencyKey:`task.entity_linked:${edge}`,data:{entity_type:'inquiry_thread',entity_id:link.entity_id,role:link.role,reference_refs:[{type:'inquiry_thread',id:link.entity_id}]}});
}
