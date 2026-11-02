import {runDestination} from '../../runtimeContext/runDestination.js';
import type {RunRecord} from '../../runs/repository.js';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {PROJECT_READING_RECORD_LIMITS,type SourceMaterialReadingContentSchema} from '@rainver/protocol';
import type {z} from 'zod';
import {HttpError,withQueryableTransaction,type Queryable} from '../../routeUtils/common.js';
import {inheritContentAccessGrants} from '../../access/contentAccessInheritance.js';
import type {SourceItemRow} from '../sourceRepositoryRows.js';
import {agentReaderContentJson,pmDocToPlainText,type StructuredReaderContent} from '../contentParsing.js';

/** Agent-provided reading text as a Reader document, by the syntax the Agent declared (absent: literal text).
 * Images it references stay `image_policy: none`: Agent-authored content never loads remote images inline. */
export function agentReadingDocument(content:z.infer<typeof SourceMaterialReadingContentSchema>,sourceUri:string):StructuredReaderContent{
 const contentJson=agentReaderContentJson(content.text,content.syntax);
 const plainText=content.syntax==='markdown'?(pmDocToPlainText(contentJson)||content.text):content.text;
 return {schema_version:1,kind:'reader_document',extraction_method:'agent_provided_v1',image_policy:'none',title:null,source_uri:sourceUri,plain_text:plainText,image_count:0,content_json:contentJson};
}

/** Reading metadata of Agent-provided content; the syntax is recorded only when the Agent declared it. */
export function agentReadingMetadata(content:z.infer<typeof SourceMaterialReadingContentSchema>):Record<string,unknown>{
 return {reading_content_kind:content.kind,reading_content_format:content.format,reading_sources:content.sources,...(content.syntax?{reading_content_syntax:content.syntax}:{})};
}
/** Single artifact writer for extracted pages and Agent-prepared reading. Stored
 * as the existing Reader JSON format, without a temporary output.json/file hop. */
export async function storeSourceReaderArtifact(db:Queryable,spaceId:string,itemId:string,title:string,content:StructuredReaderContent,metadata:Record<string,unknown>={},privateOrigin?:{userId:string;runId:string|null;projectId:string}){
 const id=randomUUID(),now=new Date().toISOString();
 const result=await db.query(`INSERT INTO artifacts(id,space_id,artifact_type,title,content,mime_type,exportable,export_formats_json,canonical_format,preview,metadata_json,created_at,updated_at,visibility,access_level,owner_user_id,trust_level,project_id,run_id)
 SELECT $1::varchar,$2::varchar,'source_reader_document',$4::varchar,$5::text,'application/json',true,'["json"]'::jsonb,'reader_document_json',false,$6::jsonb,$7::timestamptz,$7::timestamptz,CASE WHEN $9::varchar IS NULL THEN visibility ELSE 'private' END,access_level,COALESCE($9::varchar,owner_user_id),CASE WHEN $8::boolean THEN 'low' ELSE 'medium' END,COALESCE($11::varchar,project_id),$10::varchar FROM source_items WHERE id=$3::varchar AND space_id=$2::varchar AND deleted_at IS NULL RETURNING id`,[id,spaceId,itemId,title.slice(0,512),JSON.stringify(content),{schema_version:1,kind:content.kind,extraction_method:content.extraction_method,image_policy:content.image_policy,image_count:content.image_count,source_uri:content.source_uri,...metadata},now,content.extraction_method==='agent_provided_v1',privateOrigin?.userId??null,privateOrigin?.runId??null,privateOrigin?.projectId??null]);
 if(!result.rows.length)throw new HttpError(404,'Material not found');
 if(!privateOrigin)await inheritContentAccessGrants(db,{spaceId,sourceResourceType:'source_item',sourceResourceId:itemId,targetResourceType:'artifact',targetResourceId:id,inheritedAt:now});
 return id;
}
/** Join the caller transaction (or open one for a Pool); caller owns Source
 * authority. Body guards preserve reading completion and annotations. */
export async function saveSourceReadingDocument(db:Queryable,input:{spaceId:string;itemId:string;document:StructuredReaderContent;metadata?:Record<string,unknown>;agentProvided?:boolean;analysisProjectId?:string|null;originalSnapshotId?:string|null;summary?:string|null;expectedHash?:string|null}){
 return withQueryableTransaction(db,tx=>writeSourceReadingDocument(tx,input));
}
async function writeSourceReadingDocument(db:Queryable,input:Parameters<typeof saveSourceReadingDocument>[1]){
 const item=(await db.query<SourceItemRow>(`SELECT * FROM source_items WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE`,[input.itemId,input.spaceId])).rows[0];if(!item)throw new HttpError(404,'Material not found');
 if(input.expectedHash!==undefined&&item.content_hash!==input.expectedHash)throw new HttpError(409,'Material changed while reading');
 if((item.project_id||input.analysisProjectId)&&input.agentProvided)return saveProjectAnalysis(db,item,input);
 const metadata={...input.metadata,reading_method:input.agentProvided?'agent':'extractor',...(!input.agentProvided?{result_provenance:null,reading_method_provenance:null,reading_content_kind:'article',reading_content_format:'source_text',reading_sources:[input.document.source_uri??item.source_uri]}:{}),...(input.agentProvided?{result_provenance:'agent_provided_unverified'}:{})};
 const artifactId=await storeSourceReaderArtifact(db,input.spaceId,item.id,item.title,input.document,metadata);
 const snapshotId=randomUUID(),now=new Date().toISOString(),hash=createHash('sha256').update(input.document.plain_text).digest('hex');
 await db.query(`INSERT INTO source_snapshots(id,space_id,project_id,source_item_id,connection_id,snapshot_type,artifact_id,content_hash,source_uri,capture_method,trust_level,metadata_json,captured_at,created_at,updated_at,owner_user_id,visibility,access_level)
 VALUES($1,$2,$3,$4,$5,'extracted',$6,$7,$8,$9,$15,$10,$11,$11,$11,$12,$13,$14)`,[snapshotId,input.spaceId,item.project_id,item.id,item.connection_id,artifactId,hash,item.source_uri,'full_text',metadata,now,item.owner_user_id,item.visibility,item.access_level,input.agentProvided?'untrusted':'normal']);
 if(!input.agentProvided)await db.query("UPDATE source_snapshots SET reading_role='original' WHERE id=$1",[snapshotId]);
 await inheritContentAccessGrants(db,{spaceId:input.spaceId,sourceResourceType:'source_item',sourceResourceId:item.id,targetResourceType:'source_snapshot',targetResourceId:snapshotId,inheritedAt:now});
 await db.query(`UPDATE source_items SET extracted_artifact_id=$3,content_hash=$4,content_state='content_saved',retention_policy='full_text',excerpt=COALESCE($5,excerpt),metadata_json=COALESCE(metadata_json,'{}'::jsonb)||$6::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2`,[item.id,input.spaceId,artifactId,hash,input.summary??null,metadata]);
 return {artifactId,snapshotId,contentHash:hash};
}

/** Project Agent output is unverified analysis even when it declares source_text.
 * The caller holds the transaction/Source locks and revalidates actual egress.
 * Never mutate article identity/hash/excerpt/reading state here.
 */
async function saveProjectAnalysis(db:Queryable,item:SourceItemRow,input:Parameters<typeof saveSourceReadingDocument>[1]):Promise<{artifactId:string;snapshotId:string;contentHash:string}>{
 const projectId=item.project_id??input.analysisProjectId!;
 if(!(await db.query('SELECT 1 FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[projectId,item.space_id])).rows.length)throw new HttpError(403,'Analysis Project unavailable');
 if(input.document.plain_text.length>PROJECT_READING_RECORD_LIMITS.bodyCharacters)throw new HttpError(422,'Analysis exceeds 200000 characters');
 const runId=typeof input.metadata?.agent_run_id==='string'?input.metadata.agent_run_id:null;
 const run=runId?(await db.query<RunRecord>("SELECT * FROM runs WHERE id=$1 AND space_id=$2",[runId,item.space_id])).rows[0]:null;
 if(runId&&!run)throw new HttpError(403,'Analysis Run unavailable');
 const owner=run?.instructed_by_user_id??item.owner_user_id;
 if(!owner)throw new HttpError(403,'Analysis owner unavailable');
 const hash=createHash('sha256').update(input.document.plain_text).digest('hex');
 if(runId){
  const old=(await db.query<{id:string;artifact_id:string;content_hash:string}>("SELECT id,artifact_id,content_hash FROM source_snapshots WHERE space_id=$1 AND source_item_id=$2 AND origin_run_id=$3 AND reading_role='analysis'",[item.space_id,item.id,runId])).rows[0];
  if(old){if(old.content_hash!==hash)throw new HttpError(409,'Analysis Run already published different content');return {snapshotId:old.id,artifactId:old.artifact_id,contentHash:old.content_hash};}
 }
 // Association with the original available at settlement, not proof that this
 // Run consumed that version (Goal collection need not supply expectedHash).
 // Actual frozen reading dependencies are supplied separately in history refs.
 const original=(await db.query<{id:string;artifact_id:string;content_hash:string}>(`SELECT s.id,s.artifact_id,s.content_hash FROM source_snapshots s JOIN artifacts a ON a.id=s.artifact_id AND a.space_id=s.space_id
 WHERE s.space_id=$1 AND s.source_item_id=$2 AND s.snapshot_type='extracted' AND a.metadata_json->>'extraction_method' IN ('structured_html_v1','markdown_v1','plain_text_v1','pdf_text_v1') AND ($3::boolean=false OR s.id=$4::varchar) ORDER BY s.captured_at DESC,s.id DESC LIMIT 1`,[item.space_id,item.id,input.originalSnapshotId!==undefined,input.originalSnapshotId??null])).rows[0];
 const refs=Array.isArray(input.metadata?.reading_history_refs)?input.metadata.reading_history_refs:[];
 const history=original?[...refs,{item_id:item.id,artifact_id:original.artifact_id,content_hash:original.content_hash,snapshot_id:original.id}]:refs;
 if(history.length>PROJECT_READING_RECORD_LIMITS.dependencies)throw new HttpError(422,'Analysis dependency limit is 16');
 const destination=run?await runDestination(db,item.space_id,run):'external_provider';
 const metadata={...input.metadata,reading_analysis_destination:destination,reading_role:'analysis',reading_method:'agent',result_provenance:'agent_provided_unverified',reading_history_refs:history,original_availability:input.originalSnapshotId===null?'unknown':original?'retained':'not_retained'};
 const artifactId=await storeSourceReaderArtifact(db,item.space_id,item.id,item.title,input.document,metadata,{userId:owner,runId,projectId});
 const snapshotId=randomUUID();
 await db.query(`INSERT INTO source_snapshots(id,space_id,project_id,source_item_id,connection_id,snapshot_type,artifact_id,content_hash,source_uri,capture_method,trust_level,metadata_json,captured_at,created_at,updated_at,owner_user_id,visibility,access_level,reading_role,origin_run_id,original_snapshot_id)
 VALUES($1,$2,$3,$4,$5,'summary',$6,$7,$8,'internal','untrusted',$9,now(),now(),now(),$10,'private','full','analysis',$11,$12)`,[snapshotId,item.space_id,projectId,item.id,item.connection_id,artifactId,hash,item.source_uri,metadata,owner,runId,original?.id??null]);
 return {artifactId,snapshotId,contentHash:hash};
}
