import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

export interface CanonicalEvidenceInput {
  id?: string;
  spaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  visibility: string;
  accessLevel: string;
  sourceItemId: string | null;
  originSourceItemId?: string | null;
  extractionJobId?: string | null;
  sourceSnapshotId?: string | null;
  sourceObjectType: string | null;
  sourceObjectId: string | null;
  evidenceType: string;
  title: string;
  contentExcerpt: string | null;
  contentHash: string | null;
  artifactId?: string | null;
  sourceUri?: string | null;
  sourceTitle?: string | null;
  sourceAuthor?: string | null;
  occurredAt?: string | null;
  trustLevel: string;
  extractionMethod: string;
  confidence?: number | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
  createdByRunId?: string | null;
  observedAt: string;
}

/**
 * `extracted_evidence` represents content identity, not an extraction attempt.
 * A retry or another extractor observing the same `(space, source item, hash)`
 * reuses the canonical row and appends its semantic/provenance observation.
 */
export async function upsertCanonicalEvidence(
  db: Queryable,
  input: CanonicalEvidenceInput,
): Promise<string> {
  const observation = {
    evidence_type: input.evidenceType,
    extraction_method: input.extractionMethod,
    extraction_job_id: input.extractionJobId ?? null,
    source_snapshot_id: input.sourceSnapshotId ?? null,
    artifact_id: input.artifactId ?? null,
    created_by_user_id: input.createdByUserId ?? null,
    created_by_agent_id: input.createdByAgentId ?? null,
    created_by_run_id: input.createdByRunId ?? null,
    metadata: input.metadata ?? {},
  };
  const metadata = {
    ...(input.metadata ?? {}),
    evidence_observations: [observation],
  };
  const result = await db.query<{ id: string }>(
    `INSERT INTO extracted_evidence (
       id, space_id, project_id, owner_user_id, visibility, access_level,
       source_item_id, origin_source_item_id, extraction_job_id, source_snapshot_id,
       source_object_type, source_object_id, evidence_type, title,
       content_excerpt, content_hash, artifact_id, source_uri, source_title,
       source_author, occurred_at, trust_level, extraction_method, confidence,
       status, metadata_json, created_by_user_id, created_by_agent_id,
       created_by_run_id, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13, $14,
       $15, $16, $17, $18, $19,
       $20, $21::timestamptz, $22, $23, $24::float,
       $25, $26::jsonb, $27, $28,
       $29, $30, $30
     )
     ON CONFLICT (space_id, source_item_id, content_hash)
       WHERE source_item_id IS NOT NULL AND content_hash IS NOT NULL
     DO UPDATE SET
       metadata_json = jsonb_set(
         COALESCE(extracted_evidence.metadata_json, '{}'::jsonb),
         '{evidence_observations}',
         CASE
           WHEN jsonb_typeof(extracted_evidence.metadata_json->'evidence_observations') = 'array'
             THEN CASE
               WHEN (extracted_evidence.metadata_json->'evidence_observations') @> jsonb_build_array($31::jsonb)
                 THEN extracted_evidence.metadata_json->'evidence_observations'
               ELSE (extracted_evidence.metadata_json->'evidence_observations') || jsonb_build_array($31::jsonb)
             END
           ELSE jsonb_build_array($31::jsonb)
         END,
         true
       ),
       updated_at = GREATEST(extracted_evidence.updated_at, EXCLUDED.updated_at)
     RETURNING id`,
    [
      input.id ?? randomUUID(),
      input.spaceId,
      input.projectId,
      input.ownerUserId,
      input.visibility,
      input.accessLevel,
      input.sourceItemId,
      input.originSourceItemId ?? null,
      input.extractionJobId ?? null,
      input.sourceSnapshotId ?? null,
      input.sourceObjectType,
      input.sourceObjectId,
      input.evidenceType,
      input.title,
      input.contentExcerpt,
      input.contentHash,
      input.artifactId ?? null,
      input.sourceUri ?? null,
      input.sourceTitle ?? null,
      input.sourceAuthor ?? null,
      input.occurredAt ?? null,
      input.trustLevel,
      input.extractionMethod,
      input.confidence ?? null,
      input.status,
      JSON.stringify(metadata),
      input.createdByUserId ?? null,
      input.createdByAgentId ?? null,
      input.createdByRunId ?? null,
      input.observedAt,
      JSON.stringify(observation),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Canonical Evidence upsert returned no row");
  return id;
}
