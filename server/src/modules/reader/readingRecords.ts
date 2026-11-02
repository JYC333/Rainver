import {canReadProject} from '../projects/access.js';
import { PROJECT_READING_RECORD_LIMITS, type ProjectReadingRecords } from '@rainver/protocol';
import type { Queryable, SpaceUserIdentity } from '../routeUtils/common.js';
import { HttpError, dateIso } from '../routeUtils/common.js';
import { assertDocumentReadable } from './repository.js';
import { contentAccessLevelSql, contentReadSql, roomRunReadAccessSql } from '../access/contentAccessSql.js';
import { contentResourceDefinition } from '../access/contentAccessRegistry.js';
import { sourceDerivedArtifactReadableClause } from '../sources/sourceItemAccess.js';

/** Classify old versions without changing their body, identity, anchors or provenance.
 * Only code-owned deterministic extractor metadata qualifies as an original. */
export async function projectReadingRecords(db:Queryable,identity:SpaceUserIdentity,itemId:string,offset=0,projectId?:string,snapshotId?:string):Promise<ProjectReadingRecords>{
 if(!Number.isSafeInteger(offset)||offset<0||offset>PROJECT_READING_RECORD_LIMITS.maxOffset)throw new HttpError(422,'Invalid offset');
 if(snapshotId!==undefined&&(!snapshotId.length||snapshotId.length>64||offset!==0))throw new HttpError(422,'Invalid exact record');
 const scope=await assertDocumentReadable(db,identity,'source_item',itemId);
 if(projectId&&(!projectId.length||projectId.length>64))throw new HttpError(422,'Invalid Project');
 const project=projectId??scope.projectId;
 if(!project||(scope.projectId&&scope.projectId!==project)||!await canReadProject(db,identity.spaceId,project,identity.userId))throw new HttpError(404,'Project material not found');
 const full=(type:'artifact'|'source_snapshot',alias:string)=>`${contentReadSql(type,alias,'$3')} AND ${contentAccessLevelSql({definition:contentResourceDefinition(type)!,alias,userExpr:'$3'})}='full'`;
 const base=`FROM source_snapshots s JOIN artifacts a ON a.space_id=s.space_id AND a.id=s.artifact_id
 WHERE $4::integer>=0 AND s.space_id=$1 AND s.source_item_id=$2 AND s.snapshot_type IN ('extracted','summary') AND (s.reading_role IS DISTINCT FROM 'analysis' OR s.project_id=$5) AND ${full('source_snapshot','s')} AND ${full('artifact','a')}
 AND ${roomRunReadAccessSql('a.run_id','a.space_id','$3')} AND ${sourceDerivedArtifactReadableClause('a','$3',true)}`;
 const original=`a.metadata_json->>'extraction_method' IN ('structured_html_v1','markdown_v1','plain_text_v1','pdf_text_v1') AND s.snapshot_type='extracted'`;
 type Row={id:string;artifact_id:string;captured_at:string;reading_role:string|null;origin_run_id:string|null;original_snapshot_id:string|null;metadata_json:Record<string,unknown>|null};
 const select='SELECT s.id,s.artifact_id,s.captured_at,s.reading_role,s.origin_run_id,s.original_snapshot_id,a.metadata_json ';
 const rows=(await db.query<Row>(select+base+(snapshotId?' AND s.id=$6':'')+' ORDER BY s.captured_at DESC,s.id DESC LIMIT 26 OFFSET $4',[identity.spaceId,itemId,identity.userId,offset,project,...(snapshotId?[snapshotId]:[])])).rows;
 const primary=(await db.query<Row>(select+base+` AND (${original}) ORDER BY s.captured_at DESC,s.id DESC LIMIT 1`,[identity.spaceId,itemId,identity.userId,0,project])).rows[0];
 // A missing readable original does not prove none was retained. Inspect only
 // existence, never an inaccessible version's identity/body/count. An old or
 // custom snapshot, a raw archive or a dangling body pointer is inconclusive.
 // Both booleans are page-independent; only authorized analysis is evidence
 // for the analysis-only not_retained state.
 const evidence=primary?null:(await db.query<{possible_original:boolean;readable_analysis:boolean}>(`SELECT
  EXISTS(SELECT 1 FROM source_items i WHERE i.space_id=$1 AND i.id=$2 AND (
   i.extracted_artifact_id IS NOT NULL OR i.raw_artifact_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM source_snapshots possible WHERE possible.space_id=i.space_id AND possible.source_item_id=i.id
    AND (possible.snapshot_type<>'summary' OR possible.reading_role IS DISTINCT FROM 'analysis'))
  )) AS possible_original,
  EXISTS(SELECT 1 ${base} AND s.reading_role='analysis') AS readable_analysis`,[identity.spaceId,itemId,identity.userId,0,project])).rows[0];
 const availability=primary?'retained':!evidence?.possible_original&&evidence?.readable_analysis?'not_retained':'unknown';
 const convert=(r:Row):ProjectReadingRecords['items'][number]=>{
  const m=r.metadata_json??{};
  const deterministic=['structured_html_v1','markdown_v1','plain_text_v1','pdf_text_v1'].includes(String(m.extraction_method));
  return {snapshot_id:r.id,artifact_id:r.artifact_id,captured_at:dateIso(r.captured_at)!,role:r.reading_role==='analysis'?'analysis':deterministic?'original':m.extraction_method==='agent_provided_v1'?'legacy_analysis':'unknown',origin_run_id:r.origin_run_id,original_snapshot_id:r.original_snapshot_id,format:m.reading_content_format==='source_text'?'source_text':m.reading_content_format==='agent_summary'?'agent_summary':'undeclared'};
 };
 return {original:primary?convert(primary):null,original_availability:availability,items:rows.slice(0,25).map(convert),next_offset:rows.length>25&&offset+25<=PROJECT_READING_RECORD_LIMITS.maxOffset?offset+25:null,truncated:rows.length>25&&offset+25>PROJECT_READING_RECORD_LIMITS.maxOffset};
}
