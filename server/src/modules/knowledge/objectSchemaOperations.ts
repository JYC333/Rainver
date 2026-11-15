import {OBJECT_SCHEMA_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {lockActivePerson} from '../access/activePerson.js';
import {classifyProposalRefusal,proposalWriter} from './proposalRefusal.js';
import {PgKnowledgeRepository} from './repository.js';
import type {Queryable} from '../routeUtils/common.js';
type Input=Record<string,any>;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
/** Space object-kind governance is a Space owner/admin submission (as the
 * retained REST entries required). The person and role rows stay share-locked
 * through COMMIT, so a concurrent demotion or Space exit cannot interleave. */
async function maintainer(db:Queryable,a:OperationActor){await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);if(!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();}
export function objectSchemaRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(OBJECT_SCHEMA_OPERATION_SCHEMAS).map(id=>({
 definition:defs.get(id)!,successStatus:202,
 async resolve(_db,raw,a){const p=(raw as Input).profile_id as string|undefined;return {authority:p?`object_profile:${p}`:`object_schema:${a.space_id}`,targets:p?{profile_id:p}:{},resourceType:p?'object_profile':'space',resourceId:p??a.space_id};},
 async authorize(db,raw,a){await maintainer(db,a);const p=(raw as Input).profile_id;if(p&&!(await db.query('SELECT id FROM space_object_profiles WHERE id=$1 AND space_id=$2 FOR SHARE',[p,a.space_id])).rows.length)throw hidden();},
 async authorizeResult(db,raw,a){if((raw as {space_id:string}).space_id!==a.space_id||!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();},
 classifyError:classifyProposalRefusal,
 async execute(db,raw,a){return proposalWriter(async()=>{const {profile_id:profile,...body}=raw as Input,r=new PgKnowledgeRepository(db),p=person(a);
  if(id==='knowledge.object_schema.propose_import')return {...await r.importObjectSchemaManifest(p,body),space_id:a.space_id};
  const out=id==='knowledge.object_kind.propose_create'?await r.proposeObjectProfileCreate(p,body)
   :id==='knowledge.object_kind.propose_update'?await r.proposeObjectProfileUpdate(p,profile,body)
   :id==='knowledge.object_kind.propose_deprecate'?await r.proposeObjectProfileDeprecate(p,profile,body)
   :await r.proposeObjectProfileArchive(p,profile,body);
  return {id:out.id,space_id:a.space_id};
 });},
}));}
