import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import type {SourceMaterialReadingContentSchema} from '@rainver/protocol';
import type {z} from 'zod';
import {HttpError,type Queryable} from '../../routeUtils/common.js';
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
export async function storeSourceReaderArtifact(db:Queryable,spaceId:string,itemId:string,title:string,content:StructuredReaderContent,metadata:Record<string,unknown>={}){
 const id=randomUUID(),now=new Date().toISOString();
 const result=await db.query(`INSERT INTO artifacts(id,space_id,artifact_type,title,content,mime_type,exportable,export_formats_json,canonical_format,preview,metadata_json,created_at,updated_at,visibility,access_level,owner_user_id,trust_level,project_id)
 SELECT $1::varchar,$2::varchar,'source_reader_document',$4::varchar,$5::text,'application/json',true,'["json"]'::jsonb,'reader_document_json',false,$6::jsonb,$7::timestamptz,$7::timestamptz,visibility,access_level,owner_user_id,CASE WHEN $8::boolean THEN 'low' ELSE 'medium' END,project_id FROM source_items WHERE id=$3::varchar AND space_id=$2::varchar AND deleted_at IS NULL RETURNING id`,[id,spaceId,itemId,title.slice(0,512),JSON.stringify(content),{schema_version:1,kind:content.kind,extraction_method:content.extraction_method,image_policy:content.image_policy,image_count:content.image_count,source_uri:content.source_uri,...metadata},now,content.extraction_method==='agent_provided_v1']);
 if(!result.rows.length)throw new HttpError(404,'Material not found');
 await inheritContentAccessGrants(db,{spaceId,sourceResourceType:'source_item',sourceResourceId:itemId,targetResourceType:'artifact',targetResourceId:id,inheritedAt:now});
 return id;
}
/** Caller owns the transaction and Source authority. The canonical item/body
 * revision guards preserve reading completion and annotations on first fill. */
export async function saveSourceReadingDocument(db:Queryable,input:{spaceId:string;itemId:string;document:StructuredReaderContent;metadata?:Record<string,unknown>;agentProvided?:boolean;summary?:string|null;expectedHash?:string|null}){
 const item=(await db.query<SourceItemRow>(`SELECT * FROM source_items WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE`,[input.itemId,input.spaceId])).rows[0];if(!item)throw new HttpError(404,'Material not found');
 if(input.expectedHash!==undefined&&item.content_hash!==input.expectedHash)throw new HttpError(409,'Material changed while reading');
 const metadata={...input.metadata,reading_method:input.agentProvided?'agent':'extractor',...(!input.agentProvided?{reading_content_kind:'article',reading_content_format:'source_text',reading_sources:[input.document.source_uri??item.source_uri]}:{}),...(input.agentProvided?{result_provenance:'agent_provided_unverified'}:{})};
 const artifactId=await storeSourceReaderArtifact(db,input.spaceId,item.id,item.title,input.document,metadata);
 const snapshotId=randomUUID(),now=new Date().toISOString(),hash=createHash('sha256').update(input.document.plain_text).digest('hex');
 await db.query(`INSERT INTO source_snapshots(id,space_id,project_id,source_item_id,connection_id,snapshot_type,artifact_id,content_hash,source_uri,capture_method,trust_level,metadata_json,captured_at,created_at,updated_at,owner_user_id,visibility,access_level)
 VALUES($1,$2,$3,$4,$5,'extracted',$6,$7,$8,$9,$15,$10,$11,$11,$11,$12,$13,$14)`,[snapshotId,input.spaceId,item.project_id,item.id,item.connection_id,artifactId,hash,item.source_uri,'full_text',metadata,now,item.owner_user_id,item.visibility,item.access_level,input.agentProvided?'untrusted':'normal']);
 await inheritContentAccessGrants(db,{spaceId:input.spaceId,sourceResourceType:'source_item',sourceResourceId:item.id,targetResourceType:'source_snapshot',targetResourceId:snapshotId,inheritedAt:now});
 await db.query(`UPDATE source_items SET extracted_artifact_id=$3,content_hash=$4,content_state='content_saved',retention_policy='full_text',excerpt=COALESCE($5,excerpt),metadata_json=COALESCE(metadata_json,'{}'::jsonb)||$6::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2`,[item.id,input.spaceId,artifactId,hash,input.summary??null,metadata]);
 return {artifactId,snapshotId,contentHash:hash};
}
