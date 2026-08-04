const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

/**
 * Segment attempt_count counts dispatched extraction jobs. Each job already
 * performs its own immediate transient retry, so later attempts use a bounded
 * provider-friendly delay and eventually settle into a daily repair cadence.
 */
export function nextBackfillRetryAt(attemptCount: number, now = new Date()): string {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attemptCount - 1));
  return new Date(now.getTime() + RETRY_DELAYS_MS[index]!).toISOString();
}
