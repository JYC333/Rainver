/**
 * Whether a host's heartbeat is too old to count it as online. Staleness is
 * computed at read time rather than by a background sweep (ADR 0016): a host
 * that died without closing its connection reports as offline the next time
 * anyone asks, which is what dispatch needs and costs no scheduler.
 */
export const HEARTBEAT_STALE_MS = 45_000;

export function isStale(lastHeartbeatAt: string | null): boolean {
  if (!lastHeartbeatAt) return true;
  return Date.now() - new Date(lastHeartbeatAt).getTime() > HEARTBEAT_STALE_MS;
}
