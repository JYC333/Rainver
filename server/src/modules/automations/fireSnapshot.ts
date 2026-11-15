import {automationTargetDefinition} from '@rainver/protocol';
import {createHash} from 'node:crypto';
import type {Queryable} from '../routeUtils/common.js';
import type {AutomationTargetExecutionContext} from './targetRegistry.js';
/** Pin runnable identity, not scheduler cursors or heartbeat timestamps. */
export async function automationFireSnapshot(db:Queryable,c:AutomationTargetExecutionContext):Promise<string>{
 const a=c.automation;
 const usesGrant=c.responsibility.triggerOrigin==='automation'&&automationTargetDefinition(String(a.config_json?.target_type??'agent_run'))?.credential_grant_required&&!(a.config_json?.target_type==='autonomous_tick'&&a.config_json?.observe_only!==false);
 const grants=usesGrant?(await db.query("SELECT id,granted_by_user_id FROM automation_credential_grants WHERE space_id=$1 AND automation_id=$2 AND status='active' ORDER BY id",[a.space_id,a.id])).rows:[];
 const versions=(await db.query(`SELECT a.current_version_id,
   (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM agent_runtime_profiles p WHERE p.space_id=a.space_id AND p.agent_id=a.id) AS profiles
   FROM agents a WHERE a.space_id=$1 AND a.id=$2`,[a.space_id,a.agent_id])).rows;
 return createHash('sha256').update(JSON.stringify({id:a.id,owner:a.owner_user_id,agent:a.agent_id,folder:a.project_folder_id,project:a.project_id,
  name:a.name,config:a.config_json,trigger:a.trigger_type,status:a.status,versions,grants,responsibility:c.responsibility,preflight:c.preflightSnapshot})).digest('hex');
}
