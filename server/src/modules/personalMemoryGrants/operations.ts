import {PERSONAL_MEMORY_GRANT_OPERATION_SCHEMAS,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {admitGrantOwner,admitGrantTarget} from './admission.js';
import {GrantRepository} from './repository.js';

type Id=keyof typeof PERSONAL_MEMORY_GRANT_OPERATION_SCHEMAS;
type Target=OperationInput<'personal_memory_grant.create'>;
/** No Memory writes or linked proposal mapping: this grants bounded acquisition only. */
export function personalMemoryGrantRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(PERSONAL_MEMORY_GRANT_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,admission:{kind:'person'},domainAuthorizationFirst:true,
  successStatus:id==='personal_memory_grant.create'?201:200,
  async resolve(_db,raw,a){return {authority:`personal-grant:${a.principal.id}`,targets:raw,resourceType:'personal_memory_grant',resourceId:(raw as {grant_id?:string;target_run_id?:string}).grant_id??(raw as Target).target_run_id};},
  async authorize(db,raw,a){
   const userId=a.on_behalf_of_user_id!;
   if(id==='personal_memory_grant.revoke'){
    await admitGrantOwner(db,userId);
    if(!(await db.query('SELECT id FROM personal_memory_grants WHERE id=$1 AND granting_user_id=$2 FOR UPDATE',[(raw as {grant_id:string}).grant_id,userId])).rows.length)throw hidden();
   }else{const i=raw as Target;await admitGrantTarget(db,userId,i.target_space_id,i.target_run_id);}
  },
  async authorizeResult(db,raw,a){
   const out=raw as {id?:string;granting_user_id?:string;target_space_id:string;target_run_id:string};
   const userId=a.on_behalf_of_user_id!;
   if(id==='personal_memory_grant.revoke'){await admitGrantOwner(db,userId);if(out.granting_user_id!==userId)throw hidden();return;}
   await admitGrantTarget(db,userId,out.target_space_id,out.target_run_id);
   if(out.id&&!(await db.query("SELECT id FROM personal_memory_grants WHERE id=$1 AND granting_user_id=$2 AND (status='used' OR (status IN ('active','consuming') AND read_expires_at>now())) FOR SHARE",[out.id,userId])).rows.length)throw hidden();
  },
  async execute(db,raw,a){
   const repository=new GrantRepository(db),identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};
   if(id==='personal_memory_grant.revoke')return repository.revoke(identity,(raw as {grant_id:string}).grant_id);
   return id==='personal_memory_grant.preview'?repository.preview(identity,raw as Target):repository.create(identity,raw as Target);
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'personalMemoryGrants'):undefined,
 }));
}
