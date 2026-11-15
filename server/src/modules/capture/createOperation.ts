import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {resolveContentCreationContext} from '../access/creationContext.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {hidden,markedRefusal,OperationError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {CaptureService} from './service.js';
type Input=OperationInput<'capture.create'>;
type Placement=Pick<Input,'destination'|'project_id'|'target_id'>;
const project=(i:Placement)=>i.destination==='personal_inbox'?null:i.project_id??null;
const marginalia=(i:Placement)=>i.destination==='object_marginalia'||i.destination==='project_marginalia';
export async function captureMarginaliaNoteIds(db:Queryable,i:Placement,a:OperationActor):Promise<string[]>{
 if(!marginalia(i))return [];
 return (await db.query<{id:string}>(`SELECT so.id FROM notes n JOIN space_objects so ON so.space_id=n.space_id AND so.id=n.object_id WHERE n.space_id=$1 AND n.marginalia_project_id=$2 AND n.marginalia_owner_user_id=$3 AND n.marginalia_target_object_id IS NOT DISTINCT FROM $4::varchar AND n.status='active' AND so.deleted_at IS NULL ORDER BY so.id`,[a.space_id,project(i),a.on_behalf_of_user_id,i.destination==='object_marginalia'?i.target_id:null])).rows.map(row=>row.id);
}
export function captureCreateRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('capture.create')!,userContentCreation:true,successStatus:201,
  normalizeInput(raw){const i=raw as Input;return i.destination==='personal_inbox'?{text:i.text,destination:i.destination}:i;},
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`capture:${a.space_id}:${a.on_behalf_of_user_id}`,targets:{project_id:project(i),target_id:i.destination==='object_marginalia'?i.target_id??null:null},resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a){
   const i=raw as Input,p=project(i),before=await captureMarginaliaNoteIds(db,i,a);
   const refs=[...before.map(object_id=>({object_type:'space_object' as const,object_id})),...(i.destination==='object_marginalia'&&i.target_id?[{object_type:'space_object' as const,object_id:i.target_id}]:[])];
   await lockSourceRetrievalRelease(db,a.space_id,a.on_behalf_of_user_id!,refs,p?[p]:[],marginalia(i)?async()=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`note-marginalia:${a.space_id}:${a.on_behalf_of_user_id}:${p}:${i.destination==='object_marginalia'?i.target_id:'-'}`]);}:undefined,[],[],before.map(object_id=>({object_type:'space_object' as const,object_id})),p?[p]:[]);
   if(JSON.stringify(before)!==JSON.stringify(await captureMarginaliaNoteIds(db,i,a)))throw new OperationError('operation_conflict',409);
   const creation=await resolveContentCreationContext(db,{userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,projectId:p});
   if(creation.spaceId!==a.space_id)throw new OperationError('operation_conflict',409);
   if(p)await assertProjectWriterForMutation(db,a.space_id,p,a.on_behalf_of_user_id!);
   for(const ref of refs)if(await contentDecisionFromDb(db,{spaceId:a.space_id,userId:a.on_behalf_of_user_id!},'space_object',ref.object_id,{includeOversight:false})!=='full')throw hidden();
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;activity_id:string;note_id:string|null};
   if(out.space_id!==a.space_id)throw hidden();
   const person={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};
   if(await contentDecisionFromDb(db,person,'activity',out.activity_id,{includeOversight:false})!=='full')throw hidden();
   if(out.note_id&&await contentDecisionFromDb(db,person,'space_object',out.note_id,{includeOversight:false})!=='full')throw hidden();
  },
  async execute(db,raw,a){const i=raw as Input;return new CaptureService(db).captureWithin(db,{userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,destination:i.destination,text:i.text,projectId:project(i),targetId:i.target_id});},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'capture'):undefined,
 };
}
