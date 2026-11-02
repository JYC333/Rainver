import type {Queryable} from '../routeUtils/common.js';
import {contentAccessLevelSql,contentReadSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {sourceDerivedArtifactReadableClause,sourceConnectionReaderConsentClause} from './sourceItemAccess.js';
import {retainedAnalysisPolicySql} from './materialProcessing/policy.js';
export interface OriginalVersion {item_id:string;snapshot_id:string;artifact_id:string;content_hash:string;plain_text:string;source_uri:string|null}
/** Deterministic retained text only; no Agent claim, private analysis or reader state.
 * An exact-id read revalidates historical versions without selecting a newer body. */
export async function sharedOriginalVersions(db:Queryable,spaceId:string,audience:string[],input:{itemIds?:string[];snapshotIds?:string[];cutoff?:string;includeText?:boolean}):Promise<OriginalVersion[]>{
 if(!audience.length||!(input.itemIds?.length||input.snapshotIds?.length))return [];
 const full=(type:'source_snapshot'|'artifact'|'source_connection',alias:string)=>`${contentReadSql(type,alias,'u.id',{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition(type)!,alias,userExpr:'u.id',includeOversight:false})}='full'`;
 return (await db.query<OriginalVersion>(`SELECT ${input.snapshotIds?'':'DISTINCT ON(s.source_item_id)'} s.source_item_id AS item_id,s.id AS snapshot_id,a.id AS artifact_id,s.content_hash,CASE WHEN $6::boolean THEN left(a.content::jsonb->>'plain_text',6001) ELSE '' END AS plain_text,s.source_uri
 FROM source_snapshots s JOIN artifacts a ON a.id=s.artifact_id AND a.space_id=s.space_id LEFT JOIN source_connections c ON c.id=s.connection_id AND c.space_id=s.space_id
 WHERE s.space_id=$1 AND s.snapshot_type='extracted' AND s.reading_role IS DISTINCT FROM 'analysis'
 AND a.metadata_json->>'extraction_method' IN ('structured_html_v1','markdown_v1','plain_text_v1','pdf_text_v1')
 AND ($3::varchar[] IS NULL OR s.source_item_id=ANY($3)) AND ($4::varchar[] IS NULL OR s.id=ANY($4)) AND ($5::timestamptz IS NULL OR s.captured_at<=$5)
 AND (s.connection_id IS NULL OR c.id IS NOT NULL AND ${retainedAnalysisPolicySql('c')})
 AND NOT EXISTS(SELECT 1 FROM unnest($2::varchar[]) u(id) WHERE NOT COALESCE((${full('source_snapshot','s')} AND ${full('artifact','a')} AND (s.connection_id IS NULL OR (${full('source_connection','c')} AND ${sourceConnectionReaderConsentClause('c','u.id','s.captured_at',{includeOversight:false})})) AND ${sourceDerivedArtifactReadableClause('a','u.id',true)}),false))
 ORDER BY s.source_item_id,s.captured_at DESC,s.id DESC`,[spaceId,audience,input.itemIds??null,input.snapshotIds??null,input.cutoff??null,input.includeText!==false])).rows;
}
