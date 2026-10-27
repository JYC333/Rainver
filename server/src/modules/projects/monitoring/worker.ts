import { monitoringDeliveryCandidates } from '../../sources/monitoring/delivery.js';
import { monitoringRecentCoverage } from '../../sources/monitoring/coverage.js';
import { monitoringAcquisitionPlans } from '../../sources/monitoring/recent.js';
import { MonitoringAdmissionError, monitoringAdmissionReason, monitoringAdmissionRunReason, checkMonitoringPermission } from './admission.js';
import { JobDeferredError } from '../../jobs/handlerRegistry.js';
import type { ServerConfig } from '../../../config.js';
import { getDbPool } from '../../../db/pool.js';
import { tryWithDedicatedSessionAdvisoryLock } from '../../../db/advisoryLock.js';
import type { JobHandlerRegistry } from '../../jobs/handlerRegistry.js';
import { withQueryableTransaction, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import { assertProjectWriter } from '../access.js';
import { getVersion, versionOut } from './repository.js';
import { requireMonitoringSource } from './service.js';
import { SourceBackfillExecutionService } from '../../sources/sourceBackfillExecutionService.js';
import { SourceExtractionWorker } from '../../sources/extractionWorker.js';
import { SourceAnnotationService } from '../../sourceAnnotation/service.js';
import { PgSourceAnnotationRepository } from '../../sourceAnnotation/repository.js';
import { SourcePostProcessingService } from '../../sources/postProcessing/service.js';
import { monitoringCandidates, sharedMonitoringItemIds } from '../../sources/monitoring/candidates.js';
import type { OutboundGuard } from '../../sources/outboundUrlSafety.js';
export function registerMonitoringJob(registry: JobHandlerRegistry, config: ServerConfig) {
  if (!config.databaseUrl) return;
  registry.register('project_information_monitoring', async job => {
    await executeMonitoringOperation(getDbPool(config.databaseUrl!), config, job.space_id, String(job.payload.operation_id));
    return {
      operation_id: job.payload.operation_id
    };
  });
}
/** Domain worker composes the canonical Sources and annotation services; no second materializer or model client. */
export async function executeMonitoringOperation(db: Queryable, config: ServerConfig, spaceId: string, operationId: string, guard?: OutboundGuard) {
  const lookup = await db.query<{
    project_id: string;
    created_by_user_id: string;
    progress_json: Record<string, unknown>;
    status: string;
  }>(`SELECT project_id,created_by_user_id,progress_json,status FROM project_operations WHERE id=$1 AND space_id=$2 AND progress_json->>'purpose'='information_monitoring'`, [operationId, spaceId]);
  const op = lookup.rows[0];
  if (!op || op.status !== 'active') return;
  const identity = {
    spaceId,
    userId: op.created_by_user_id
  };
  const lock = await tryWithDedicatedSessionAdvisoryLock(db, `monitoring-run:${spaceId}:${op.project_id}`, async () => {
    const current = await db.query(`SELECT 1 FROM project_operations WHERE id=$1 AND space_id=$2 AND status='active'`, [operationId, spaceId]);
    if (!current.rows.length) return;
    let reason: string | null = null;
    try {
      await checkMonitoringPermission(() => assertProjectWriter(db, spaceId, op.project_id, identity.userId));
      const version = await getVersion(db, spaceId, op.project_id, String(op.progress_json.version_id));
      const cfg = versionOut(version).config;
      let connectorKey = 'arxiv_api';
      await checkMonitoringPermission(async () => {connectorKey = (await requireMonitoringSource(db, identity, op.project_id, version.source_channel_id, version.query_fingerprint)).connector_key;}, 'source_changed');
      if (!(await phase(db, spaceId, operationId, 'acquiring'))) return;
      const backfill = new SourceBackfillExecutionService(db, operationId);
      const plans = (op.progress_json.run_kind === 'initial' && connectorKey === 'arxiv_api') ? [version.backfill_plan_id!] : await monitoringAcquisitionPlans(db, spaceId, version.source_channel_id, version.backfill_plan_id!);
      let pages = 0;
      for (const planId of plans) {
        // Re-open due quota/transient pauses without touching the persisted window or cap.
        await db.query(`UPDATE source_backfill_plans SET status='approved',next_eligible_at=NULL WHERE id=$1 AND space_id=$2 AND status='paused' AND (next_eligible_at IS NULL OR next_eligible_at<=now())`, [planId, spaceId]);
        while (pages < cfg.batch.pages) {
          const dispatch = (await backfill.executeNext(spaceId, planId)) as {
            job_id?: string;
          } | null;
          if (!dispatch?.job_id) break;
          pages++;
          try {
            const extraction = await new SourceExtractionWorker(db, config, guard, operationId).runPendingJob(dispatch.job_id, spaceId);
            await backfill.reconcile(spaceId, planId);
            if (extraction.status !== 'succeeded') {
              const failure = await db.query<{
                error_code: string | null;
                metadata_json: Record<string, unknown>;
              }>(`SELECT error_code,metadata_json FROM extraction_jobs WHERE id=$1 AND space_id=$2`, [dispatch.job_id, spaceId]);
              const admission = failure.rows[0]?.metadata_json.monitoring_admission as {
                reason?: unknown;
              } | undefined;
              const refusal = monitoringAdmissionReason(failure.rows[0]?.error_code, admission?.reason);
              reason = refusal ? monitoringAdmissionRunReason(refusal) : 'source_failed';
              break;
            }
          } catch (error) {
            reason = error instanceof MonitoringAdmissionError ? monitoringAdmissionRunReason(error.reason) : 'source_failed';
            break;
          }
        }
        const remainingRecent = await db.query(`SELECT 1 FROM source_backfill_segments WHERE space_id=$1 AND plan_id=$2 AND status IN ('pending','running') LIMIT 1`, [spaceId, planId]);
        // A pending recent page is not a completed window; history cannot overtake it.
        if (reason && reason !== 'source_failed' || remainingRecent.rows.length) break;
      }
      if (!(await phase(db, spaceId, operationId, 'processing'))) return;
      const candidates = await monitoringCandidates(db, identity, op.project_id, version, undefined, {
        pendingOnly: true
      });
      const ids = candidates.slice(0, Math.min(cfg.batch.candidates, cfg.daily.candidates)).map(r => r.id);
      const annotation = new PgSourceAnnotationRepository(db);
      await annotation.enqueueMonitoringItems(spaceId, version.source_channel_id, ids);
      // Explicit Run now may reopen exhausted old annotations through the canonical manual retry seam.
      await annotation.requeueParked(spaceId, {
        reasons: ['budget_exhausted'],
        itemIds: ids,
        limit: ids.length
      });
      for (let offset = 0; offset < ids.length; offset += 10) {
        const batch = await sharedMonitoringItemIds(db, spaceId, op.project_id, ids.slice(offset, offset + 10));
        if (!batch.length) continue;
        const missing = await db.query<{
          source_item_id: string;
        }>(`SELECT source_item_id FROM source_item_annotations WHERE space_id=$1 AND source_item_id=ANY($2::varchar[]) AND status='pending'`, [spaceId, batch]);
        if (missing.rows.length) {
          const result = await new SourceAnnotationService(db, config).annotatePendingBatch(spaceId, {
            itemIds: missing.rows.map(r => r.source_item_id),
            agentId: cfg.agent_id,
            operationId,
            projectId: op.project_id,
            userId: identity.userId
          });
          if (result.status === 'blocked' || result.failed) reason = 'analysis_pending';
        }
        const ready = await db.query<{
          source_item_id: string;
        }>(`SELECT a.source_item_id FROM source_item_annotations a WHERE a.space_id=$1 AND a.source_item_id=ANY($2::varchar[]) AND a.status='succeeded' AND NOT EXISTS(SELECT 1 FROM source_post_processing_item_decisions d WHERE d.space_id=a.space_id AND d.source_item_id=a.source_item_id AND d.rule_id=$3)`, [spaceId, batch, version.rule_id]);
        if (ready.rows.length) {
          const result = await new SourcePostProcessingService(db, config).runRuleForItems({
            spaceId,
            ruleId: version.rule_id!,
            itemIds: ready.rows.map(r => r.source_item_id),
            monitoringOperationId: operationId
          });
          if (result?.status !== 'succeeded') reason = 'analysis_pending';
        }
      }
      const pending = await db.query(`SELECT 1 FROM unnest($2::varchar[]) selected(item_id) LEFT JOIN source_item_annotations a ON a.space_id=$1 AND a.source_item_id=selected.item_id AND a.status='succeeded' LEFT JOIN source_post_processing_item_decisions d ON d.space_id=$1 AND d.source_item_id=selected.item_id AND d.rule_id=$3 WHERE a.id IS NULL OR d.id IS NULL LIMIT 1`, [spaceId, ids, version.rule_id]);
      if ((pending.rows.length || candidates.length > ids.length) && !reason) reason = 'analysis_pending';
      const remaining = await db.query<{plan_id:string}>(`SELECT plan_id FROM source_backfill_segments WHERE space_id=$1 AND plan_id=ANY($2::varchar[]) AND (status IN ('pending','running','failed','skipped') OR window_json->>'partial'='true')`, [spaceId, plans]);
      if (remaining.rows.length && !reason) {
        const counters = await db.query<{
          progress_json: {
            used?: Record<string, number>;
          };
        }>(`SELECT progress_json FROM project_operations WHERE id=$1 AND space_id=$2`, [operationId, spaceId]);
        const used = counters.rows[0]?.progress_json.used ?? {};
        const daily = await db.query<{
          used: Record<string, number>;
        }>(`SELECT progress_json->'used' AS used FROM project_operations WHERE space_id=$1 AND project_id=$2 AND progress_json->>'purpose'='information_monitoring_budget' AND (progress_json->>'period_start')::timestamptz<=now() AND (progress_json->>'period_end')::timestamptz>now() ORDER BY created_at DESC LIMIT 1`, [spaceId, op.project_id]);
        const total = await db.query<{
          consumed: string;
        }>(`SELECT COALESCE(sum(COALESCE((window_json->>'consumed_items')::int,0)),0)::text AS consumed FROM source_backfill_segments WHERE space_id=$1 AND plan_id=$2`, [spaceId, version.backfill_plan_id]);
        reason = !remaining.rows.some(row=>row.plan_id!==version.backfill_plan_id) && Number(total.rows[0]?.consumed) >= cfg.total_candidates ? 'history_cap_reached' : (['candidates', 'pages', 'source_requests', 'model_runs'] as const).some(key => (used[key] ?? 0) >= cfg.batch[key] || (daily.rows[0]?.used[key] ?? 0) >= cfg.daily[key]) ? 'quota_paused' : 'coverage_partial';
      }
    } catch (error) {
      reason = error instanceof MonitoringAdmissionError ? monitoringAdmissionRunReason(error.reason) : 'processing_failed';
    }
    await seal(db, identity, op.project_id, operationId, reason);
  });
  if (!lock.acquired) throw new JobDeferredError('Monitoring coordinator session lock is held', 5000);
}
async function phase(db: Queryable, spaceId: string, id: string, value: string) {
  const changed = await db.query(`UPDATE project_operations SET progress_json=jsonb_set(progress_json,'{phase}',to_jsonb($3::text)),updated_at=now() WHERE id=$1 AND space_id=$2 AND status='active' RETURNING id`, [id, spaceId, value]);
  return changed.rows.length > 0;
}
async function seal(db: Queryable, identity: SpaceUserIdentity, projectId: string, operationId: string, reason: string | null) {
  await withQueryableTransaction(db, async tx => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`monitoring-delivery:${identity.spaceId}:${projectId}`]);
    const op = await tx.query<{
      progress_json: Record<string, unknown>;
      status: string;
    }>(`SELECT progress_json,status FROM project_operations WHERE id=$1 AND space_id=$2 FOR UPDATE`, [operationId, identity.spaceId]);
    if (op.rows[0]?.status !== 'active') return;
    const version = await getVersion(tx, identity.spaceId, projectId, String(op.rows[0].progress_json.version_id));
    const delivery = op.rows[0].progress_json.run_kind && op.rows[0].progress_json.run_kind !== 'initial' ? [] : await monitoringDeliveryCandidates(tx, identity.spaceId, projectId, new Date(0).toISOString(), new Date().toISOString(), versionOut(version).config.recommendation_count, version.rule_id);
    const selected = delivery.map(item => item.source_item_id);
    const coverage = await monitoringRecentCoverage(tx, identity.spaceId, version.source_channel_id);
    const finalReason = reason ?? (op.rows[0].progress_json.run_kind !== 'initial' && !['completed', 'no_new', 'current_only'].includes(coverage) ? coverage : null);
    const acquisition = await tx.query<{history_mode:string}>(`SELECT strategy_json->>'history_mode' AS history_mode FROM source_backfill_plans WHERE id=$1 AND space_id=$2`,[version.backfill_plan_id,identity.spaceId]);
    const page = await tx.query<{page_observation:string}>(`SELECT metadata_json->>'page_observation' AS page_observation FROM extraction_jobs WHERE space_id=$1 AND metadata_json->>'monitoring_operation_id'=$2 AND metadata_json ? 'page_observation' ORDER BY created_at DESC LIMIT 1`,[identity.spaceId,operationId]);
    const result = {
      coverage_scope: acquisition.rows[0]?.history_mode === 'current_snapshot' ? 'current_only' : 'bounded_history',
      page_observation: page.rows[0]?.page_observation ?? null,
      coverage: acquisition.rows[0]?.history_mode === 'current_snapshot' && coverage === 'not_run' ? reason ?? 'current_only' : coverage,
      phase: finalReason ? 'partial' : 'completed',
      reason: finalReason,
      recommendation_ids: selected,
      recommendations: delivery.map(r => ({
        id: r.source_item_id,
        ...(r.page_change ? {page_change:r.page_change,content_revision:r.content_revision} : {}),
        summary: r.summary,
        reason: r.reason,
        evidence_depth: r.evidence_depth,
        version_id: r.version_id,
        config_hash: r.config_hash
      })),
      as_of: new Date().toISOString()
    };
    await tx.query(`UPDATE project_operations SET status='completed',progress_json=progress_json||$3::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2`, [operationId, identity.spaceId, JSON.stringify(result)]);
  });
}
