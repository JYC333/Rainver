import {contentReadSql} from '../access/contentAccessSql.js';
import {KNOWLEDGE_REVIEW_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {assertProjectReadableLocked,assertProjectWriterForMutation,assertProjectWriter,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {KnowledgePromotionCandidateService} from './candidateService.js';
import {CandidateMutationError} from './candidateErrors.js';
import {PgKnowledgeRepository} from '../knowledge/repository.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function discover(db:Queryable,id:string,input:Record<string,any>,a:OperationActor){
 const needsSource=id!=='knowledge.evidence.remove' && (!input.candidate_id || input.decision==='promote');
 let source=needsSource?(input.source_id??input.note_id??input.thread_id??null):null;
 let link=null;
 if(input.link_id){link=(await db.query<{id:string;knowledge_item_id:string;source_id:string}>('SELECT id,knowledge_item_id,source_id FROM knowledge_item_sources WHERE id=$1 AND space_id=$2',[input.link_id,a.space_id])).rows[0]??null;if(link&&link.knowledge_item_id!==input.item_id)throw hidden();}
 let candidate=null;
 if(input.candidate_id){candidate=(await db.query<{id:string;source_kind:string;source_id:string;source_ref_json:unknown;visibility:string;owner_user_id:string|null}>('SELECT id,source_kind,source_id,source_ref_json,visibility,owner_user_id FROM knowledge_promotion_candidates WHERE id=$1 AND space_id=$2 AND project_id=$3',[input.candidate_id,a.space_id,input.project_id])).rows[0];if(!candidate)throw hidden();if(needsSource&&['note','inquiry_thread'].includes(candidate.source_kind))source=candidate.source_id;}
 const ids=[...new Set<string>([input.item_id,source,input.supersedes_knowledge_item_id].filter(Boolean))].sort();
 const reference=input.supersedes_knowledge_item_id!==input.item_id&&input.supersedes_knowledge_item_id!==source?input.supersedes_knowledge_item_id??null:null;
 const roots=ids.length?(await db.query<{id:string;object_type:string;primary_project_id:string|null}>('SELECT id,object_type,primary_project_id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) AND (deleted_at IS NULL OR id=$3::varchar) ORDER BY id',[a.space_id,ids,reference])).rows:[];
 if(roots.length!==ids.length)throw hidden();
 return {source,candidate,roots,link};
}
export function knowledgeReviewRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(KNOWLEDGE_REVIEW_SCHEMAS).map(id=>({
 definition:defs.get(id)!,successStatus:id.endsWith('.add')||id.includes('.from_')||id.endsWith('.open')?201:200,
 async resolve(db,raw,a){const input=raw as Record<string,any>;return {authority:input.item_id?`knowledge:${input.item_id}`:`project:${input.project_id}`,targets:{item_id:input.item_id??null,candidate_id:input.candidate_id??null,packet_id:input.packet_id??null,project_id:input.project_id??null},resourceType:input.item_id?'source_item':'knowledge_promotion_candidate',resourceId:input.item_id??input.candidate_id??null,closure:await discover(db,id,input,a)};},
 normalizeInput(raw){const input=raw as Record<string,any>;if(id==='knowledge.candidate.packet.open')return {...input,limit:Math.max(1,Math.min(input.limit,20))};if(id==='knowledge.evidence.add'){const {link_type,...rest}=input;return {...rest,relation_type:input.relation_type??link_type??'derived_from'};}return input;},
 async authorize(db,raw,a,scope){const input=raw as Record<string,any>,before=(scope as typeof scope&{closure:Awaited<ReturnType<typeof discover>>}).closure;
  if(canonical(await discover(db,id,input,a))!==canonical(before))throw new OperationError('operation_conflict',409);
  try {
  if(input.project_id)await assertProjectWriter(db,a.space_id,input.project_id,a.on_behalf_of_user_id!);
  const projects=[...new Set<string>([input.project_id,...before.roots.filter(r=>r.id!==input.supersedes_knowledge_item_id||r.id===input.item_id||r.id===before.source).map(r=>r.primary_project_id)].filter(Boolean))].sort();
  // Candidate writers take this aggregate fence themselves. Acquire it first,
  // never upgrade concurrent FOR SHARE admission locks after locking a source.
  for(const project of projects){if(project===input.project_id){await lockActiveProjectForMutation(db,a.space_id,project);await assertProjectWriterForMutation(db,a.space_id,project,a.on_behalf_of_user_id!);}else await assertProjectReadableLocked(db,a.space_id,project,a.on_behalf_of_user_id!);}
  } catch(error){if(error instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'knowledge');throw error;}
  for(const root of before.roots){
    const referenceOnly=root.id===input.supersedes_knowledge_item_id&&root.id!==input.item_id&&root.id!==before.source;
    await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=$2 '+(referenceOnly?'FOR SHARE':'FOR UPDATE'),[a.space_id,root.id]);
  }
  if(before.link)await db.query('SELECT id FROM knowledge_item_sources WHERE id=$1 AND space_id=$2 AND knowledge_item_id=$3 FOR UPDATE',[input.link_id,a.space_id,input.item_id]);
  if(canonical(await discover(db,id,input,a))!==canonical(before))throw new OperationError('operation_conflict',409);
  for(const root of before.roots){
    // Supersession is a readable reference in canonical create(), not a body
    // extraction or target write. Preserve its original summary/oversight rule.
    const referenceOnly=root.id===input.supersedes_knowledge_item_id&&root.id!==input.item_id&&root.id!==before.source;
    if(referenceOnly){
      const readable=await db.query(`SELECT ki.object_id FROM knowledge_items ki JOIN space_objects so ON so.id=ki.object_id AND so.space_id=ki.space_id WHERE ki.object_id=$1 AND ki.space_id=$2 AND ${contentReadSql('space_object','so','$3')}`,[root.id,a.space_id,a.on_behalf_of_user_id]);
      if(!readable.rows.length)throw hidden();
    }else if(await contentDecisionFromDb(db,person(a),'space_object',root.id,{includeOversight:false})!=='full')throw hidden();
  }
  if(input.item_id){const item=(await db.query("SELECT so.owner_user_id FROM knowledge_items ki JOIN space_objects so ON so.id=ki.object_id AND so.space_id=ki.space_id WHERE ki.object_id=$1 AND ki.space_id=$2",[input.item_id,a.space_id])).rows[0];if(!item||item.owner_user_id!==a.on_behalf_of_user_id)throw hidden();if(before.source&&!before.roots.some(r=>r.id===before.source&&r.object_type==='source'))throw hidden();}
  if(input.note_id&&!before.roots.some(r=>r.id===input.note_id&&r.object_type==='note'))throw hidden();
  if(input.packet_id)await new KnowledgePromotionCandidateService(db).getReviewPacket(person(a),input.project_id,input.packet_id);
  if(input.candidate_id)await new KnowledgePromotionCandidateService(db).getCandidate(person(a),input.project_id,input.candidate_id);
 },
 async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string;project_id:string|null;item_id:string|null};if(out.space_id!==a.space_id)throw hidden();if(out.project_id){await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);if(id.includes('.packet.'))await new KnowledgePromotionCandidateService(db).getReviewPacket(person(a),out.project_id,out.id);else if(id.includes('.from_')){if(!(await db.query('SELECT id FROM knowledge_promotion_candidates WHERE id=$1 AND space_id=$2 AND project_id=$3 AND created_by_user_id=$4',[out.id,a.space_id,out.project_id,a.on_behalf_of_user_id])).rows.length)throw hidden();}else await new KnowledgePromotionCandidateService(db).getCandidate(person(a),out.project_id,out.id);}},
 async execute(db,raw,a){const input=raw as Record<string,any>,p=person(a),service=new KnowledgePromotionCandidateService(db);let out:Record<string,unknown>;
  if(id==='knowledge.evidence.add')out=await new PgKnowledgeRepository(db).createItemSource(p,input.item_id,input);
  else if(id==='knowledge.evidence.remove'){await new PgKnowledgeRepository(db).deleteItemSource(p,input.item_id,input.link_id);out={id:input.link_id};}
  else if(id.endsWith('.from_note'))out=await service.createFromNote(p,input.project_id,input);
  else if(id.endsWith('.from_thread'))out=await service.createFromThread(p,input.project_id,input);
  else if(id.endsWith('.from_interpretation'))out=await service.createFromInterpretation(p,input.project_id,input);
  else if(id.endsWith('.decide'))out=await service.decideCandidate(p,input.project_id,input.candidate_id,input);
  else if(id.endsWith('.reopen'))out=await service.reopenCandidate(p,input.project_id,input.candidate_id);
  else if(id.endsWith('.open'))out=await service.openReviewPacket(p,input.project_id,input.limit);
  else out=await service.closeReviewPacket(p,input.project_id,input.packet_id);
  return {id:out.id,space_id:a.space_id,project_id:input.project_id??null,item_id:input.item_id??null};
 },
 classifyError(error){if(error instanceof CandidateMutationError||error instanceof ProjectArchivedMutationError)return new OperationBusinessError(error.statusCode===422?'operation_invalid_input':'operation_conflict',error.statusCode===422?422:409,'knowledge');const pg=error as {code?:string;constraint?:string};if(pg?.code==='23505'&&pg.constraint==='ix_knowledge_item_sources_unique')return new OperationBusinessError('operation_conflict',409,'knowledge');return undefined;},
}));}
