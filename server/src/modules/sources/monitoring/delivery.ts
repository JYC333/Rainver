import type { Queryable } from '../../routeUtils/common.js';
import { projectReaderIds } from '../../projects/access.js';
import { sourceItemFullContentReadClause } from '../sourceItemAccess.js';

/** Sources projection; content and provenance remain subject to the complete current Project audience. */
export async function monitoringDeliveryCandidates(db: Queryable, spaceId: string, projectId: string, start: string, end: string, limit: number, ruleId?: string | null) {
  const readers = await projectReaderIds(db, spaceId, projectId);
  if (!readers.length) return [];
  const result = await db.query<{
    source_item_id: string;
    page_change: Record<string, unknown> | null;
    content_revision: string | null;
    connection_id: string | null;
    title: string;
    source_uri: string | null;
    source_domain: string | null;
    author: string | null;
    excerpt: string | null;
    occurred_at: string | null;
    first_seen_at: string;
    domain_key: string;
    depth: string;
    genre: string;
    summary: string;
    topic_candidates_json: string[];
    stance_target: string | null;
    stance_target_key: string | null;
    stance_polarity: string;
    stance_confidence: number;
    project_relevance: string;
    project_confidence: number;
    reason: string;
    decision_id: string;
    run_id: string;
    version: number;
    version_id: string;
    config_hash: string;
    ready_at: string;
    evidence_depth: string;
  }>(`WITH ready AS (
    SELECT DISTINCT ON(i.id) i.id AS source_item_id,i.metadata_json->'page_change' AS page_change,i.metadata_json->>'after_hash' AS content_revision,i.connection_id,i.title,COALESCE(i.source_uri,i.metadata_json->>'page_uri') AS source_uri,i.source_domain,i.author,i.excerpt,i.occurred_at,i.first_seen_at,
      a.domain_key,a.depth,a.genre,a.summary,a.topic_candidates_json,a.stance_target,a.stance_target_key,a.stance_polarity,a.stance_confidence,
      d.relevance AS project_relevance,d.confidence AS project_confidence,d.reason,d.id AS decision_id,source_run.id AS run_id,v.version,v.id AS version_id,v.config_hash,
      greatest(pl.created_at,a.annotated_at,d.updated_at) AS ready_at,CASE WHEN length(trim(COALESCE(i.excerpt,'')))>0 THEN 'abstract' ELSE 'title' END AS evidence_depth
    FROM project_information_monitoring_versions v
    JOIN project_operations execution ON execution.space_id=v.space_id AND execution.project_id=v.project_id AND execution.progress_json->>'version_id'=v.id AND execution.progress_json->>'purpose'='information_monitoring'
    JOIN runs source_run ON source_run.space_id=execution.space_id AND source_run.contract_snapshot_json->'source'->>'id'=execution.id
    JOIN source_post_processing_runs processing ON processing.agent_run_id=source_run.id AND processing.space_id=source_run.space_id
    JOIN source_post_processing_item_decisions d ON d.run_id=processing.id AND d.rule_id=v.rule_id AND d.space_id=v.space_id AND d.relevance='relevant' AND d.review_status NOT IN ('ignored','dismissed')
    JOIN source_items i ON i.id=d.source_item_id AND i.space_id=d.space_id AND i.deleted_at IS NULL AND COALESCE(i.metadata_json->>'monitoring_page_baseline','false')<>'true'
    JOIN source_item_annotations a ON a.source_item_id=i.id AND a.space_id=i.space_id AND a.status='succeeded'
    JOIN project_source_item_links pl ON pl.source_item_id=i.id AND pl.space_id=i.space_id AND pl.project_id=$2 AND pl.status='active'
    JOIN source_channel_item_links cl ON cl.source_item_id=i.id AND cl.space_id=i.space_id AND cl.source_channel_id=v.source_channel_id AND cl.status='active'
    WHERE v.space_id=$1 AND v.project_id=$2 AND ($7::varchar IS NULL OR v.rule_id=$7) AND NOT EXISTS(SELECT 1 FROM unnest($6::varchar[]) audience(user_id) WHERE NOT ${sourceItemFullContentReadClause('i', 'audience.user_id')})
      AND greatest(pl.created_at,a.annotated_at,d.updated_at)<$4::timestamptz
      AND NOT EXISTS(SELECT 1 FROM project_corpus_items corpus WHERE corpus.space_id=i.space_id AND corpus.project_id=$2 AND corpus.source_item_id=i.id AND corpus.triage_status='excluded')
      AND EXISTS(SELECT 1 FROM source_backfill_plans plan WHERE plan.space_id=i.space_id AND (plan.id=v.backfill_plan_id OR plan.strategy_json->>'information_monitoring_version_id'=v.id) AND (i.metadata_json->>'source_backfill_plan_id'=plan.id OR EXISTS(SELECT 1 FROM source_snapshots snap WHERE snap.space_id=i.space_id AND snap.source_item_id=i.id AND snap.metadata_json->>'source_backfill_plan_id'=plan.id)))
      AND NOT EXISTS(SELECT 1 FROM information_digest_items di JOIN information_digests dg ON dg.id=di.digest_id AND dg.space_id=di.space_id WHERE dg.space_id=$1 AND dg.project_id=$2 AND di.source_item_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM project_operations op WHERE op.space_id=$1 AND op.project_id=$2 AND op.progress_json->>'purpose'='information_monitoring' AND (op.progress_json->'recommendation_ids') ? i.id)
    ORDER BY i.id,v.version DESC
  ) SELECT * FROM ready ORDER BY CASE WHEN ready_at >= $3::timestamptz THEN 0 ELSE 1 END,ready_at DESC,source_item_id LIMIT $5`, [spaceId, projectId, start, end, limit, readers, ruleId ?? null]);
  return result.rows.map(({
    topic_candidates_json,
    ...row
  }) => ({
    ...row,
    topic_candidates: topic_candidates_json ?? []
  }));
}
