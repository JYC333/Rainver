import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * Shared writer for the review/context-layer artifact rows.
 *
 * Every report / packet / brief / eval / explain / session artifact writes the
 * exact same `artifacts` row; the only differences are values
 * (artifact type, content, canonical format, visibility, run/project refs). This
 * helper owns that one INSERT so the positional-parameter ordering lives in a
 * single place (it was an easy `$10/$11` footgun when copy-pasted), and callers
 * only describe the fields that vary.
 *
 * `content` is the already-rendered `content` column (callers decide pretty vs
 * compact); `metadata` is the object stored in `metadata_json`.
 */
export interface InsertArtifactRowInput {
  id?: string;
  spaceId: string;
  ownerUserId: string;
  artifactType: string;
  title: string;
  content: string;
  metadata: unknown;
  canonicalFormat: string;
  visibility: string;
  mimeType?: string;
  exportFormats?: string[];
  runId?: string | null;
  proposalId?: string | null;
  projectId?: string | null;
  trustLevel?: string;
  exportable?: boolean;
  preview?: boolean;
  createdAt?: string;
}

const DEFAULT_MIME = "application/json; charset=utf-8";

export async function insertArtifactRow(db: Queryable, input: InsertArtifactRowInput): Promise<string> {
  const id = input.id ?? randomUUID();
  const now = input.createdAt ?? new Date().toISOString();
  const mimeType = input.mimeType ?? DEFAULT_MIME;
  const exportFormats = input.exportFormats ?? [mimeType];
  await db.query(
    `INSERT INTO artifacts (
       id, space_id, run_id, proposal_id, artifact_type, title, content,
       storage_ref, storage_path, mime_type, exportable, export_formats_json,
       canonical_format, preview, relevant_period_start, relevant_period_end,
       created_at, updated_at, metadata_json, visibility, owner_user_id,
       trust_level, project_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       NULL, NULL, $8, $9, $10::jsonb,
       $11, $12, NULL, NULL,
       $13, $13, $14::jsonb, $15, $16,
       $17, $18
     )`,
    [
      id,
      input.spaceId,
      input.runId ?? null,
      input.proposalId ?? null,
      input.artifactType,
      input.title,
      input.content,
      mimeType,
      input.exportable ?? true,
      JSON.stringify(exportFormats),
      input.canonicalFormat,
      input.preview ?? false,
      now,
      JSON.stringify(input.metadata ?? {}),
      input.visibility,
      input.ownerUserId,
      input.trustLevel ?? "medium",
      input.projectId ?? null,
    ],
  );
  return id;
}
