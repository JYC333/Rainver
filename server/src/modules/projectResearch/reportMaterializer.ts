import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { buildResearchReportReaderProjection } from "./reportProjection";
import { assignReportReferenceIds } from "./reportReferenceNumbering";
import { ProjectResearchAreaService } from "./areaService";

export interface MaterializeResearchReportInput {
  spaceId: string; projectId: string; workflowId: string; operationId: string; synthesisRunId: string;
  runKind: string; researchQuestion: string; researchQuestionVersion: number;
  report: Record<string, unknown>; archiveArtifactId: string; evidenceMatrixArtifactId: string | null;
}

export class ProjectResearchReportMaterializer {
  constructor(private readonly db: Queryable) {}

  async materialize(input: MaterializeResearchReportInput): Promise<{ id: string; ideaCount: number }> {
    const existing = await this.db.query<{ id: string; content_json: Record<string, unknown> }>(
      `SELECT id,content_json FROM project_research_reports WHERE space_id=$1 AND synthesis_run_id=$2 LIMIT 1`,
      [input.spaceId, input.synthesisRunId],
    );
    const ideaCount = Array.isArray(input.report.ideas) ? input.report.ideas.length : 0;
    if (existing.rows[0]) {
      await new ProjectResearchAreaService(this.db).seedFromReport({
        spaceId: input.spaceId,
        projectId: input.projectId,
        runId: input.synthesisRunId,
        report: existing.rows[0].content_json,
      });
      return { id: existing.rows[0].id, ideaCount };
    }
    const report = await assignReportReferenceIds(this.db, input.spaceId, input.report);
    const projection = buildResearchReportReaderProjection(report);
    const id = randomUUID(); const now = new Date().toISOString();
    await this.db.query(
      `UPDATE artifacts SET artifact_type='research_report.archive.v1', surface_role='system_archive', updated_at=$3,
          metadata_json=COALESCE(metadata_json,'{}'::jsonb) || $4::jsonb
        WHERE id=$1 AND space_id=$2 AND project_id=$5`,
      [input.archiveArtifactId, input.spaceId, now, JSON.stringify({ research_report_id: id, research_question: input.researchQuestion, research_question_version: input.researchQuestionVersion }), input.projectId],
    );
    if (input.evidenceMatrixArtifactId) await this.db.query(
      `UPDATE artifacts SET surface_role='operational', updated_at=$3 WHERE id=$1 AND space_id=$2`,
      [input.evidenceMatrixArtifactId, input.spaceId, now],
    );
    await this.db.query(
      `INSERT INTO project_research_reports (
         id,space_id,project_id,workflow_id,operation_id,synthesis_run_id,run_kind,research_question,
         research_question_version,status,content_json,reader_document_json,normalized_text,content_hash,
         archive_artifact_id,evidence_matrix_artifact_id,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_review',$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$16)`,
      [id, input.spaceId, input.projectId, input.workflowId, input.operationId, input.synthesisRunId, input.runKind,
        input.researchQuestion, input.researchQuestionVersion, JSON.stringify(report), JSON.stringify(projection.readerDocument),
        projection.normalizedText, projection.contentHash, input.archiveArtifactId, input.evidenceMatrixArtifactId, now],
    );
    await new ProjectResearchAreaService(this.db).seedFromReport({
      spaceId: input.spaceId, projectId: input.projectId, runId: input.synthesisRunId, report,
    });
    return { id, ideaCount };
  }
}
