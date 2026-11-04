import {HttpError,type SpaceUserIdentity} from '../routeUtils/common.js';
import {PgTaskRepository} from '../tasks/repository.js';
import type {Pool} from '../../db/pool.js';
import {assertProjectReadable} from '../projects/access.js';
import {referenceReadableSql} from '../inquiry/problemReferences.js';
import {runInheritedReadSql} from '../access/contentAccessSql.js';

/** Read-only, bounded access to the entire retained Task stream, including retired stages. */
export async function readTaskHistory(db:Pool,identity:SpaceUserIdentity,taskId:string,before?:string){
 if(before!==undefined&&!/^[1-9][0-9]{0,17}$/.test(before))throw new HttpError(422,'Invalid history cursor');
 const task=await new PgTaskRepository(db).findReadableTask(identity,taskId);
 if(!task?.project_id)throw new HttpError(404,'Project Task not found');
 await assertProjectReadable(db,identity.spaceId,task.project_id,identity.userId);
 const full=await db.query(`SELECT t.id FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND ${referenceReadableSql("jsonb_build_object('type','task','id',t.id)",'$3','t.space_id','t.project_id')}`,[taskId,identity.spaceId,identity.userId]);
 if(!full.rowCount)throw new HttpError(404,'Task not found');
 const rows=await db.query(`SELECT e.id,e.seq::text AS seq,e.event_kind,e.actor_id,e.occurred_at,e.data_json FROM project_work_events e WHERE e.space_id=$1 AND e.subject_type='task' AND e.subject_id=$2 AND ($4::bigint IS NULL OR e.seq<$4) AND ${runInheritedReadSql("e.data_json->>'run_id'",'e.space_id','$3')} AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(e.data_json->'reference_refs','[]'::jsonb)) history_ref WHERE NOT COALESCE(${referenceReadableSql('history_ref','$3','e.space_id','e.project_id')},false)) ORDER BY e.seq DESC LIMIT 51`,[identity.spaceId,taskId,identity.userId,before??null]);
 return {items:rows.rows.slice(0,50),next_cursor:rows.rows.length>50?String(rows.rows[49]!.seq):null};
}
