import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {canonical} from '../systemActions/operations/repository.js';
import {OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectReadable,assertProjectReadableLocked} from '../projects/access.js';
import {discoverInquiry,authorizeInquiry} from '../inquiry/operationAdmission.js';
import {PgMemoryApplyRepository} from '../memory/memoryApplyRepository.js';
import {readProjectUndoEvent} from './updateUndo.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
export async function discoverUpdateUndo(db:Queryable,project:string,eventId:string,a:OperationActor){
 await assertProjectReadable(db,a.space_id,project,a.on_behalf_of_user_id!);
 const event=await readProjectUndoEvent(db,person(a),project,eventId);
 const refs=(Array.isArray(event.data_json?.reference_refs)?event.data_json.reference_refs:[]).filter((r):r is {type:string;id:string}=>!!r&&typeof r==='object'&&typeof r.type==='string'&&typeof r.id==='string');
 if(event.event_kind==='thread.round_closed'&&typeof event.data_json?.closeout_id==='string'){
  const closeout=(await db.query<{previous_primary:{context_refs?:Array<{role?:string;ref:{type:string;id:string}}>}}>('SELECT previous_primary FROM inquiry_round_closeouts WHERE id=$1 AND space_id=$2 AND project_id=$3 AND thread_id=$4',[event.data_json.closeout_id,a.space_id,project,event.subject_id])).rows[0];
  for(const ref of closeout?.previous_primary?.context_refs??[])if(ref.role==='input')refs.push(ref.ref);
 }
 const runId=typeof event.data_json?.run_id==='string'?event.data_json.run_id:null;
 const runScope=runId?(await db.query<{id:string;project_id:string|null;session_id:string|null;run_group_id:string|null;session_room_id:string|null;group_room_id:string|null}>('SELECT r.id,r.project_id,r.session_id,r.run_group_id,s.room_id AS session_room_id,g.room_id AS group_room_id FROM runs r LEFT JOIN sessions s ON s.id=r.session_id AND s.space_id=r.space_id LEFT JOIN agent_run_groups g ON g.id=r.run_group_id AND g.space_id=r.space_id WHERE r.id=$1 AND r.space_id=$2',[runId,a.space_id])).rows[0]??null:null;
 const input={project_id:project,...(event.subject_type==='inquiry_thread'?{thread_id:event.subject_id}:{}),input_refs:refs};
 return {event,input,runScope,inquiry:event.subject_type==='inquiry_thread'?await discoverInquiry(db,input,a,'inquiry.lifecycle.transition'):null};
}
export async function authorizeUpdateUndo(db:Queryable,project:string,eventId:string,a:OperationActor,before:Awaited<ReturnType<typeof discoverUpdateUndo>>){
 if(before.runScope){
  const closure=before.inquiry,projects=[...new Set([project,before.runScope.project_id,...closure?.roots.map(r=>r.primary_project_id)??[],...closure?.sources.flatMap(r=>[r.project_id,r.parent_project_id])??[],...closure?.snapshots.flatMap(r=>[r.project_id,r.parent_project_id])??[],...closure?.evidence.map(r=>r.project_id)??[]].filter((id):id is string=>!!id))].sort();
  for(const id of projects)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 '+(id===project&&closure?'FOR UPDATE':'FOR SHARE'),[id,a.space_id]);
  await db.query('SELECT id FROM project_members WHERE space_id=$1 AND project_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE',[a.space_id,projects,a.on_behalf_of_user_id]);
  const run=before.runScope;
  if(run.run_group_id)await db.query('SELECT id FROM agent_run_groups WHERE id=$1 AND space_id=$2 FOR SHARE',[run.run_group_id,a.space_id]);
  if(run.session_id)await db.query('SELECT id FROM sessions WHERE id=$1 AND space_id=$2 FOR SHARE',[run.session_id,a.space_id]);
  const rooms=[run.group_room_id,run.session_room_id].filter(Boolean).sort();
  await db.query('SELECT id FROM rooms WHERE id=ANY($1::varchar[]) AND space_id=$2 ORDER BY id FOR SHARE',[rooms,a.space_id]);
  await db.query('SELECT id FROM room_user_members WHERE room_id=ANY($1::varchar[]) AND space_id=$2 AND user_id=$3 ORDER BY id FOR SHARE',[rooms,a.space_id,a.on_behalf_of_user_id]);
  await db.query('SELECT id FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE',[run.id,a.space_id]);
  await db.query('SELECT id FROM content_access_grants WHERE resource_id=$1 AND space_id=$2 ORDER BY id FOR SHARE',[run.id,a.space_id]);
 }
 if(before.inquiry)await authorizeInquiry(db,before.input,a,'inquiry.lifecycle.transition',before.inquiry);
 else {
  await assertProjectReadableLocked(db,a.space_id,project,a.on_behalf_of_user_id!);
  if(before.event.subject_type==='memory_entry'){
   const memory=new PgMemoryApplyRepository(db),ids=[before.event.subject_id,...(typeof before.event.data_json?.restores_memory_id==='string'?[before.event.data_json.restores_memory_id]:[])];
   for(const id of ids)if(!await memory.authorizeOwnVersion(a.space_id,a.on_behalf_of_user_id!,id))throw hidden();
  }
 }
 await readProjectUndoEvent(db,person(a),project,eventId,true);
 if(canonical(await discoverUpdateUndo(db,project,eventId,a))!==canonical(before))throw new OperationError('operation_conflict',409,false,'projectWork');
}
