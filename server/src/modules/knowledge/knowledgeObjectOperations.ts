import {KnowledgeProfileValidationError} from './knowledgeObjectErrors.js';
import {canonical} from '../systemActions/operations/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {KNOWLEDGE_OBJECT_SCHEMAS} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectReadableLocked,assertProjectWriterForMutation} from '../projects/access.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {assertWritableSpaceObject} from './knowledgeWriteAccess.js';
import {PgKnowledgeRepository} from './repository.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function discover(db:Queryable,input:Record<string,any>,a:OperationActor){
 const target=input.note_id??input.source_id;
 const row=target?(await db.query<{id:string;primary_project_id:string|null}>("SELECT id,primary_project_id FROM space_objects WHERE id=$1 AND space_id=$2 AND object_type=$3 AND deleted_at IS NULL",[target,a.space_id,input.note_id?'note':'source'])).rows[0]:null;
 if(target&&!row)throw hidden();
 return {target:target??null,parent:row?.primary_project_id??null,project:input.note_id?(input.project_id??row?.primary_project_id??null):input.project_id??row?.primary_project_id??null};
}
export function knowledgeObjectRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(KNOWLEDGE_OBJECT_SCHEMAS).map(id=>({
 definition:defs.get(id)!,...(id==='knowledge.source.create'?{userContentCreation:true as const}:{}),successStatus:id==='note.promote_to_knowledge'?202:id.endsWith('.create')?201:200,
 async resolve(db,raw,a){const input=raw as Record<string,any>,bound=await discover(db,input,a);return {authority:bound.target?`knowledge_object:${bound.target}`:`space:${a.space_id}`,targets:{id:bound.target},resourceType:id==='note.promote_to_knowledge'?'proposal':'source_item',resourceId:bound.target,bound};},
 normalizeInput(raw,scope){const input=raw as Record<string,any>,bound=(scope as typeof scope&{bound:Awaited<ReturnType<typeof discover>>}).bound;return id==='knowledge.source.create'?{...input,summary:input.summary??null,uri:input.uri??null,content_ref:input.content_ref??null,raw_text:input.raw_text??null,metadata:input.metadata??{},status:input.status??'raw',project_folder_id:input.project_id?input.project_folder_id:null,visibility:input.project_id?'space_shared':'private'}:id==='note.promote_to_knowledge'?{...input,project_id:bound.project}:input;},
 async authorize(db,raw,a,scope){const input=raw as Record<string,any>,bound=(scope as typeof scope&{bound:Awaited<ReturnType<typeof discover>>}).bound;
  if(canonical(await discover(db,input,a))!==canonical(bound))throw new OperationError('operation_conflict',409);
  for(const project of [...new Set<string>([bound.parent,bound.project].filter((p):p is string=>!!p))].sort())await (id==='note.promote_to_knowledge'?assertProjectReadableLocked:assertProjectWriterForMutation)(db,a.space_id,project,a.on_behalf_of_user_id!);
  if(input.source_activity_id && await contentDecisionFromDb(db,person(a),'activity',input.source_activity_id,{includeOversight:false})==='deny')throw hidden();
  if(input.project_folder_id){const folder=(await db.query('SELECT id,project_id FROM project_folders WHERE id=$1 AND space_id=$2 FOR SHARE',[input.project_folder_id,a.space_id])).rows[0];if(!folder)throw hidden();if(folder.project_id!==bound.project)throw new OperationError('operation_conflict',409);}
  if(bound.target){await db.query('SELECT id FROM space_objects WHERE id=$1 AND space_id=$2 FOR UPDATE',[bound.target,a.space_id]);
   if(canonical(await discover(db,input,a))!==canonical(bound))throw new OperationError('operation_conflict',409);
   if(id==='note.promote_to_knowledge'){if(await contentDecisionFromDb(db,person(a),'space_object',bound.target,{includeOversight:false})!=='full')throw hidden();}
   else await assertWritableSpaceObject(db,person(a),bound.target,'Source not found');
  }
 },
 async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string};if(out.space_id!==a.space_id)throw hidden();if(id==='note.promote_to_knowledge'){if(await contentDecisionFromDb(db,person(a),'proposal',out.id,{includeOversight:false})==='deny')throw hidden();}else await assertWritableSpaceObject(db,person(a),out.id,'Source not found');},
 classifyError(error){return error instanceof KnowledgeProfileValidationError?new OperationBusinessError('operation_invalid_input',422,'knowledge'):undefined;},
 async execute(db,raw,a){const input=raw as Record<string,any>,repo=new PgKnowledgeRepository(db),p=person(a);let out:{id:unknown};
  if(id==='note.promote_to_knowledge'){const {note_id,...body}=input;out=await repo.promoteNoteToKnowledge(p,note_id,body);}
  else if(id==='knowledge.source.create')out=await repo.createSource(p,input) as {id:unknown};
  else if(id==='knowledge.source.update')out=await repo.updateSource(p,input.source_id,input.changes) as {id:unknown};
  else out=await repo.archiveSource(p,input.source_id) as {id:unknown};
  return {id:out.id,space_id:a.space_id};
 },
}));}
