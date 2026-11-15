import {ACCOUNT_OPERATION_SCHEMAS,type RegisteredSystemActionDefinition,type OperationActor} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import {isInstanceAdminIn} from '../routeUtils/access.js';
import {PgRoomRosterRepository} from '../rooms/rosterRepository.js';
import {OperationError,hidden} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';

/** Discover actual retained-Project and destination references before user locks.
 * Include terminal grants/invitations, so revocation does not shrink the set. */
async function references(db:Queryable,user:string):Promise<string[]>{
 return (await db.query<{id:string}>(`SELECT DISTINCT id FROM (
   SELECT a.access_project_id AS id FROM agents a WHERE a.owner_user_id=$1 AND a.access_project_id IS NOT NULL
   UNION SELECT r.project_id AS id FROM room_agent_access_grants g JOIN agents a ON a.id=g.agent_id AND a.space_id=g.space_id JOIN rooms r ON r.id=g.room_id AND r.space_id=g.space_id WHERE a.owner_user_id=$1 AND a.access_project_id IS NOT NULL AND a.access_project_id<>r.project_id
   UNION SELECT r.project_id AS id FROM room_invitation_agent_approvals approval JOIN agents a ON a.id=approval.agent_id AND a.space_id=approval.space_id JOIN room_user_invitations i ON i.id=approval.invitation_id AND i.space_id=approval.space_id JOIN rooms r ON r.id=i.room_id AND r.space_id=i.space_id WHERE approval.owner_user_id=$1 AND a.access_project_id IS NOT NULL AND a.access_project_id<>r.project_id
 ) refs ORDER BY id`,[user])).rows.map(r=>r.id);
}
const admitted=new WeakMap<object,{target:string;projects:string[]}>();
async function admit(db:Queryable,config:ServerConfig,target:string,a:OperationActor,disable:boolean):Promise<void>{
 if(!await isInstanceAdminIn(db,config,a.principal.id))throw hidden();
 if(disable&&target===a.principal.id)throw new OperationError('operation_invalid_input',422,false,'auth');
 const projects=disable?await references(db,target):[];
 const prior=admitted.get(db);
 if(prior&&(prior.target!==target||JSON.stringify(prior.projects)!==JSON.stringify(projects)))throw new OperationError('operation_conflict',409,false,'auth');
 await db.query('SELECT id FROM projects WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE',[projects]);
 // Acquire both roots in one order, without a SHARE -> UPDATE upgrade.
 await db.query('SELECT id FROM users WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE',[[...new Set([target,a.principal.id])].sort()]);
 if(!await isInstanceAdminIn(db,config,a.principal.id))throw hidden();
 admitted.set(db,{target,projects});
 if(disable&&JSON.stringify(await references(db,target))!==JSON.stringify(projects))throw new OperationError('operation_conflict',409,false,'auth');
 const user=(await db.query<{status:string}>('SELECT status FROM users WHERE id=$1',[target])).rows[0];
 if(!user||!['active','disabled'].includes(user.status))throw new OperationError('operation_invalid_input',422,false,'auth');
}
export function accountOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return Object.keys(ACCOUNT_OPERATION_SCHEMAS).map(id=>({
  definition:definitions.get(id)!,admission:{kind:'person'},domainAuthorizationFirst:true,
  async resolve(_db,raw){const {user_id}=raw as {user_id:string};return {authority:`instance:user:${user_id}`,targets:{user_id},resourceType:'instance',resourceId:null};},
  authorize:(db,raw,a)=>admit(db,config,(raw as {user_id:string}).user_id,a,id==='auth.user.disable'),
  authorizeResult:(db,raw,a)=>admit(db,config,(raw as {user_id:string}).user_id,a,id==='auth.user.disable'),
  async execute(db,raw,a){
   const {user_id}=raw as {user_id:string},disable=id==='auth.user.disable';
   await db.query('UPDATE users SET status=$2,updated_at=now() WHERE id=$1',[user_id,disable?'disabled':'active']);
   if(disable){
    await new PgRoomRosterRepository(db).revokeCrossProjectGrantsForDisabledOwner(user_id,a.principal.id);
    await db.query('DELETE FROM user_sessions WHERE user_id=$1',[user_id]);
   }
   return {user_id,ok:true};
  },
 }));
}
