import {assertResearchReportCallReadable} from './reportAccess.js';
import {ResearchCallContentUnavailable} from "./researchCallAccess.js";
import {researchMetadataReadableSql} from "./researchOperationMetadata.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, dateIso, objectValue } from "../routeUtils/common.js";
import { assertProjectReadable } from "../projects/access.js";
import { resolveResearchReportReferences } from "./reportReferenceResolver.js";

interface ReportListRow {
  id: string; project_id: string; workflow_id: string; operation_id: string; synthesis_run_id: string;
  run_kind: string; research_question: string; research_question_version: number; status: string;
  created_at: unknown; updated_at: unknown;
}

interface ReportRow extends ReportListRow {
  content_json: unknown; reader_document_json: unknown; normalized_text: string; content_hash: string;
  archive_artifact_id: string; evidence_matrix_artifact_id: string | null; integrity_artifact_id: string | null;
}

const LIST_COLUMNS = `id,project_id,workflow_id,operation_id,synthesis_run_id,run_kind,research_question,
  research_question_version,status,created_at,updated_at`;

const DETAIL_COLUMNS = `${LIST_COLUMNS},content_json,reader_document_json,normalized_text,content_hash,
  archive_artifact_id,evidence_matrix_artifact_id,integrity_artifact_id`;

export class ProjectResearchReportRepository {
  constructor(private readonly db: Queryable) {}

  /** Exhaustive list for Area initialization and the full-list route; the records UI pages. */
  async list(identity:SpaceUserIdentity,projectId:string):Promise<Record<string,unknown>[]>{
    const items:Record<string,unknown>[]=[];let cursor:string|null=null;
    do{const page=await this.page(identity,projectId,cursor);items.push(...page.items);cursor=page.next_cursor;}while(cursor);
    return items;
  }
  async page(identity:SpaceUserIdentity,projectId:string,after:string|null=null){
    await assertProjectReadable(this.db,identity.spaceId,projectId,identity.userId);
    if(after!==null&&(!after.trim()||after.length>128))throw new HttpError(422,"Invalid report cursor");
    if(after){const cursor=await this.db.query(`SELECT r.id,r.operation_id FROM project_research_reports r JOIN project_operations op ON op.id=r.operation_id AND op.space_id=r.space_id AND op.project_id=r.project_id WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3 AND ${researchMetadataReadableSql("op","$4")}`,[after,identity.spaceId,projectId,identity.userId]);if(!cursor.rows[0])throw new HttpError(422,"Invalid report cursor");try{await assertResearchReportCallReadable(this.db,identity,projectId,String(cursor.rows[0].operation_id));}catch(error){if(error instanceof ResearchCallContentUnavailable)throw new HttpError(422,"Invalid report cursor");throw error;}}
    const rows=await this.db.query<ReportListRow>(`SELECT r.id,r.project_id,r.workflow_id,r.operation_id,r.synthesis_run_id,r.run_kind,r.research_question,r.research_question_version,r.status,r.created_at,r.updated_at FROM project_research_reports r JOIN project_operations op ON op.id=r.operation_id AND op.space_id=r.space_id AND op.project_id=r.project_id WHERE r.space_id=$1 AND r.project_id=$2 AND ${researchMetadataReadableSql("op","$3")} AND ($4::varchar IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM project_research_reports WHERE id=$4 AND space_id=$1 AND project_id=$2)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[identity.spaceId,projectId,identity.userId,after]);
    const readable=[];
    for(const row of rows.rows.slice(0,50)){
      try{await assertResearchReportCallReadable(this.db,identity,projectId,row.operation_id);readable.push(reportListOut(row));}
      catch(error){if(!(error instanceof ResearchCallContentUnavailable))throw error;}
    }
    return {items:readable,next_cursor:rows.rows.length>50?rows.rows[49]!.id:null};
  }

  async get(identity: SpaceUserIdentity, projectId: string, reportId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<ReportRow>(
      `SELECT ${DETAIL_COLUMNS} FROM project_research_reports WHERE id=$1 AND space_id=$2 AND project_id=$3`,
      [reportId, identity.spaceId, projectId],
    );
    if (!rows.rows[0]) throw new HttpError(404, "Research report not found or not accessible");
    const row = rows.rows[0];
    await assertResearchReportCallReadable(this.db,identity,projectId,row.operation_id);
    // "Current" question means the live workflow's question now, not the
    // immutable value this report was generated against (row.research_question).
    const workflow = await this.db.query<{ research_question: string | null }>(
      `SELECT state_json->>'research_question' AS research_question
         FROM project_research_workflows WHERE space_id=$1 AND project_id=$2 AND object_id=$3`,
      [identity.spaceId, projectId, row.workflow_id],
    );
    const references = await resolveResearchReportReferences(this.db, identity, objectValue(row.content_json));
    return {
      ...reportListOut(row),
      content: references.content,
      reader_document: objectValue(row.reader_document_json),
      normalized_text: row.normalized_text, content_hash: row.content_hash,
      integrity: { artifact_id: row.integrity_artifact_id, status: row.integrity_artifact_id ? "available" : "not_run" },
      provenance: { workflow_id: row.workflow_id, operation_id: row.operation_id, synthesis_run_id: row.synthesis_run_id },
      archive_descriptors: [
        { kind: "archive", artifact_id: row.archive_artifact_id },
        ...(row.evidence_matrix_artifact_id ? [{ kind: "evidence_matrix", artifact_id: row.evidence_matrix_artifact_id }] : []),
        ...(row.integrity_artifact_id ? [{ kind: "integrity", artifact_id: row.integrity_artifact_id }] : []),
      ],
      current_research_question: workflow.rows[0]?.research_question ?? null,
      resolved_references: references.resolved,
    };
  }
}

function reportListOut(row: ReportListRow): Record<string, unknown> {
  return {
    id: row.id, project_id: row.project_id, workflow_id: row.workflow_id, operation_id: row.operation_id,
    synthesis_run_id: row.synthesis_run_id, run_kind: row.run_kind, research_question: row.research_question,
    research_question_version: row.research_question_version, status: row.status,
    created_at: dateIso(row.created_at), updated_at: dateIso(row.updated_at),
  };
}
