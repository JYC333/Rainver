import {PUBLICATION_OPERATION_SCHEMAS,type OperationActor,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {HttpError} from '../routeUtils/common.js';
import {lockSpaceRole} from '../spaces/writers.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PublicationService,lockPublicationSource} from './service.js';
const person=(a:OperationActor):SpaceUserIdentity=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Target=OperationInput<'publication.import'>;

/** Decisions here retain the publication's source/target boundary. A target
 * may read an immutable publication; it never gains live source access. */
async function authorizePublication(db:Queryable,a:OperationActor,id:string,kind:'import'|'revoke'){
 await lockSpaceRole(db,a.space_id,a.on_behalf_of_user_id!);
 const row=(await db.query<{source_space_id:string;published_by_user_id:string}>(
   'SELECT source_space_id,published_by_user_id FROM content_publications WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!row)throw hidden();
 if(kind==='revoke'){
   if(row.source_space_id!==a.space_id||row.published_by_user_id!==a.on_behalf_of_user_id)throw hidden();
 }else{
   if(!(await db.query('SELECT id FROM content_publication_targets WHERE publication_id=$1 AND target_space_id=$2 FOR SHARE',[id,a.space_id])).rows.length)throw hidden();
 }
}
export function publicationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(PUBLICATION_OPERATION_SCHEMAS) as (keyof typeof PUBLICATION_OPERATION_SCHEMAS)[]).map(id=>({
   definition:definitions.get(id)!,successStatus:id==='publication.revoke'?200:201,
   async resolve(_db,raw,a){
     if(id==='publication.create'){
       const i=raw as OperationInput<'publication.create'>;
       return {authority:`space:${a.space_id}`,targets:{resource_type:i.resource_type,resource_id:i.resource_id},resourceType:i.resource_type,resourceId:i.resource_id};
     }
     const i=raw as Target;
     return {authority:`space:${a.space_id}`,targets:{publication_id:i.publication_id},resourceType:'content_publication',resourceId:i.publication_id};
   },
   async authorize(db,raw,a){
     if(id==='publication.create'){
       const i=raw as OperationInput<'publication.create'>;
       await lockPublicationSource(db,person(a),i.resource_type,i.resource_id,i.target_space_ids);
     }else await authorizePublication(db,a,(raw as Target).publication_id,id==='publication.import'?'import':'revoke');
   },
   async authorizeResult(db,raw,a){
     // Replays retain the current source/target gate. Import receipts disclose
     // a private resource id only to its original importer.
     if(id==='publication.import'){
       const out=raw as {publication_id:string;imported_by_user_id:string;imported_resource_id:string|null};
       await authorizePublication(db,a,out.publication_id,'import');
       if(out.imported_resource_id&&out.imported_by_user_id!==a.on_behalf_of_user_id)throw hidden();
     }else{
       const out=raw as {id:string};
       await authorizePublication(db,a,out.id,'revoke');
     }
   },
   classifyError(error){return error instanceof HttpError?markedRefusal(error,'publications'):undefined;},
   async execute(db,raw,a){
     const service=new PublicationService(db);
     if(id==='publication.create')return service.create(person(a),raw as OperationInput<'publication.create'>);
     const i=raw as Target;
     return id==='publication.import'?service.import(person(a),i.publication_id):service.revoke(person(a),i.publication_id);
   },
 }));
}
