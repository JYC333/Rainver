export interface FailedBackfillRow {
  plan_id: string;
  segment_id: string;
  source_channel_id: string;
  provider_key: string | null;
  provider_display_name: string | null;
  attempt_count: number;
  error_json: unknown;
}

export interface BackfillFailureSummary {
  code: "source_history_backfill_failed";
  message: string;
  diagnostics: Record<string, unknown>;
}

export interface BackfillPlanProgress {
  status: string;
  items_ingested: number | null;
  error_json: unknown;
}

export function isDeferredBackfillPlan(plan: BackfillPlanProgress): boolean {
  return plan.status === "paused"
    && record(plan.error_json).code === "source_backfill_deferred";
}

/**
 * A transiently unavailable provider must not block useful results from other
 * providers. If every plan is terminal or deferred and at least one item was
 * collected, Research may continue with an explicit coverage warning. With no
 * collected items there is nothing honest to screen, so the operation remains
 * active while the background retry cadence continues.
 */
export function backfillCanProceed(plans: BackfillPlanProgress[], expectedPlanCount: number): boolean {
  if (plans.length !== expectedPlanCount) return false;
  const allSettledOrDeferred = plans.every((plan) =>
    plan.status === "completed" || plan.status === "failed" || isDeferredBackfillPlan(plan)
  );
  if (!allSettledOrDeferred) return false;
  const hasDeferred = plans.some(isDeferredBackfillPlan);
  const itemsIngested = plans.reduce((sum, plan) => sum + Number(plan.items_ingested ?? 0), 0);
  return !hasDeferred || itemsIngested > 0;
}

/**
 * Converts Source-owned segment failures into a safe Project Research error.
 * Query text, endpoint URLs, response bodies, and credentials are deliberately
 * excluded from the operation projection.
 */
export function summarizeBackfillFailures(rows: FailedBackfillRow[]): BackfillFailureSummary {
  const failedSources = rows.map((row) => {
    const error = record(row.error_json);
    const diagnostics = record(error.diagnostics);
    return {
      provider_key: stringValue(diagnostics.provider_key) ?? row.provider_key,
      provider_display_name: stringValue(diagnostics.provider_display_name) ?? row.provider_display_name,
      upstream_status: integerValue(diagnostics.upstream_status),
      automatic_attempts: integerValue(diagnostics.attempts) ?? row.attempt_count,
      retryable: diagnostics.retryable === true,
      failure_kind: stringValue(diagnostics.failure_kind),
      plan_id: row.plan_id,
      segment_id: row.segment_id,
      source_channel_id: row.source_channel_id,
      extraction_job_id: stringValue(error.extraction_job_id),
      error_code: stringValue(error.code),
      error_message: stringValue(error.message),
    };
  });
  const providers = unique(failedSources.map((source) =>
    source.provider_display_name ?? source.provider_key ?? "source provider"
  ));
  const statuses = unique(failedSources
    .map((source) => source.upstream_status)
    .filter((value): value is number => value !== null)
    .map(String));
  const attempts = Math.max(0, ...failedSources.map((source) => source.automatic_attempts));
  const providerLabel = providers.join(", ") || "a source provider";
  const reason = statuses.length > 0
    ? ` returned HTTP ${statuses.join("/")}`
    : " could not be reached";
  const attemptLabel = attempts > 0
    ? ` after ${attempts} automatic attempt${attempts === 1 ? "" : "s"}`
    : "";
  return {
    code: "source_history_backfill_failed",
    message: `History import from ${providerLabel} failed${attemptLabel} because the provider${reason}. Completed source data was not removed.`,
    diagnostics: {
      retryable: failedSources.some((source) => source.retryable),
      failed_source_count: failedSources.length,
      failed_sources: failedSources,
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
