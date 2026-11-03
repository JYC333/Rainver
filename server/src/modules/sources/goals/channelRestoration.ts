import type {SourceGoalBindingSpec} from '@rainver/protocol';
import {goalSourceFingerprint,type GoalRow,type GoalSourceRow} from './access.js';
import {assertTransferUnchanged,transferRows,type TransferState} from './transferState.js';
import type {Queryable} from '../../routeUtils/common.js';

/** Explicit restoration is limited to a paused channel whose active state is
 * otherwise exactly the authority already confirmed by this Following. It
 * cannot activate a Source, adopt new consent/configuration or restart legacy
 * scheduling. The confirmation transaction also checks the full transfer CAS. */
export function canRestoreGoalChannel(g:GoalRow,b:{status:string;spec_json:SourceGoalBindingSpec;fixture_json?:{authority_sha256?:string;collection_error?:string;repair_block_reason?:string}|null},c:GoalSourceRow|undefined):boolean{
 if(!c||!g.active_version_id||!['running','paused'].includes(g.status)||g.compatibility_json?.scheduler_owner!=='goal')return false;
 if(!['active','cooldown','paused'].includes(b.status))return false;
 const error=b.fixture_json?.collection_error??b.fixture_json?.repair_block_reason;
 if(b.status==='paused'&&error&&!['source_authority_revoked','source_scope_changed','source_goal_source_inactive'].includes(error))return false;
 if(c.owner_user_id!==g.owner_user_id||c.project_id!==g.project_id||c.status!=='active'||c.channel_status!=='paused')return false;
 const transfer=(g.compatibility_json.transfers as Record<string,TransferState>|undefined)?.[b.spec_json.source_channel_id];
 return transfer?.expected?.channel.status==='active'&&transfer.expected.channel.fetch_frequency==='manual'
  &&!!b.fixture_json?.authority_sha256&&goalSourceFingerprint({...c,channel_status:'active'})===b.fixture_json.authority_sha256;
}

/** The old pause path also touched the paused legacy task's update clock.
 * Accept that clock alone after explicit restoration, keeping every task id,
 * status, schedule, cursor, metadata and backfill under the original CAS. */
export async function confirmChannelRestorationState(db:Queryable,g:GoalRow,channelId:string){
 const transfer=(g.compatibility_json!.transfers as Record<string,TransferState>)[channelId];
 const current=await transferRows(db,g.space_id,channelId,g.project_id);
 const clocks=new Map(current.tasks.map(task=>[task.id,task.updated_at]));
 const expected={...transfer.expected,tasks:transfer.expected.tasks.map(task=>({...task,updated_at:clocks.get(task.id)??task.updated_at}))};
 await assertTransferUnchanged(db,g.space_id,channelId,g.project_id,{...transfer,expected});
 // Keep the first pre-transfer snapshot; only acknowledge the compared clocks.
 await db.query("UPDATE source_goals SET compatibility_json=jsonb_set(compatibility_json,ARRAY['transfers',$2::text,'expected'],$3::jsonb,false) WHERE id=$1 AND space_id=$4",[g.id,channelId,current,g.space_id]);
}
