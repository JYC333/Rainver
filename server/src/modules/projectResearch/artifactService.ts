import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { objectValue } from "../routeUtils/common";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { evidenceProvenanceReadableClause, sourceItemReadableClause } from "../sources/sourceItemAccess";

const MATRIX_SOURCE_ACCESS = contentResourceDefinition("source_item")!;
const MATRIX_EVIDENCE_ACCESS = contentResourceDefinition("extracted_evidence")!;

interface MatrixRow {
  id: string;
  object_id: string | null;
  source_connection_id: string | null;
  source_item_id: string | null;
  evidence_id: string | null;
  title: string | null;
  source_external_id: string | null;
  occurred_at: string | null;
  triage_status: string;
  relevance: string | null;
  confidence: number | null;
  role: string;
  reason: string | null;
  source_metadata: unknown;
  evidence_title: string | null;
  evidence_excerpt: string | null;
}

/**
 * Materializes deterministic Project Research read artifacts from the
 * approved corpus. The agent-generated synthesis archive remains owned by the
 * normal RunMaterializationService; this service only owns derived matrices.
 */
export class ProjectResearchArtifactService {
  constructor(private readonly db: Queryable) {}

  async ensureEvidenceMatrix(input: {
    spaceId: string;
    projectId: string;
    workflowId: string;
    operationId: string;
    ownerUserId: string;
  }): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      `SELECT id
         FROM artifacts
        WHERE space_id=$1 AND project_id=$2 AND artifact_type='evidence_matrix'
          AND metadata_json->>'project_research_operation_id'=$3
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.spaceId, input.projectId, input.operationId],
    );
    const rows = await this.db.query<MatrixRow>(
      `SELECT pci.id, pci.object_id, pci.source_connection_id,
              si.id AS source_item_id, pci.evidence_id,
              si.title, si.source_external_id, si.occurred_at,
              pci.triage_status, pci.relevance, pci.confidence, pci.role,
              pci.reason, si.metadata_json AS source_metadata,
              ee.title AS evidence_title, ee.content_excerpt AS evidence_excerpt
         FROM project_corpus_items pci
         LEFT JOIN LATERAL (
           SELECT source_item.*
             FROM project_corpus_item_sources pcis
             JOIN source_items source_item
               ON source_item.id=pcis.source_item_id AND source_item.space_id=pcis.space_id
              AND source_item.deleted_at IS NULL
            WHERE pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
              AND ${sourceItemReadableClause("source_item", "$3", false)}
              AND ${contentAccessLevelSql({ definition: MATRIX_SOURCE_ACCESS, alias: "source_item", userExpr: "$3" })} = 'full'
            ORDER BY source_item.last_seen_at DESC, source_item.id ASC
            LIMIT 1
         ) si ON true
         LEFT JOIN extracted_evidence ee
           ON ee.id=pci.evidence_id AND ee.space_id=pci.space_id
         LEFT JOIN source_items evidence_source
           ON evidence_source.id=COALESCE(ee.source_item_id,ee.origin_source_item_id)
          AND evidence_source.space_id=ee.space_id
          AND evidence_source.deleted_at IS NULL
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pci.status='active'
          AND pci.triage_status <> 'excluded'
          AND (
            pci.evidence_id IS NULL
            OR (
              ee.id IS NOT NULL
              AND ${contentReadSql("extracted_evidence", "ee", "$3")}
              AND ${contentAccessLevelSql({ definition: MATRIX_EVIDENCE_ACCESS, alias: "ee", userExpr: "$3" })} = 'full'
              AND ${evidenceProvenanceReadableClause("ee", "$3", true)}
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM project_corpus_item_sources any_source
               WHERE any_source.corpus_item_id=pci.id AND any_source.space_id=pci.space_id
            )
            OR si.id IS NOT NULL
          )
        ORDER BY COALESCE(si.occurred_at, pci.created_at) DESC, pci.id`,
      [input.spaceId, input.projectId, input.ownerUserId],
    );

    const content = JSON.stringify({
      schema_version: "evidence_matrix.v1",
      project_id: input.projectId,
      workflow_id: input.workflowId,
      operation_id: input.operationId,
      generated_at: new Date().toISOString(),
      rows: rows.rows.map((row) => ({
        corpus_item_id: row.id,
        title: row.title ?? row.evidence_title ?? "Untitled source",
        source_external_id: row.source_external_id,
        occurred_at: row.occurred_at,
        triage_status: row.triage_status,
        relevance: row.relevance,
        confidence: row.confidence,
        role: row.role,
        reason: row.reason,
        evidence_excerpt: row.evidence_excerpt,
        source_metadata: objectValue(row.source_metadata),
        references: [citationReference(row)].filter(Boolean),
      })),
    });
    const sourceConnectionIds = [...new Set(rows.rows
      .map((row) => row.source_connection_id)
      .filter((value): value is string => Boolean(value)))];
    const metadata = JSON.stringify({
      schema_version: "evidence_matrix.v1",
      project_research_operation_id: input.operationId,
      project_research_workflow_id: input.workflowId,
      source_connection_ids: sourceConnectionIds,
    });
    const now = new Date().toISOString();
    if (existing.rows[0]) {
      await this.db.query(
        `UPDATE artifacts
            SET content=$1, title=$2, updated_at=$3, metadata_json=$4::jsonb
          WHERE id=$5 AND space_id=$6 AND project_id=$7`,
        [content, `Evidence Matrix (${now})`, now, metadata, existing.rows[0].id, input.spaceId, input.projectId],
      );
      return existing.rows[0].id;
    }

    const artifactId = randomUUID();
    await this.db.query(
      `INSERT INTO artifacts (
         id, space_id, project_id, artifact_type, surface_role, title, content, mime_type,
         exportable, export_formats_json, canonical_format, preview,
         created_at, updated_at, metadata_json, visibility, owner_user_id, trust_level
       ) VALUES (
         $1,$2,$3,'evidence_matrix','operational',$4,$5,'application/json',
         true,$6::jsonb,'json',false,$7,$7,$8::jsonb,'private',$9,'medium'
       )`,
      [
        artifactId,
        input.spaceId,
        input.projectId,
        `Evidence Matrix (${new Date().toISOString()})`,
        content,
        JSON.stringify(["json"]),
        now,
        metadata,
        input.ownerUserId,
      ],
    );
    return artifactId;
  }
}

function citationReference(row: MatrixRow): Record<string, string> | null {
  if (row.source_item_id) return { source_item_id: row.source_item_id };
  if (row.evidence_id) return { evidence_id: row.evidence_id };
  if (row.object_id) return { object_id: row.object_id };
  return null;
}
