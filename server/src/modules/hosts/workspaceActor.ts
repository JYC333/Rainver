import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {PgHostRepository} from './repository.js';
import {hidden,OperationError} from '../systemActions/operations/errors.js';

/** Process-local proof of bearer authentication. A JSON actor cannot manufacture it. */
const proofs=new WeakMap<object,{tokenHash:string;owner:string}>();
export const DAEMON_WORKSPACE_OPERATIONS=new Set(['host.workspace.create','host.workspace.remove']);
export async function daemonWorkspaceActor(db:Queryable,token:string,operation:string,input:{project_id?:string;location_id?:string},key?:string):Promise<OperationActor>{
  if(!DAEMON_WORKSPACE_OPERATIONS.has(operation))throw hidden();
  const host=await new PgHostRepository(db).authenticate(token);
  if(!host)throw new OperationError('authentication_required',401);
  if(host.kind!=='remote'||!host.owner_user_id||!host.token_hash)throw hidden();
  let space:string|undefined;
  if(operation==='host.workspace.create'){
    space=(await db.query<{space_id:string}>('SELECT space_id FROM projects WHERE id=$1 AND deleted_at IS NULL',[input.project_id])).rows[0]?.space_id;
  }else{
    space=(await db.query<{space_id:string}>('SELECT space_id FROM workspace_locations WHERE id=$1 AND execution_host_id=$2',[input.location_id,host.id])).rows[0]?.space_id;
    // The Location is absent after success. Only locate this Host/owner's exact
    // receipt; the core still locks the key and reauthorizes its current target.
    if(!space&&key)space=(await db.query<{space_id:string}>(`SELECT space_id FROM operation_idempotency WHERE principal_kind='system' AND principal_id=$1 AND on_behalf=$2 AND authority_scope_id=$3 AND operation_id=$4 AND idempotency_key=$5`,[host.id,`user:${host.owner_user_id}`,`host:${host.id}:location:${input.location_id}`,operation,key])).rows[0]?.space_id;
  }
  if(!space)throw hidden();
  const actor:OperationActor=Object.freeze({principal:Object.freeze({kind:'system',id:host.id}),on_behalf_of_user_id:host.owner_user_id,space_id:space,agent_id:null,run_id:null,origin:'system_event',effective_origin:'system_event',root_run_id:null,continuation_hops:0,surface:'public_api'});
  proofs.set(actor,{tokenHash:host.token_hash,owner:host.owner_user_id});
  return actor;
}
export async function assertDaemonWorkspaceActor(db:Queryable,actor:OperationActor,lock=false):Promise<void>{
  const proof=proofs.get(actor);
  if(!proof||actor.principal.kind!=='system'||actor.on_behalf_of_user_id!==proof.owner)throw hidden();
  const host=await db.query(`SELECT id FROM hosts WHERE id=$1 AND kind='remote' AND owner_user_id=$2 AND token_hash=$3 AND status IN ('online','offline') ${lock?'FOR SHARE':''}`,[actor.principal.id,proof.owner,proof.tokenHash]);
  const owner=await db.query(`SELECT id FROM users WHERE id=$1 AND status='active' ${lock?'FOR SHARE':''}`,[proof.owner]);
  if(!host.rows.length||!owner.rows.length)throw hidden();
}
