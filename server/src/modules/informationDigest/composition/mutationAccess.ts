import {projectBriefing} from '../briefing/projection.js';
import {topicScope} from '../topics/scope.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {lockReadingMutations} from '../../sources/readingMutationAccess.js';
import {lockBriefingVersionsClosure} from '../briefing/referenceDelivery.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {inputDeps,comparisonClosure,type ComparisonEntry} from '../briefing/authorization.js';
import {canonical} from '../../systemActions/operations/repository.js';
import type {lockSourceRetrievalRelease} from '../../sources/retrievalReleaseLocks.js';

/** Discovery pins the complete input/context of every candidate round before
 * any Source lock; changed cohorts or frozen dependencies require a fresh try. */
export async function lockCompositionMutation(db:Queryable,identity:SpaceUserIdentity,projectId:string,roundIds:readonly string[]){
 const ids=[...new Set(roundIds)].sort();
 const read=async()=>{
  const rounds=(await db.query<{id:string;briefing_id:string|null;execution_json:unknown;status:string}>(`SELECT id,briefing_id,execution_json,status FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 AND id=ANY($3::varchar[]) ORDER BY id`,[identity.spaceId,projectId,ids])).rows;
  const repository=new PgBriefingRepository(db),versions=[];
  for(const id of [...new Set(rounds.flatMap(r=>r.briefing_id?[r.briefing_id]:[]))].sort()){
   const row=await repository.get(identity.spaceId,id);if(row)versions.push({row,inputs:await repository.inputs(id)});
  }
  return {rounds,versions};
 };
 const before=await read();
 const refs: Parameters<typeof lockSourceRetrievalRelease>[3][number][]=[];
 const items:string[]=[];
 for(const {row,inputs} of before.versions){
  if(row.run_id)refs.push({object_type:'run',object_id:row.run_id});
  const comparison=comparisonClosure((row.comparison_json??[]) as ComparisonEntry[]);
  for(const dep of [...inputs.filter(i=>i.status==='included').map(inputDeps),comparison.deps]){
   for(const item of dep.items){items.push(item.id);if(item.connection_id)refs.push({object_type:'source_connection',object_id:item.connection_id});if(item.original)refs.push({object_type:'source_snapshot',object_id:item.original.snapshot_id},{object_type:'artifact',object_id:item.original.artifact_id});}
   for(const source of [...dep.annotations,...dep.signals])if(source.connection_id)refs.push({object_type:'source_connection',object_id:source.connection_id});
  }
  for(const source of [...row.context_json.map(c=>c.source),...comparison.context])if(source.type==='task')refs.push({object_type:'task',object_id:source.id});
 }
 await lockReadingMutations(db,identity,items,[projectId],refs);
 await lockBriefingVersionsClosure(db,identity.spaceId,before.versions.map(v=>({id:v.row.id,requester:v.row.requested_by_user_id})));
 if(ids.length)await db.query('SELECT id FROM project_reading_rounds WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,ids]);
 if(canonical(before)!==canonical(await read()))throw new HttpError(409,'Reading composition dependencies changed');
}

export async function assertCompositionRetryReadable(db:Queryable,identity:SpaceUserIdentity,projectId:string,roundIds:readonly string[]){
 await lockCompositionMutation(db,identity,projectId,roundIds);
 const versions=(await db.query<{goal_id:string;briefing_id:string|null}>('SELECT goal_id,briefing_id FROM project_reading_rounds WHERE space_id=$1 AND project_id=$2 AND id=ANY($3::varchar[]) ORDER BY id',[identity.spaceId,projectId,roundIds])).rows;
 if(versions.length!==roundIds.length)throw new HttpError(404,'Project Reading not found');
 const repository=new PgBriefingRepository(db);
 for(const version of versions){
  const row=version.briefing_id?await repository.get(identity.spaceId,version.briefing_id):null;
  if(!row||row.project_id!==projectId||(await projectBriefing(db,repository,topicScope(identity.spaceId,projectId,version.goal_id),row)).visibility!=='visible')throw new HttpError(404,'Project Reading not found');
 }
}
