import type { ServerConfig } from '../../config.js';
import { randomUUID } from 'node:crypto';
import type { OfficialPluginCleanupStatus, PluginScope, PluginRetainedEffects } from '@rainver/protocol';
import type { PluginBackground } from './background.js';
import { operationPackages } from './operationRegistry.js';
import { dependencyIds, pluginDependenciesEnabled, lockOperationPluginScope, operationPluginEnabled } from './operationEnablement.js';
import { pluginServiceFor } from './service.js';
import { getOfficialPlugin, listOfficialPlugins } from './registry.js';
import { getDbPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { withDedicatedSessionAdvisoryLock } from '../../db/advisoryLock.js';
import { runHostWorkOutsideOperation } from '../../db/operationTransaction.js';
import { sessionActor, assertCurrentActor } from '../systemActions/operations/actor.js';
import { PgJobQueueRepository } from '../jobs/repository.js';
import { HttpError, type Queryable } from '../routeUtils/common.js';
import { z } from 'zod';
import { JobDeferredError, type JobHandlerRegistry } from '../jobs/handlerRegistry.js';
import type { LocalHoldStatus, PluginDisposeClaim, PluginScopeEntry } from './effectScopes.js';

/*
 * Durable scope holds (`official_plugin_scope_holds`, B51/B53 scope keys).
 *
 * Local effects are process-local, so every one is admitted under a durable
 * hold: one row per (package, scope, owner instance) and generation. The row
 * is the fence; its invariants, each enforced by PostgreSQL:
 *
 * - Commit. Work under a hold commits only if its own transaction read the
 *   row `active`, owned by the instance that admitted it, with that
 *   instance's lease held by its own session, under `FOR SHARE`
 *   (`pluginScopeHoldCurrent`). The row lock lasts through COMMIT, so every
 *   transition of the row (disable, release, adoption, `owner_gone`) is
 *   ordered after that commit, and any commit after a transition reads a
 *   state that refuses it. A query error throws (fail closed).
 * - Scope order. Admission (`FOR SHARE`), enable/disable and every reopen of
 *   a hold (`FOR UPDATE`) take the scope's row locks first, so an enable's
 *   "nothing releasing" check and its commit cannot interleave with a reopen.
 * - Registration windows (R1-R4, OFFICIAL_OPTIONAL_MODULES). A dispose
 *   callback is registered only through an open handle, and a handle opens
 *   only while its hold is durably an obligation: the Job's entry (right after
 *   admission committed it `active`) or a `retainPluginScopeHold` handle
 *   (confirmed under the scope's write locks, the row lock and the lease before
 *   the plugin receives it; a hold whose generation ended is refused, never
 *   reopened). No owner path records a hold released while a handle on it is
 *   open here, so no registration can land on a hold another process could
 *   see clean. An original-contract Job handle stays open until the process
 *   ends (the hold settles `owner_gone` after it); a registration through a
 *   closed handle throws.
 * - Budget. Every callback invocation (a host drain, an early dispose) runs
 *   under an attempt claimed by one SQL write (`claimHoldAttempt`) against the
 *   hold's per-round counter (due, below `OWNER_ATTEMPTS`, not attention,
 *   lease held in the same statement), at most once per claim. The claim of the
 *   last attempt marks `needs_attention`; only a new disable round retries.
 *
 * Ownership is a lease: the session advisory lock `plugin-scope-owner:<id>`
 * held on a dedicated connection (backend `pid`) for the instance's lifetime.
 * Only that session ever takes the key (other processes read `pg_locks`, they
 * never acquire it), so a lease once free stays free and a reused pid can
 * never hold it. A lost lease fences the process at once (admission refused,
 * every local signal aborted); it continues under a fresh instance and adopts
 * (durably `releasing`, scope-locked) what it still holds. Another process
 * settles a hold only when its owner's lease was free for
 * `OWNER_LOST_GRACE_MS`, as `owner_gone` (never released), visiting every
 * foreign owner in rotation, so no Job is needed and none can starve.
 *
 * Not covered: an effect outside PostgreSQL that the plugin already issued.
 * The signal and the grace are cooperative; a process paused or cut off from
 * PostgreSQL past the grace is presumed gone, and what it does on return is
 * adopted again but not undone. An effect that must never act for a stale
 * owner goes through the Job's transaction (an outbox row), or must check a
 * fencing token at its own resource.
 */
interface Runtime { backgrounds: ReadonlyMap<string, PluginBackground>; owner: ScopeOwner }
const runtimes = new WeakMap<ServerConfig, Runtime>();
const transitions = new WeakMap<ServerConfig, Map<string, Promise<void>>>();
const holdOps = new WeakMap<ServerConfig, Map<string, Promise<unknown>>>();
/** Foreign-owner rotation of a cleanup Job, per round (the recovery pass keeps its own). */
const roundCursors = new WeakMap<ServerConfig, Map<string, { value: string }>>();
export const PLUGIN_SCOPE_CLEANUP_JOB = 'official_plugin_scope_cleanup';
const CLEANUP_RECOVERY_DELAY_MS = 30_000;
const OWNER_ATTEMPTS = 3;
const OWNER_RETRY_SECONDS = 5;
const OWNER_TICK_MS = 2_000;
const LEASE_CHECK_MS = 1_000;
const FOREIGN_OWNERS_PER_PASS = 20;
export const OWNER_LOST_GRACE_MS = 15_000;
let ownerTickMs: number | null = OWNER_TICK_MS;
let leaseCheckMs: number | null = LEASE_CHECK_MS;
/** Tests drive the owner's periodic recovery and lease checks explicitly (`pluginScopeOwnerTick`, `pluginScopeLeaseCheck`); `ms` sets the recovery period. */
export function __setPluginScopeOwnerTickForTests(ms: number | null): void {
  ownerTickMs = ms;
  leaseCheckMs = ms === null ? null : Math.min(ms, LEASE_CHECK_MS);
}
const ownerLeaseKey = (instance: string) => `plugin-scope-owner:${instance}`;
const pool = (config: ServerConfig) => getDbPool(config.databaseUrl!);
/** The advisory lock row of the lease of the instance named by the SQL expression `instance`. */
const leaseLock = (instance: string) => `pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
    AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND l.classid::bigint=((hashtextextended('plugin-scope-owner:'||${instance},0)>>32)&4294967295)
    AND l.objid::bigint=(hashtextextended('plugin-scope-owner:'||${instance},0)&4294967295)`;
/** SQL: the lease of `instance` is held by backend `pid` at this statement. */
const heldBy = (instance: string, pid: string) => `EXISTS(SELECT 1 FROM ${leaseLock(instance)} AND l.pid=${pid})`;
/** SQL: anyone holds the lease of `instance` (only its owner session ever does). */
const heldAtAll = (instance: string) => `EXISTS(SELECT 1 FROM ${leaseLock(instance)})`;

/** The backend that holds `instance`'s lease, seen from any session. */
async function leaseHolder(db: Queryable, instance: string): Promise<number | null> {
  return (await db.query<{ pid: number }>(`SELECT l.pid FROM ${leaseLock('$1::text')}`, [instance])).rows[0]?.pid ?? null;
}
/** Whether the lease is held by its own session `pid`, in the caller's session and transaction. A query error propagates. */
async function leaseHeldBy(db: Queryable, lease: Lease): Promise<boolean> {
  return (await db.query<{ held: boolean }>(`SELECT ${heldBy('$1::text', '$2::int')} AS held`, [lease.instance, lease.pid])).rows[0]!.held;
}
interface Lease { instance: string; pid: number }

/**
 * One process's owner identity and lease. Two independent loops: the lease
 * check (every `LEASE_CHECK_MS`, never queued behind cleanup work; detection
 * only, the fences are the SQL conditions above) and the recovery pass
 * (adopts what this process still holds, records what a retired lease left
 * released, judges other owners in rotation, and attempts its own due holds).
 */
class ScopeOwner {
  instance = '';
  /** Set only while the lease is believed held by `pid`; every DB write re-proves it. */
  lease: Lease | null = null;
  ready: Promise<void> = Promise.resolve();
  private stopLease?: () => void;
  private leaseDone: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setInterval>[] = [];
  private ticking?: Promise<void>;
  private checking?: Promise<boolean>;
  private renewing?: Promise<void>;
  /** Earlier instances of this process (lost leases) whose rows are not settled yet. */
  private readonly retired = new Set<string>();
  private readonly retiredLeases: Promise<void>[] = [];
  private readonly foreignCursor = { value: '' };
  private stopped = false;
  constructor(private readonly config: ServerConfig, readonly backgrounds: ReadonlyMap<string, PluginBackground>) {
    if (!config.databaseUrl) {
      // No database, no lease: nothing can be admitted, so nothing local is ever held.
      this.ready = Promise.reject(new Error('Plugin database unavailable'));
      this.ready.catch(() => {});
      this.stopped = true;
      return;
    }
    this.acquire();
    if (leaseCheckMs) this.timers.push(setInterval(() => { void this.checkLease(); }, leaseCheckMs));
    if (ownerTickMs) this.timers.push(setInterval(() => { void this.tick().catch(() => {}); }, ownerTickMs));
    for (const t of this.timers) t.unref();
  }
  private acquire() {
    const instance = this.instance = randomUUID();
    this.lease = null;
    let acquired!: () => void, failed!: (e: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    this.ready.catch(() => {});
    const released = new Promise<void>(resolve => { this.stopLease = resolve; });
    this.leaseDone = withDedicatedSessionAdvisoryLock(pool(this.config), ownerLeaseKey(instance), async () => {
      const pid = await leaseHolder(pool(this.config), instance);
      if (pid === null) throw new Error('Plugin scope owner lease is not visible');
      if (this.instance === instance && !this.stopped) this.lease = { instance, pid };
      acquired();
      await released;
    }).then(() => {}, error => { failed(error); });
  }
  private async endLease() {
    this.stopLease?.();
    await this.leaseDone;
  }
  /** The lease new work may use: none while stopping, lost or renewing. */
  live(): Lease | null {
    return this.stopped ? null : this.lease;
  }
  /** The current lease, once the first acquisition settled. */
  async current(): Promise<Lease | null> {
    await this.ready;
    return this.live();
  }
  /**
   * Verifies the lease now. Lost (or acquisition failed) → fenced at once:
   * nothing is admitted, every local signal aborts, and a fresh lease and
   * instance follow, which adopt what is still held here. A failed check
   * query proves nothing either way; every DB write proves the lease itself.
   */
  checkLease(): Promise<boolean> {
    return this.checking ??= this.runCheck().finally(() => { this.checking = undefined; });
  }
  private async runCheck(): Promise<boolean> {
    if (this.stopped || this.renewing) return false;
    try { await this.ready; } catch { this.lost(); return false; }
    const lease = this.lease;
    if (!lease) return false;
    let held: boolean;
    try { held = await leaseHeldBy(pool(this.config), lease); } catch { return false; }
    if (!held && this.lease === lease) this.lost();
    return held;
  }
  private lost() {
    if (this.renewing || this.stopped) return;
    this.lease = null;
    this.retired.add(this.instance);
    for (const b of this.backgrounds.values()) { b.effects.fence(); b.effects.abortAll(); }
    // The old lease is ended without waiting for it (its unlock may hang on a half-open
    // connection); the new lease is a new instance and key, independent of it.
    this.stopLease?.();
    const oldLease = this.leaseDone;
    this.renewing = (async () => {
      if (this.stopped) return;
      this.acquire();
      await this.ready.catch(() => {});
      if (!this.lease) return;
      for (const b of this.backgrounds.values()) b.effects.unfence();
      // What the old lease still holds here becomes durably releasing under the new one now, not at the next pass.
      void this.adoptLocal().catch(() => {});
    })().finally(() => { this.renewing = undefined; });
    this.retiredLeases.push(oldLease);
    void oldLease.finally(() => { const i = this.retiredLeases.indexOf(oldLease); if (i >= 0) this.retiredLeases.splice(i, 1); });
  }
  tick(): Promise<void> {
    return this.ticking ??= this.runTick().finally(() => { this.ticking = undefined; });
  }
  private async runTick() {
    if (this.stopped) return;
    if (!(await this.checkLease())) {
      await this.renewing;
      if (!(await this.checkLease())) return;
    }
    const instance = this.lease!.instance;
    // Each step is independent: one failing (a DB fault) never skips the others; it is retried next pass.
    await this.adoptLocal().catch(() => {});
    await this.settleRetired().catch(() => {});
    await judgeForeignOwners(this.config, this.instances(), null, this.foreignCursor).catch(() => {});
    const due = (await pool(this.config).query<HoldRow>(`SELECT ${HOLD_COLUMNS} FROM official_plugin_scope_holds
      WHERE owner_instance=$1 AND state='releasing' AND NOT needs_attention AND attempts<$2 AND next_attempt_at<=now() ORDER BY created_at LIMIT 50`, [instance, OWNER_ATTEMPTS])).rows;
    for (const hold of due) {
      if (this.lease?.instance !== instance) return;
      await ordered(this.config, hold, () => settleOwnHold(this.config, hold)).catch(() => {});
    }
  }
  /**
   * Keeps every aborted hold that still holds something here durably
   * `releasing` under the current lease (one a lost lease left, one settled
   * `owner_gone` while this process was cut off), each through the
   * scope-locked reopen. A reopened obligation starts a new round.
   */
  async adoptLocal() {
    if (!this.live()) return;
    const ids = [...this.backgrounds.entries()].flatMap(([id, b]) => b.effects.closingHolds(id));
    for (const id of ids) await holdOp(this.config, id, () => reopenHold(this.config, this, id, 'adopt')).catch(() => {});
  }
  /** Rows of retired instances: released once nothing of them remains here (the rest is adopted). */
  private async settleRetired() {
    for (const instance of [...this.retired]) {
      const rows = (await pool(this.config).query<HoldRow>(`SELECT ${HOLD_COLUMNS} FROM official_plugin_scope_holds WHERE owner_instance=$1 AND state IN ('active','releasing')`, [instance])).rows;
      for (const row of rows) await holdOp(this.config, row.id, async () => {
        if (localStatus(this.backgrounds, row) === 'released') await recordUnheld(this.config, this.backgrounds, row, instance);
      });
      if (!rows.length) this.retired.delete(instance);
    }
  }
  /** Own holds (any instance of this process, any state but settled) with nothing left here. */
  private async markLocallyReleased() {
    for (const instance of this.instances()) {
      const rows = (await pool(this.config).query<HoldRow>(`SELECT ${HOLD_COLUMNS} FROM official_plugin_scope_holds WHERE owner_instance=$1 AND state IN ('active','releasing')`, [instance])).rows;
      for (const row of rows) await holdOp(this.config, row.id, async () => {
        if (localStatus(this.backgrounds, row) === 'released') await recordUnheld(this.config, this.backgrounds, row, instance);
      });
    }
  }
  /**
   * Process exit: every hold still holding something here gets one claimed
   * attempt under a durable round (an active hold opens one), in parallel and
   * bounded; what fails stays releasing and settles `owner_gone` elsewhere
   * once this lease is gone.
   */
  private async exitRound() {
    const holds = [...this.backgrounds.entries()].flatMap(([id, b]) => b.effects.localHolds(id).filter(h => b.effects.holdStatus(id, h) !== 'released'));
    await Promise.all(holds.map(async id => {
      try {
        await holdOp(this.config, id, () => reopenHold(this.config, this, id, 'exit'));
        const row = (await pool(this.config).query<HoldRow>(`SELECT ${HOLD_COLUMNS} FROM official_plugin_scope_holds WHERE id=$1 AND owner_instance=$2 AND state='releasing'`, [id, this.instance])).rows[0];
        if (row) await settleOwnHold(this.config, row, 'exit');
      } catch { /* settled owner_gone elsewhere after exit */ }
    }));
  }
  /** Instances of this process; never judged as foreign owners here. */
  instances(): string[] {
    return [this.instance, ...this.retired].filter(Boolean);
  }
  async stop() {
    if (!this.config.databaseUrl) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const b of this.backgrounds.values()) { b.effects.fence(); }
    await this.ticking?.catch(() => {});
    await this.renewing?.catch(() => {});
    try {
      await this.ready;
      if (this.lease) await this.exitRound();
      await this.markLocallyReleased();
    } catch { /* the lease ends with us: owner_gone elsewhere */ }
    this.lease = null;
    await this.endLease();
    await Promise.all(this.retiredLeases.splice(0));
  }
}

export function registerPluginLifecycle(config: ServerConfig, map: ReadonlyMap<string, PluginBackground>) {
  const runtime: Runtime = { backgrounds: map, owner: new ScopeOwner(config, map) };
  runtimes.set(config, runtime);
  for (const b of map.values()) b.effects.earlyAttempt = (_id, hold, run) => earlyAttempt(config, hold, run);
  return async () => {
    await runtime.owner.stop();
    if (runtimes.get(config) === runtime) runtimes.delete(config);
  };
}
/** This process's owner recovery pass, as its timer runs it (tests call it directly). */
export function pluginScopeOwnerTick(config: ServerConfig): Promise<void> {
  return runtimes.get(config)?.owner.tick() ?? Promise.resolve();
}
/** This process's lease check, as its own timer runs it (tests call it directly); true while the lease is held. */
export function pluginScopeLeaseCheck(config: ServerConfig): Promise<boolean> {
  return runtimes.get(config)?.owner.checkLease() ?? Promise.resolve(false);
}
/** The owner instance of this config's process (diagnostics and tests; never sent to a browser). */
export async function pluginScopeOwnerInstance(config: ServerConfig): Promise<string | null> {
  const owner = runtimes.get(config)?.owner;
  if (!owner) return null;
  await owner.ready;
  return owner.instance;
}
/** Whether `instance` is still this process's live lease (a synchronous fence before local entry). */
export function pluginScopeLeaseIs(config: ServerConfig, instance: string): boolean {
  return runtimes.get(config)?.owner.live()?.instance === instance;
}

/**
 * Admits new local work of an operation package in a scope: a short
 * transaction, serialized with enable/disable by the scope's row locks, that
 * returns this process's current (active) hold for the scope, creating it, or
 * null when the package is not enabled there. The write itself requires this
 * process's lease held by its own session at that statement; a lost lease or
 * a failed query refuses admission (fail closed). An admitted hold is
 * `active`, which no foreign settlement touches, and any commit under it is
 * still fenced by `pluginScopeHoldCurrent`.
 */
export async function admitPluginScopeHold(config: ServerConfig, id: string, scope: PluginScope): Promise<{ hold: string; instance: string } | null> {
  const runtime = runtimes.get(config);
  if (!runtime) throw new Error('Plugin lifecycle is not running');
  const lease = await runtime.owner.current();
  if (!lease) throw new Error('Plugin scope owner lease is not held');
  return withTransaction(pool(config), async tx => {
    await lockOperationPluginScope(tx, id, scope.spaceId, scope.userId, config);
    if (!(await operationPluginEnabled(tx, id, scope.spaceId, scope.userId, config))) return null;
    const hold = (await tx.query<{ id: string }>(`INSERT INTO official_plugin_scope_holds(id,plugin_id,space_id,user_id,owner_instance,state,created_at,updated_at)
      SELECT gen_random_uuid(),$1::text,$2::text,$3::text,$4::text,'active',now(),now() WHERE ${heldBy('$4::text', '$5::int')}
      ON CONFLICT (plugin_id,space_id,user_id,owner_instance) WHERE state='active' DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING id`, [id, scope.spaceId, scope.userId, lease.instance, lease.pid])).rows[0]?.id;
    if (!hold) {
      void runtime.owner.checkLease();
      throw new Error('Plugin scope owner lease is not held');
    }
    return { hold, instance: lease.instance };
  });
}
/**
 * The commit fence of work under a hold, in the caller's transaction (after
 * the scope lock): the hold is `active`, owned by `instance` (the instance
 * that admitted the work, which must still be this process's live lease), and
 * that lease is held by its own session at this statement. The row is read
 * `FOR SHARE`: the lock lasts through the caller's COMMIT, so no transition
 * of the hold (disable, release, adoption, `owner_gone`) can take effect
 * before that commit, and every one after it makes this check fail. A query
 * error throws.
 */
export async function pluginScopeHoldCurrent(db: Queryable, config: ServerConfig, hold: string, instance: string): Promise<boolean> {
  const lease = runtimes.get(config)?.owner.live();
  if (!lease || lease.instance !== instance) return false;
  return (await db.query(`SELECT 1 FROM official_plugin_scope_holds WHERE id=$1 AND state='active' AND owner_instance=$2 AND ${heldBy('$2::text', '$3::int')} FOR SHARE`, [hold, instance, lease.pid])).rows.length > 0;
}
/**
 * A handle on an admitted hold that may outlive the Job's entry (for a
 * resource created later). It is pinned locally first (the hold cannot be
 * recorded released from then on), then confirmed in a scope-locked
 * transaction (`reopenHold`, ordered with every enable and disable) as still
 * this generation's obligation (`active` or `releasing`); only then does it
 * resolve. A hold whose generation ended (`released`, `owner_gone`) is
 * refused, never reopened. Any failure (that, no lease, a DB fault, a lock
 * timeout) closes the handle and rejects: nothing was created under it.
 */
export async function retainPluginScopeHold(config: ServerConfig, entry: Pick<PluginScopeEntry, 'pin'> & { hold: string }): Promise<PluginRetainedEffects> {
  const runtime = runtimes.get(config);
  if (!runtime) throw new Error('Plugin lifecycle is not running');
  return holdOp(config, entry.hold, async () => {
    const handle = entry.pin();
    try {
      await reopenHold(config, runtime.owner, entry.hold, 'retain');
    } catch (error) {
      handle.close();
      throw error;
    }
    return { signal: handle.signal, onDispose: handle.onDispose, release: handle.close };
  });
}
/**
 * Makes a hold of this process durably an obligation of its live lease, in
 * one transaction with the scope's write locks (the same order as enable and
 * disable, so an enable either committed before it or sees it releasing) and
 * the hold's row lock; the lease is proven in it. `retain` only confirms a
 * hold of this generation (`active` or `releasing`, a durable touch) and
 * refuses one already `released` or `owner_gone`. Kept as is when it already
 * is one (`adopt`: releasing; `exit`: releasing, an active one opens a round).
 * Otherwise it becomes `releasing` under the live lease: a new round with
 * fresh attempts unless it was already releasing. Never a hold of another
 * process.
 */
async function reopenHold(config: ServerConfig, owner: ScopeOwner, hold: string, mode: 'retain' | 'adopt' | 'exit'): Promise<void> {
  const lease = mode === 'exit' ? owner.lease : owner.live();
  if (!lease) throw new Error('Plugin scope owner lease is not held');
  await withTransaction(pool(config), async tx => {
    await tx.query("SET LOCAL lock_timeout='5s'");
    const scope = (await tx.query<{ plugin_id: string; space_id: string; user_id: string }>('SELECT plugin_id,space_id,user_id FROM official_plugin_scope_holds WHERE id=$1', [hold])).rows[0];
    if (!scope) throw new Error('Plugin scope hold not found');
    await lockOperationPluginScope(tx, scope.plugin_id, scope.space_id, scope.user_id, config, true);
    const row = (await tx.query<HoldRow & { state: string }>(`SELECT ${HOLD_COLUMNS},state FROM official_plugin_scope_holds WHERE id=$1 FOR UPDATE`, [hold])).rows[0]!;
    if (!owner.instances().includes(row.owner_instance)) throw new Error('Plugin scope hold is not owned here');
    if (!(await leaseHeldBy(tx, lease))) throw new Error('Plugin scope owner lease is not held');
    if (mode === 'retain' && (row.state === 'released' || row.state === 'owner_gone')) throw new Error('Plugin scope hold is closed');
    if (row.owner_instance === lease.instance && (row.state === 'releasing' || (row.state === 'active' && mode === 'retain'))) {
      if (mode === 'retain') await tx.query('UPDATE official_plugin_scope_holds SET updated_at=now() WHERE id=$1', [hold]);
      return;
    }
    const reopened = (await tx.query<HoldRow>(`UPDATE official_plugin_scope_holds SET owner_instance=$2,owner_lost_at=NULL,released_at=NULL,updated_at=now(),
        release_plugin_id=COALESCE(release_plugin_id,plugin_id),
        release_round=CASE WHEN state='releasing' THEN release_round ELSE $3 END,
        attempts=CASE WHEN state='releasing' THEN attempts ELSE 0 END,
        needs_attention=CASE WHEN state='releasing' THEN needs_attention ELSE false END,
        next_attempt_at=CASE WHEN state='releasing' THEN next_attempt_at ELSE now() END,
        last_outcome=CASE WHEN state='releasing' THEN last_outcome ELSE 'reopened' END,
        state='releasing'
      WHERE id=$1 RETURNING ${HOLD_COLUMNS}`, [hold, lease.instance, randomUUID()])).rows[0]!;
    if (row.state === 'released' || row.state === 'owner_gone') await recordEvent(tx, config, reopened, 'scope_cleanup_reopened', { from: row.state });
  });
}
/** Live actor and Space administration for a plugin transition, checked before any local effect is touched. */
export async function authorizedPluginTransition(config: ServerConfig, id: string, space: string, user: string) {
  return authorized(config, id, space, user);
}
async function authorized(config: ServerConfig, id: string, space: string, user: string) {
  const descriptor = getOfficialPlugin(id, config);
  if (!descriptor) throw new HttpError(404, 'Plugin not found');
  await assertCurrentActor(pool(config), sessionActor({ spaceId: space, userId: user }));
  if (descriptor.scope === 'space' && !(await pool(config).query("SELECT 1 FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [space, user])).rows.length) throw new HttpError(403, 'Plugin administration denied');
  return descriptor;
}
/**
 * Whether a plugin's enablement involves operation packages whose background
 * effects are local to this process (their own enable/disable lifecycle).
 */
export function hasOperationPluginEffects(config: ServerConfig, id: string): boolean {
  return operationPackages(config).some(p => p.id === id || p.operationManifest?.requires.includes(id));
}

/** Set by a committed disable's DB half, read by the local step after commit. */
export interface OperationPluginTransition {
  obligation?: PluginScopeCleanupObligation;
}
/**
 * A committed disable round: every hold of the scope it marked `releasing`
 * (`round`) and the delayed `official_plugin_scope_cleanup` Job that drives
 * its settlement when the request's own after-commit release did not finish.
 */
export interface PluginScopeCleanupObligation {
  readonly plugin_id: string;
  readonly space_id: string;
  readonly user_id: string;
  readonly round: string;
  readonly job_id: string;
}
interface HoldRow { id: string; plugin_id: string; space_id: string; user_id: string; owner_instance: string; release_plugin_id: string | null; release_round: string | null; needs_attention: boolean; owner_lost_at: string | null }
const HOLD_COLUMNS = 'id,plugin_id,space_id,user_id,owner_instance,release_plugin_id,release_round,needs_attention,owner_lost_at::text AS owner_lost_at';

function scopeKey(config: ServerConfig, id: string, space: string, user: string) {
  const descriptor = getOfficialPlugin(id, config);
  if (!descriptor) throw new HttpError(404, 'Plugin not found');
  return { descriptor, key: `${id}:${descriptor.scope}:${descriptor.scope === 'space' ? space : user}` };
}
/** Transitions and their after-commit releases of one scope are ordered in this process. */
async function serialized<T>(config: ServerConfig, key: string, work: () => Promise<T>): Promise<T> {
  let pending = transitions.get(config);
  if (!pending) transitions.set(config, pending = new Map());
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}
/** A recovery attempt of a hold, ordered with its scope's transitions in this process when the plugin is known here. */
function ordered<T>(config: ServerConfig, hold: HoldRow, work: () => Promise<T>): Promise<T> {
  const owner = hold.release_plugin_id && getOfficialPlugin(hold.release_plugin_id, config) ? scopeKey(config, hold.release_plugin_id, hold.space_id, hold.user_id).key : null;
  return owner ? serialized(config, owner, work) : work();
}
function affectedIds(config: ServerConfig, id: string): string[] {
  return operationPackages(config).filter(p => dependencyIds(p.id, config).includes(id)).map(p => p.id);
}

/**
 * The local, outside-every-transaction half of an operation package's
 * enable/disable. Nothing local is touched before the DB half: a refused,
 * conflicting, malformed, unkeyed or replayed command has no local effect.
 * Only a committed disable round releases this process's holds of it, after
 * commit and with no DB transaction open. `transaction` is the DB half
 * (`applyOperationPluginEnabledIn`), run by the caller: the operation core's
 * own transaction, or `setOperationPluginEnabled`'s. `cleanupFailures` counts
 * the round's holds still releasing anywhere.
 */
export async function aroundOperationPluginTransition<T>(config: ServerConfig, id: string, space: string, user: string, enabled: boolean,
  transaction: (transition: OperationPluginTransition) => Promise<{ committed: boolean; value: T }>): Promise<{ value: T; cleanupFailures: number }> {
  const { key } = scopeKey(config, id, space, user);
  return serialized(config, key, async () => {
    const transition: OperationPluginTransition = {};
    const outcome = await transaction(transition);
    if (!outcome.committed || enabled || !transition.obligation) return { value: outcome.value, cleanupFailures: 0 };
    const remaining = await settleRound(config, transition.obligation, true);
    return { value: outcome.value, cleanupFailures: remaining };
  });
}

function localStatus(backgrounds: ReadonlyMap<string, PluginBackground> | undefined, hold: Pick<HoldRow, 'id' | 'plugin_id'>): LocalHoldStatus {
  return backgrounds?.get(hold.plugin_id)?.effects.holdStatus(hold.plugin_id, hold.id) ?? 'released';
}
/**
 * Per-hold order in this process: reading what a hold still holds here and
 * writing that outcome is never interleaved with another such step (a
 * retained handle's pin and reopen cannot land between a `released` read and
 * its write).
 */
async function holdOp<T>(config: ServerConfig, hold: string, work: () => Promise<T>): Promise<T> {
  let ops = holdOps.get(config);
  if (!ops) holdOps.set(config, ops = new Map());
  const previous = ops.get(hold) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  const tail = current.catch(() => {});
  ops.set(hold, tail);
  try {
    return await current;
  } finally {
    if (ops.get(hold) === tail) ops.delete(hold);
  }
}
/**
 * Records a hold of `instance` released because nothing of it is held here,
 * without a claimed attempt (no callback ran for it). Skips a row another
 * transaction has locked (a commit in flight under it); the next pass retries.
 */
async function recordUnheld(config: ServerConfig, backgrounds: ReadonlyMap<string, PluginBackground>, hold: HoldRow, instance: string) {
  await writeReleased(config, backgrounds, hold, `WITH c AS (SELECT id FROM official_plugin_scope_holds WHERE id=$1 AND owner_instance=$2 AND state IN ('active','releasing') FOR UPDATE SKIP LOCKED)
    UPDATE official_plugin_scope_holds h SET state='released',last_outcome='released',needs_attention=false,released_at=now(),updated_at=now() FROM c WHERE h.id=c.id`, [hold.id, instance]);
}
/**
 * Writes a hold released, called inside its `holdOp` after a `released` local
 * read. No handle can open on the hold between that read and COMMIT (an entry
 * of a closing hold is refused, a retained pin waits for the same `holdOp`,
 * a closed handle refuses registration), so the recheck inside the
 * transaction is an assertion: it rolls the write back rather than record a
 * hold released that holds something here.
 */
async function writeReleased(config: ServerConfig, backgrounds: ReadonlyMap<string, PluginBackground> | undefined, hold: HoldRow, sql: string, params: unknown[]): Promise<boolean> {
  const taken = new Error('held here');
  return withTransaction(pool(config), async tx => {
    await tx.query(sql, params);
    if (localStatus(backgrounds, hold) !== 'released') throw taken;
    return true;
  }).catch(error => { if (error === taken) return false; throw error; });
}
async function recordEvent(db: Queryable, config: ServerConfig, hold: HoldRow, type: string, metadata: Record<string, unknown>) {
  const pluginId = hold.release_plugin_id ?? hold.plugin_id;
  const space = getOfficialPlugin(pluginId, config)?.scope === 'user' ? null : hold.space_id;
  await db.query("INSERT INTO official_plugin_events(id,plugin_id,space_id,target_user_id,event_type,actor_user_id,metadata_json,created_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,NULL,$5::jsonb,now())", [pluginId, space, hold.user_id, type, JSON.stringify(metadata)]);
}
type AttemptMode = 'host' | 'exit' | 'early';
/**
 * The one claim of an attempt of this process's own hold, for every entry
 * (the request after commit, the owner's recovery pass, the cleanup Job,
 * process exit, an early dispose): one SQL statement against the hold's
 * durable counter for its round — only when due (process exit does not wait),
 * not needing attention, below `OWNER_ATTEMPTS`, owned by the live lease and
 * that lease held by its session in the same statement. The claim moves the
 * next due time forward, so concurrent or repeated entries never double count
 * or re-enter; the claim of the last attempt already marks `needs_attention`
 * (a crash during it stays visible). A `releasing` hold is claimed in its
 * release round; an `active` one (early dispose only) in its active counter
 * (`release_round` null). Host entries skip a row another transaction locks
 * (a commit in flight under it); an early dispose waits for it (bounded).
 */
async function claimHoldAttempt(config: ServerConfig, hold: HoldRow, state: 'active' | 'releasing', lease: Lease, mode: AttemptMode): Promise<number | null> {
  const sql = `WITH c AS (SELECT id FROM official_plugin_scope_holds
      WHERE id=$1 AND owner_instance=$2 AND state=$8 AND release_round IS NOT DISTINCT FROM $3 AND NOT needs_attention AND attempts<$5
        AND ($6::boolean OR next_attempt_at IS NULL OR next_attempt_at<=now()) AND ${heldBy('$2::text', '$7::int')} FOR UPDATE${mode === 'early' ? '' : ' SKIP LOCKED'})
    UPDATE official_plugin_scope_holds h SET attempts=h.attempts+1,last_attempt_at=now(),next_attempt_at=now()+make_interval(secs=>$4*(h.attempts+1)),needs_attention=h.attempts+1>=$5,updated_at=now()
    FROM c WHERE h.id=c.id RETURNING h.attempts`;
  const params = [hold.id, hold.owner_instance, state === 'active' ? null : hold.release_round, OWNER_RETRY_SECONDS, OWNER_ATTEMPTS, mode === 'exit', lease.pid, state];
  const rows = mode === 'early'
    ? await withTransaction(pool(config), async tx => { await tx.query("SET LOCAL lock_timeout='5s'"); return (await tx.query<{ attempts: number }>(sql, params)).rows; })
    : (await pool(config).query<{ attempts: number }>(sql, params)).rows;
  return rows[0]?.attempts ?? null;
}
/**
 * One release attempt of this process's own `releasing` hold: claimed first
 * (`claimHoldAttempt`); only then does the drain run (no DB transaction open;
 * bounded wait; callbacks done stay done, one in flight is shared, each at
 * most once under this claim), and one short write records the outcome.
 */
async function settleOwnHold(config: ServerConfig, hold: HoldRow, mode: AttemptMode = 'host'): Promise<LocalHoldStatus | 'not_due'> {
  const db = pool(config);
  const runtime = runtimes.get(config);
  const lease = mode === 'exit' ? runtime?.owner.lease : runtime?.owner.live();
  if (!lease || lease.instance !== hold.owner_instance) return 'not_due';
  const claimed = await claimHoldAttempt(config, hold, 'releasing', lease, mode);
  if (claimed === null) return 'not_due';
  const effects = runtime?.backgrounds.get(hold.plugin_id)?.effects;
  if (effects) await effects.closeHold(hold.plugin_id, hold.id, { round: hold.release_round, attempt: claimed }).catch(() => {});
  return holdOp(config, hold.id, async () => {
    const status = localStatus(runtime?.backgrounds, hold);
    if (status === 'released' && await writeReleased(config, runtime?.backgrounds, hold,
      "UPDATE official_plugin_scope_holds SET state='released',last_outcome='released',needs_attention=false,released_at=now(),updated_at=now() WHERE id=$1 AND owner_instance=$2 AND state='releasing' AND release_round=$3", [hold.id, hold.owner_instance, hold.release_round])) return status;
    if (status === 'released') return 'inflight';
    const row = (await db.query<{ attempts: number }>(`UPDATE official_plugin_scope_holds SET last_outcome=$3,updated_at=now()
      WHERE id=$1 AND owner_instance=$2 AND state='releasing' AND release_round=$4 AND attempts=$5 RETURNING attempts`, [hold.id, hold.owner_instance, status, hold.release_round, claimed])).rows[0];
    if (row) {
      await recordEvent(db, config, hold, 'scope_cleanup_failed', { outcome: status, attempts: row.attempts });
      if (row.attempts >= OWNER_ATTEMPTS) await recordEvent(db, config, hold, 'scope_cleanup_needs_attention', { outcome: status, attempts: row.attempts });
    }
    return status;
  });
}
/**
 * An early dispose (the function `onDispose` returned), through the same
 * claim as every host entry, outside the operation work that may call it. On
 * a `releasing` hold it is one full release attempt (`settleOwnHold`). On an
 * `active` hold it claims the active counter and `run` invokes the requested
 * callbacks; the outcome write resets the counter when nothing of the hold
 * has failed (`disposed`), otherwise it keeps the backoff and attention for
 * the hold's disable round, which starts a fresh round. False when nothing was
 * claimed (no lease, not owned here, not due, attention, a closed hold).
 */
function earlyAttempt(config: ServerConfig, hold: string, run: (claim: PluginDisposeClaim) => Promise<void>): Promise<boolean> {
  return runHostWorkOutsideOperation(async () => {
    const runtime = runtimes.get(config);
    const lease = runtime?.owner.live();
    if (!runtime || !lease) return false;
    const db = pool(config);
    const row = (await db.query<HoldRow & { state: string }>(`SELECT ${HOLD_COLUMNS},state FROM official_plugin_scope_holds WHERE id=$1`, [hold])).rows[0];
    if (!row || row.owner_instance !== lease.instance) return false;
    if (row.state === 'releasing') return (await settleOwnHold(config, row, 'early')) !== 'not_due';
    if (row.state !== 'active') return false;
    const claimed = await claimHoldAttempt(config, row, 'active', lease, 'early');
    if (claimed === null) return false;
    try {
      await run({ round: null, attempt: claimed });
    } finally {
      await holdOp(config, hold, async () => {
        const failed = runtime.backgrounds.get(row.plugin_id)?.effects.hasFailedDispose(row.plugin_id, hold) ?? false;
        await db.query(failed
          ? "UPDATE official_plugin_scope_holds SET last_outcome='failed',updated_at=now() WHERE id=$1 AND state='active' AND release_round IS NULL AND attempts=$2"
          : "UPDATE official_plugin_scope_holds SET attempts=0,needs_attention=false,next_attempt_at=NULL,last_outcome='disposed',updated_at=now() WHERE id=$1 AND state='active' AND release_round IS NULL AND attempts=$2", [hold, claimed]);
      }).catch(() => {});
    }
    return true;
  });
}
/**
 * Other processes' holds still releasing, visited in rotation: owners are
 * taken in `owner_instance` order after `cursor`, wrapping around, at most
 * `FOREIGN_OWNERS_PER_PASS` per pass, so every owner is visited within
 * ceil(owners / limit) passes whatever the others' state. For each owner, in
 * statements that read the lease themselves: held → alive, any grace
 * observation is reset; free → its holds are marked lost, and those lost for
 * `OWNER_LOST_GRACE_MS` settle as `owner_gone`, never as released. Rows
 * another transaction holds are skipped (next pass). A DB error ends the pass
 * where it is (the cursor stays at the last owner done) and settles nothing.
 * `round` limits the visit to one round's owners (the cleanup Job).
 */
async function judgeForeignOwners(config: ServerConfig, mine: string[], round: string | null, cursor: { value: string }): Promise<void> {
  const db = pool(config);
  const page = async (after: string | null, upTo: string | null, limit: number) => (await db.query<{ owner_instance: string }>(`SELECT owner_instance FROM official_plugin_scope_holds
    WHERE state='releasing' AND owner_instance<>ALL($1::text[]) AND ($2::text IS NULL OR release_round=$2) AND ($3::text IS NULL OR owner_instance>$3) AND ($4::text IS NULL OR owner_instance<=$4)
    GROUP BY owner_instance ORDER BY owner_instance LIMIT $5`, [mine, round, after, upTo, limit])).rows.map(r => r.owner_instance);
  const owners = await page(cursor.value || null, null, FOREIGN_OWNERS_PER_PASS);
  if (owners.length < FOREIGN_OWNERS_PER_PASS && cursor.value) owners.push(...(await page(null, cursor.value, FOREIGN_OWNERS_PER_PASS - owners.length)).filter(o => !owners.includes(o)));
  for (const instance of owners) {
    await db.query(`UPDATE official_plugin_scope_holds SET owner_lost_at=NULL,updated_at=now() WHERE owner_instance=$1 AND state='releasing' AND owner_lost_at IS NOT NULL AND ${heldAtAll('$1::text')}`, [instance]);
    await db.query(`WITH c AS (SELECT id FROM official_plugin_scope_holds WHERE owner_instance=$1 AND state='releasing' AND owner_lost_at IS NULL AND NOT ${heldAtAll('$1::text')} FOR UPDATE SKIP LOCKED)
      UPDATE official_plugin_scope_holds h SET owner_lost_at=now(),updated_at=now() FROM c WHERE h.id=c.id`, [instance]);
    const gone = await db.query<HoldRow>(`WITH c AS (SELECT id FROM official_plugin_scope_holds WHERE owner_instance=$1 AND state='releasing' AND owner_lost_at<=now()-make_interval(secs=>$2) AND NOT ${heldAtAll('$1::text')} FOR UPDATE SKIP LOCKED)
      UPDATE official_plugin_scope_holds h SET state='owner_gone',last_outcome='owner_gone',needs_attention=false,released_at=now(),updated_at=now() FROM c WHERE h.id=c.id
      RETURNING h.id,h.plugin_id,h.space_id,h.user_id,h.owner_instance,h.release_plugin_id,h.release_round,h.needs_attention,h.owner_lost_at::text AS owner_lost_at`, [instance, OWNER_LOST_GRACE_MS / 1000]);
    for (const hold of gone.rows) await recordEvent(db, config, hold, 'scope_cleanup_owner_gone', {});
    cursor.value = instance;
  }
}
/** Releases this process's holds of a round; returns how many of the round's holds remain releasing anywhere. */
async function settleRound(config: ServerConfig, o: PluginScopeCleanupObligation, retire: boolean): Promise<number> {
  const db = pool(config);
  const instance = runtimes.get(config)?.owner.live()?.instance ?? null;
  const own = instance ? (await db.query<HoldRow>(`SELECT ${HOLD_COLUMNS} FROM official_plugin_scope_holds WHERE release_round=$1 AND state='releasing' AND owner_instance=$2 ORDER BY created_at`, [o.round, instance])).rows : [];
  for (const hold of own) await settleOwnHold(config, hold);
  const remaining = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM official_plugin_scope_holds WHERE release_round=$1 AND state='releasing'", [o.round])).rows[0]!.n);
  if (!remaining && retire) await new PgJobQueueRepository(db).cancelJob(o.job_id, null, new Date(), ['pending']);
  return remaining;
}

/**
 * The cleanup Job of a disable round, on any worker. It attempts the holds
 * this process owns through the same claimed counter as every other entry
 * (never a fourth attempt, never one before it is due), judges the round's
 * other owners in rotation only by a verifiably free lease across the grace
 * period (`owner_gone`), and completes only when no hold of the round is
 * still releasing. While any hold still has an automatic path (an own retry
 * not yet due, a live owner still working, a free lease inside its grace
 * period) it defers without spending an attempt. When every remaining hold
 * needs attention it fails; the obligation stays the hold, visible on the
 * plugin's card, and every owner's recovery pass keeps judging a crashed
 * owner even after this Job ended. A worker whose process does not host the
 * plugin never completes the round for that reason.
 */
export function registerPluginScopeCleanupHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  registry.register(PLUGIN_SCOPE_CLEANUP_JOB, async job => {
    const o = cleanupPayload.parse(job.payload);
    if (o.space_id !== job.space_id || o.user_id !== job.user_id) throw new Error('Plugin cleanup obligation does not match its Job');
    const inScope = getOfficialPlugin(o.plugin_id, config)
      ? <T>(work: () => Promise<T>) => serialized(config, scopeKey(config, o.plugin_id, o.space_id, o.user_id).key, work)
      : <T>(work: () => Promise<T>) => work();
    const db = pool(config);
    return inScope(async () => {
      const owner = runtimes.get(config)?.owner;
      const instance = owner?.live()?.instance ?? null;
      const holds = (await db.query<HoldRow>(`SELECT ${HOLD_COLUMNS} FROM official_plugin_scope_holds WHERE release_round=$1 AND state='releasing' ORDER BY created_at`, [o.round])).rows;
      for (const hold of holds) if (instance && hold.owner_instance === instance) await settleOwnHold(config, hold);
      const mine = owner?.instances() ?? [];
      let cursors = roundCursors.get(config);
      if (!cursors) roundCursors.set(config, cursors = new Map());
      const cursor = cursors.get(o.round) ?? { value: '' };
      cursors.set(o.round, cursor);
      await judgeForeignOwners(config, mine, o.round, cursor);
      const left = (await db.query<HoldRow & { due_in_ms: number }>(`SELECT ${HOLD_COLUMNS},GREATEST(0,EXTRACT(EPOCH FROM next_attempt_at-now())*1000)::int AS due_in_ms
        FROM official_plugin_scope_holds WHERE release_round=$1 AND state='releasing'`, [o.round])).rows;
      if (!left.length) {
        cursors.delete(o.round);
        const counts = (await db.query<{ released: string; owner_gone: string }>("SELECT count(*) FILTER (WHERE state='released') AS released,count(*) FILTER (WHERE state='owner_gone') AS owner_gone FROM official_plugin_scope_holds WHERE release_round=$1", [o.round])).rows[0]!;
        return { settled: true, released: Number(counts.released), owner_gone: Number(counts.owner_gone) };
      }
      const ownRetry = left.filter(h => mine.includes(h.owner_instance) && !h.needs_attention);
      if (ownRetry.length) throw new JobDeferredError('Plugin scope cleanup waits for its retry', Math.min(OWNER_LOST_GRACE_MS, Math.max(1000, Math.min(...ownRetry.map(h => h.due_in_ms)))));
      // Another owner still working, or a free lease inside its grace period: wait for it.
      if (left.some(h => !mine.includes(h.owner_instance) && (!h.needs_attention || h.owner_lost_at))) throw new JobDeferredError('Plugin scope cleanup waits for its owner', OWNER_LOST_GRACE_MS);
      throw new Error('Plugin scope cleanup did not release every resource');
    });
  });
}
const cleanupPayload = z.object({
  plugin_id: z.string().min(1).max(128), space_id: z.string().min(1).max(36), user_id: z.string().min(1).max(36),
  round: z.string().uuid(),
}).strict();

/**
 * The DB half of an operation package's enable/disable, in the caller's
 * transaction: the scope lock, the live administration check, dependencies,
 * the enablement write. An enable is refused (409) while any hold of the
 * scope is still releasing anywhere. A disable cancels the scope's Jobs and
 * opens a new release round: every active or still-releasing hold of the
 * affected packages in the scope becomes `releasing` under it (a retry of a
 * failed round is exactly this), with a delayed cleanup Job.
 */
export async function applyOperationPluginEnabledIn(tx: Queryable, config: ServerConfig, id: string, space: string, user: string, enabled: boolean,
  transition: OperationPluginTransition, settings?: Record<string, unknown>) {
  const descriptor = getOfficialPlugin(id, config);
  if (!descriptor) throw new HttpError(404, 'Plugin not found');
  const affected = affectedIds(config, id);
  await lockOperationPluginScope(tx, id, space, user, config, true);
  if (descriptor.scope === 'space' && !(await tx.query("SELECT 1 FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND status='active'", [space, user])).rows.length) throw new HttpError(403, 'Plugin administration denied');
  const inScope = "(($2::boolean AND user_id=$3) OR (NOT $2::boolean AND space_id=$4))";
  const scopeArgs = [descriptor.scope === 'user', user, space];
  if (enabled && (await tx.query(`SELECT 1 FROM official_plugin_scope_holds WHERE plugin_id=ANY($1::text[]) AND state='releasing' AND ${inScope} LIMIT 1`, [affected, ...scopeArgs])).rows.length) throw new HttpError(409, 'Plugin cleanup is still pending');
  if (enabled && !(await pluginDependenciesEnabled(tx, id, space, user, config))) throw new HttpError(409, 'Plugin dependency is disabled or unavailable');
  const result = enabled ? await pluginServiceFor(config).enablePlugin(tx, id, space, user, { settings }) : await pluginServiceFor(config).disablePlugin(tx, id, space, user);
  if (!enabled) {
    const types = operationPackages(config).filter(p => affected.includes(p.id)).flatMap(p => p.operationManifest?.jobs?.map(j => j.id) ?? []);
    const jobs = (await tx.query<{ id: string }>(`SELECT id FROM jobs WHERE job_type=ANY($1::text[]) AND status IN ('pending','claimed','running') AND ${inScope}`, [types, ...scopeArgs])).rows;
    const queue = new PgJobQueueRepository(tx);
    for (const j of jobs) await queue.cancelJob(j.id, null);
    const round = randomUUID();
    await tx.query(`UPDATE official_plugin_scope_holds SET state='releasing',release_plugin_id=$5,release_round=$6,attempts=0,needs_attention=false,last_outcome=NULL,next_attempt_at=now(),updated_at=now()
      WHERE plugin_id=ANY($1::text[]) AND state IN ('active','releasing') AND ${inScope}`, [affected, ...scopeArgs, id, round]);
    const obligation = { plugin_id: id, space_id: space, user_id: user, round };
    const job = await queue.enqueue({ job_type: PLUGIN_SCOPE_CLEANUP_JOB, space_id: space, user_id: user, payload: obligation, max_attempts: 3, scheduled_at: new Date(Date.now() + CLEANUP_RECOVERY_DELAY_MS) });
    transition.obligation = { ...obligation, job_id: job.id };
  }
  return { ...result, cleanup_pending: false };
}

/** The same transition in its own transaction, for callers outside the operation core (tests, internal owners). */
export async function setOperationPluginEnabled(config: ServerConfig, id: string, space: string, user: string, enabled: boolean, settings?: Record<string, unknown>) {
  await authorized(config, id, space, user);
  const out = await aroundOperationPluginTransition(config, id, space, user, enabled, async transition => ({
    committed: true,
    value: await withTransaction(pool(config), async tx => {
      await assertCurrentActor(tx, sessionActor({ spaceId: space, userId: user }), true);
      return applyOperationPluginEnabledIn(tx, config, id, space, user, enabled, transition, settings);
    }),
  }));
  return { ...out.value, cleanup_pending: out.cleanupFailures > 0 };
}

/**
 * Cleanup obligations a person may see and repair, per plugin they
 * administer in this context (B53: a Space plugin's for a Space owner/admin of
 * this Space, a user plugin's for that user). Counts and times only: no owner,
 * process, path or error detail. The repair is a new disable round, except for
 * a hold whose last attempt found only an original-contract registration window
 * (`last_outcome='registering'`) while its owner is not known lost: no round can
 * release it (`awaiting_restart`); it settles `owner_gone` after that process
 * ends. A hold whose owner is known lost (`owner_lost_at`) is pending whatever
 * its attempts: it settles `owner_gone` after the grace on its own.
 */
export async function pluginCleanupStatuses(db: Queryable, config: ServerConfig, space: string, user: string): Promise<Map<string, OfficialPluginCleanupStatus>> {
  const admin = (await db.query("SELECT 1 FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [space, user])).rows.length > 0;
  const rows = (await db.query<{ release_plugin_id: string; space_id: string; user_id: string; retryable: boolean; awaiting_restart: boolean; last_attempt_at: string | null }>(
    `SELECT release_plugin_id,space_id,user_id,
        (needs_attention AND owner_lost_at IS NULL AND last_outcome IS DISTINCT FROM 'registering') AS retryable,
        (last_outcome IS NOT DISTINCT FROM 'registering' AND owner_lost_at IS NULL) AS awaiting_restart,last_attempt_at::text AS last_attempt_at
      FROM official_plugin_scope_holds WHERE state='releasing' AND (space_id=$1 OR user_id=$2)`, [space, user])).rows;
  const out = new Map<string, OfficialPluginCleanupStatus>();
  for (const descriptor of listOfficialPlugins(config)) {
    const mine = rows.filter(r => r.release_plugin_id === descriptor.id && (descriptor.scope === 'user' ? r.user_id === user : admin && r.space_id === space));
    if (!mine.length) continue;
    const restart = mine.filter(r => r.awaiting_restart).length;
    const attention = mine.filter(r => r.retryable).length;
    const last = mine.map(r => r.last_attempt_at).filter((x): x is string => !!x).sort().at(-1) ?? null;
    out.set(descriptor.id, {
      state: attention ? 'needs_attention' : restart ? 'awaiting_restart' : 'pending',
      pending: mine.length - attention - restart, attention, awaiting_restart: restart,
      last_attempt_at: last ? new Date(last).toISOString() : null,
    });
  }
  return out;
}
