import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {resolveContentCreationContext} from '../access/creationContext.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {assertWritableSpaceObject} from '../knowledge/knowledgeWriteAccess.js';
import {assertProjectWriterForMutation,holdProjects,lockActiveProjectForMutation,lockProjectAudience} from '../projects/access.js';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease,sourceRetrievalReleaseProjects} from '../sources/retrievalReleaseLocks.js';
import {canonical} from '../systemActions/operations/repository.js';
import {hidden,markedRefusal,OperationError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {captureMarginaliaNoteIds} from './createOperation.js';
import {canMoveCapture,spaceAllowsCopyOut,type CaptureRow} from './relocation.js';
import {RelocationService} from './relocationService.js';
type Input=OperationInput<'capture.relocate'>;
type Ref=Parameters<typeof lockSourceRetrievalRelease>[3][number];
async function discover(db:Queryable,i:Input,a:OperationActor,key:string|null){
 const source=(await db.query<CaptureRow&{block_id:string|null}>(`SELECT id,space_id,owner_user_id,project_id,NULL::text AS content,payload_json->'marginalia'->>'note_id' AS note_id,payload_json->'marginalia'->>'block_id' AS block_id FROM activity_records WHERE id=$1 AND discarded_at IS NULL`,[i.activity_id])).rows[0];
 if(!source)throw hidden();
 const creation=await resolveContentCreationContext(db,{userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,projectId:i.destination==='personal_inbox'?null:i.project_id});
 const destinationActor={...a,space_id:creation.spaceId};
 const slot=await captureMarginaliaNoteIds(db,i,destinationActor);
 const groups=new Map<string,{refs:Ref[];exclusive:Ref[];projects:string[];written:string[]}>();
 const group=(space:string)=>{let value=groups.get(space);if(!value){value={refs:[],exclusive:[],projects:[],written:[]};groups.set(space,value);}return value;};
 const from=group(source.space_id),to=group(creation.spaceId);
 from.refs.push({object_type:'activity',object_id:source.id});from.exclusive.push({object_type:'activity',object_id:source.id});
 if(source.note_id){from.refs.push({object_type:'space_object',object_id:source.note_id});from.exclusive.push({object_type:'space_object',object_id:source.note_id});}
 if(source.project_id){from.projects.push(source.project_id);if(i.mode==='move')from.written.push(source.project_id);}
 if(creation.projectId){to.projects.push(creation.projectId);to.written.push(creation.projectId);}
 for(const id of slot){to.refs.push({object_type:'space_object',object_id:id});to.exclusive.push({object_type:'space_object',object_id:id});}
 if(i.destination==='object_marginalia'&&i.target_id)to.refs.push({object_type:'space_object',object_id:i.target_id});
 // Host-authored successful receipts identify replay outputs before any domain
 // lock. The source Activity serializes all relocations; never discover a new
 // destination root late while returning a cached receipt.
 const outputs=(await db.query<{activity:string;note:string|null;space:string}>(`SELECT ar.id AS activity,ar.space_id AS space,receipt.result_json->'data'->>'note_id' AS note FROM operation_idempotency receipt JOIN activity_records ar ON ar.id=receipt.result_json->'data'->>'activity_id' WHERE receipt.space_id=$1 AND receipt.principal_kind='user' AND receipt.principal_id=$2 AND receipt.on_behalf=('user:'||$2) AND receipt.operation_id='capture.relocate' AND receipt.authority_scope_id=$3 AND receipt.idempotency_key=$4 ORDER BY ar.space_id,ar.id`,[a.space_id,a.on_behalf_of_user_id,`capture-relocation:${i.activity_id}`,key])).rows;
 for(const out of outputs){const g=group(out.space);g.refs.push({object_type:'activity',object_id:out.activity});if(out.note)g.refs.push({object_type:'space_object',object_id:out.note});}
 const scopes=[];
 for(const [space,g] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const refs=[...new Map(g.refs.map(r=>[r.object_type+':'+r.object_id,r])).values()].sort((a,b)=>(a.object_type+':'+a.object_id).localeCompare(b.object_type+':'+b.object_id));
  scopes.push({space,refs,exclusive:g.exclusive,written:[...new Set(g.written)].sort(),projects:await sourceRetrievalReleaseProjects(db,space,refs,[...new Set(g.projects)].sort())});
 }
 // Text is deliberately excluded: relocation's canonical owner reads the
 // locked Note, not the capture snapshot. This is placement/authority lineage.
 const {content:_content,...lineage}=source;
 return {source,creation,scopes,fingerprint:canonical({lineage,creation,slot,outputs,scopes})};
}
async function admit(db:Queryable,i:Input,a:OperationActor,key:string|null){
 const before=await discover(db,i,a,key);
 const projects=before.scopes.flatMap(g=>g.projects.map(id=>({space:g.space,id,write:g.written.includes(id)}))).sort((a,b)=>(a.space+':'+a.id).localeCompare(b.space+':'+b.id));
 for(const p of projects){if(p.write)await lockActiveProjectForMutation(db,p.space,p.id);await lockProjectAudience(db,p.space,p.id);}
 const close=holdProjects(db,projects.map(p=>p.id));
 try{
  if((await discover(db,i,a,key)).fingerprint!==before.fingerprint)throw new OperationError('operation_conflict',409);
  for(const g of before.scopes)await lockSourceRetrievalRelease(db,g.space,a.on_behalf_of_user_id!,g.refs,g.projects,async()=>{
   if(g.space===before.creation.spaceId&&(i.destination==='object_marginalia'||i.destination==='project_marginalia'))await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`note-marginalia:${g.space}:${a.on_behalf_of_user_id}:${before.creation.projectId}:${i.destination==='object_marginalia'?i.target_id:'-'}`]);
  },[],[],g.exclusive,g.written);
  if((await discover(db,i,a,key)).fingerprint!==before.fingerprint)throw new OperationError('operation_conflict',409);
  const identity={spaceId:before.source.space_id,userId:a.on_behalf_of_user_id!};
  if(await contentDecisionFromDb(db,identity,'activity',i.activity_id,{includeOversight:false})!=='full')throw hidden();
  if(before.source.note_id&&await contentDecisionFromDb(db,identity,'space_object',before.source.note_id,{includeOversight:false})!=='full')throw hidden();
  if(i.mode==='move'){
   if(!await canMoveCapture(db,before.source,identity.userId))throw hidden();
   if(before.source.note_id)await assertWritableSpaceObject(db,identity,before.source.note_id,'Capture note is not writable',403);
  }
  if(before.source.space_id!==before.creation.spaceId&&before.source.owner_user_id!==identity.userId&&!await spaceAllowsCopyOut(db,before.source.space_id))throw hidden();
  if(before.creation.projectId)await assertProjectWriterForMutation(db,before.creation.spaceId,before.creation.projectId,identity.userId);
 }finally{close();}
}
export function captureRelocationRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {
  definition:defs.get('capture.relocate')!,
  async resolve(_db,raw,a,invocation){const i=raw as Input;return {key:invocation?.idempotencyKey??null,authority:`capture-relocation:${i.activity_id}`,targets:i,resourceType:'space',resourceId:a.space_id};},
  async authorize(db,raw,a,scope){await admit(db,raw as Input,a,(scope as typeof scope&{key:string|null}).key);},
  async authorizeResult(db,raw,a){const out=raw as {activity_id:string;note_id:string|null};const row=(await db.query<{space_id:string}>('SELECT space_id FROM activity_records WHERE id=$1',[out.activity_id])).rows[0];if(!row)throw hidden();const person={spaceId:row.space_id,userId:a.on_behalf_of_user_id!};if(await contentDecisionFromDb(db,person,'activity',out.activity_id,{includeOversight:false})!=='full'||out.note_id&&await contentDecisionFromDb(db,person,'space_object',out.note_id,{includeOversight:false})!=='full')throw hidden();},
  async execute(db,raw,a){const i=raw as Input;return new RelocationService(db).relocate({userId:a.on_behalf_of_user_id!,requestSpaceId:a.space_id,activityId:i.activity_id,destination:i.destination,mode:i.mode,blockIds:i.block_ids,projectId:i.project_id,targetId:i.target_id});},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'capture'):undefined,
 };
}
