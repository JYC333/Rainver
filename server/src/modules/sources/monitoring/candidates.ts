import { readingStatusSql } from '../readingIdentity.js';
import { SourceReadingStateService } from '../readingState.js';
import { ProjectMonitoringConfigSchema, type MonitoringCandidate } from '@rainver/protocol';
import { type Queryable, type SpaceUserIdentity, HttpError, withQueryableTransaction } from '../../routeUtils/common.js';
import { projectReaderIds, assertProjectReadable } from '../../projects/access.js';
import { sourceItemFullContentReadClause } from '../sourceItemAccess.js';
interface MonitoringCandidateScope {
  config_json: unknown;
  rule_id: string | null;
  backfill_plan_id: string | null;
  id?: string;
}
export async function sharedMonitoringItemIds(db: Queryable, spaceId: string, projectId: string, itemIds: string[]): Promise<string[]> {
  const readers = await projectReaderIds(db, spaceId, projectId);
  if (!readers.length || !itemIds.length) return [];
  const r = await db.query<{
    id: string;
  }>(`SELECT i.id FROM source_items i WHERE i.space_id=$1 AND i.id=ANY($2::varchar[]) AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM unnest($3::varchar[]) AS audience(user_id) WHERE NOT ${sourceItemFullContentReadClause('i', 'audience.user_id')})`, [spaceId, itemIds, readers]);
  return r.rows.map(r => r.id);
}
export async function monitoringCandidates(db: Queryable, identity: SpaceUserIdentity, projectId: string, version: MonitoringCandidateScope, progress?: Record<string, unknown>, options: {
  offset?: number;
  pendingOnly?: boolean;
  readyFirst?: boolean;
} = {}): Promise<MonitoringCandidate[]> {
  const cfg = ProjectMonitoringConfigSchema.parse(version.config_json);
  const readers = await projectReaderIds(db, identity.spaceId, projectId);
  if (!readers.length) return [];
  const rows = await db.query<{
    id: string;
    title: string;
    source_uri: string | null;
    occurred_at: string | null;
    summary: string | null;
    excerpt: string | null;
    relevance: string | null;
    reason: string | null;
    feedback: string | null;
    metadata_json: Record<string, unknown>;
    read_status: 'unread' | 'skimmed' | 'read' | 'discussed';
  }>(`SELECT i.metadata_json,i.id,i.title,COALESCE(i.source_uri,i.metadata_json->>'page_uri') AS source_uri,i.occurred_at,i.excerpt,a.summary,d.relevance,d.reason, us.progress_json->'project_monitoring_feedback'->>$3 AS feedback,${readingStatusSql('i', 'us')} AS read_status
 FROM source_items i JOIN source_channel_item_links l ON l.source_item_id=i.id AND l.space_id=i.space_id AND l.source_channel_id=$4 AND l.status='active'

 LEFT JOIN source_item_annotations a ON a.source_item_id=i.id AND a.space_id=i.space_id AND a.status='succeeded'
 LEFT JOIN source_post_processing_item_decisions d ON d.source_item_id=i.id AND d.space_id=i.space_id AND d.rule_id=$5
 LEFT JOIN source_item_user_states us ON us.source_item_id=i.id AND us.space_id=i.space_id AND us.user_id=$2
 WHERE i.space_id=$1 AND i.deleted_at IS NULL AND COALESCE(i.metadata_json->>'monitoring_page_baseline','false')<>'true' AND NOT EXISTS(SELECT 1 FROM unnest($9::varchar[]) audience(user_id) WHERE NOT ${sourceItemFullContentReadClause('i', 'audience.user_id')}) AND ($10::boolean=false OR a.source_item_id IS NULL OR d.source_item_id IS NULL) AND EXISTS(SELECT 1 FROM project_source_item_links pl WHERE pl.source_item_id=i.id AND pl.space_id=i.space_id AND pl.project_id=$3 AND pl.status='active') AND (( (i.metadata_json->>'source_backfill_plan_id'=$8 OR EXISTS(SELECT 1 FROM source_snapshots snapshot WHERE snapshot.space_id=i.space_id AND snapshot.source_item_id=i.id AND snapshot.metadata_json->>'source_backfill_plan_id'=$8)) AND (EXISTS(SELECT 1 FROM source_backfill_plans observation WHERE observation.id=$8 AND observation.space_id=i.space_id AND observation.strategy_json->>'history_mode'='current_snapshot') OR (COALESCE(i.occurred_at,i.first_seen_at)>=$6::timestamptz AND COALESCE(i.occurred_at,i.first_seen_at)<=$7::timestamptz )) ) OR EXISTS(SELECT 1 FROM source_backfill_plans rp WHERE rp.space_id=i.space_id AND rp.source_channel_id=$4 AND rp.strategy_json->>'monitoring_purpose'='recent' AND (rp.strategy_json->>'information_monitoring_version_id'=$14 OR EXISTS(SELECT 1 FROM project_information_monitoring_versions rv WHERE rv.id=rp.strategy_json->>'information_monitoring_version_id' AND rv.space_id=i.space_id AND rv.rule_id=$5)) AND (i.metadata_json->>'source_backfill_plan_id'=rp.id OR EXISTS(SELECT 1 FROM source_snapshots rs WHERE rs.space_id=i.space_id AND rs.source_item_id=i.id AND rs.metadata_json->>'source_backfill_plan_id'=rp.id))))
 ORDER BY CASE WHEN i.id=ANY($13::varchar[]) THEN 0 ELSE 1 END,CASE WHEN $11::boolean AND a.summary IS NOT NULL AND d.relevance='relevant' THEN 0 ELSE 1 END,i.occurred_at DESC NULLS LAST,i.id LIMIT 200 OFFSET $12`, [identity.spaceId, identity.userId, projectId, cfg.source_channel_id, version.rule_id, cfg.from, cfg.to, version.backfill_plan_id, readers, options.pendingOnly ?? false, options.readyFirst ?? false, options.offset ?? 0, Array.isArray(progress?.recommendation_ids) ? progress.recommendation_ids : [], version.id ?? null]);
  const allowed = new Set(await sharedMonitoringItemIds(db, identity.spaceId, projectId, rows.rows.map(r => r.id)));
  const selected = new Set(Array.isArray(progress?.recommendation_ids) ? progress.recommendation_ids as string[] : []);
  return rows.rows.filter(r => allowed.has(r.id)).map(r => ({
    id: r.id,
    ...(r.metadata_json.page_change ? {change:r.metadata_json.page_change as MonitoringCandidate['change']} : {}),
    title: r.title,
    source_uri: r.source_uri,
    relevance: r.relevance,
    feedback: r.feedback,
    read_status: r.read_status,
    occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    evidence_depth: selected.has(r.id) ? ((Array.isArray(progress?.recommendations) ? progress.recommendations : []) as MonitoringCandidate[]).find(saved => saved.id === r.id)?.evidence_depth ?? (r.excerpt?.trim() ? 'abstract' : 'title') : r.excerpt?.trim() ? 'abstract' : 'title',
    summary: selected.has(r.id) ? ((Array.isArray(progress?.recommendations) ? progress.recommendations : []) as MonitoringCandidate[]).find(saved => saved.id === r.id)?.summary ?? r.summary : r.summary,
    reason: selected.has(r.id) ? ((Array.isArray(progress?.recommendations) ? progress.recommendations : []) as MonitoringCandidate[]).find(saved => saved.id === r.id)?.reason ?? r.reason : r.reason,
    recommended: selected.has(r.id)
  }));
}
export async function monitoringFeedback(db: Queryable, identity: SpaceUserIdentity, projectId: string, itemId: string, feedback: 'read' | 'relevant' | 'not_relevant') {
  await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  const read = await db.query(`SELECT i.id FROM source_items i JOIN project_source_item_links l ON l.source_item_id=i.id AND l.space_id=i.space_id AND l.project_id=$3 AND l.status='active' WHERE i.id=$1 AND i.space_id=$2 AND ${sourceItemFullContentReadClause('i', '$4')}`, [itemId, identity.spaceId, projectId, identity.userId]);
  if (!read.rows[0]) throw new HttpError(404, 'Source item not found');
  if (feedback === 'read') {
    await new SourceReadingStateService(db).update(identity, itemId, { read_status: 'read' });
    return { feedback };
  }
  await withQueryableTransaction(db, async tx => {
    await tx.query(`INSERT INTO source_item_user_states(id,space_id,source_item_id,user_id,library_status,read_status,progress_json,created_at,updated_at) VALUES(gen_random_uuid()::text,$1,$2,$3,'new','unread','{}',now(),now()) ON CONFLICT(space_id,source_item_id,user_id) DO NOTHING`, [identity.spaceId, itemId, identity.userId]);
    await tx.query(`SELECT id FROM source_item_user_states WHERE space_id=$1 AND source_item_id=$2 AND user_id=$3 FOR UPDATE`, [identity.spaceId, itemId, identity.userId]);
    await tx.query(`UPDATE source_item_user_states SET progress_json=jsonb_set(COALESCE(progress_json,'{}'),'{project_monitoring_feedback}',COALESCE(progress_json->'project_monitoring_feedback','{}')||jsonb_build_object($4::text,$5::text)),updated_at=now() WHERE space_id=$1 AND source_item_id=$2 AND user_id=$3`, [identity.spaceId, itemId, identity.userId, projectId, feedback]);
  });
  return {
    feedback
  };
}
