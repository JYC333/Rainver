import { localMonitoringDate } from '../../projects/monitoringControl.js';
import type { ProjectMonitoringConfig } from '@rainver/protocol';
import type { ServerConfig } from '../../../config.js';
import type { Queryable, SpaceUserIdentity } from '../../routeUtils/common.js';
import { SourceBackfillPlanningService } from '../sourceBackfillService.js';

/** Called under Project lock after confirmation and Sources authority checks. No public direct-start. */
export async function prepareMonitoringRecent(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, projectId: string, versionId: string, cfg: ProjectMonitoringConfig, cutoff: string, scheduled = false) {
  const channel = await db.query<{
    connector_key: string;
  }>(`SELECT c.connector_key FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id JOIN source_provider_connectors spc ON spc.id=sc.provider_connector_id JOIN source_connectors c ON c.id=spc.connector_id WHERE ch.id=$1 AND ch.space_id=$2`, [cfg.source_channel_id, identity.spaceId]);
  const observation = channel.rows[0]?.connector_key !== 'arxiv_api';
  if (!observation && cutoff <= cfg.to) return;
  const binding = await db.query<{
    id: string;
  }>(`SELECT id FROM project_source_bindings WHERE space_id=$1 AND project_id=$2 AND source_channel_id=$3 AND status='active'`, [identity.spaceId, projectId, cfg.source_channel_id]);
  const last = await db.query<{
    until: string | null;
  }>(`SELECT max(strategy_json->>'to') AS until FROM source_backfill_plans WHERE space_id=$1 AND source_channel_id=$2 AND strategy_json->>'monitoring_purpose'='recent'`, [identity.spaceId, cfg.source_channel_id]);
  const day = localMonitoringDate(cfg.timezone, new Date(cutoff));
  const existing = await db.query(`SELECT 1 FROM source_backfill_plans WHERE space_id=$1 AND source_channel_id=$2 AND strategy_json->>'monitoring_purpose'='recent' AND strategy_json->>'local_date'=$3 AND status NOT IN ('completed','failed','cancelled') LIMIT 1`, [identity.spaceId, cfg.source_channel_id, day]);
  if (!scheduled && existing.rows.length) return;
  const from = last.rows[0]?.until ?? (observation ? new Date(Date.parse(cutoff)-1).toISOString() : cfg.to);
  if (from >= cutoff) return;
  const plan = await new SourceBackfillPlanningService(db, config).create(identity, cfg.source_channel_id, {
    idempotency_key: `recent:${versionId}:${cutoff}`,
    project_source_binding_id: binding.rows[0]!.id,
    strategy: {
      window_unit: observation ? 'page_cursor' : 'date_window',
      history_mode: observation ? 'current_snapshot' : 'bounded_range',
      from,
      to: cutoff,
      max_items: cfg.schedule?.recent_window_candidates ?? cfg.total_candidates,
      window_size: 365
    },
    quota_policy: {
      window: 'minute',
      limit_count: 10
    }
  });
  // This is the accepted daily scope's finite recent window, never a generic history approval.
  await db.query(`UPDATE source_backfill_plans SET status='approved',strategy_json=strategy_json||jsonb_build_object('information_monitoring_version_id',$3::text,'monitoring_purpose','recent','local_date',$4::text),updated_at=now() WHERE id=$1 AND space_id=$2 AND status='draft'`, [plan.id, identity.spaceId, versionId, day]);
}
export async function monitoringAcquisitionPlans(db: Queryable, spaceId: string, channelId: string, historyId: string) {
  const recent = await db.query<{
    id: string;
    status: string;
  }>(`SELECT id,status FROM source_backfill_plans WHERE space_id=$1 AND source_channel_id=$2 AND strategy_json->>'monitoring_purpose'='recent' AND status NOT IN ('completed','failed','cancelled') ORDER BY strategy_json->>'to' DESC,id`, [spaceId, channelId]);
  return [...recent.rows.map(p => p.id), historyId];
}
