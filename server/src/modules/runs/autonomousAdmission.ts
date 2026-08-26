import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";

export type AutonomousAdmissionRefusalReason =
  | "daily_run_limit_reached"
  | "daily_cost_limit_reached"
  | "candidate_ineligible"
  | "quota_unavailable"
  | "quota_stale"
  | "quota_utilization_exceeded";

export interface AutonomousAdmissionPolicy {
  daily_run_limit: number;
  daily_cost_limit_usd: number | null;
  /** Maximum consumed subscription capacity, expressed as 0..100. */
  max_subscription_utilization_pct: number;
  quota_max_age_seconds: number;
}

export interface AutonomousQuotaSnapshot {
  runtime: string;
  credential_profile_id: string;
  available: boolean;
  /** Consumed capacity, expressed as 0..100. */
  utilization_pct: number | null;
  checked_at: string | null;
  source: "live_probe" | "run_piggyback";
}

export interface AutonomousAdmissionTrace {
  version: "autonomous_admission.v1";
  pool: {
    space_id: string;
    owner_user_id: string;
    window_start: string;
    window_end: string;
  };
  policy: AutonomousAdmissionPolicy;
  usage_before: {
    admitted_runs: number;
    estimated_cost_usd: number;
  };
  candidate_estimated_cost_usd: number;
  eligibility_reason: string | null;
  quota: AutonomousQuotaSnapshot;
  decided_at: string;
}

export type AutonomousAdmissionDecision<T> =
  | { allowed: true; reason: "admitted"; trace: AutonomousAdmissionTrace; value: T }
  | { allowed: false; reason: AutonomousAdmissionRefusalReason; trace: AutonomousAdmissionTrace };

export interface AutonomousAdmissionInput<T> {
  spaceId: string;
  ownerUserId: string;
  policy: AutonomousAdmissionPolicy;
  quota: AutonomousQuotaSnapshot;
  now?: Date;
  candidateEstimatedCostUsd?: number | null;
  recheckEligibility?: (db: Queryable) => Promise<{ eligible: boolean; reason?: string | null }>;
  /** Persists either an allowed or refused decision in the caller's audit row. */
  persistDecision?: (
    db: Queryable,
    decision: {
      allowed: boolean;
      reason: "admitted" | AutonomousAdmissionRefusalReason;
      trace: AutonomousAdmissionTrace;
    },
  ) => Promise<void>;
  /**
   * Creates the admitted Run/link and persists the decision. It executes in
   * the same transaction as the locked recheck and must use the supplied db.
   */
  create: (db: Queryable, trace: AutonomousAdmissionTrace) => Promise<T>;
}

/**
 * Serializes one Space/owner/UTC-day autonomous pool. Domain budget checks
 * belong in `create`, so their locks, the autonomous decision, and Run/link
 * creation share one commit boundary.
 */
export async function admitAutonomousRun<T>(
  db: Queryable,
  input: AutonomousAdmissionInput<T>,
): Promise<AutonomousAdmissionDecision<T>> {
  validatePolicy(input.policy);
  const now = input.now ?? new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowEnd = new Date(windowStart.getTime() + 86_400_000);
  return withQueryableTransaction(db, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`autonomous-admission:${input.spaceId}:${input.ownerUserId}:${windowStart.toISOString()}`],
    );
    const usage = await client.query<{ admitted_runs: number; estimated_cost_usd: string }>(
      `SELECT count(*)::int AS admitted_runs,
              COALESCE(sum(cost.run_cost), 0)::text AS estimated_cost_usd
         FROM runs r
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(e.estimated_cost_usd), 0)::numeric AS run_cost
             FROM token_usage_events e
            WHERE e.space_id = r.space_id
              AND (e.run_id = r.id OR e.root_run_id = r.id)
         ) cost ON true
        WHERE r.space_id = $1
          AND r.owner_user_id = $2
          AND r.trigger_origin = 'autonomous'
          AND r.run_role = 'execution'
          AND r.root_run_id IS NULL
          AND r.created_at >= $3
          AND r.created_at < $4`,
      [input.spaceId, input.ownerUserId, windowStart.toISOString(), windowEnd.toISOString()],
    );
    const eligibility = await input.recheckEligibility?.(client) ?? { eligible: true, reason: null };
    const candidateEstimatedCost = typeof input.candidateEstimatedCostUsd === "number"
      && Number.isFinite(input.candidateEstimatedCostUsd)
      && input.candidateEstimatedCostUsd >= 0
      ? input.candidateEstimatedCostUsd
      : 0;
    const trace: AutonomousAdmissionTrace = {
      version: "autonomous_admission.v1",
      pool: {
        space_id: input.spaceId,
        owner_user_id: input.ownerUserId,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
      },
      policy: input.policy,
      usage_before: {
        admitted_runs: usage.rows[0]?.admitted_runs ?? 0,
        estimated_cost_usd: Number(usage.rows[0]?.estimated_cost_usd ?? 0),
      },
      candidate_estimated_cost_usd: candidateEstimatedCost,
      eligibility_reason: eligibility.reason ?? null,
      quota: input.quota,
      decided_at: now.toISOString(),
    };
    const refusal = eligibility.eligible ? refusalReason(trace, now) : "candidate_ineligible";
    if (refusal) {
      await input.persistDecision?.(client, { allowed: false, reason: refusal, trace });
      return { allowed: false as const, reason: refusal, trace };
    }
    await input.persistDecision?.(client, { allowed: true, reason: "admitted", trace });
    const value = await input.create(client, trace);
    return { allowed: true as const, reason: "admitted" as const, trace, value };
  });
}

function refusalReason(
  trace: AutonomousAdmissionTrace,
  now: Date,
): AutonomousAdmissionRefusalReason | null {
  if (trace.usage_before.admitted_runs >= trace.policy.daily_run_limit) {
    return "daily_run_limit_reached";
  }
  if (
    trace.policy.daily_cost_limit_usd !== null
    && trace.usage_before.estimated_cost_usd + trace.candidate_estimated_cost_usd > trace.policy.daily_cost_limit_usd
  ) {
    return "daily_cost_limit_reached";
  }
  if (!trace.quota.available || trace.quota.utilization_pct === null || !trace.quota.checked_at) {
    return "quota_unavailable";
  }
  const checkedAt = Date.parse(trace.quota.checked_at);
  if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt > trace.policy.quota_max_age_seconds * 1000) {
    return "quota_stale";
  }
  if (trace.quota.utilization_pct >= trace.policy.max_subscription_utilization_pct) {
    return "quota_utilization_exceeded";
  }
  return null;
}

function validatePolicy(policy: AutonomousAdmissionPolicy): void {
  if (!Number.isInteger(policy.daily_run_limit) || policy.daily_run_limit < 1) {
    throw new Error("daily_run_limit must be a positive integer");
  }
  if (policy.daily_cost_limit_usd !== null && (!Number.isFinite(policy.daily_cost_limit_usd) || policy.daily_cost_limit_usd < 0)) {
    throw new Error("daily_cost_limit_usd must be null or a non-negative number");
  }
  if (!Number.isFinite(policy.max_subscription_utilization_pct) || policy.max_subscription_utilization_pct <= 0 || policy.max_subscription_utilization_pct > 100) {
    throw new Error("max_subscription_utilization_pct must be within (0, 100]");
  }
  if (!Number.isInteger(policy.quota_max_age_seconds) || policy.quota_max_age_seconds < 1) {
    throw new Error("quota_max_age_seconds must be a positive integer");
  }
}
