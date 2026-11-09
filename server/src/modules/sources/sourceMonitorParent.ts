import {OperationBusinessError} from '../systemActions/operations/errors.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {assertSourceConnectionManageable} from './sourceConnectionAccess.js';
export class SourceMonitorScopeConflict extends OperationBusinessError {constructor(){super('operation_conflict',409,'sources');}}
export interface MonitorParent {id:string;project_id:string|null;owner_user_id:string;visibility:string}
/** Discover only in the authenticated Space; never discover a Space from an id. */
export async function discoverMonitorParent(db:Queryable,identity:SpaceUserIdentity,id:string):Promise<MonitorParent>{
 const row=(await db.query<MonitorParent>('SELECT id,project_id,owner_user_id,visibility FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[id,identity.spaceId])).rows[0];
 if(!row)throw new HttpError(404,'Source not found');
 await assertSourceConnectionManageable(db,identity,id);
 if(row.project_id)await assertProjectWriter(db,identity.spaceId,row.project_id,identity.userId,{allowArchived:true});
 return row;
}
/** Keys have already been admitted. Project -> parent -> child, with a recheck. */
export async function lockMonitorParent(db:Queryable,identity:SpaceUserIdentity,expected:MonitorParent){
 if(expected.project_id){try{await lockActiveProjectForMutation(db,identity.spaceId,expected.project_id);}catch(error){if(error instanceof HttpError&&error.statusCode===409)throw new SourceMonitorScopeConflict();throw error;}await assertProjectWriterForMutation(db,identity.spaceId,expected.project_id,identity.userId);}
 // A control may rename the parent. Serialize here rather than upgrade shared
 // locks after locking different children of the same Source.
 const row=(await db.query<MonitorParent>('SELECT id,project_id,owner_user_id,visibility FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE',[expected.id,identity.spaceId])).rows[0];
 if(!row)throw new HttpError(404,'Source not found');
 if(row.project_id!==expected.project_id||row.owner_user_id!==expected.owner_user_id||row.visibility!==expected.visibility)throw new SourceMonitorScopeConflict();
 await assertSourceConnectionManageable(db,identity,row.id);return row;
}
/** Owner-scoped domain admission covers implicit and explicit parent reuse.
 * Waiting is only for known root/pre-domain entry; composed writers try instead. */
export async function lockMonitorCreation(db:Queryable,identity:SpaceUserIdentity,wait=false){
 const key=`source-monitor-create:${identity.spaceId}:${identity.userId}`;
 if(wait){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);return;}
 const lock=(await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[key])).rows[0];
 if(!lock?.locked)throw new SourceMonitorScopeConflict();
}

/** Source pair row locks, not authority. Call inside the owning transaction,
 * after request/Project admission. Never depend on JOIN rowmark order. */
export async function lockSourceChannelReference(db:Queryable,space:string,channel:string,update=false):Promise<string|null>{
 const parent=(await db.query<{source_connection_id:string}>('SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2',[channel,space])).rows[0]?.source_connection_id;
 if(!parent)return null;
 const mode=update?'UPDATE':'SHARE';
 if(!(await db.query(`SELECT id FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR ${mode}`,[parent,space])).rows.length)return null;
 // Lock only a child still attached to the admitted parent. A concurrent
 // reparent must not cause a late lock of a different Source.
 if(!(await db.query(`SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 AND source_connection_id=$3 FOR ${mode}`,[channel,space,parent])).rows.length)return null;
 return parent;
}
