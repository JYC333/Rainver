import {READER_JOB_OPERATIONS,READER_OPERATION_SCHEMAS,READER_WRITE_JOB,type OperationActor,type ReaderOperationId,type ReaderWriteReceipt,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {PgAnnotationRepository,PgCommentRepository,PgReaderActionRepository,assertDocumentReadable} from './repository.js';
import {ReaderAppearanceSettings} from './positions.js';
import {ReaderDocumentNotes} from './documentNotes.js';
import {lockReaderWriteTarget} from './writeAuthority.js';

type Input=Record<string,any>;
/** Authority-free target lineage. It is a fingerprint, never permission. */
interface Target{document_type:string;document_id:string;annotation_id:string|null;thread_id:string|null;comment_id:string|null}
type Scope=ResolvedOperation&{bound:Target|null};
const person=(a:OperationActor):SpaceUserIdentity=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const JOB=new Set<string>(READER_JOB_OPERATIONS);
const CREATED=new Set(['reader.annotation.create','reader.comment.create','reader.evidence.create','reader.memory.propose','reader.knowledge.propose']);
const without=(i:Input,...keys:string[])=>Object.fromEntries(Object.entries(i).filter(([k])=>!keys.includes(k)));

export async function discoverReaderTarget(db:Queryable,spaceId:string,i:Input):Promise<Target|null>{
 if(i.comment_id===undefined&&i.thread_id===undefined&&i.annotation_id===undefined&&i.document_id===undefined)return null;
 let comment:string|null=i.comment_id??null,thread:string|null=i.thread_id??null,annotation:string|null=i.annotation_id??null;
 if(comment){thread=(await db.query<{thread_id:string}>('SELECT thread_id FROM reader_comments WHERE space_id=$1 AND id=$2',[spaceId,comment])).rows[0]?.thread_id??null;if(!thread)throw hidden();}
 if(thread){annotation=(await db.query<{annotation_id:string}>('SELECT annotation_id FROM reader_comment_threads WHERE space_id=$1 AND id=$2',[spaceId,thread])).rows[0]?.annotation_id??null;if(!annotation)throw hidden();}
 if(annotation){
  const row=(await db.query<{document_type:string;document_id:string}>('SELECT document_type,document_id FROM reader_annotations WHERE space_id=$1 AND id=$2',[spaceId,annotation])).rows[0];
  if(!row)throw hidden();
  return {document_type:row.document_type,document_id:row.document_id,annotation_id:annotation,thread_id:thread,comment_id:comment};
 }
 return {document_type:String(i.document_type),document_id:String(i.document_id),annotation_id:null,thread_id:null,comment_id:null};
}

/** The receipt's target must still be readable as the person alone, on every fresh and replayed release. */
async function authorizeReceipt(db:Queryable,out:ReaderWriteReceipt,a:OperationActor):Promise<void>{
 const p=person(a);
 if(out.space_id!==a.space_id)throw hidden();
 if(out.kind==='appearance'){if(out.id!==p.userId)throw hidden();return;}
 if(out.kind==='evidence'||out.kind==='proposal'){
  if(await contentDecisionFromDb(db,p,out.kind==='evidence'?'extracted_evidence':'proposal',out.id,{includeOversight:false})==='deny')throw hidden();
  return;
 }
 if(!out.document_type||!out.document_id)throw hidden();
 await assertDocumentReadable(db,p,out.document_type,out.document_id);
 if(out.kind==='note'){
  const current=await new ReaderDocumentNotes(db).get(p,out.document_type,out.document_id);
  if(current.note?.id!==out.id||current.note.space_id!==out.note_space_id)throw hidden();
  return;
 }
 if(out.kind==='job'){
  if(!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[out.job_id,a.space_id,p.userId,READER_WRITE_JOB])).rows.length)throw hidden();
 }
 if(out.annotation_id){
  // A creator keeps sight of their own archived annotation; anyone else needs current full access.
  const row=(await db.query<{created_by_user_id:string}>('SELECT created_by_user_id FROM reader_annotations WHERE space_id=$1 AND id=$2 AND document_type=$3 AND document_id=$4',[a.space_id,out.annotation_id,out.document_type,out.document_id])).rows[0];
  if(!row)throw hidden();
  if(row.created_by_user_id!==p.userId&&await contentDecisionFromDb(db,p,'reader_annotation',out.annotation_id,{includeOversight:false})!=='full')throw hidden();
 }
 if(out.kind==='thread'&&!(await db.query('SELECT id FROM reader_comment_threads WHERE space_id=$1 AND id=$2 AND annotation_id=$3',[a.space_id,out.id,out.annotation_id])).rows.length)throw hidden();
 if(out.kind==='comment'&&!(await db.query('SELECT c.id FROM reader_comments c JOIN reader_comment_threads t ON t.id=c.thread_id AND t.space_id=c.space_id WHERE c.space_id=$1 AND c.id=$2 AND t.annotation_id=$3',[a.space_id,out.id,out.annotation_id])).rows.length)throw hidden();
}

/** Human-only Reader commands. Each runs the canonical Reader writer inside the
 * core transaction after the Reader target fence pinned the document closure;
 * the two body-reading writers only queue their one-attempt Job here. */
export function readerRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,_config:ServerConfig):OperationRegistration[]{
 return (Object.keys(READER_OPERATION_SCHEMAS) as ReaderOperationId[]).map(id=>({
  definition:defs.get(id)!,
  successStatus:JOB.has(id)?202:CREATED.has(id)?201:200,
  async resolve(db,raw,a){
   const bound=await discoverReaderTarget(db,a.space_id,raw as Input);
   return {authority:bound?`reader_document:${bound.document_type}:${bound.document_id}`:`reader_appearance:${a.on_behalf_of_user_id}`,targets:bound??{user_id:a.on_behalf_of_user_id},resourceType:'reader_document',resourceId:bound?.document_id??null,bound} as Scope;
  },
  async authorize(db,raw,a,scope){
   const b=(scope as Scope).bound;if(!b)return;
   await lockReaderWriteTarget(db,person(a),{document_type:b.document_type,document_id:b.document_id,...(b.annotation_id?{annotation_id:b.annotation_id}:{}),...(b.thread_id?{thread_id:b.thread_id}:{}),...(b.comment_id?{comment_id:b.comment_id}:{})});
   if(canonical(await discoverReaderTarget(db,a.space_id,raw as Input))!==canonical(b))throw new OperationBusinessError('operation_conflict',409,'reader');
   // A range Job is queued only for the annotation's own creator.
   if(id==='reader.annotation.range.replace'&&!(await db.query('SELECT id FROM reader_annotations WHERE space_id=$1 AND id=$2 AND created_by_user_id=$3',[a.space_id,b.annotation_id,a.on_behalf_of_user_id])).rows.length)throw hidden();
  },
  async authorizeResult(db,raw,a){await authorizeReceipt(db,raw as ReaderWriteReceipt,a);},
  classifyError(error){
   if(error instanceof HttpError&&[400,409,422].includes(error.statusCode))return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'reader');
   return undefined;
  },
  async execute(db,raw,a){
   const i=raw as Input,p=person(a),b=await discoverReaderTarget(db,a.space_id,i);
   const receipt=(kind:ReaderWriteReceipt['kind'],rid:string,extra:Partial<ReaderWriteReceipt>={}):ReaderWriteReceipt=>({id:rid,space_id:a.space_id,document_type:(b?.document_type??null) as ReaderWriteReceipt['document_type'],document_id:b?.document_id??null,annotation_id:b?.annotation_id??null,kind,...extra});
   if(JOB.has(id)){
    if(id==='reader.position.write'&&Date.parse(i.client_at)>Date.now()+5*60_000)throw new OperationRefusal(422,'reader','Reading position time is in the future');
    const job=await new PgJobQueueRepository(db).enqueue({job_type:READER_WRITE_JOB,space_id:a.space_id,user_id:p.userId,max_attempts:1,payload:{operation:id,user_id:p.userId,request:i}});
    return receipt('job',job.id,{job_id:job.id});
   }
   switch(id){
    case 'reader.annotation.create':{const ann=await new PgAnnotationRepository(db).createAnnotation(p,i);return {...receipt('annotation',ann.id),annotation_id:ann.id};}
    case 'reader.annotation.update':return receipt('annotation',(await new PgAnnotationRepository(db).updateAnnotation(p,i.annotation_id,without(i,'annotation_id'))).id);
    case 'reader.annotation.archive':await new PgAnnotationRepository(db).archiveAnnotation(p,i.annotation_id);return receipt('annotation',i.annotation_id);
    case 'reader.comment.create':return receipt('thread',(await new PgCommentRepository(db).createComment(p,i.annotation_id,{body:i.body})).thread.id);
    case 'reader.comment.update':return receipt('comment',(await new PgCommentRepository(db).updateComment(p,i.comment_id,without(i,'comment_id'))).id);
    case 'reader.thread.update':return receipt('thread',(await new PgCommentRepository(db).updateThread(p,i.thread_id,{status:i.status})).id);
    case 'reader.evidence.create':return receipt('evidence',(await new PgReaderActionRepository(db).createEvidence(p,i.annotation_id,without(i,'annotation_id'))).id);
    case 'reader.memory.propose':case 'reader.knowledge.propose':return receipt('proposal',(await new PgReaderActionRepository(db).createProposal(p,i.annotation_id,without(i,'annotation_id'))).id);
    case 'reader.appearance.set':await new ReaderAppearanceSettings(db).set(p,i);return receipt('appearance',p.userId);
    case 'reader.document_note.create':{const out=await new ReaderDocumentNotes(db).create(p,i.document_type,i.document_id,without(i,'document_type','document_id'));if(!out.note)throw new HttpError(409,'Document note unavailable');return receipt('note',out.note.id,{note_space_id:out.note.space_id});}
    default:throw hidden();
   }
  },
 }));
}
