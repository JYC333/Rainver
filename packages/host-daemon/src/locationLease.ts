/**
 * One execution lease per WorkspaceLocation: a reader–writer lock.
 *
 * Two writers in one checkout would each capture the other's edits in their
 * diff, race each other's commits, and see files change under them mid-turn.
 * So a writer holds every Location it may write — its Primary and each
 * attachment granted `write` — exclusively, from launch until its diff is
 * captured, and the next writer waits in arrival order.
 *
 * A Run the namespace binds read-only (a strict host's `read_only` dispatch)
 * holds its Locations *shared*: any number of readers at once, never beside a
 * writer. So a review reads one version of the directory for its whole run —
 * no writer can start until the readers have finished, and a reader arriving
 * while a writer runs waits for it. Arrival order is kept across modes: a
 * reader that arrives after a waiting writer queues behind it rather than
 * joining the readers already in, so a stream of reviews cannot starve a
 * writer. A Run in a managed workspace, and a Task Run in a worktree of its
 * own, take no lease on those (hosts.md, "Location lease").
 *
 * A Task worktree has a lease of its own under a key that is not a Location
 * id (`taskLeaseKey`): its Runs take it like any writer, so a second launch of
 * the Task queues, and its settle, branch delete and sweep take it without
 * waiting (`tryAcquireLease`) and refuse or skip while anyone holds or awaits it.
 *
 * Several leases are always taken in sorted Location-id order, whatever their
 * mode, so two Runs that each need two Locations cannot each hold one and wait
 * for the other. Locations are keyed by id, not by path: two Locations
 * registered at the same directory, or one nested inside another, are not
 * serialized against each other (deferred register).
 *
 * In-process state for this daemon's lifetime, keyed like `activeRuns`: a
 * lease outlives a WebSocket reconnect along with the Run that holds it.
 * Holders and waiters are launch attempts: a supervisor retry reuses the run
 * id, and one attempt's release or cancellation must not touch another's.
 */

type LeaseMode = "exclusive" | "shared";

interface Waiter {
  launchId: string;
  mode: LeaseMode;
  grant: () => void;
}

interface LocationLease {
  mode: LeaseMode;
  /** One holder when exclusive; any number of readers when shared. */
  holders: Set<string>;
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
type LeaseOutcome = "acquired" | "cancelled";

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
  /** Of these, the ones taken shared (a reader); one also listed exclusive is exclusive. */
  sharedIds: readonly string[] = [],
): Promise<LeaseOutcome> {
  const exclusive = new Set(locationIds);
  const ids = [...new Set([...locationIds, ...sharedIds])].sort();
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
      if ((await acquireOne(id, state, exclusive.has(id) ? "exclusive" : "shared", queued)) === "cancelled") break;
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

function acquireOne(locationId: string, state: Attempt, mode: LeaseMode, onQueued: () => void): Promise<LeaseOutcome> {
  const lease = leases.get(locationId);
  if (!lease) {
    leases.set(locationId, { mode, holders: new Set([state.launchId]), queue: [] });
    return Promise.resolve("acquired");
  }
  // A reader joins readers only while nobody waits: a waiting writer came first.
  if (mode === "shared" && lease.mode === "shared" && lease.queue.length === 0) {
    lease.holders.add(state.launchId);
    return Promise.resolve("acquired");
  }
  return new Promise<LeaseOutcome>((resolve) => {
    const waiter: Waiter = {
      launchId: state.launchId,
      mode,
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
      // A writer that gave up waiting may have been all that kept readers out.
      if (index === 0) admitWaiting(locationId);
    };
    onQueued();
  });
}

/**
 * Hands a Location on from the front of its queue: to the next writer when it
 * is free, or to every reader at the front while it is free or held by
 * readers. Frees it when nobody holds or awaits it.
 */
function admitWaiting(locationId: string): void {
  const lease = leases.get(locationId);
  if (!lease) return;
  while (lease.queue.length > 0) {
    const next = lease.queue[0]!;
    if (next.mode === "exclusive") {
      if (lease.holders.size > 0) return;
      lease.queue.shift();
      lease.mode = "exclusive";
      lease.holders.add(next.launchId);
      next.grant();
      return;
    }
    if (lease.holders.size > 0 && lease.mode === "exclusive") return;
    lease.queue.shift();
    lease.mode = "shared";
    lease.holders.add(next.launchId);
    next.grant();
  }
  if (lease.holders.size === 0) leases.delete(locationId);
}

/**
 * Takes one lease only if nobody holds it, for work that must not wait behind
 * a Run and must not run beside one (a Task worktree's settle, delete and
 * sweep). `holderId` is released with `releaseLocationLeases` like a launch id.
 */
export function tryAcquireLease(key: string, holderId: string): boolean {
  if (isLeaseBusy(key)) return false;
  leases.set(key, { mode: "exclusive", holders: new Set([holderId]), queue: [] });
  return true;
}

/** Whether a lease is held, or a launch attempt is waiting to take it. */
export function isLeaseBusy(key: string): boolean {
  if (leases.has(key)) return true;
  for (const attempt of acquiring.values()) if (attempt.ids.includes(key)) return true;
  return false;
}

/**
 * Gives up this attempt's hold on each Location; the last holder hands it to
 * whoever waits next (`admitWaiting`). Only a holder's own release counts, so
 * a late or repeated call from an attempt that no longer holds a lease cannot
 * hand someone else's directory away.
 */
export function releaseLocationLeases(locationIds: readonly string[], launchId: string): void {
  for (const locationId of locationIds) {
    const held = leases.get(locationId);
    if (!held || !held.holders.delete(launchId)) continue;
    admitWaiting(locationId);
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
