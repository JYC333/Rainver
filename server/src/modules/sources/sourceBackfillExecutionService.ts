import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { HttpError, objectValue, withQueryableTransaction } from "../routeUtils/common.js";
import { consumeConnectionQuota } from "./sourceQuotaBucket.js";
import { nextBackfillRetryAt } from "./sourceBackfillRetry.js";

interface PlanRow {
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

    const remainingBudget = await this.remainingBudgetLocked(spaceId, plan, segment);
    if (remainingBudget <= 0) {
      await this.db.query(
        `UPDATE source_backfill_segments SET status='skipped'
          WHERE plan_id=$1 AND space_id=$2 AND status='pending'`,
        [planId, spaceId],
      );
      await this.finishIfDone(spaceId, planId);
      return null;
    }
    const window = objectValue(segment.window_json);
    const scheduledWindow = {
      ...window,
      max_items: remainingBudget,
      remaining_items: remainingBudget,
      page_size: Math.min(100, remainingBudget),
      partial: false,
      exhausted: false,
    };
    await this.db.query(
      `UPDATE source_backfill_segments SET window_json=$3::jsonb WHERE id=$1 AND space_id=$2 AND status='pending'`,
      [segment.id, spaceId, JSON.stringify(scheduledWindow)],
    );

    const now = new Date().toISOString();
    const channel = await this.db.query<{ source_connection_id: string }>(
      `SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2 AND status <> 'archived'`,
      [plan.source_channel_id, spaceId],
    );
    if (!channel.rows[0]) throw new Error("Source channel not found for backfill plan");
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
   * Project Research owns the total budget on the operation row. Locking that
   * row serializes reservations across sibling monitor plans while the source
   * plan counters provide the settled usage and running segment windows provide
   * the in-flight reservation. Standalone Source plans keep their own budget
   * in strategy_json.
   */
  private async remainingBudgetLocked(spaceId: string, plan: PlanRow, segment: SegmentRow): Promise<number> {
    if (plan.project_operation_kind !== "research") {
      const configuredMax = integerValue(objectValue(plan.strategy_json).max_items) ?? integerValue(objectValue(segment.window_json).max_items) ?? 100;
      return configuredMax - Number(plan.items_ingested ?? 0);
    }
    const total = integerValue(plan.operation_max_items);
    if (!total || total < 1) throw new HttpError(409, "Project Research operation has no valid item budget");
    const settled = await this.db.query<{ settled: string | null }>(
      `SELECT COALESCE(SUM(items_ingested),0)::int AS settled
         FROM source_backfill_plans
        WHERE project_operation_id=$1 AND space_id=$2`,
      [plan.project_operation_id, spaceId],
    );
    const reserved = await this.db.query<{ reserved: string | null }>(
      `SELECT COALESCE(SUM(COALESCE(NULLIF(s.window_json->>'page_size','0')::int,0)),0) AS reserved
         FROM source_backfill_segments s
         JOIN source_backfill_plans p ON p.id=s.plan_id AND p.space_id=s.space_id
        WHERE p.project_operation_id=$1 AND p.space_id=$2 AND s.status='running'`,
      [plan.project_operation_id, spaceId],
    );
    return total - Number(settled.rows[0]?.settled ?? 0) - Number(reserved.rows[0]?.reserved ?? 0);
  }

  private async reconcileLocked(spaceId: string, planId: string) {
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
    const nextWindow = {
      ...window,
      max_items: additionalItems,
      remaining_items: additionalItems,
      page_size: Math.min(100, additionalItems),
      partial: false,
      exhausted: false,
      has_more: true,
      next_cursor: window.cursor ?? null,
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
   * Raises a plan's item budget (e.g. after a Source Monitor's search query
   * was fixed following a zero-result run), independent of the
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

function integerValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
