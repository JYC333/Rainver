import {contentReadSql,contentAccessLevelSql} from '../access/contentAccessSql.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {sourceItemFullContentReadClause} from '../sources/sourceItemAccess.js';
import {researchMetadataReadableSql} from './researchOperationMetadata.js';
/** Existing report/output and producing execution provenance, never the artifact's copied title/type. */
export function researchArtifactOriginSql(artifact:string,operation:string):string{
 return `(${operation}.space_id=${artifact}.space_id AND (
 EXISTS(SELECT 1 FROM project_research_reports artifact_report WHERE artifact_report.space_id=${artifact}.space_id AND artifact_report.project_id=${operation}.project_id AND artifact_report.operation_id=${operation}.id AND ${artifact}.id IN (artifact_report.archive_artifact_id,artifact_report.evidence_matrix_artifact_id,artifact_report.integrity_artifact_id))
 OR (${artifact}.run_id IS NOT NULL AND (${operation}.progress_json->>'synthesis_run_id'=${artifact}.run_id OR EXISTS(SELECT 1 FROM workflow_execution_node_runs artifact_node_run JOIN workflow_execution_nodes artifact_node ON artifact_node.id=artifact_node_run.node_id AND artifact_node.space_id=artifact_node_run.space_id JOIN workflow_executions artifact_execution ON artifact_execution.id=artifact_node.execution_id AND artifact_execution.space_id=artifact_node.space_id WHERE artifact_node_run.run_id=${artifact}.run_id AND artifact_node_run.space_id=${artifact}.space_id AND artifact_execution.research_operation_id=${operation}.id)))
 OR (COALESCE(${operation}.progress_json->'artifact_ids','[]'::jsonb) ? ${artifact}.id)))`;
}
/** Additive provenance gate in the existing Artifact ACL; no new visibility state or publication. */
export function researchArtifactReadableSql(artifact:string,user:string,includeOversight?:boolean):string{
 return `NOT EXISTS(SELECT 1 FROM project_operations artifact_origin WHERE artifact_origin.research_call_json IS NOT NULL AND ${researchArtifactOriginSql(artifact,'artifact_origin')} AND NOT COALESCE((
 ${researchMetadataReadableSql('artifact_origin',user,includeOversight)}
 AND artifact_origin.research_call_json->>'schema_version'='research_call.v1'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(artifact_origin.progress_json->'source_item_ids')='array' THEN artifact_origin.progress_json->'source_item_ids' ELSE '[]'::jsonb END) origin_item_id WHERE NOT EXISTS(SELECT 1 FROM source_items origin_item WHERE origin_item.id=origin_item_id AND origin_item.space_id=artifact_origin.space_id AND ${sourceItemFullContentReadClause('origin_item',user)}))
 AND NOT EXISTS(SELECT 1 FROM (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(artifact_origin.research_call_json->'scope'->'source_channel_ids')='array' THEN artifact_origin.research_call_json->'scope'->'source_channel_ids' ELSE '[]'::jsonb END) AS id UNION SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(artifact_origin.progress_json->'channel_ids')='array' THEN artifact_origin.progress_json->'channel_ids' ELSE '[]'::jsonb END)) origin_channel_id WHERE NOT EXISTS(SELECT 1 FROM source_channels origin_channel JOIN source_connections origin_connection ON origin_connection.id=origin_channel.source_connection_id AND origin_connection.space_id=origin_channel.space_id WHERE origin_channel.id=origin_channel_id.id AND origin_channel.space_id=artifact_origin.space_id AND ${contentReadSql('source_connection','origin_connection',user,{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition('source_connection')!,alias:'origin_connection',userExpr:user,includeOversight:false})}='full'))
 ),false))`;
}
