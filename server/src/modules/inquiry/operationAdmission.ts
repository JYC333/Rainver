import type {OperationActor} from '@rainver/protocol';
import {canonical} from '../systemActions/operations/repository.js';
import {hidden,OperationError} from '../systemActions/operations/errors.js';
import type {Queryable} from '../routeUtils/common.js';
import {assertProjectReadableLocked,assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {assertThreadReadable,readableThreadIds} from './threadAccess.js';
import {ProjectCorpusRepository} from '../projects/corpusRepository.js';
import {assertLinkableNote} from './threadCreationAccess.js';
import {readableCandidateIds} from './signalService.js';
import {referenceReadableSql} from './problemReferences.js';
export const inquiryPerson=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
export type InquiryInput={project_id:string;thread_id?:string;from_thread_id?:string;to_thread_id?:string;parent_thread_id?:string|null;note_object_id?:string;relation_id?:string;candidate_id?:string;target_candidate_id?:string;packet_id?:string;corpus_item_id?:string;task_id?:string;input_refs?:Array<{type:string;id:string}>;output_refs?:Array<{type:string;id:string}>};
export async function discoverInquiry(db:Queryable,i:InquiryInput,a:OperationActor,operation:string){
 const threads=new Set([i.thread_id,i.from_thread_id,i.to_thread_id,i.parent_thread_id].filter((id):id is string=>!!id));
 const candidateRows=(await db.query<{id:string;thread_id:string}>(`SELECT id,thread_id FROM inquiry_signal_candidates WHERE space_id=$1 AND project_id=$2 AND (id=ANY($3::varchar[]) OR ($4::boolean AND status='pending')) ORDER BY id`,[a.space_id,i.project_id,[i.candidate_id,i.target_candidate_id].filter(Boolean),['inquiry.review_packet.open','inquiry.delta_brief.generate'].includes(operation)])).rows;
 const collect=idSet(operation);
 const allowedCandidates=collect?await readableCandidateIds(db,inquiryPerson(a),i.project_id,candidateRows,operation==='inquiry.delta_brief.generate'?'publish':'change'):null;
 const candidates=allowedCandidates?candidateRows.filter(c=>allowedCandidates.has(c.id)):candidateRows;
 for(const c of candidates)threads.add(c.thread_id);
 const relations=i.relation_id?(await db.query<{from_object_id:string;to_object_id:string}>('SELECT from_object_id,to_object_id FROM object_relations WHERE id=$1 AND space_id=$2',[i.relation_id,a.space_id])).rows:[];
 for(const r of relations){threads.add(r.from_object_id);threads.add(r.to_object_id);}
 const signalRows=(await db.query<{id:string;thread_id:string;corpus_item_id:string|null}>(`SELECT id,thread_id,corpus_item_id FROM inquiry_evidence_signals WHERE space_id=$1 AND project_id=$2 AND (candidate_id=ANY($3::varchar[]) OR $4::boolean) ORDER BY id`,[a.space_id,i.project_id,candidates.map(c=>c.id),operation==='inquiry.delta_brief.generate'])).rows;
 const publishThreads=operation==='inquiry.delta_brief.generate'?await readableThreadIds(db,inquiryPerson(a),signalRows.map(s=>s.thread_id),'publish'):null;
 const readableCorpus=publishThreads?await new ProjectCorpusRepository(db).readableItemIds(inquiryPerson(a),i.project_id,signalRows.flatMap(s=>s.corpus_item_id?[s.corpus_item_id]:[])):null;
 const signals=publishThreads?signalRows.filter(s=>publishThreads.has(s.thread_id)&&(!s.corpus_item_id||readableCorpus!.has(s.corpus_item_id))):signalRows;
 for(const s of signals)threads.add(s.thread_id);
 const corpusIds=[...new Set([i.corpus_item_id,...signals.map(s=>s.corpus_item_id)].filter((id):id is string=>!!id))];
 const corpus=(await db.query<{id:string;object_id:string|null;evidence_id:string|null}>('SELECT id,object_id,evidence_id FROM project_corpus_items WHERE space_id=$1 AND project_id=$2 AND id=ANY($3::varchar[]) ORDER BY id',[a.space_id,i.project_id,corpusIds])).rows;
 const evidence=(await db.query<{id:string;project_id:string|null;source_item_id:string|null;origin_source_item_id:string|null;snapshot_id:string|null}>('SELECT id,project_id,source_item_id,origin_source_item_id,source_snapshot_id AS snapshot_id FROM extracted_evidence WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[a.space_id,corpus.map(c=>c.evidence_id).filter(Boolean)])).rows;
 const snapshots=(await db.query<{id:string;project_id:string|null;connection_id:string|null;parent_project_id:string|null;source_item_id:string|null}>('SELECT s.id,s.project_id,s.connection_id,c.project_id AS parent_project_id,s.source_item_id FROM source_snapshots s LEFT JOIN source_connections c ON c.id=s.connection_id AND c.space_id=s.space_id WHERE s.space_id=$1 AND s.id=ANY($2::varchar[]) ORDER BY s.id',[a.space_id,evidence.map(e=>e.snapshot_id).filter(Boolean)])).rows;
 const sourceIds=(await db.query<{source_item_id:string}>('SELECT source_item_id FROM project_corpus_item_sources WHERE space_id=$1 AND project_id=$2 AND corpus_item_id=ANY($3::varchar[]) ORDER BY source_item_id',[a.space_id,i.project_id,corpusIds])).rows.map(r=>r.source_item_id);
 sourceIds.push(...snapshots.flatMap(s=>s.source_item_id?[s.source_item_id]:[]));
 sourceIds.push(...evidence.flatMap(e=>[e.source_item_id,e.origin_source_item_id].filter((id):id is string=>!!id)));
 const sources=(await db.query<{id:string;project_id:string|null;connection_id:string|null;parent_project_id:string|null}>('SELECT s.id,s.project_id,s.connection_id,c.project_id AS parent_project_id FROM source_items s LEFT JOIN source_connections c ON c.id=s.connection_id AND c.space_id=s.space_id WHERE s.space_id=$1 AND s.id=ANY($2::varchar[]) ORDER BY s.id',[a.space_id,sourceIds])).rows;
 const refs=[...(i.input_refs??[]),...(i.output_refs??[])];
 const taskIds=[...new Set([i.task_id,...refs.filter(r=>r.type==='task').map(r=>r.id)].filter((v):v is string=>!!v))].sort();
 const artifactIds=[...new Set(refs.filter(r=>r.type==='artifact').map(r=>r.id))].sort();
 const rootIds=[...new Set([...threads,i.note_object_id,...corpus.map(c=>c.object_id),...refs.filter(r=>['note','inquiry_thread'].includes(r.type)).map(r=>r.id)].filter((id):id is string=>!!id))].sort();
 const roots=(await db.query<{id:string;primary_project_id:string|null}>('SELECT id,primary_project_id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id',[a.space_id,rootIds])).rows;
 return {threads:[...threads].sort(),candidates,relations,signals,corpus,evidence,sources,snapshots,roots,taskIds,artifactIds};
}
export async function authorizeInquiry(db:Queryable,i:InquiryInput,a:OperationActor,id:string,before:Awaited<ReturnType<typeof discoverInquiry>>){
 const person=inquiryPerson(a),personal=id==='inquiry.personal_focus.set';
 if(!personal)await assertProjectWriter(db,a.space_id,i.project_id,person.userId,{allowArchived:true});
 const projects=[...new Set([i.project_id,...before.roots.map(r=>r.primary_project_id),...before.evidence.map(e=>e.project_id),...before.sources.flatMap(s=>[s.project_id,s.parent_project_id]),...before.snapshots.flatMap(s=>[s.project_id,s.parent_project_id])].filter((v):v is string=>!!v))].sort();
 for(const project of projects){
  if(project===i.project_id){if(personal)await assertProjectReadableLocked(db,a.space_id,project,person.userId);else{try{await lockActiveProjectForMutation(db,a.space_id,project);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'inquiry');throw e;}await assertProjectWriterForMutation(db,a.space_id,project,person.userId);}}
  else await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[project,a.space_id]);
 }
 await db.query('SELECT id FROM project_members WHERE space_id=$1 AND project_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE',[a.space_id,projects,person.userId]);
 const connections=[...new Set([...before.sources,...before.snapshots].map(s=>s.connection_id).filter((v):v is string=>!!v))].sort();
 await db.query('SELECT id FROM source_connections WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,connections]);
 const channels=(await db.query<{id:string}>('SELECT id FROM source_channels WHERE space_id=$1 AND source_connection_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,connections])).rows.map(r=>r.id);
 for(const table of ['source_channel_user_subscriptions','source_channel_subscription_windows'])await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND source_channel_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`,[a.space_id,channels,person.userId]);
 await db.query('SELECT id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,before.sources.map(s=>s.id)]);
 await db.query('SELECT id FROM extracted_evidence WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,before.evidence.map(e=>e.id)]);
 await db.query('SELECT id FROM source_snapshots WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,before.evidence.map(e=>e.snapshot_id).filter(Boolean)]);
 await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE',[a.space_id,before.roots.map(r=>r.id)]);
 await db.query('SELECT object_id FROM inquiry_threads WHERE space_id=$1 AND object_id=ANY($2::varchar[]) ORDER BY object_id FOR UPDATE',[a.space_id,before.threads]);
 await db.query('SELECT id FROM tasks WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE',[a.space_id,before.taskIds]);
 await db.query('SELECT id FROM artifacts WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,before.artifactIds]);
 const resources=[...before.taskIds,...before.artifactIds,...before.roots.map(r=>r.id),...before.sources.map(s=>s.id),...connections,...before.evidence.flatMap(e=>[e.id,e.snapshot_id].filter((v):v is string=>!!v))];
 await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,resources]);
 if(canonical(await discoverInquiry(db,i,a,id))!==canonical(before))throw new OperationError('operation_conflict',409,false,'inquiry');
 for(const thread of before.threads)await assertThreadReadable(db,person,i.project_id,thread,personal?'read':'change');
 if(i.note_object_id&&id==='inquiry.note.link')await assertLinkableNote(db,person,i.note_object_id,{lock:true,statusCode:404});
 if(i.candidate_id||i.target_candidate_id){const targets=[i.candidate_id,i.target_candidate_id].filter(Boolean);const selected=before.candidates.filter(c=>targets.includes(c.id)),allowed=await readableCandidateIds(db,person,i.project_id,selected,'change');if(selected.length!==targets.length||selected.some(c=>!allowed.has(c.id)))throw hidden();}
 if(i.task_id)await assertInquiryTask(db,a.space_id,i.project_id,i.task_id,person.userId);
 if(i.packet_id&&!(await db.query('SELECT id FROM inquiry_review_packets WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.packet_id,a.space_id,i.project_id])).rowCount)throw hidden();
}

function idSet(id:string){return id==='inquiry.review_packet.open'||id==='inquiry.delta_brief.generate';}

export async function assertInquiryTask(db:Queryable,space:string,project:string,task:string,user:string){
 if(!(await db.query(`SELECT t.id FROM tasks t WHERE t.id=$1 AND t.space_id=$2 AND t.project_id=$3 AND t.deleted_at IS NULL AND ${referenceReadableSql("jsonb_build_object('type','task','id',t.id)",'$4','t.space_id','t.project_id')}`,[task,space,project,user])).rowCount)throw hidden();
}
