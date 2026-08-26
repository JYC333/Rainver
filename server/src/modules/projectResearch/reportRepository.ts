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

  async list(identity: SpaceUserIdentity, projectId: string): Promise<Record<string, unknown>[]> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    // The report body (content_json/reader_document_json/normalized_text) can
    // be tens of KB of LLM-generated text per row — list callers only ever
    // render metadata, so `reportOut(row, false)` never reads those fields.
    // Leave them out of this query entirely instead of fetching and discarding.
    const rows = await this.db.query<ReportListRow>(
      `SELECT ${LIST_COLUMNS} FROM project_research_reports WHERE space_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC`,
      [identity.spaceId, projectId],
    );
    return rows.rows.map((row) => reportListOut(row));
  }

  async get(identity: SpaceUserIdentity, projectId: string, reportId: string): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const rows = await this.db.query<ReportRow>(
      `SELECT ${DETAIL_COLUMNS} FROM project_research_reports WHERE id=$1 AND space_id=$2 AND project_id=$3`,
      [reportId, identity.spaceId, projectId],
    );
    if (!rows.rows[0]) throw new HttpError(404, "Research report not found or not accessible");
    const row = rows.rows[0];
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
