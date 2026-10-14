/**
 * How far automatic annotation retries go, and why a row is not running.
 *
 * A failed batch is retried on a bounded schedule: three initial attempts
 * (the second and third one and five minutes after a failure), then one
 * automatic recovery round of three more at thirty minutes, two hours and six
 * hours — six attempts per failure episode, after which the rows pause until
 * a person retries them. The schedule is the sweep's: a retry becomes
 * runnable at `next_retry_at` and runs on the next scheduler pass after it.
 *
 * A row waiting on a condition the space can change — no annotator Provider,
 * egress refused for its Source, consent missing — spends no attempt. The
 * sweep re-checks the condition without a model call and reopens the rows
 * when it holds again; a manual retry does the same on demand.
 */
export const ANNOTATION_INITIAL_ATTEMPTS = 3;
export const ANNOTATION_RECOVERY_ATTEMPTS = 3;
export const ANNOTATION_MAX_ATTEMPTS_PER_EPISODE = ANNOTATION_INITIAL_ATTEMPTS + ANNOTATION_RECOVERY_ATTEMPTS;

/** Delay before the next attempt, indexed by the number of attempts already spent (1 → after the first failure). */
export const ANNOTATION_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];

/** The most rows one manual retry reopens. */
export const ANNOTATION_MANUAL_RETRY_LIMIT = 500;

export type AnnotationWaitReason =
  | "retry_scheduled"
  | "provider_unavailable"
  | "egress_denied"
  | "consent_missing"
  | "budget_exhausted";

/** Reasons that wait on something outside the items; no attempt is spent while they hold. */
export const ANNOTATION_CONDITION_REASONS: readonly AnnotationWaitReason[] = [
  "provider_unavailable",
  "egress_denied",
  "consent_missing",
];

export function annotationRetryDelayMs(attemptsSpent: number): number | null {
  if (attemptsSpent >= ANNOTATION_MAX_ATTEMPTS_PER_EPISODE) return null;
  return ANNOTATION_RETRY_DELAYS_MS[attemptsSpent - 1] ?? null;
}
