import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {RelationInputError} from './operationErrors.js';
import {RELATION_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {type Queryable} from '../routeUtils/common.js';
import {assertProjectWriterForMutation,assertProjectReadableLocked} from '../projects/access.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {RelationsService} from './service.js';
import {RelationsRepository} from './repository.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Input=Record<string,any>;
type Bound={object:string|null;refs:string[];projects:{id:string;write:boolean}[]};
type Scope=ResolvedOperation&{bound:Bound};
async function discover(db:Queryable,i:Input,a:OperationActor):Promise<Bound>{
 let object=i.object_id??i.person_object_id??null;
 if(i.identity_id)object=(await db.query('SELECT object_id FROM relation_identities WHERE id=$1 AND space_id=$2',[i.identity_id,a.space_id])).rows[0]?.object_id??null;
 if(i.affiliation_id)object=await new RelationsRepository(db).affiliationPersonObjectId(a.space_id,i.affiliation_id);
 if(i.affiliation_id&&!object)throw hidden();
 const refs=[...new Set<string>([object,i.organization_object_id,i.parent_organization_object_id].filter(Boolean))].sort();
 const projects=new Map<string,boolean>();if(i.project_id)projects.set(i.project_id,true);
 if(i.activity_id){const activity=(await db.query<{project_id:string|null}>('SELECT project_id FROM activity_records WHERE id=$1 AND space_id=$2',[i.activity_id,a.space_id])).rows[0];if(!activity)throw hidden();if(activity.project_id)projects.set(activity.project_id,false);}
 for(const ref of refs){const row=(await db.query<{primary_project_id:string|null}>('SELECT primary_project_id FROM space_objects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[ref,a.space_id])).rows[0];if(!row)throw hidden();if(row.primary_project_id)projects.set(row.primary_project_id,(projects.get(row.primary_project_id)??false)||ref===object);}
 return {object,refs,projects:[...projects].sort(([a],[b])=>a.localeCompare(b)).map(([id,write])=>({id,write}))};
}
export function relationRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(RELATION_OPERATION_SCHEMAS).map(id=>({
 definition:defs.get(id)!,...(['relation.person.create','relation.organization.create'].includes(id)?{userContentCreation:true as const}:{}),
 successStatus:id.includes('.propose')?202:id.endsWith('.create')?201:200,
 async resolve(db,raw,a){const bound=await discover(db,raw as Input,a);return {authority:(raw as Input).identity_id?`relation_identity:${(raw as Input).identity_id}`:bound.object?`relation:${bound.object}`:`space:${a.space_id}`,targets:(raw as Input).identity_id?{identity_id:(raw as Input).identity_id}:bound,resourceType:'space_object',resourceId:bound.object,bound} as Scope;},
 async authorize(db,raw,a,scope){const i=raw as Input,b=(scope as Scope).bound;
  if(canonical(await discover(db,i,a))!==canonical(b))throw new OperationError('operation_conflict',409);
  if(i.source_item_id||i.evidence_id)await lockSourceRetrievalRelease(db,a.space_id,a.on_behalf_of_user_id!,i.source_item_id?[{object_type:'source_item',object_id:i.source_item_id}]:[{object_type:'extracted_evidence',object_id:i.evidence_id}],b.projects.map(p=>p.id));
  for(const p of b.projects)await(p.write?assertProjectWriterForMutation:assertProjectReadableLocked)(db,a.space_id,p.id,a.on_behalf_of_user_id!);
  for(const ref of b.refs)await db.query('SELECT id FROM space_objects WHERE id=$1 AND space_id=$2 FOR UPDATE',[ref,a.space_id]);
  if(canonical(await discover(db,i,a))!==canonical(b))throw new OperationError('operation_conflict',409);
  if(i.activity_id){await db.query('SELECT id FROM activity_records WHERE id=$1 AND space_id=$2 FOR SHARE',[i.activity_id,a.space_id]);await db.query("SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type='activity' AND resource_id=$2 AND grantee_user_id=$3 ORDER BY id FOR SHARE",[a.space_id,i.activity_id,a.on_behalf_of_user_id!]);}
  const repo=new RelationsRepository(db);
  if(i.activity_id&&!await repo.activityExistsInSpace(a.space_id,i.activity_id,a.on_behalf_of_user_id!))throw hidden();
  if(i.source_item_id&&!await repo.sourceItemExistsInSpace(a.space_id,i.source_item_id,a.on_behalf_of_user_id!))throw hidden();
  if(i.evidence_id&&!await repo.evidenceExistsInSpace(a.space_id,i.evidence_id,a.on_behalf_of_user_id!))throw hidden();
  if(b.object&&!await repo.isOwnedRelationObject(a.space_id,b.object,a.on_behalf_of_user_id!))throw hidden();
  for(const ref of b.refs)if(await contentDecisionFromDb(db,person(a),'space_object',ref,{includeOversight:false})!=='full')throw hidden();
 },
 async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string;object_id:string|null;kind:string};if(out.space_id!==a.space_id)throw hidden();
  if(out.kind==='proposal'){if(await contentDecisionFromDb(db,person(a),'proposal',out.id,{includeOversight:false})==='deny')throw hidden();}
  if(out.object_id){const repo=new RelationsRepository(db);if(!await repo.isOwnedRelationObject(a.space_id,out.object_id,a.on_behalf_of_user_id!))throw hidden();const row=(await db.query<{primary_project_id:string|null}>('SELECT primary_project_id FROM space_objects WHERE id=$1 AND space_id=$2',[out.object_id,a.space_id])).rows[0];if(row?.primary_project_id)await assertProjectWriterForMutation(db,a.space_id,row.primary_project_id,a.on_behalf_of_user_id!);}
 },
 classifyError(error){return error instanceof RelationInputError&&[409,422].includes(error.statusCode)?new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode as 409|422,'relations'):undefined;},
 async execute(db,raw,a){const i=raw as Input,p=person(a),s=new RelationsService(db,new RelationsRepository(db));let result:any,kind='proposal',object=i.object_id??i.person_object_id??null;
  if(id==='relation.person.create'){result=await s.createPerson(p,{...i,visibility:i.project_id?'space_shared':'private'});kind='person';object=result.object_id;}
  else if(id==='relation.organization.create'){result=await s.createOrganization(p,{...i,visibility:i.project_id?'space_shared':'private'});kind='organization';object=result.object_id;}
  else if(id==='relation.person.update'){result=await s.updatePerson(p,i.object_id,i);kind='person';}
  else if(id==='relation.person.archive'){await s.archivePerson(p,i.object_id);result={id:i.object_id};kind='person';}
  else if(id==='relation.identity.create'){result=await s.createIdentity(p,i.object_id,i);kind='identity';}
  else if(id==='relation.identity.delete'){object=(await discover(db,i,a)).object;await s.deleteIdentity(p,i.identity_id);result={id:i.identity_id};kind='identity';}
  else if(id==='relation.affiliation.propose')result=await s.createAffiliation(p,i);
  else if(id==='relation.affiliation.end.propose'){object=(await discover(db,i,a)).object;result=await s.endAffiliation(p,i.affiliation_id,i.end_date??null);}
  else if(id==='relation.note.create'){result=await s.createNote(p,i.object_id,i);kind='note';}
  else {result=await s.createSourceLink(p,i.object_id,i);kind='source_link';}
  return {id:result.id??result.object_id,space_id:a.space_id,object_id:object,kind};
 },
}));}
