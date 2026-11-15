import {automationTargetDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {PgAutomationRepository,type AutomationRow} from './repository.js';
import {canReadAgent} from '../agents/agentAccess.js';
import {lockEvolutionAssets,lockEvolutionAssetKeys} from '../evolution/assetLocks.js';
import {assertProjectWriter} from '../projects/access.js';
import {fireResponsibility} from './targetSupport.js';

export type ConfigurationInput={
 space_id:string;automation_id?:string;agent_id?:string;project_id?:string|null;project_folder_id?:string|null;
 project_ids?:string[];config_json?:Record<string,unknown>|null;[key:string]:unknown;
};
type Discovery={row:AutomationRow|null;agent:string;projects:string[];folders:string[];assets:{id:string;owner_scope_type:string;owner_scope_id:string|null}[];agents:string[]};
/** Discover before taking any domain lock. Never expand the closure after
 * waiting; drift requires a fresh request in the same owner order. */
async function discover(db:Queryable,space:string,user:string,i:ConfigurationInput,autonomy:boolean):Promise<Discovery>{
 const repo=new PgAutomationRepository(db);
 const row=i.automation_id?await repo.get(space,i.automation_id):autonomy?
  (await repo.list(space)).find(r=>r.owner_user_id===user&&r.config_json?.target_type==='autonomous_tick')??null:null;
 const agent=i.agent_id??row?.agent_id??'';
 const configs=[row?.config_json,i.config_json];
 const keys=[...new Set(configs.flatMap(c=>typeof c?.workflow_asset_key==='string'?[c.workflow_asset_key]:[]))].sort();
 const assets=keys.length?(await db.query<{id:string;owner_scope_type:string;owner_scope_id:string|null}>(
  'SELECT id,owner_scope_type,owner_scope_id FROM evolvable_assets WHERE (space_id=$1 OR space_id IS NULL) AND asset_key=ANY($2::text[]) ORDER BY id',[space,keys])).rows:[];
 const agents=[...new Set([agent,...assets.flatMap(a=>a.owner_scope_type==='agent'&&a.owner_scope_id?[a.owner_scope_id]:[])].filter(Boolean))].sort();
 const projects=[...new Set([row?.project_id,i.project_id,...(i.project_ids??[]),...configs.flatMap(c=>Array.isArray(c?.project_ids)?c.project_ids.filter((p):p is string=>typeof p==='string'):[]),...assets.flatMap(a=>a.owner_scope_type==='project'?[a.owner_scope_id]:[])].filter((v):v is string=>!!v))].sort();
 const folders=[...new Set([row?.project_folder_id,i.project_folder_id].filter((v):v is string=>!!v))].sort();
 return {row,agent,projects,folders,assets,agents};
}
const signature=(d:Discovery)=>JSON.stringify(d);
export async function lockAutomationConfiguration(db:Queryable,space:string,user:string,i:ConfigurationInput,autonomy=false){
 return lockAutomationAuthority(db,space,user,i,autonomy,false);
}
/** Fire checks live authority before receipt replay as well as before dispatch. */
export async function lockAutomationFire(db:Queryable,space:string,user:string,i:ConfigurationInput){
 return lockAutomationAuthority(db,space,user,i,false,true);
}
async function lockAutomationAuthority(db:Queryable,space:string,user:string,i:ConfigurationInput,autonomy:boolean,fire:boolean){
 if(i.space_id!==space)throw new HttpError(404,'Automation not found');
 if(autonomy)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automation_configuration:${space}:${user}`]);
 const before=await discover(db,space,user,i,autonomy);
 const responsibility=fire&&before.row?fireResponsibility(before.row,{actorUserId:user,prompt:typeof i.prompt==='string'?i.prompt:null,instruction:typeof i.instruction==='string'?i.instruction:null},String(i.trigger_type??'manual')):null;
 const responsible=responsibility?.instructedByUserId??user;
 const target=String(before.row?.config_json?.target_type??'agent_run');
 const usesGrant=fire&&responsibility?.triggerOrigin==='automation'&&automationTargetDefinition(target)?.credential_grant_required
  &&!(target==='autonomous_tick'&&before.row?.config_json?.observe_only!==false);
 const grants=usesGrant&&before.row?(await db.query<{id:string;granted_by_user_id:string}>(
  "SELECT id,granted_by_user_id FROM automation_credential_grants WHERE space_id=$1 AND automation_id=$2 AND status='active' ORDER BY id",[space,before.row.id])).rows:[];
 // The namespace owner serializes insertion of a same-key candidate too;
 // row locks alone cannot fence a candidate that did not exist at discovery.
 if([before.row?.config_json,i.config_json].some(c=>typeof c?.workflow_asset_key==='string'))
  await lockEvolutionAssetKeys(db,space);
 if(i.automation_id&&!before.row)throw new HttpError(404,'Automation not found');
 // Project audiences, active person, Space, Folders, Agent roots and grants
 // share the canonical content-owner order and remain locked through COMMIT.
 await lockSourceRetrievalRelease(db,space,user,before.agents.map(object_id=>({object_type:'agent' as const,object_id})),before.projects,undefined,before.folders,[responsible,...grants.map(g=>g.granted_by_user_id)]);
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`runtime-egress-settings:${space}`]);
 await lockEvolutionAssets(db,before.assets.map(a=>a.id));
 for(const asset of before.assets){
  await db.query('SELECT id FROM evolvable_assets WHERE id=$1 FOR SHARE',[asset.id]);
  await db.query('SELECT id FROM evolvable_asset_versions WHERE asset_id=$1 ORDER BY id FOR SHARE',[asset.id]);
  await db.query('SELECT id FROM evolvable_asset_pins WHERE asset_id=$1 ORDER BY id FOR SHARE',[asset.id]);
 }

 if(before.row)await db.query('SELECT id FROM automations WHERE space_id=$1 AND id=$2 FOR UPDATE',[space,before.row.id]);
 if(fire&&before.row)await db.query('SELECT id FROM automation_credential_grants WHERE space_id=$1 AND automation_id=$2 ORDER BY id FOR SHARE',[space,before.row.id]);
 if(signature(before)!==signature(await discover(db,space,user,i,autonomy)))throw new HttpError(409,'Automation configuration changed');
 const repo=new PgAutomationRepository(db);
 const row=before.row;
 const role=await repo.getMembershipRole(space,user);
 if(fire){
  if(!row||!await repo.get(space,row.id,{readableBy:user}))throw new HttpError(404,'Automation not found');
  if(!await canReadAgent(db,{spaceId:space,userId:responsible},before.agent))throw new HttpError(404,'Agent not found');
  if(row.project_id){await assertProjectWriter(db,space,row.project_id,user);await assertProjectWriter(db,space,row.project_id,responsible);}
  const current=usesGrant?(await db.query<{id:string;granted_by_user_id:string}>("SELECT id,granted_by_user_id FROM automation_credential_grants WHERE space_id=$1 AND automation_id=$2 AND status='active' ORDER BY id",[space,row.id])).rows:[];
  if(JSON.stringify(grants)!==JSON.stringify(current))throw new HttpError(409,'Automation credential authority changed');
 }else if(row&&row.owner_user_id!==user){
  const visible=await repo.get(space,row.id,{readableBy:user,includeOpsView:true});
  if(!visible)throw new HttpError(404,'Automation not found');
  if(!['owner','admin'].includes(role??'')||Object.keys(i).some(k=>!['space_id','automation_id','status'].includes(k))||!['paused','archived'].includes(String(i.status)))
   throw new HttpError(403,'Only the owner can configure this Automation');
 }else{
  if(i.agent_id&&!await canReadAgent(db,{spaceId:space,userId:user},before.agent))throw new HttpError(404,'Agent not found');
  for(const project of [...new Set([row?.project_id,i.project_id].filter((p):p is string=>!!p))])await assertProjectWriter(db,space,project,user);
 }
 // The Agent row fences current_version and profile mutations; also pin the
 // exact version/profile/Host rows used by configuration preflight.
 await db.query('SELECT id FROM agent_versions WHERE space_id=$1 AND agent_id=$2 ORDER BY id FOR SHARE',[space,before.agent]);
 await db.query('SELECT id FROM agent_runtime_profiles WHERE space_id=$1 AND agent_id=$2 ORDER BY id FOR SHARE',[space,before.agent]);
 await db.query(`SELECT h.id FROM hosts h WHERE h.id IN (SELECT execution_host_id FROM agent_runtime_profiles WHERE space_id=$1 AND agent_id=$2) ORDER BY h.id FOR SHARE`,[space,before.agent]);
 const config=i.config_json??row?.config_json;
 const project=Object.hasOwn(i,'project_id')?i.project_id:row?.project_id;
 return {membership_role:role??'guest',agent_id:before.agent,target_type:autonomy?'autonomous_tick':config?.target_type??'agent_run',
  project_id:project??row?.project_id??null,project_writer:!!(project??row?.project_id)&&(fire||!row||row.owner_user_id===user),
  actor_is_owner:!row||row.owner_user_id===user,trigger_type:row?.trigger_type??i.trigger_type??'manual'};
}
