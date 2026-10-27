import type { Queryable } from '../../routeUtils/common.js';
/** Coarse shared coverage has no candidate counts or private reading signals. */
export async function monitoringRecentCoverage(db: Queryable, spaceId: string, channelId: string): Promise<string> {
  const rows = await db.query<{
    status: string;
    history_mode: string;
    segments_failed: number;
    items_ingested: number;
    pending: string;
    partial: string;
  }>(`SELECT p.strategy_json->>'history_mode' AS history_mode,p.status,p.segments_failed,p.items_ingested,count(s.id) FILTER(WHERE s.status IN ('pending','running'))::text AS pending,count(s.id) FILTER(WHERE s.window_json->>'partial'='true')::text AS partial FROM source_backfill_plans p LEFT JOIN source_backfill_segments s ON s.plan_id=p.id AND s.space_id=p.space_id WHERE p.space_id=$1 AND p.source_channel_id=$2 AND p.strategy_json->>'monitoring_purpose'='recent' GROUP BY p.id ORDER BY p.strategy_json->>'to' DESC`, [spaceId, channelId]);
  const latest = rows.rows[0];
  if (!latest) return 'not_run';
  if (latest.segments_failed > 0 || latest.status === 'failed') return 'source_failed';
  // Older failed ranges remain a coverage gap; they do not say today's fetch failed.
  if (rows.rows.some(row => Number(row.pending) > 0 || Number(row.partial) > 0 || row.segments_failed > 0 || row.status === 'failed')) return 'coverage_partial';
  if (latest.history_mode === 'current_snapshot') return 'current_only';
  return latest.items_ingested === 0 ? 'no_new' : 'completed';
}
