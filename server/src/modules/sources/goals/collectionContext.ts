import {assertCollectionDiscoveryContext,type CollectionDiscoveryContext} from './collectionDiscovery.js';
import {requireGoal} from './access.js';
import {sha256Json} from '../../evolution/hash.js';
import type {Queryable} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import type {RunRecord} from '../../runs/repository.js';
import {assertClosedReadingContext} from '../../prompts/index.js';
import {readingRunContext} from '../readingMethods/followingContext.js';
import {assertReadingAudience,assertReadingRunEgress} from '../readingMethods/context.js';

export interface SourceCollectionContext {
 schema_version:'source_collection.v1';
 project_id:string|null;
 context_hash:string;
 discovery:CollectionDiscoveryContext;
}
export function freezeCollectionContext(projectId:string|null,context:unknown,discovery:CollectionDiscoveryContext):SourceCollectionContext{
 return {schema_version:'source_collection.v1',project_id:projectId,discovery,context_hash:sha256Json({context,discovery})};
}
export function sourceCollectionContextOf(run:{contract_snapshot_json?:unknown}):SourceCollectionContext|null{
 return (run.contract_snapshot_json as {workflow_input_json?:{source_collection?:SourceCollectionContext}}|null)?.workflow_input_json?.source_collection??null;
}
/** Collection keeps the same context/Source authority without resolving a deep-reading method. */
export async function assertSourceCollectionContext(db:Queryable,run:RunRecord){
 const frozen=sourceCollectionContextOf(run);
 if(!frozen||frozen.schema_version!=='source_collection.v1'||run.project_id!==frozen.project_id||!run.instructed_by_user_id)throw new HttpError(403,'source_native_context_refused');
 const goal=(run.contract_snapshot_json as {workflow_input_json?:{source_goal?:{purpose?:string;goal_id?:string;source_connection_id?:string}}})?.workflow_input_json?.source_goal;
 if(goal?.purpose!=='collect'||!goal.goal_id||!goal.source_connection_id)throw new HttpError(403,'source_native_context_refused');
 const identity={spaceId:run.space_id,userId:run.instructed_by_user_id};
 const current=await requireGoal(db,identity,goal.goal_id);if(current.owner_user_id!==identity.userId)throw new HttpError(403,'source_authority_revoked');
 const source=(await db.query<{visibility:string;project_id:string|null}>('SELECT visibility,project_id FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[goal.source_connection_id,run.space_id])).rows[0];
 if(!source||frozen.project_id&&source.project_id!==frozen.project_id)throw new HttpError(403,'source_authority_revoked');
 await assertClosedReadingContext(db,run.space_id,run.id,frozen.project_id);
 const context=await readingRunContext(db,identity,run,frozen.project_id,source.visibility==='private');
 if(freezeCollectionContext(frozen.project_id,context,frozen.discovery).context_hash!==frozen.context_hash)throw new HttpError(409,'source_native_context_changed');
 await assertCollectionDiscoveryContext(db,identity,current.id,goal.source_connection_id,frozen.discovery);
 await assertReadingAudience(db,identity,null,null,goal.source_connection_id);
 await assertReadingRunEgress(db,run,goal.source_connection_id);
}
