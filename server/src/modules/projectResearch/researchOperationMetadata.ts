import {contentResourceDefinition} from "../access/contentAccessRegistry.js";
import { ResearchOperationMetadataSchema } from "@rainver/protocol";
import { dateIso } from "../routeUtils/common.js";
import { contentReadSql,contentAccessLevelSql,runInheritedReadSql } from "../access/contentAccessSql.js";
import { threadReadableSql } from "../inquiry/threadAccess.js";
import {researchSnapshotWorkflowReadableSql} from './snapshotAccess.js';
/** Source-independent permission for call identity/status, never its body. */
export function researchMetadataReadableSql(alias:string,user:string,includeOversight?:boolean):string{
 const threadGate=includeOversight===false?`(${contentReadSql("space_object","metadata_thread",user,{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition("space_object")!,alias:"metadata_thread",userExpr:user,includeOversight:false})}='full')`:threadReadableSql("metadata_thread",user,"read_content");
 return `((${alias}.research_call_json IS NULL AND ${researchSnapshotWorkflowReadableSql(alias,user,includeOversight)}) OR (EXISTS(SELECT 1 FROM space_objects metadata_thread WHERE metadata_thread.id=${alias}.research_call_json->>'thread_id' AND metadata_thread.space_id=${alias}.space_id AND metadata_thread.primary_project_id=${alias}.project_id AND ${threadGate}) AND ${runInheritedReadSql(`${alias}.research_call_json->>'requested_by_run_id'`,`${alias}.space_id`,user,{includeOversight})}))`;
}
/** Deliberate allowlist: no spread of operation, call, payload or diagnostics. */
export function researchOperationMetadata(row:Record<string,unknown>){
 return ResearchOperationMetadataSchema.parse({id:String(row.id),space_id:row.space_id,project_id:row.project_id,kind:"research",title:"Research invocation",intent_text:null,status:row.status,version:row.version,created_at:dateIso(row.created_at),updated_at:dateIso(row.updated_at),created_by_user_id:null,initiating_run_id:null,plan_artifact_id:null,progress_json:{content_withheld:true},content_withheld:true,steps:[],links:[],stop_ref:{operation_id:String(row.id)}});
}
export const RESEARCH_METADATA_COLUMNS="id,space_id,project_id,status,version,created_at,updated_at";
