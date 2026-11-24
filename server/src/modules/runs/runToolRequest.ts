/**
 * Host-authored facts of one Run tool request, for the work that runs inside it: which launch of the Run
 * sent it and when it arrived. Set only by the Run tool transport from the caller's verified token
 * (`PgRunToolIdentityRepository.resolve`), never from a business input.
 *
 * - `launchId`: the launch the caller's live token was issued for, stored with the token when it was issued
 *   (`PgRunToolIdentityRepository`), never read from the Run's attempt. A request keeps it for its whole
 *   life, so work that must belong to one launch — a sensitive read and its release, a fact written from it
 *   (ADR 0034) — compares it with the Run's current launch instead of trusting whichever launch is current by
 *   the time it checks.
 * - `startedAt`: when the request was accepted, so its steps share one end-to-end budget inside the
 *   caller's own HTTP timeout.
 * - `signal`: aborted when the caller goes away, so work after the business step (a release transaction)
 *   stops instead of committing for a caller that no longer waits.
 *
 * Outside a Run tool request (`runToolRequest()` is undefined) nothing is known about the caller's launch,
 * and launch-bound work refuses.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunToolRequestFacts {
  readonly launchId: string | null;
  readonly startedAt: number;
  readonly signal?: AbortSignal;
}

const current = new AsyncLocalStorage<RunToolRequestFacts>();

export function withRunToolRequest<T>(facts: RunToolRequestFacts, work: () => Promise<T>): Promise<T> {
  return current.run(Object.freeze({ ...facts }), work);
}

export function runToolRequest(): RunToolRequestFacts | undefined {
  return current.getStore();
}
