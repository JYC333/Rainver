import type { SourceRunSummaryDTO } from "@rainver/protocol";
import {
  HttpError,
  countFromRow,
  dateIso,
  page,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";

interface SourceRunProjectionRow {
  id: string;
  space_id: string;
  source_connection_id: string;
  run_kind: SourceRunSummaryDTO["run_kind"];
  implementation: SourceRunSummaryDTO["implementation"];
  status: SourceRunSummaryDTO["status"];
  items_created: number | null;
  error: string | null;
  extraction_job_id: string | null;
  handler_run_id: string | null;
  recipe_version_id: string | null;
  created_at: unknown;
  started_at: unknown;
  completed_at: unknown;
}

export async function listSourceRuns(
  db: Queryable,
  identity: SpaceUserIdentity,
  channelId: string,
  filters: { limit: number; offset: number },
) {
  await requireChannel(db, identity, channelId);
  const baseParams = [identity.spaceId, channelId];
  const total = await db.query<{ total: string }>(
    `WITH projected AS (${SOURCE_RUNS_PROJECTED_SQL})
     SELECT count(*)::text AS total FROM projected`,
    baseParams,
  );
  const rows = await db.query<SourceRunProjectionRow>(
    `WITH projected AS (${SOURCE_RUNS_PROJECTED_SQL})
     SELECT *
       FROM projected
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [...baseParams, filters.limit, filters.offset],
  );
  return page(rows.rows.map(sourceRunOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
}

async function requireChannel(db: Queryable, identity: SpaceUserIdentity, channelId: string): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT ch.id
       FROM source_channels ch
       JOIN source_connections sc ON sc.id = ch.source_connection_id
      WHERE ch.space_id = $1 AND ch.id = $2 AND ch.status <> 'archived' AND sc.deleted_at IS NULL`,
    [identity.spaceId, channelId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Source channel not found");
}

function sourceRunOut(row: SourceRunProjectionRow): SourceRunSummaryDTO {
  return {
    id: row.id,
    space_id: row.space_id,
    source_connection_id: row.source_connection_id,
    run_kind: row.run_kind,
    implementation: row.implementation,
    status: row.status,
    items_created: row.items_created,
    error: row.error,
    extraction_job_id: row.extraction_job_id,
    handler_run_id: row.handler_run_id,
    recipe_version_id: row.recipe_version_id,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    started_at: dateIso(row.started_at),
    completed_at: dateIso(row.completed_at),
  };
}

const SOURCE_RUNS_PROJECTED_SQL = `
  SELECT
    ('job:' || ej.id)::text AS id,
    ej.space_id,
    ej.connection_id AS source_connection_id,
    (CASE
      WHEN ej.job_type = 'connection_scan' THEN 'scan'
      WHEN ej.job_type = 'manual_url' THEN 'manual_url'
      WHEN ej.job_type IN ('extract_text', 'snapshot') THEN 'extract'
      ELSE 'other'
    END)::text AS run_kind,
    (CASE
      WHEN sc.handler_kind = 'recipe' OR COALESCE(ej.metadata_json->>'implementation', '') = 'recipe' THEN 'recipe'
      WHEN sc.handler_kind = 'generated_custom' THEN 'generated_handler'
      ELSE 'built_in'
    END)::text AS implementation,
    (CASE
      WHEN ej.status = 'pending' THEN 'queued'
      ELSE ej.status
    END)::text AS status,
    ej.items_created,
    ej.error_message AS error,
    ej.id AS extraction_job_id,
    NULL::varchar AS handler_run_id,
    CASE
      WHEN sc.handler_kind = 'recipe' OR COALESCE(ej.metadata_json->>'implementation', '') = 'recipe'
        THEN COALESCE(NULLIF(ej.metadata_json->>'recipe_version_id', ''), sc.active_recipe_version_id)
      ELSE NULL
    END AS recipe_version_id,
    ej.created_at,
    ej.started_at,
    ej.completed_at
  FROM extraction_jobs ej
  JOIN source_connections sc
    ON sc.space_id = ej.space_id
   AND sc.id = ej.connection_id
  WHERE ej.space_id = $1
    AND ej.metadata_json->>'source_channel_id' = $2
    AND NOT EXISTS (
      SELECT 1
        FROM source_handler_runs shr
       WHERE shr.space_id = ej.space_id
         AND shr.extraction_job_id = ej.id
    )

  UNION ALL

  SELECT
    ('handler_run:' || shr.id)::text AS id,
    shr.space_id,
    shr.source_connection_id,
    (CASE WHEN shr.extraction_job_id IS NULL THEN 'test' ELSE 'scan' END)::text AS run_kind,
    'generated_handler'::text AS implementation,
    shr.status::text AS status,
    ej.items_created,
    COALESCE(shr.failure_class, ej.error_message) AS error,
    shr.extraction_job_id,
    shr.id AS handler_run_id,
    NULL::varchar AS recipe_version_id,
    shr.created_at,
    shr.started_at,
    shr.completed_at
  FROM source_handler_runs shr
  LEFT JOIN extraction_jobs ej
    ON ej.space_id = shr.space_id
   AND ej.id = shr.extraction_job_id
  WHERE shr.space_id = $1
    AND EXISTS (
      SELECT 1 FROM source_channels ch
       WHERE ch.id = $2 AND ch.source_connection_id = shr.source_connection_id
    )

  UNION ALL

  SELECT
    ('recipe_dry_run:' || srv.id)::text AS id,
    srv.space_id,
    srv.source_connection_id,
    'dry_run'::text AS run_kind,
    'recipe'::text AS implementation,
    COALESCE(NULLIF(srv.test_result_json->>'status', ''), 'failed')::text AS status,
    CASE
      WHEN (srv.test_result_json->>'item_count') ~ '^[0-9]+$'
        THEN (srv.test_result_json->>'item_count')::int
      ELSE NULL
    END AS items_created,
    NULLIF(
      COALESCE(
        srv.test_result_json->'errors'->>0,
        srv.test_result_json->>'error'
      ),
      ''
    ) AS error,
    NULL::varchar AS extraction_job_id,
    NULL::varchar AS handler_run_id,
    srv.id AS recipe_version_id,
    COALESCE((srv.test_result_json->>'started_at')::timestamptz, srv.created_at) AS created_at,
    (srv.test_result_json->>'started_at')::timestamptz AS started_at,
    (srv.test_result_json->>'completed_at')::timestamptz AS completed_at
  FROM source_recipe_versions srv
  WHERE srv.space_id = $1
    AND EXISTS (
      SELECT 1 FROM source_channels ch
       WHERE ch.id = $2 AND ch.source_connection_id = srv.source_connection_id
    )
    AND srv.test_result_json IS NOT NULL
`;
