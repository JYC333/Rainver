import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";
import { writeJsonDurable } from "./durableFile.js";

/**
 * The drain of identity-less archives (a managed-workspace archive or restore
 * without `operation_id`, an isolated workspace's `archive_profiles` without
 * `archive_identity`). Such a request carries no generation, so no journal can
 * refuse a late copy of it, and its handler runs detached from the connection
 * that delivered it: a reconnect neither cancels nor waits for it.
 *
 * `drainLegacyArchives` is the proof the control plane needs before it lets a
 * launch or restore use a target one was ever sent to. It first closes this
 * installation to every later identity-less request — durably, so a restarted
 * process stays closed — and then waits for every one this process admitted.
 * Once it answers, none admitted earlier is still running and none can start.
 * Admission is synchronous with the frame's dispatch, so a request delivered
 * before the drain is always among those it waits for.
 */

const inFlight = new Set<Promise<unknown>>();
let closedInProcess = false;

const closedMarker = () => join(configDir(), "managed-operations", "legacy-archives-closed");

/** Whether identity-less archives are refused here: this process drained, or an earlier one of this installation did. */
export function legacyArchivesClosed(): boolean {
  if (!closedInProcess && existsSync(closedMarker())) closedInProcess = true;
  return closedInProcess;
}

/**
 * Runs one identity-less archive, tracked for the drain; `null` when the drain
 * already closed them. Must be called in the same tick the frame is dispatched.
 */
export function admitLegacyArchive<T>(work: () => Promise<T>): Promise<T> | null {
  if (legacyArchivesClosed()) return null;
  let running: Promise<T>;
  try { running = work(); } catch (error) { running = Promise.reject(error); }
  const tracked = running.then(() => undefined, () => undefined);
  inFlight.add(tracked);
  void tracked.then(() => inFlight.delete(tracked));
  return running;
}

/**
 * The closed marker, written durably (`writeJsonDurable`: the file, its
 * directory and that directory's chain up to the config directory). A marker
 * that merely exists proves nothing — an earlier attempt may have created it
 * and failed before its fsync — so every process writes it again before its
 * first answer. Concurrent drains share one attempt; a failed one is
 * forgotten, so the next drain redoes every step, as is a success whose
 * marker has since disappeared.
 */
let persisted: { attempt: Promise<void>; done: boolean } | null = null;

function persistClosed(): Promise<void> {
  if (persisted?.done && !existsSync(closedMarker())) persisted = null;
  if (persisted) return persisted.attempt;
  const current = { attempt: writeJsonDurable(closedMarker(), { closed: true }), done: false };
  persisted = current;
  current.attempt.then(() => { current.done = true; }, () => { if (persisted === current) persisted = null; });
  return current.attempt;
}

/**
 * Closes identity-less archives here for good, then waits until none admitted
 * before is still running. Answers only once the closure is durable; a failure
 * to persist it rejects every drain sharing that attempt, and the process stays
 * closed meanwhile.
 */
export async function drainLegacyArchives(): Promise<void> {
  closedInProcess = true;
  const waiting = [...inFlight];
  await persistClosed();
  await Promise.all(waiting);
}
