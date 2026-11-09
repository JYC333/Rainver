import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {runReadSql} from '../access/contentAccessSql.js';
import {canonical} from '../systemActions/operations/repository.js';
import {ProjectManagementMutationError} from './managementErrors.js';
export async function discoverPublicSummaryRun(db:Queryable,space:string,project:string,runId:string|null){
 if(!runId)return null;
 return (await db.query<{id:string;session_id:string|null;run_group_id:string|null;room_id:string|null;room_project_id:string|null}>(`SELECT r.id,r.session_id,r.run_group_id,room.id AS room_id,room.project_id AS room_project_id FROM runs r LEFT JOIN sessions s ON s.id=r.session_id AND s.space_id=r.space_id LEFT JOIN agent_run_groups g ON g.id=r.run_group_id AND g.space_id=r.space_id LEFT JOIN rooms room ON room.id=COALESCE(g.room_id,s.room_id) AND room.space_id=r.space_id WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3`,[runId,space,project])).rows[0]??null;
}
/** A provenance reference grants no execution authority and keeps the canonical Run/Room read tier. */
export async function authorizePublicSummaryRun(db:Queryable,identity:SpaceUserIdentity,project:string,runId:string|null,before:Awaited<ReturnType<typeof discoverPublicSummaryRun>>){
 if(!runId)return;
 const invalid=()=>new ProjectManagementMutationError(422,'generated_by_run_id must reference a readable Run in this Project');
 if(!before)throw invalid();
 if(before.run_group_id)await db.query('SELECT id FROM agent_run_groups WHERE id=$1 AND space_id=$2 FOR SHARE',[before.run_group_id,identity.spaceId]);
 if(before.session_id)await db.query('SELECT id FROM sessions WHERE id=$1 AND space_id=$2 FOR SHARE',[before.session_id,identity.spaceId]);
 if(before.room_id){await db.query('SELECT id FROM rooms WHERE id=$1 AND space_id=$2 FOR SHARE',[before.room_id,identity.spaceId]);await db.query('SELECT id FROM room_user_members WHERE room_id=$1 AND space_id=$2 AND user_id=$3 ORDER BY id FOR SHARE',[before.room_id,identity.spaceId,identity.userId]);}
 await db.query('SELECT id FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE',[runId,identity.spaceId]);
 await db.query('SELECT id FROM content_access_grants WHERE resource_id=$1 AND space_id=$2 ORDER BY id FOR SHARE',[runId,identity.spaceId]);
 if(canonical(await discoverPublicSummaryRun(db,identity.spaceId,project,runId))!==canonical(before))throw new ProjectManagementMutationError(409,'Run scope changed');
 if(!(await db.query(`SELECT r.id FROM runs r WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3 AND ${runReadSql('$4','r')}`,[runId,identity.spaceId,project,identity.userId])).rows.length)throw invalid();
}
