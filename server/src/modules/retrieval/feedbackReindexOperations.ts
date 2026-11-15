import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {isSpaceOwnerOrAdminIn} from '../routeUtils/access.js';
import {lockActivePerson} from '../access/activePerson.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {Queryable} from '../routeUtils/common.js';
import {RetrievalFeedbackService,RetrievalProjectionService,type RetrievalRegistry} from './index.js';
import {enqueueRetrievalEmbeddingBackfillWithQueue} from './embedding/job.js';
import {knowledgeRetrievalRegistry} from '../knowledge/retrievalAdapter.js';
import {memoryRetrievalRegistry} from '../memory/retrievalAdapter.js';
import {PgMemoryReadRepository} from '../memory/repository.js';
type Feedback={query:string;object_type:string;object_id:string;signal_type:string;dwell_ms?:number;metadata?:Record<string,unknown>};
type Domain={prefix:'knowledge'|'memory';registry:RetrievalRegistry;surface:string;resourceType:string;afterFeedback?:(db:Queryable,b:Feedback,a:OperationActor)=>Promise<void>};
/** Retrieval feedback and reindex as core commands, one shape per projection.
 * Feedback is the person's private signal on a result they can currently read
 * (the canonical adapter revalidates before writing). Reindex is DB-only, like
 * source.retrieval.reindex: the projection rebuild and its embedding backfill
 * Job intent commit together; the Job's provider calls run later. */
function registrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,d:Domain):OperationRegistration[]{
 return [{
  definition:defs.get(`${d.prefix}.retrieval.feedback`)!,
  async resolve(_db,raw){const i=raw as Feedback;return {authority:`${d.prefix}_retrieval_feedback:${i.object_type}:${i.object_id}`,targets:{object_type:i.object_type,object_id:i.object_id},resourceType:d.resourceType,resourceId:i.object_id};},
  async authorize(db,_raw,a){await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);},
  async authorizeResult(_db,raw,a){if((raw as {space_id:string}).space_id!==a.space_id)throw hidden();},
  async execute(db,raw,a){const b=raw as Feedback;
   if(!d.registry.objectTypes().includes(b.object_type as never))throw new OperationRefusal(422,d.prefix,`${d.prefix} feedback only supports ${d.registry.objectTypes().join(', ')}`);
   const recorded=await new RetrievalFeedbackService(db,d.registry).record({spaceId:a.space_id,viewerUserId:a.on_behalf_of_user_id!,surface:d.surface as never,query:b.query,objectType:b.object_type as never,objectId:b.object_id,signalType:b.signal_type as never,dwellMs:b.dwell_ms??null,metadata:b.metadata??null});
   if(!recorded)throw hidden();await d.afterFeedback?.(db,b,a);return {id:b.object_id,space_id:a.space_id};},
 },{
  definition:defs.get(`${d.prefix}.retrieval.reindex`)!,
  async resolve(_db,_raw,a){return {authority:`${d.prefix}_retrieval_reindex:${a.space_id}`,targets:{},resourceType:'space',resourceId:a.space_id};},
  async authorize(db,_raw,a){await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);if(!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();},
  async authorizeResult(db,raw,a){if((raw as {space_id:string}).space_id!==a.space_id||!await isSpaceOwnerOrAdminIn(db,a.space_id,a.on_behalf_of_user_id!))throw hidden();},
  async execute(db,_raw,a){
   const reindexed=await new RetrievalProjectionService(db,d.registry).reindexAll(a.space_id);
   const backfill=await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(db),{spaceId:a.space_id,userId:a.on_behalf_of_user_id!,trigger:`${d.prefix}_retrieval_reindex`});
   return {id:a.space_id,space_id:a.space_id,reindexed,embedding_backfill_job_id:backfill.jobId};
  },
 }];
}
export function retrievalFeedbackReindexRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return [
  ...registrations(defs,{prefix:'knowledge',registry:knowledgeRetrievalRegistry,surface:'knowledge_search',resourceType:'knowledge_item'}),
  // Memory feedback also counts as the owner's read of the entry, as the retained entry did.
  ...registrations(defs,{prefix:'memory',registry:memoryRetrievalRegistry,surface:'memory_retrieval_search',resourceType:'memory_entry',afterFeedback:(db,b,a)=>new PgMemoryReadRepository(db).recordRetrievalFeedbackReads([b.object_id],a.space_id,a.on_behalf_of_user_id!)}),
 ];
}
