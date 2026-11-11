import { AsyncLocalStorage } from 'node:async_hooks';
import { runOperationWork } from '../../db/operationTransaction.js';
import type { PluginScope } from '@rainver/protocol';
/**
 * One registered dispose callback. A callback that resolved is never invoked
 * again; one that rejected is retried by a later claimed attempt (dispose
 * callbacks must tolerate a retry after their own rejection). Every invocation
 * happens inside an attempt claimed durably (`lifecycle.ts`), at most once per
 * claim (`claims`); one still in flight is shared, never invoked a second time.
 * There is no local budget: the hold's SQL counter is the only one.
 */
interface Disposer {
  fn: () => Promise<void> | void;
  done: boolean;
  work?: Promise<void>;
  /** Keys of the claimed attempts that invoked it. */
  claims: Set<string>;
  /** Invocations so far (an early dispose tells whether its claim invoked it). */
  invocations: number;
  error?: unknown;
  /** An early dispose of it waits for the next early claim. */
  early?: { resolve: () => void; reject: (error: unknown) => void; promise: Promise<void> };
}
/** One durably claimed attempt here (`lifecycle.ts` claimed it in SQL first). */
export interface PluginDisposeClaim { round: string | null; attempt: number }
/** The Job transaction a plugin call runs in: open until that transaction has ended. */
interface JobTransaction { open: boolean }
const jobTransaction = new AsyncLocalStorage<JobTransaction>();
/**
 * Runs a Job handler marked as inside its transaction (`background.ts`). The
 * mark is inherited by every continuation the handler starts and stays set
 * until `close`, which the host calls once the transaction has ended.
 */
export function inJobTransaction<T>(work: () => Promise<T>): { result: Promise<T>; close(): void } {
  const mark: JobTransaction = { open: true };
  return { result: jobTransaction.run(mark, work), close: () => { mark.open = false; } };
}
/** A dispose the host did not invoke: inside an open transaction, not claimed (not due, attention, no lease, a DB fault). */
export class PluginDisposeRefused extends Error {
  constructor(message: string) { super(message); this.name = 'PluginDisposeRefused'; }
}
/** A registration through a handle that already closed (only a broken lifecycle contract reaches it). */
export class PluginRegistrationClosed extends Error {
  constructor() { super('Plugin dispose registration is closed: retain() before creating a resource that outlives the handler'); this.name = 'PluginRegistrationClosed'; }
}
/**
 * Claims one early attempt of a hold in SQL and records its outcome
 * (`lifecycle.ts`): on a `releasing` hold a full attempt (`closeHold`), on an
 * `active` one `run(claim)`, which invokes the pending early disposes. False
 * when nothing was claimed.
 */
export type PluginEarlyAttempt = (id: string, hold: string, run: (claim: PluginDisposeClaim) => Promise<void>) => Promise<boolean>;
/**
 * The local resources admitted under one durable hold (one owner, one scope
 * generation, `lifecycle.ts`). A cleanup closes exactly its hold, never a
 * newer one of the same scope.
 */
interface HoldState {
  id: string;
  hold: string;
  scope: PluginScope;
  controller: AbortController;
  disposers: Disposer[];
  /** Open handles that will close (a running Job's entry, a retained handle). */
  active: number;
  /** Original-contract Job handles after their handler returned: open, never closing, until the process ends. */
  lingering: number;
  /** The drain in flight (started only by a claimed attempt; it runs until nothing is pending). */
  cleanup?: Promise<void>;
  /** The last drain rejected: resources may still be held, kept for the next claimed attempt. */
  failed: boolean;
  /** Claimed attempts currently waiting on this hold: inside one, a registration or a leave restarts the drain. */
  windows: number;
  /** Waiting attempts: settled when the hold is released (or only lingering handles remain), rejected when a drain fails. */
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
  /** Key of the latest claimed attempt the drain invokes under. */
  claim: string | null;
  /**
   * An early-dispose runner holds the scheduling right (one per hold here;
   * concurrent requests join its claim). Only the runner clears it, in the same
   * synchronous step that found no request pending, so a request made by a
   * continuation of a settled caller always finds either a runner that will
   * see it or none (and starts one).
   */
  early: boolean;
}
let claimSeq = 0;
/** A local key per claimed attempt: a callback is invoked at most once under it. */
const keyOf = (claim: PluginDisposeClaim) => `${claim.round ?? 'active'}:${claim.attempt}:${++claimSeq}`;
/**
 * Lifecycle of one hold here: open (admits entries) -> closing (aborted) ->
 * released (nothing registered remains, no handle open; dropped from
 * `states`). Every callback invocation happens under an attempt `lifecycle.ts`
 * claimed in SQL first: a drain of `closeHold` (the host's entries) or an early
 * run (`earlyAttempt`, for the function `onDispose` returned). Never from a
 * registration, a leave, a lease loss or a shutdown by themselves.
 *
 * Registration windows: a callback is registered only through an open handle,
 * and a handle opens only while its hold is durably an obligation (the Job's
 * entry right after admission, a handle `lifecycle.ts` pinned for `retain()`).
 * While any handle is open the hold is not `released` here. A handle closes
 * where no registration can follow (`leave` when a bounded-contract handler
 * settled, a retained handle's `close`); an original-contract Job handle
 * lingers (`linger`) until the process ends. A registration through a closed
 * handle throws `PluginRegistrationClosed`.
 */
/** What one hold still holds locally (`registering`: only lingering original-contract handles keep it). */
export type LocalHoldStatus = 'released' | 'failed' | 'inflight' | 'registering';
export interface PluginEffectHandle {
  signal: AbortSignal;
  /** Registers a dispose callback through an open handle; throws `PluginRegistrationClosed` once the handle closed. */
  onDispose(fn: () => Promise<void> | void): () => Promise<void>;
}
export interface PluginScopeEntry extends PluginEffectHandle {
  /** The entered work ended and registers nothing more (bounded contract): the handle closes. */
  leave(): void;
  /** The handler returned under the original contract: the handle stays open for registrations until the process ends. */
  linger(): void;
  /** Opens another handle on the same hold (owner-only: confirmed durably before the plugin receives it). */
  pin(): PluginEffectHandle & { close(): void };
}
/** Per-config cooperative resource lifecycle, not a worker or scheduler engine. */
export class PluginEffectScopes {
  constructor(private readonly cleanupTimeoutMs = 3000) {}
  private readonly states = new Map<string, HoldState>();
  /** Holds whose cleanup started here: never admitted again (a new generation is a new hold). */
  private readonly closed = new Set<string>();
  /** Set while this process has no valid owner lease: nothing is admitted. */
  private fenced = false;
  /** The owner's SQL claim for early disposes (`lifecycle.ts`); without it an early dispose is refused. */
  earlyAttempt?: PluginEarlyAttempt;
  private key(id: string, hold: string) {
    return `${id}:${hold}`;
  }
  enter(id: string, scope: PluginScope, hold: string): PluginScopeEntry {
    const key = this.key(id, hold);
    let state = this.states.get(key);
    if (this.fenced || this.closed.has(key) || state?.failed || state?.controller.signal.aborted) throw new Error('Plugin scope is closing');
    if (!state) {
      state = { id, hold, scope, controller: new AbortController(), disposers: [], active: 0, lingering: 0, failed: false, windows: 0, waiters: [], claim: null, early: false };
      this.states.set(key, state);
    }
    const current = state;
    const handle = this.open(key, current);
    return {
      signal: handle.signal,
      onDispose: handle.onDispose,
      leave: handle.close,
      linger: handle.linger,
      pin: () => {
        // A hold already released here is tracked again: the pin keeps it unreleased.
        if (this.states.get(key) !== current) this.states.set(key, current);
        return this.open(key, current);
      },
    };
  }
  private open(key: string, state: HoldState): PluginEffectHandle & { close(): void; linger(): void } {
    state.active++;
    let mode: 'open' | 'lingering' | 'closed' = 'open';
    return {
      signal: state.controller.signal,
      onDispose: (fn: () => Promise<void> | void) => {
        if (mode === 'closed') throw new PluginRegistrationClosed();
        const disposer: Disposer = { fn, done: false, claims: new Set(), invocations: 0 };
        state.disposers.push(disposer);
        this.wake(key, state);
        return () => this.requestDispose(key, state, disposer);
      },
      close: () => {
        if (mode === 'closed') return;
        if (mode === 'open') state.active--; else state.lingering--;
        mode = 'closed';
        this.wake(key, state);
      },
      linger: () => {
        if (mode !== 'open') return;
        mode = 'lingering';
        state.active--;
        state.lingering++;
        this.wake(key, state);
      },
    };
  }
  /** Inside a claimed attempt's wait, a registration or a leave continues that attempt's drain. */
  private wake(key: string, state: HoldState) {
    if (state.windows > 0 && !state.cleanup) void this.startDrain(key, state).catch(() => {});
  }
  /**
   * The early dispose of one resource (the function `onDispose` returned):
   * done → resolves; in flight → shared; inside an open Job transaction →
   * refused; otherwise it waits for an early attempt the owner claims in SQL
   * (concurrent requests join it) and settles with that invocation's outcome,
   * or is refused when nothing was claimed or invoked for it.
   */
  private requestDispose(key: string, state: HoldState, d: Disposer): Promise<void> {
    if (d.done) return Promise.resolve();
    if (d.work) return d.work;
    if (jobTransaction.getStore()?.open) return Promise.reject(new PluginDisposeRefused('Plugin dispose does not run inside its Job transaction; call it after the transaction ends, or leave it to the host'));
    if (!this.earlyAttempt) return Promise.reject(new PluginDisposeRefused('Plugin dispose has no scope owner here'));
    if (!d.early) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      d.early = { resolve, reject, promise };
    }
    const early = d.early.promise;
    if (!state.early) {
      state.early = true;
      // Never rejects (`runEarly` settles every request itself): no unhandled rejection from the runner.
      void jobTransaction.exit(() => this.runEarly(key, state));
    }
    return early;
  }
  /** The early runner: claims attempts until no request is pending, then gives up the scheduling right atomically. */
  private async runEarly(key: string, state: HoldState): Promise<void> {
    try {
      await this.earlyRounds(key, state);
    } catch (error) {
      // Unexpected fault outside the claim: nothing waits forever on this runner.
      state.early = false;
      for (const d of state.disposers) {
        if (!d.early) continue;
        const { reject } = d.early;
        d.early = undefined;
        reject(error);
      }
    }
  }
  private async earlyRounds(key: string, state: HoldState): Promise<void> {
    for (;;) {
      const requested = state.disposers.filter(d => d.early);
      // Exit and release of the scheduling right in one synchronous step (no await between them).
      if (!requested.length) { state.early = false; return; }
      const marks = new Map(state.disposers.map(d => [d, d.invocations]));
      let claimed = false;
      try {
        claimed = await this.earlyAttempt!(state.id, state.hold, async claim => {
          // An active hold: only the requested callbacks, each once under this claim (late requests join it).
          const k = keyOf(claim), invoked = new Set<Disposer>();
          for (;;) {
            const batch = state.disposers.filter(d => d.early && !d.done && !invoked.has(d));
            if (!batch.length) break;
            await Promise.all(batch.map(d => { invoked.add(d); return this.invoke(state, d, k).catch(() => {}); }));
          }
        });
      } catch { claimed = false; }
      // Settle what this attempt considered: the requests present at its claim and any it invoked.
      for (const d of state.disposers) {
        if (!d.early || (!requested.includes(d) && d.invocations === (marks.get(d) ?? 0))) continue;
        const { resolve, reject } = d.early;
        d.early = undefined;
        if (d.done) resolve();
        else if (d.work) d.work.then(resolve, reject);
        else if (claimed && d.invocations > (marks.get(d) ?? 0)) reject(d.error);
        else reject(new PluginDisposeRefused(claimed
          ? 'Plugin dispose was not invoked by this attempt'
          : 'Plugin dispose attempt is not available (not due, needs attention, or not claimable); the host retries it in its cleanup round'));
      }
      this.wake(key, state);
    }
  }
  /** One invocation of a callback under the claimed attempt `claim`, outside every transaction; never re-entered. */
  private invoke(state: HoldState, d: Disposer, claim: string): Promise<void> {
    if (d.done) return Promise.resolve();
    if (d.work) return d.work;
    if (d.claims.has(claim)) return Promise.reject(d.error);
    d.claims.add(claim);
    d.invocations++;
    const work = jobTransaction.exit(() => runOperationWork(async () => d.fn())).then(() => {
      d.done = true;
      d.error = undefined;
      d.work = undefined;
    }, error => {
      d.error = error;
      d.work = undefined;
      throw error;
    });
    d.work = work;
    return work;
  }
  /**
   * One claimed attempt (the caller already counted it durably): admission
   * under the hold is refused from now on, its signal aborts, its pending
   * callbacks drain (LIFO; done ones never rerun; one in flight is shared;
   * each at most once under this claim), and the bounded wait ends when every
   * callback is done and no closing handle remains. The drain may outlive the
   * deadline; registrations after it wait for the next attempt.
   */
  async closeHold(id: string, hold: string, claim: PluginDisposeClaim = { round: null, attempt: 1 }): Promise<void> {
    const key = this.key(id, hold);
    this.closed.add(key);
    const state = this.states.get(key);
    if (!state) return;
    state.claim = keyOf(claim);
    state.controller.abort();
    const settled = this.settled(key, state);
    state.windows++;
    try {
      if (!state.cleanup) void this.startDrain(key, state).catch(() => {});
      await this.waitForCleanup([settled]);
    } finally {
      state.windows--;
    }
  }
  private settled(key: string, state: HoldState): Promise<void> {
    if (this.states.get(key) !== state) return Promise.resolve();
    const settled = new Promise<void>((resolve, reject) => { state.waiters.push({ resolve, reject }); });
    settled.catch(() => {});
    return settled;
  }
  private startDrain(key: string, state: HoldState): Promise<void> {
    if (state.cleanup) return state.cleanup;
    // Outside any Job transaction mark a waking registration carried in: the drain is the host's.
    const cleanup = jobTransaction.exit(() => Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempted = new Set<Disposer>();
      // LIFO; callbacks registered while this drain runs are drained by it too, under the latest claim.
      for (;;) {
        const claim = state.claim!;
        const batch = state.disposers.filter(d => !d.done && !attempted.has(d) && (d.work || !d.claims.has(claim))).reverse();
        if (!batch.length) break;
        for (const disposer of batch) {
          attempted.add(disposer);
          try { await this.invoke(state, disposer, claim); } catch (e) { errors.push(e); }
        }
      }
      // Failed earlier under the same claim (a restarted drain): still failed, not invoked again here.
      for (const d of state.disposers) if (!d.done && !d.work && !attempted.has(d) && d.claims.has(state.claim!)) errors.push(d.error);
      if (errors.length) {
        // Not released: keep the exact state (which callbacks are done) for the next attempt.
        state.failed = true;
        throw new AggregateError(errors, 'Plugin cleanup failed');
      }
      state.failed = false;
    }));
    state.cleanup = cleanup;
    // Observed even when every waiter has already timed out.
    cleanup.then(() => this.afterDrain(key, state, cleanup), error => this.afterDrain(key, state, cleanup, error));
    return cleanup;
  }
  private afterDrain(key: string, state: HoldState, cleanup: Promise<void>, error?: unknown) {
    if (state.cleanup === cleanup) state.cleanup = undefined;
    const waiters = () => state.waiters.splice(0);
    if (error) {
      for (const w of waiters()) w.reject(error);
      return;
    }
    // Registered between the drain's last check and now: drained within a claimed attempt only.
    if (state.disposers.some(d => !d.done)) {
      if (state.windows > 0) void this.startDrain(key, state).catch(() => {});
      return;
    }
    // Released only when no handle remains (it may still register callbacks).
    if (state.active > 0) return;
    // Only lingering original-contract handles: the attempt is over, the hold stays held here.
    if (state.lingering > 0) {
      for (const w of waiters()) w.resolve();
      return;
    }
    if (this.states.get(key) === state) this.states.delete(key);
    for (const w of waiters()) w.resolve();
  }
  private async waitForCleanup(work: Promise<void>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Plugin cleanup timed out')), this.cleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** `released` exactly when nothing admitted under the hold remains here. */
  holdStatus(id: string, hold: string): LocalHoldStatus {
    const state = this.states.get(this.key(id, hold));
    if (!state) return 'released';
    if (state.cleanup || state.active > 0 || state.disposers.some(d => d.work)) return 'inflight';
    if (state.failed) return 'failed';
    if (!state.controller.signal.aborted || !state.disposers.every(d => d.done)) return 'inflight';
    return state.lingering > 0 ? 'registering' : 'released';
  }
  /** Whether a callback of the hold was invoked and has not succeeded (an early dispose keeps its counter then). */
  hasFailedDispose(id: string, hold: string): boolean {
    return this.states.get(this.key(id, hold))?.disposers.some(d => d.invocations > 0 && !d.done) ?? false;
  }
  /** Closing holds of a package that still hold something here (the owner keeps them durably releasing). */
  closingHolds(id: string): string[] {
    return [...this.states.values()].filter(s => s.id === id && s.controller.signal.aborted && this.holdStatus(id, s.hold) !== 'released').map(s => s.hold);
  }
  /**
   * Lease lost: every hold here is closed at once (signals abort, admission
   * refused). No callback runs here: the owner adopts each hold under its new
   * lease (durably releasing) and drains it through claimed attempts.
   */
  abortAll() {
    for (const [key, state] of [...this.states]) {
      this.closed.add(key);
      state.controller.abort();
    }
  }
  /** Holds this process still tracks for a package (open or unreleased). */
  localHolds(id: string): string[] {
    return [...this.states.values()].filter(s => s.id === id).map(s => s.hold);
  }
  /** Closing holds (aborted) that still hold something here. */
  unreleased(id: string): { failed: number; inflight: number } {
    const out = { failed: 0, inflight: 0 };
    for (const s of [...this.states.values()]) {
      if (s.id !== id || !s.controller.signal.aborted) continue;
      const status = this.holdStatus(id, s.hold);
      if (status === 'failed') out.failed++;
      else if (status !== 'released') out.inflight++;
    }
    return out;
  }
  /** Lease lost or process shutting down: nothing new is admitted until `unfence`. */
  fence() { this.fenced = true; }
  unfence() { this.fenced = false; }
}
