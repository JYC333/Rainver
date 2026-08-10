import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { PgJobQueueRepository } from "../jobs/repository";
import { PgSourceAnnotationRepository, SOURCE_ANNOTATION_JOB_TYPE } from "../sourceAnnotation/repository";

export interface ExternalDiscoverySample {
  title: string;
  source_uri: string;
  occurred_at?: string | null;
  author?: string | null;
  excerpt?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Sources-owned admission path for bounded external discovery results.
 *
 * These are private, metadata-only SourceItems with no subscription-bearing
 * connection. The caller receives only rows the reader may own/read, and the
 * normal objective annotation queue remains the sole classifier.
 */
export async function materializeExternalDiscovery(
  db: Queryable,
  input: { spaceId: string; projectId: string | null; userId: string; samples: readonly ExternalDiscoverySample[]; discoveryKey: string },
): Promise<string[]> {
  const ids: string[] = [];
  const now = new Date().toISOString();
  for (const sample of input.samples) {
    const uri = canonicalUrl(sample.source_uri);
    if (!uri || !sample.title.trim()) continue;
    const existing = await db.query<{ id: string; owner_user_id: string | null; visibility: string }>(
      `SELECT id, owner_user_id, visibility FROM source_items
        WHERE space_id=$1 AND project_id IS NOT DISTINCT FROM $3 AND canonical_uri=$2 AND deleted_at IS NULL LIMIT 1`,
      [input.spaceId, uri, input.projectId],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.owner_user_id === input.userId || row.visibility === "space_shared") ids.push(row.id);
      continue;
    }
    const id = randomUUID();
    const metadata = { ...(sample.metadata ?? {}), discovery_key: input.discoveryKey, discovered_externally: true };
    await db.query(
      `INSERT INTO source_items
         (id,space_id,project_id,owner_user_id,visibility,access_level,connection_id,item_type,title,
          source_uri,canonical_uri,source_domain,author,occurred_at,first_seen_at,last_seen_at,
          content_hash,excerpt,content_state,retention_policy,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'private','summary',NULL,'external_url',$5,$6,$6,$7,$8,$9,$10,$10,
               $11,$12,'metadata_only','summary_only',$13::jsonb,$10,$10)`,
      [id, input.spaceId, input.projectId, input.userId, sample.title.trim().slice(0, 1024), uri,
        new URL(uri).hostname, sample.author ?? null, validDate(sample.occurred_at), now,
        createHash("sha256").update(`${uri}\n${sample.title}`).digest("hex"),
        sample.excerpt?.slice(0, 2048) ?? null, JSON.stringify(metadata)],
    );
    ids.push(id);
  }
  if (ids.length > 0) {
    const queued = await new PgSourceAnnotationRepository(db).enqueueItems(input.spaceId, ids, null);
    if (queued > 0) {
      try {
        await new PgJobQueueRepository(db).enqueue({
          job_type: SOURCE_ANNOTATION_JOB_TYPE,
          payload: { trigger: "external_discovery", queued_item_count: queued },
          space_id: input.spaceId,
          user_id: null,
        });
      } catch {
        // Pending annotations remain recoverable by the annotation sweep.
      }
    }
  }
  return ids;
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function validDate(value: string | null | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
