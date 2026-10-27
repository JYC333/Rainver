import {HttpError,type Queryable} from '../../routeUtils/common.js';
type Row=Record<string,unknown>;
export interface TransferState {at:string;channel:Row;tasks:Row[];backfills:Row[];expected:{channel:Row;tasks:Row[];backfills:Row[]}}
async function channelRow(db:Queryable,space:string,id:string){return (await db.query<{snapshot:Row}>('SELECT to_jsonb(ch) snapshot FROM source_channels ch WHERE space_id=$1 AND id=$2 FOR UPDATE',[space,id])).rows[0]?.snapshot;}
async function rows(db:Queryable,sql:string,args:unknown[]){return (await db.query<{snapshot:Row}>(sql,args)).rows.map(r=>r.snapshot);}
export async function transferRows(db:Queryable,space:string,channel:string,project:string|null){
 const ch=await channelRow(db,space,channel);if(!ch)throw new HttpError(404,'Source unavailable');
 const tasks=await rows(db,`SELECT to_jsonb(t) snapshot FROM scheduler_tasks t WHERE space_id=$1 AND ((task_type='source_channel_scan' AND task_key=$2) OR (task_type='project_information_monitoring' AND task_key=$3 AND EXISTS(SELECT 1 FROM projects p JOIN project_information_monitoring_versions v ON v.id=p.active_information_monitoring_version_id WHERE p.id=$3 AND v.config_json->>'source_channel_id'=$2))) ORDER BY id FOR UPDATE`,[space,channel,project]);
 const backfills=await rows(db,`SELECT to_jsonb(p) snapshot FROM source_backfill_plans p WHERE space_id=$1 AND source_channel_id=$2 AND status IN ('approved','running','paused') ORDER BY id FOR UPDATE`,[space,channel]);
 return {channel:ch,tasks,backfills};
}
export async function pauseTransfer(db:Queryable,space:string,channel:string,project:string|null):Promise<TransferState>{
 const before=await transferRows(db,space,channel,project);
 for(const t of before.tasks)await db.query("UPDATE scheduler_tasks SET status='paused',next_run_at=NULL WHERE id=$1 AND space_id=$2",[t.id,space]);
 for(const p of before.backfills)await db.query("UPDATE source_backfill_plans SET status='paused',next_eligible_at=NULL,updated_at=now() WHERE id=$1 AND space_id=$2",[p.id,space]);
 await db.query("UPDATE source_channels SET fetch_frequency='manual' WHERE id=$1 AND space_id=$2",[channel,space]);
 return {...before,at:new Date().toISOString(),expected:await transferRows(db,space,channel,project)};
}
export async function assertTransferUnchanged(db:Queryable,space:string,channel:string,project:string|null,transfer:TransferState){
 if(!transfer.expected)throw new HttpError(409,'source_goal_transfer_changed');
 const current=await transferRows(db,space,channel,project);
 // Compare jsonb, including every managed timestamp/cursor/rule and additions or
 // removals. Do not overwrite a later admin/operator/dispatcher change.
 const r=await db.query<{same:boolean}>('SELECT $1::jsonb=$2::jsonb AS same',[current,transfer.expected]);
 if(!r.rows[0]?.same)throw new HttpError(409,'source_goal_transfer_changed');
}
export async function restoreTransfer(db:Queryable,space:string,channel:string,project:string|null,transfer:TransferState){
 await assertTransferUnchanged(db,space,channel,project,transfer);
 for(const t of transfer.tasks)await db.query('UPDATE scheduler_tasks SET status=$3,next_run_at=$4,last_run_at=$5,state_json=$6,metadata_json=$7,updated_at=$8 WHERE id=$1 AND space_id=$2',[t.id,space,t.status,t.next_run_at,t.last_run_at,t.state_json,t.metadata_json,t.updated_at]);
 for(const p of transfer.backfills)await db.query('UPDATE source_backfill_plans SET status=$3,next_eligible_at=$4,error_json=$5,updated_at=$6 WHERE id=$1 AND space_id=$2',[p.id,space,p.status,p.next_eligible_at,p.error_json,p.updated_at]);
 await db.query('UPDATE source_channels SET fetch_frequency=$3,status=$4 WHERE id=$1 AND space_id=$2',[channel,space,transfer.channel.fetch_frequency,transfer.channel.status]);
}
