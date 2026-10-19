import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError, objectValue, withQueryableTransaction } from "../routeUtils/common.js";
import { consumeConnectionQuota } from "./sourceQuotaBucket.js";
import { sourceConnectorRegistry } from "./catalog/sourceConnectorRegistry.js";
import { nextBackfillRetryAt } from "./sourceBackfillRetry.js";

interface PlanRow {
  id: string;
  status: string;
  source_channel_id: string;
  quota_policy_json: { window?: unknown; limit_count?: unknown };
  strategy_json: unknown;
  items_ingested: number | null;
  project_operation_id: string | null;
  project_operation_kind: string | null;
  operation_max_items: number | null;
}

interface SegmentRow {
  id: string;
  window_json: unknown;
}

interface ReconcileJobRow {
  segment_id: string;
  extraction_job_id: string;
  window_json: unknown;
  status: string;
  items_created: number | null;
  items_updated: number | null;
  error_code: string | null;
  error_message: string | null;
  metadata_json: unknown;
  attempt_count: number;
}

export class SourceBackfillExecutionService {
  constructor(private readonly db: Queryable) {}

  async start(spaceId: string, planId: string, proposalId: string, strategy: unknown, quota: unknown) {
    return withQueryableTransaction(this.db, (db) =>
      new SourceBackfillExecutionService(db).startLocked(spaceId, planId, proposalId, strategy, quota),
    );
  }

  /**
   * Start a plan from an explicit user-owned Project Research operation.
   *
   * Generic Source and agent-triggered plans remain proposal-gated through
   * start(). Project Research has already collected the user's history scope,
   * item cap, and start intent in the same request, so it records that intent
   * on the operation/plan and starts directly without creating a second review
   * prompt.
   */
  async startUserAuthorized(spaceId: string, planId: string, projectOperationId: string, userId: string) {
    return withQueryableTransaction(this.db, (db) =>
      new SourceBackfillExecutionService(db).startUserAuthorizedLocked(spaceId, planId, projectOperationId, userId),
    );
  }

  async executeNext(spaceId: string, planId: string) {
    return withQueryableTransaction(this.db, (db) => new SourceBackfillExecutionService(db).executeNextLocked(spaceId, planId));
  }

  async reconcile(spaceId: string, planId: string) {
    return withQueryableTransaction(this.db, (db) => new SourceBackfillExecutionService(db).reconcileLocked(spaceId, planId));
  }

  async retry(spaceId: string, planId: string) {
    return withQueryableTransaction(this.db, (db) => new SourceBackfillExecutionService(db).retryLocked(spaceId, planId));
  }

  async continuePartial(spaceId: string, planId: string, additionalItems: number) {
    return withQueryableTransaction(this.db, (db) => new SourceBackfillExecutionService(db).continuePartialLocked(spaceId, planId, additionalItems));
  }

  async rescanZeroYield(spaceId: string, planId: string, additionalItems: number) {
    return withQueryableTransaction(this.db, (db) => new SourceBackfillExecutionService(db).rescanZeroYieldLocked(spaceId, planId, additionalItems));
  }

  private async startLocked(spaceId: string, planId: string, proposalId: string, strategy: unknown, quota: unknown) {
    // Every path takes the research operation before the plan (see
    // lockResearchOperationForPlan); taking the plan first could deadlock.
    await this.lockResearchOperationForPlan(spaceId, planId);
    const updated = await this.db.query<{ id: string }>(
      `UPDATE source_backfill_plans
          SET status='approved', updated_at=$4
        WHERE id=$1 AND space_id=$2 AND proposal_id=$3 AND status='proposed'
          AND strategy_json=$5::jsonb AND quota_policy_json=$6::jsonb
        RETURNING id`,
      [planId, spaceId, proposalId, new Date().toISOString(), JSON.stringify(strategy), JSON.stringify(quota)],
    );
    if (!updated.rows[0]) throw new Error("Backfill plan is stale or does not match its proposal");
    return this.executeNextLocked(spaceId, planId);
  }

  private async startUserAuthorizedLocked(spaceId: string, planId: string, projectOperationId: string, userId: string) {
    await this.db.query(
      `SELECT id FROM project_operations
        WHERE id=$1 AND space_id=$2 AND kind='research'
        FOR UPDATE`,
      [projectOperationId, spaceId],
    );
    const plan = await this.db.query<{ status: string }>(
      `SELECT status FROM source_backfill_plans
        WHERE id=$1 AND space_id=$2 AND project_operation_id=$3 AND requested_by_user_id=$4
        FOR UPDATE`,
      [planId, spaceId, projectOperationId, userId],
    );
    const current = plan.rows[0];
    if (!current) throw new HttpError(403, "Project Research backfill plan is not owned by the requesting user");
    if (current.status === "draft") {
      await this.db.query(
        `UPDATE source_backfill_plans
            SET status='approved', proposal_id=NULL, error_json=NULL, next_eligible_at=NULL, updated_at=now()
          WHERE id=$1 AND space_id=$2 AND project_operation_id=$3 AND requested_by_user_id=$4 AND status='draft'`,
        [planId, spaceId, projectOperationId, userId],
      );
    } else if (!["approved", "running", "paused", "completed"].includes(current.status)) {
      throw new HttpError(409, `Project Research backfill plan cannot start from status ${current.status}`);
    }
    return this.executeNextLocked(spaceId, planId);
  }

  private async executeNextLocked(spaceId: string, planId: string) {
    await this.lockResearchOperationForPlan(spaceId, planId);
    const planResult = await this.db.query<PlanRow>(
      `SELECT p.*, o.kind AS project_operation_kind,
              (o.progress_json->'history'->>'max_items')::int AS operation_max_items
         FROM source_backfill_plans p
         LEFT JOIN project_operations o ON o.id=p.project_operation_id AND o.space_id=p.space_id
        WHERE p.id=$1 AND p.space_id=$2
        FOR UPDATE OF p`,
      [planId, spaceId],
    );
    const plan = planResult.rows[0];
    if (!plan || !["approved", "running"].includes(plan.status)) return null;

    const segmentResult = await this.db.query<SegmentRow>(
      `SELECT * FROM source_backfill_segments
        WHERE plan_id=$1 AND space_id=$2 AND status='pending' AND (next_eligible_at IS NULL OR next_eligible_at<=now())
        ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [planId, spaceId],
    );
    const segment = segmentResult.rows[0];
    if (!segment) {
      await this.finishIfDone(spaceId, planId);
      return null;
    }

    const { remaining: remainingBudget, unsettled } = await this.remainingBudgetLocked(spaceId, plan, segment);
    // A sibling's in-flight page holds budget it may not use. Wait for it to
    // settle rather than skipping this plan's remaining history for good.
    if (remainingBudget <= 0 && unsettled > 0) return null;
    if (remainingBudget <= 0) {
      await this.db.query(
        `UPDATE source_backfill_segments SET status='skipped'
          WHERE plan_id=$1 AND space_id=$2 AND status='pending'`,
        [planId, spaceId],
      );
      await this.finishIfDone(spaceId, planId);
      return null;
    }
    const channel = await this.db.query<{ source_connection_id: string; connector_key: string }>(
      `SELECT ch.source_connection_id, c.connector_key
         FROM source_channels ch
         JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id
         JOIN source_provider_connectors spc ON spc.id=sc.provider_connector_id
         JOIN source_connectors c ON c.id=spc.connector_id
        WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status <> 'archived'`,
      [plan.source_channel_id, spaceId],
    );
    if (!channel.rows[0]) throw new Error("Source channel not found for backfill plan");
    const window = objectValue(segment.window_json);
    const scheduledWindow = {
      ...window,
      max_items: remainingBudget,
      remaining_items: remainingBudget,
      page_size: resumedPageSize(window, channel.rows[0].connector_key) ?? Math.min(100, remainingBudget),
      partial: false,
      exhausted: false,
    };
    await this.db.query(
      `UPDATE source_backfill_segments SET window_json=$3::jsonb WHERE id=$1 AND space_id=$2 AND status='pending'`,
      [segment.id, spaceId, JSON.stringify(scheduledWindow)],
    );

    const now = new Date().toISOString();
    const quota = await consumeConnectionQuota(this.db, spaceId, channel.rows[0].source_connection_id, plan.quota_policy_json);
    if (!quota.allowed) {
      await this.db.query(
        `UPDATE source_backfill_segments SET next_eligible_at=$3 WHERE id=$1 AND space_id=$2 AND status='pending'`,
        [segment.id, spaceId, quota.resetAt],
      );
      await this.db.query(
        `UPDATE source_backfill_plans SET status='paused', next_eligible_at=$3, updated_at=$4 WHERE id=$1 AND space_id=$2`,
        [planId, spaceId, quota.resetAt, new Date().toISOString()],
      );
      return { paused: true, next_eligible_at: quota.resetAt };
    }

    const jobId = randomUUID();
    await this.db.query(
      `INSERT INTO extraction_jobs (id, space_id, connection_id, job_type, status, metadata_json, created_at)
       VALUES ($1,$2,$3,'connection_scan','pending',$4::jsonb,$5)`,
      [jobId, spaceId, channel.rows[0].source_connection_id, JSON.stringify({ source_channel_id: plan.source_channel_id, source_backfill_plan_id: planId, source_backfill_segment_id: segment.id, window: scheduledWindow }), now],
    );
    await this.db.query(
      `UPDATE source_backfill_segments SET status='running', next_eligible_at=NULL, attempt_count=attempt_count+1, extraction_job_id=$3 WHERE id=$1 AND space_id=$2`,
      [segment.id, spaceId, jobId],
    );
    await this.db.query(`UPDATE source_backfill_plans SET status='running', updated_at=$3 WHERE id=$1 AND space_id=$2`, [planId, spaceId, now]);
    return { job_id: jobId, segment_id: segment.id };
  }

  /**
   * `remaining` is what may be dispatched now; `unsettled` is the part of the
   * budget held only by in-flight reservations, which may yet come back.
   */
  private async remainingBudgetLocked(spaceId: string, plan: PlanRow, segment: SegmentRow): Promise<{ remaining: number; unsettled: number }> {
    const usage = await this.budgetUsageLocked(spaceId, plan, segment.id);
    const settledRemaining = usage.total - usage.settled;
    return {
      remaining: settledRemaining - usage.reserved,
      unsettled: Math.max(0, Math.min(settledRemaining, usage.reserved)),
    };
  }

  /**
   * How many items a running segment's next history page may take, decided
   * under the same lock as dispatch: what is left of the shared budget after
   * every segment's imported items and every other in-flight page. Called by
   * the extraction worker, inside its transaction, after it wrote the page's
   * consumed items onto the segment window and before it queues the page.
   */
  async continuationAllowanceLocked(spaceId: string, planId: string, segmentId: string): Promise<number> {
    const plan = await this.db.query<PlanRow>(
      `SELECT p.*, o.kind AS project_operation_kind,
              (o.progress_json->'history'->>'max_items')::int AS operation_max_items
         FROM source_backfill_plans p
         LEFT JOIN project_operations o ON o.id=p.project_operation_id AND o.space_id=p.space_id
        WHERE p.id=$1 AND p.space_id=$2
        FOR UPDATE OF p`,
      [planId, spaceId],
    );
    if (!plan.rows[0]) return 0;
    const usage = await this.budgetUsageLocked(spaceId, plan.rows[0], segmentId);
    return Math.max(0, usage.total - usage.settled - usage.reserved);
  }

  /**
   * Budget accounting for dispatch and for each continuation page. Project
   * Research owns one total on the operation row, shared by sibling monitor
   * plans; a standalone Source plan owns its own in strategy_json. Settled
   * usage counts every segment's imported items, including the pages a
   * still-running segment has already read (`consumed_items`), and never less
   * than the plan's recorded counter. Each other running segment reserves its
   * current page, at most what its window still allows. The caller holds the
   * operation lock (Project Research) or the plan row lock (standalone), so
   * reservations are serialized.
   */
  private async budgetUsageLocked(
    spaceId: string,
    plan: PlanRow,
    excludeSegmentId: string,
  ): Promise<{ total: number; settled: number; reserved: number }> {
    const research = plan.project_operation_kind === "research";
    let total: number;
    if (research) {
      const operationTotal = integerValue(plan.operation_max_items);
      if (!operationTotal || operationTotal < 1) throw new HttpError(409, "Project Research operation has no valid item budget");
      total = operationTotal;
    } else {
      const segment = await this.db.query<{ window_json: unknown }>(
        `SELECT window_json FROM source_backfill_segments WHERE id=$1 AND space_id=$2`,
        [excludeSegmentId, spaceId],
      );
      total = integerValue(objectValue(plan.strategy_json).max_items)
        ?? integerValue(objectValue(segment.rows[0]?.window_json).max_items)
        ?? 100;
    }
    const usage = await this.db.query<{ settled: number; reserved: number }>(
      `SELECT COALESCE(SUM(GREATEST(COALESCE(p.items_ingested,0), COALESCE(seg.consumed,0))),0)::int AS settled,
              COALESCE(SUM(seg.reserved),0)::int AS reserved
         FROM source_backfill_plans p
         LEFT JOIN LATERAL (
           SELECT SUM(GREATEST(s.items_ingested, COALESCE((s.window_json->>'consumed_items')::int,0))) AS consumed,
                  SUM(CASE
                        WHEN s.status='running' AND s.id<>$3
                         AND COALESCE(s.window_json->>'partial','false')<>'true'
                         AND COALESCE(s.window_json->>'exhausted','false')<>'true'
                        THEN LEAST(
                          COALESCE(NULLIF(s.window_json->>'page_size','0')::int,0),
                          COALESCE((s.window_json->>'remaining_items')::int, NULLIF(s.window_json->>'page_size','0')::int, 0))
                        ELSE 0
                      END) AS reserved
             FROM source_backfill_segments s
            WHERE s.plan_id=p.id AND s.space_id=p.space_id
         ) seg ON true
        WHERE p.space_id=$1 AND ${research ? "p.project_operation_id=$2" : "p.id=$2"}`,
      [spaceId, research ? plan.project_operation_id : plan.id, excludeSegmentId],
    );
    return { total, settled: Number(usage.rows[0]?.settled ?? 0), reserved: Number(usage.rows[0]?.reserved ?? 0) };
  }

  private async reconcileLocked(spaceId: string, planId: string) {
    // Operation, then segments, then plan: the order a page continuation
    // takes (extractionWorker.queueBackfillContinuationIfNeeded). Settling
    // segments and counters first and the operation last would deadlock
    // against a continuation finishing at the same time.
    await this.lockResearchOperationForPlan(spaceId, planId);
    const rows = await this.db.query<ReconcileJobRow>(
      `SELECT s.id AS segment_id, j.id AS extraction_job_id, s.window_json, s.attempt_count,
              j.status, j.items_created, j.items_updated,
              j.error_code, j.error_message, j.metadata_json
         FROM source_backfill_segments s JOIN extraction_jobs j ON j.id=s.extraction_job_id
        WHERE s.plan_id=$1 AND s.space_id=$2 AND s.status='running'`,
      [planId, spaceId],
    );
    const deferredRetries: Array<{ at: string; error: Record<string, unknown> }> = [];
    for (const row of rows.rows) {
      if (row.status === "succeeded") {
        const itemsIngested = Number(row.items_created ?? 0) + Number(row.items_updated ?? 0);
        const window = row.window_json && typeof row.window_json === "object" && !Array.isArray(row.window_json)
          ? row.window_json as Record<string, unknown>
          : {};
        const cumulative = Number.isInteger(Number(window.consumed_items)) ? Number(window.consumed_items) : itemsIngested;
        await this.db.query(`UPDATE source_backfill_segments SET status='succeeded', items_ingested=$3 WHERE id=$1 AND space_id=$2`, [row.segment_id, spaceId, cumulative]);
      } else if (row.status === "failed") {
        const failureDiagnostics = objectValue(objectValue(row.metadata_json).failure_diagnostics);
        const errorJson = {
          code: row.error_code,
          message: row.error_message,
          extraction_job_id: row.extraction_job_id,
          ...(Object.keys(failureDiagnostics).length > 0 ? { diagnostics: failureDiagnostics } : {}),
        };
        if (failureDiagnostics.retryable === true) {
          const nextRetryAt = nextBackfillRetryAt(Number(row.attempt_count ?? 1));
          const deferredError = { ...errorJson, deferred_retry: true, next_retry_at: nextRetryAt };
          deferredRetries.push({ at: nextRetryAt, error: deferredError });
          await this.db.query(
            `UPDATE source_backfill_segments
                SET status='pending', extraction_job_id=NULL, next_eligible_at=$3, error_json=$4::jsonb
              WHERE id=$1 AND space_id=$2`,
            [row.segment_id, spaceId, nextRetryAt, JSON.stringify(deferredError)],
          );
        } else {
          await this.db.query(
            `UPDATE source_backfill_segments SET status='failed', error_json=$3::jsonb WHERE id=$1 AND space_id=$2`,
            [row.segment_id, spaceId, JSON.stringify(errorJson)],
          );
        }
      }
    }
    await this.refreshCounters(spaceId, planId);
    if (deferredRetries.length > 0) {
      const nextRetry = deferredRetries.map((retry) => retry.at).sort()[0]!;
      await this.db.query(
        `UPDATE source_backfill_plans
            SET status='paused', next_eligible_at=$3, error_json=$4::jsonb, updated_at=now()
          WHERE id=$1 AND space_id=$2`,
        [planId, spaceId, nextRetry, JSON.stringify({
          code: "source_backfill_deferred",
          message: "A transient source failure is scheduled for background retry.",
          next_retry_at: nextRetry,
          diagnostics: objectValue(deferredRetries[0]!.error.diagnostics),
        })],
      );
    }
    return this.executeNextLocked(spaceId, planId);
  }

  private async retryLocked(spaceId: string, planId: string) {
    await this.lockResearchOperationForPlan(spaceId, planId);
    const planResult = await this.db.query<{ status: string }>(
      `SELECT status FROM source_backfill_plans WHERE id=$1 AND space_id=$2 FOR UPDATE`,
      [planId, spaceId],
    );
    const plan = planResult.rows[0];
    if (!plan) throw new Error("Source backfill plan not found");
    if (plan.status !== "failed") throw new Error("Only failed source backfill plans can be retried");

    await this.db.query(
      `UPDATE source_backfill_segments
          SET status='pending', extraction_job_id=NULL, next_eligible_at=NULL, error_json=NULL
        WHERE plan_id=$1 AND space_id=$2 AND status='failed'`,
      [planId, spaceId],
    );
    await this.db.query(
      `UPDATE source_backfill_plans
          SET status='approved', next_eligible_at=NULL, error_json=NULL, updated_at=now()
        WHERE id=$1 AND space_id=$2`,
      [planId, spaceId],
    );
    return this.executeNextLocked(spaceId, planId);
  }

  private async continuePartialLocked(spaceId: string, planId: string, additionalItems: number) {
    await this.lockResearchOperationForPlan(spaceId, planId);
    const planResult = await this.db.query<{ status: string; strategy_json: unknown; items_ingested: number | null; project_operation_id: string | null; project_operation_kind: string | null }>(
      `SELECT p.status, p.strategy_json, p.items_ingested, p.project_operation_id, o.kind AS project_operation_kind
         FROM source_backfill_plans p
         LEFT JOIN project_operations o ON o.id=p.project_operation_id AND o.space_id=p.space_id
        WHERE p.id=$1 AND p.space_id=$2
        FOR UPDATE OF p`,
      [planId, spaceId],
    );
    const plan = planResult.rows[0];
    if (!plan) throw new Error("Source backfill plan not found");
    if (plan.status !== "completed") throw new Error("Only completed partial source backfills can be continued");

    const segmentResult = await this.db.query<{ id: string; seq: number; window_json: unknown }>(
      `SELECT id, seq, window_json
         FROM source_backfill_segments
        WHERE plan_id=$1 AND space_id=$2 AND status='succeeded'
          AND window_json->>'partial'='true'
          AND COALESCE(window_json->>'exhausted','false') <> 'true'
        ORDER BY seq
        LIMIT 1
        FOR UPDATE`,
      [planId, spaceId],
    );
    const segment = segmentResult.rows[0];
    if (!segment) throw new Error("Source backfill has no resumable partial segment");
    const window = segment.window_json && typeof segment.window_json === "object" && !Array.isArray(segment.window_json)
      ? segment.window_json as Record<string, unknown>
      : {};
    // The partial window still describes the last page imported; resume at
    // the page after it, which the worker recorded as `next_cursor`, from the
    // item the segment reached.
    const cursor = (window.next_cursor == null ? null : integerValue(window.next_cursor))
      ?? (window.cursor == null ? 0 : integerValue(window.cursor) ?? 0) + 1;
    const consumedItems = window.consumed_items == null ? null : integerValue(window.consumed_items);
    const nextWindow = {
      ...window,
      cursor,
      ...(consumedItems !== null ? { offset: consumedItems } : {}),
      max_items: additionalItems,
      remaining_items: additionalItems,
      page_size: Math.min(100, additionalItems),
      partial: false,
      exhausted: false,
      has_more: true,
      next_cursor: cursor,
    };
    const currentMax = integerValue(objectValue(plan.strategy_json).max_items) ?? Number(plan.items_ingested ?? 0);
    if (plan.project_operation_kind === "research") {
      await this.db.query(
        `UPDATE source_backfill_plans
            SET status='approved', next_eligible_at=NULL, error_json=NULL, updated_at=now()
          WHERE id=$1 AND space_id=$2`,
        [planId, spaceId],
      );
    } else {
      await this.db.query(
        `UPDATE source_backfill_plans
            SET strategy_json=jsonb_set(COALESCE(strategy_json,'{}'::jsonb),'{max_items}',to_jsonb($3::int),true),
                status='approved', next_eligible_at=NULL, error_json=NULL, updated_at=now()
          WHERE id=$1 AND space_id=$2`,
        [planId, spaceId, currentMax + additionalItems],
      );
    }
    await this.db.query(
      `UPDATE source_backfill_segments
          SET status='pending', extraction_job_id=NULL, next_eligible_at=NULL,
              window_json=$3::jsonb, error_json=NULL
        WHERE id=$1 AND space_id=$2`,
      [segment.id, spaceId, JSON.stringify(nextWindow)],
    );
    await this.db.query(
      `UPDATE source_backfill_segments
          SET status='pending', extraction_job_id=NULL, next_eligible_at=NULL, error_json=NULL
        WHERE plan_id=$1 AND space_id=$2 AND seq>$3 AND status='skipped'`,
      [planId, spaceId, segment.seq],
    );
    return this.executeNextLocked(spaceId, planId);
  }

  /**
   * Raises a plan's item budget (for example after a Source Monitor search
   * query is corrected following a zero-result run), independent of the
   * budget-exhaustion recovery `continuePartial` handles. For a plan that's
   * still in progress ('approved'/'running'), this only raises the stored
   * budget — the plan's own dispatch loop picks up the new number next time
   * it schedules a segment, so no reset is needed. For a plan that already
   * finished ('completed'), zero-yield settled segments go back to 'pending'
   * so the connector rebuilds their request from the channel's current
   * (corrected) query when they re-run; segments that already ingested items
   * are left alone.
   */
  private async rescanZeroYieldLocked(spaceId: string, planId: string, additionalItems: number) {
    await this.lockResearchOperationForPlan(spaceId, planId);
    const planResult = await this.db.query<{ status: string; strategy_json: unknown; project_operation_id: string | null; project_operation_kind: string | null }>(
      `SELECT p.status, p.strategy_json, p.project_operation_id, o.kind AS project_operation_kind
         FROM source_backfill_plans p
         LEFT JOIN project_operations o ON o.id=p.project_operation_id AND o.space_id=p.space_id
        WHERE p.id=$1 AND p.space_id=$2
        FOR UPDATE OF p`,
      [planId, spaceId],
    );
    const plan = planResult.rows[0];
    if (!plan) throw new Error("Source backfill plan not found");
    if (!["approved", "running", "completed"].includes(plan.status)) {
      throw new Error(`Cannot adjust the item budget for a source backfill plan in status ${plan.status}`);
    }

    if (plan.project_operation_kind === "research" && additionalItems > 0) {
      throw new HttpError(409, "Project Research item limits are owned by the operation");
    }
    const currentMax = integerValue(objectValue(plan.strategy_json).max_items) ?? 0;
    if (plan.project_operation_kind === "research") {
      await this.db.query(
        `UPDATE source_backfill_plans
            SET status=CASE WHEN status='completed' THEN 'approved' ELSE status END,
                next_eligible_at=NULL, error_json=NULL, updated_at=now()
          WHERE id=$1 AND space_id=$2`,
        [planId, spaceId],
      );
    } else {
      await this.db.query(
        `UPDATE source_backfill_plans
            SET strategy_json=jsonb_set(COALESCE(strategy_json,'{}'::jsonb),'{max_items}',to_jsonb($3::int),true),
                status=CASE WHEN status='completed' THEN 'approved' ELSE status END,
                next_eligible_at=NULL, error_json=NULL, updated_at=now()
          WHERE id=$1 AND space_id=$2`,
        [planId, spaceId, currentMax + additionalItems],
      );
    }
    if (plan.status !== "completed") return null;
    await this.db.query(
      `UPDATE source_backfill_segments
          SET status='pending', extraction_job_id=NULL, next_eligible_at=NULL, error_json=NULL
        WHERE plan_id=$1 AND space_id=$2 AND items_ingested=0 AND status IN ('succeeded','skipped')`,
      [planId, spaceId],
    );
    return this.executeNextLocked(spaceId, planId);
  }

  private async refreshCounters(spaceId: string, planId: string): Promise<void> {
    await this.db.query(
      `UPDATE source_backfill_plans p
          SET segments_completed = x.done, segments_failed = x.failed, items_ingested = x.items, updated_at = now()
         FROM (SELECT count(*) FILTER (WHERE status='succeeded')::int done,
                      count(*) FILTER (WHERE status='failed')::int failed,
                      coalesce(sum(items_ingested), 0)::int items
                 FROM source_backfill_segments
                WHERE plan_id=$1 AND space_id=$2) x
        WHERE p.id=$1 AND p.space_id=$2`,
      [planId, spaceId],
    );
  }

  private async finishIfDone(spaceId: string, planId: string): Promise<void> {
    await this.refreshCounters(spaceId, planId);
    await this.db.query(
      `UPDATE source_backfill_plans
          SET status = CASE WHEN segments_failed>0 THEN 'failed' ELSE 'completed' END, updated_at = now()
        WHERE id=$1 AND space_id=$2
          AND NOT EXISTS(SELECT 1 FROM source_backfill_segments WHERE plan_id=$1 AND space_id=$2 AND status IN ('pending','running'))`,
      [planId, spaceId],
    );
  }

  /** The lock dispatch takes; a continuation takes it first, inside its own transaction. */
  async lockBudgetForPlan(spaceId: string, planId: string): Promise<void> {
    await this.lockResearchOperationForPlan(spaceId, planId);
  }

  /**
   * The first lock of every plan mutation. A plan inside a research
   * operation shares that operation's item budget with its siblings, so the
   * operation row serializes them; it is always taken before any segment or
   * plan row, so two paths can never wait on each other.
   */
  private async lockResearchOperationForPlan(spaceId: string, planId: string): Promise<void> {
    const scope = await this.db.query<{ project_operation_id: string | null; project_operation_kind: string | null }>(
      `SELECT p.project_operation_id, o.kind AS project_operation_kind
         FROM source_backfill_plans p
         LEFT JOIN project_operations o ON o.id=p.project_operation_id AND o.space_id=p.space_id
        WHERE p.id=$1 AND p.space_id=$2`,
      [planId, spaceId],
    );
    const operationId = scope.rows[0]?.project_operation_id;
    if (!operationId || scope.rows[0]?.project_operation_kind !== "research") return;
    await this.db.query(
      `SELECT id FROM project_operations
        WHERE id=$1 AND space_id=$2 AND kind='research'
        FOR UPDATE`,
      [operationId, spaceId],
    );
  }
}

/**
 * A page-numbered connector (OpenAlex) resuming a segment past its first page
 * must keep the page width it started with: the same page number at another
 * width is a different slice. The remaining budget then caps the items kept.
 */
function resumedPageSize(window: Record<string, unknown>, connectorKey: string): number | null {
  const cursor = window.cursor == null ? 0 : integerValue(window.cursor) ?? 0;
  const pageSize = window.page_size == null ? null : integerValue(window.page_size);
  if (cursor < 1 || pageSize === null || pageSize < 1) return null;
  let narrowable: boolean;
  try {
    narrowable = sourceConnectorRegistry.get(connectorKey).getCapabilities().supports_page_size_narrowing;
  } catch {
    return null;
  }
  return narrowable ? null : Math.min(100, pageSize);
}

function integerValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
