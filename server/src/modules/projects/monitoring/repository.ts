import { randomUUID } from 'node:crypto';
import { ProjectMonitoringConfigSchema, type MonitoringVersion, type ProjectMonitoringConfig } from '@rainver/protocol';
import { type Queryable, HttpError } from '../../routeUtils/common.js';
import { fingerprintOf } from '../projectOperationIdempotency.js';
export interface VersionRow {
  id: string;
  project_id: string;
  version: number;
  config_json: unknown;
  config_hash: string;
  proposal_id: string | null;
  backfill_plan_id: string | null;
  rule_id: string | null;
  created_by_user_id: string;
  source_channel_id: string;
  query_fingerprint: string;
}
export function versionOut(row: VersionRow): MonitoringVersion {
  return {
    id: row.id,
    version: row.version,
    config: ProjectMonitoringConfigSchema.parse(row.config_json),
    config_hash: row.config_hash,
    proposal_id: row.proposal_id,
    backfill_plan_id: row.backfill_plan_id,
    rule_id: row.rule_id
  };
}
export async function getVersion(db: Queryable, spaceId: string, projectId: string, id: string): Promise<VersionRow> {
  const r = await db.query<VersionRow>(`SELECT * FROM project_information_monitoring_versions WHERE id=$1 AND space_id=$2 AND project_id=$3`, [id, spaceId, projectId]);
  if (!r.rows[0]) throw new HttpError(404, 'Monitoring version not found');
  return r.rows[0];
}
export async function appendVersion(db: Queryable, spaceId: string, projectId: string, userId: string, config: ProjectMonitoringConfig, previous?: VersionRow) {
  const id = randomUUID();
  const query = await db.query<{
    query_fingerprint: string;
  }>(`SELECT COALESCE(ss.query_fingerprint,ch.query_fingerprint) AS query_fingerprint FROM source_channels ch LEFT JOIN source_search_specs ss ON ss.source_channel_id=ch.id AND ss.space_id=ch.space_id WHERE ch.space_id=$1 AND ch.id=$2`, [spaceId, config.source_channel_id]);
  const queryFingerprint = query.rows[0]?.query_fingerprint;
  if (previous && previous.query_fingerprint !== queryFingerprint) throw new HttpError(409, 'Confirmed source query changed');
  if (!queryFingerprint) throw new HttpError(409, 'Executable source query required');
  const hash = fingerprintOf({
    config,
    query_fingerprint: queryFingerprint
  });
  const r = await db.query<VersionRow>(`INSERT INTO project_information_monitoring_versions(id,space_id,project_id,version,config_json,config_hash,source_channel_id,backfill_plan_id,rule_id,created_by_user_id,query_fingerprint,created_at)
 SELECT $1::varchar,$2::varchar,$3::varchar,COALESCE(MAX(version),0)+1,$4::jsonb,$5::varchar,$6::varchar,$7::varchar,$8::varchar,$9::varchar,$10::varchar,now() FROM project_information_monitoring_versions WHERE space_id=$2::varchar AND project_id=$3::varchar RETURNING *`, [id, spaceId, projectId, JSON.stringify(config), hash, config.source_channel_id, previous?.backfill_plan_id ?? null, previous?.rule_id ?? null, userId, queryFingerprint]);
  return r.rows[0]!;
}
export function monitoringRelevanceInstruction(cfg: ProjectMonitoringConfig): string {
  return `Give a short relevance reason in ${cfg.language}. Judge only the supplied title and ${cfg.incremental_strategy ? 'excerpt (for page changes, the captured before/after excerpts)' : 'abstract'}; do not claim to have read full text.`;
}
