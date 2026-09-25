/**
 * One execution lease per WorkspaceLocation, for Runs that may write it.
 *
 * Two writers in one checkout would each capture the other's edits in their
 * diff, race each other's commits, and see files change under them mid-turn.
 * So a writer holds every Location it may write — its Primary and each
 * attachment granted `write` — from launch until its diff is captured, and
 * the next writer waits in arrival order. Nothing else waits: a read-only
 * Run, a Run in a managed workspace, and a Task Run in a worktree of its own
 * take no lease on those (hosts.md, "Location lease").
 *
 * A Task worktree has a lease of its own under a key that is not a Location
 * id (`taskLeaseKey`): its Runs take it like any writer, so a second launch of
 * the Task queues, and its settle, branch delete and sweep take it without
 * waiting (`tryAcquireLease`) and refuse or skip while anyone holds or awaits it.
 *
 * Several leases are always taken in sorted Location-id order, so two Runs
 * that each need two Locations cannot each hold one and wait for the other.
 * Locations are keyed by id, not by path: two Locations registered at the
 * same directory, or one nested inside another, are not serialized against
 * each other (deferred register).
 *
 * In-process state for this daemon's lifetime, keyed like `activeRuns`: a
 * lease outlives a WebSocket reconnect along with the Run that holds it.
 * Holders and waiters are launch attempts: a supervisor retry reuses the run
 * id, and one attempt's release or cancellation must not touch another's.
 */

interface Waiter {
  launchId: string;
  grant: () => void;
}

interface LocationLease {
  launchId: string;
  queue: Waiter[];
}

interface Attempt {
  runId: string;
  launchId: string;
  /** Every lease this attempt asks for, held or not yet. */
  ids: readonly string[];
  cancelled: boolean;
  /** Takes this attempt out of whichever queue it is in, when it is in one. */
  cancelWait: (() => void) | null;
}

const leases = new Map<string, LocationLease>();
/** Attempts between asking for their leases and holding all of them, by launch id. */
const acquiring = new Map<string, Attempt>();

/** What `acquireLocationLeases` answers: every lease is held, or the wait was cancelled and none is. */
export type LeaseOutcome = "acquired" | "cancelled";

/**
 * Takes every named Location's lease for one launch attempt, waiting in each
 * queue in turn. `onQueued` fires at most once, the first time the attempt
 * has to wait — the caller tells the control plane, so a person sees "waiting
 * for the directory" rather than a turn that silently does nothing.
 */
export async function acquireLocationLeases(
  locationIds: readonly string[],
  attempt: { runId: string; launchId: string },
  onQueued: () => void,
): Promise<LeaseOutcome> {
  const ids = [...new Set(locationIds)].sort();
  const state: Attempt = { ...attempt, ids, cancelled: false, cancelWait: null };
  acquiring.set(attempt.launchId, state);
  const held: string[] = [];
  let notified = false;
  const queued = () => {
    if (notified) return;
    notified = true;
    onQueued();
  };
  try {
    for (const id of ids) {
      if (state.cancelled) break;
      if ((await acquireOne(id, state, queued)) === "cancelled") break;
      held.push(id);
    }
    if (state.cancelled || held.length !== ids.length) {
      releaseLocationLeases(held, attempt.launchId);
      return "cancelled";
    }
    return "acquired";
  } finally {
    acquiring.delete(attempt.launchId);
  }
}

function acquireOne(locationId: string, state: Attempt, onQueued: () => void): Promise<LeaseOutcome> {
  const lease = leases.get(locationId);
  if (!lease) {
    leases.set(locationId, { launchId: state.launchId, queue: [] });
    return Promise.resolve("acquired");
  }
  return new Promise<LeaseOutcome>((resolve) => {
    const waiter: Waiter = {
      launchId: state.launchId,
      grant: () => {
        state.cancelWait = null;
        resolve("acquired");
      },
    };
    lease.queue.push(waiter);
    state.cancelWait = () => {
      const index = lease.queue.indexOf(waiter);
      if (index >= 0) lease.queue.splice(index, 1);
      state.cancelWait = null;
      resolve("cancelled");
    };
    onQueued();
  });
}

/**
 * Takes one lease only if nobody holds it, for work that must not wait behind
 * a Run and must not run beside one (a Task worktree's settle, delete and
 * sweep). `holderId` is released with `releaseLocationLeases` like a launch id.
 */
export function tryAcquireLease(key: string, holderId: string): boolean {
  if (isLeaseBusy(key)) return false;
  leases.set(key, { launchId: holderId, queue: [] });
  return true;
}

/** Whether a lease is held, or a launch attempt is waiting to take it. */
export function isLeaseBusy(key: string): boolean {
  if (leases.has(key)) return true;
  for (const attempt of acquiring.values()) if (attempt.ids.includes(key)) return true;
  return false;
}

/**
 * Gives each Location to its next waiter, or frees it. Only the holder's own
 * release counts, so a late or repeated call from an attempt that no longer
 * holds a lease cannot hand someone else's directory away.
 */
export function releaseLocationLeases(locationIds: readonly string[], launchId: string): void {
  for (const locationId of locationIds) {
    const held = leases.get(locationId);
    if (!held || held.launchId !== launchId) continue;
    const next = held.queue.shift();
    if (!next) {
      leases.delete(locationId);
      continue;
    }
    held.launchId = next.launchId;
    next.grant();
  }
}

/**
 * Stops launch attempts of a Run that are still waiting for their Locations:
 * the one named by `launchId`, or every attempt of the Run when the stop does
 * not say which. Returns whether any was found; an attempt that already holds
 * its leases is stopped through its process.
 */
export function cancelLeaseWaits(runId: string, launchId?: string): boolean {
  let found = false;
  for (const attempt of acquiring.values()) {
    if (attempt.runId !== runId || (launchId && attempt.launchId !== launchId)) continue;
    attempt.cancelled = true;
    attempt.cancelWait?.();
    found = true;
  }
  return found;
}

/** Stops every waiting attempt, for a host whose registration was revoked. */
export function cancelAllLeaseWaits(): void {
  for (const attempt of acquiring.values()) {
    attempt.cancelled = true;
    attempt.cancelWait?.();
  }
}

/** Whether any launch is waiting for a Location; a restart must not drop it. */
export function hasLeaseWaiters(): boolean {
  return acquiring.size > 0;
}
