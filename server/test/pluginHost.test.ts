import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginEffectScopes, PluginRegistrationClosed, inJobTransaction, type PluginEarlyAttempt } from '../src/modules/plugins/effectScopes.js';
import type {
  RainverPlugin,
  PluginActivationResult,
  PluginHostContext,
} from "@rainver/protocol";
import { loadConfig } from "../src/config.js";
import { PluginHost } from "../src/modules/plugins/host/index.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";

describe("PluginHost", () => {
  it("activates built-in plugins synchronously and exposes contributions", async () => {
    const app = Fastify({ logger: false });
    const plugin: RainverPlugin = {
      id: "test_plugin",
      version: "0.1.0",
      activate(ctx: PluginHostContext) {
        const fastify = ctx.fastify as FastifyInstance;
        fastify.get("/api/v1/test-plugin/ping", async () => ({ ok: true }));
        ctx.jobs.register("test_plugin_job", async () => ({ handled: true }));
        ctx.scheduler.register({
          name: "test_plugin_tick",
          intervalSeconds: 60,
          run: async () => undefined,
        });
        ctx.proposals.register("test_plugin_proposal", async () => undefined);
        return { activated: true };
      },
    };

    const host = new PluginHost([plugin]);
    host.activate(app, loadConfig({}));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/v1/test-plugin/ping" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const registry = new JobHandlerRegistry();
    host.applyJobHandlers(registry);
    expect(registry.registeredJobTypes()).toContain("test_plugin_job");
    expect(host.getSchedulerTasks().map((task) => task.name)).toContain("test_plugin_tick");

    const proposals = new ProposalApplierRegistry();
    host.applyProposalAppliers(proposals);
    expect(proposals.registeredTypes()).toContain("test_plugin_proposal");

    await app.close();
  });

  it("rejects async activation because contributions would be registered too late", () => {
    const app = Fastify({ logger: false });
    const plugin: RainverPlugin = {
      id: "async_plugin",
      version: "0.1.0",
      activate: (() =>
        Promise.resolve({ activated: true })) as unknown as (
        ctx: PluginHostContext,
      ) => PluginActivationResult,
    };

    const host = new PluginHost([plugin]);
    expect(() => host.activate(app, loadConfig({}))).toThrow(
      "plugin async_plugin activate() must register synchronously",
    );
  });
});

describe('Plugin resource cleanup deadlines', () => {
  afterEach(() => { vi.useRealTimers(); });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  it('returns at the deadline but quarantines unfinished cleanup until it actually settles, never touching a newer hold', async () => {
    vi.useFakeTimers();
    const effects = new PluginEffectScopes(25), scope = {spaceId:'space',userId:'person'};
    const resource = effects.enter('probe',scope,'g1');
    let finish!: () => void, calls = 0;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const seen: string[] = [];
    resource.onDispose(() => { seen.push('first'); });
    resource.onDispose(async () => { calls++; await held; seen.push('last'); });
    resource.leave();
    const closed = expect(effects.closeHold('probe','g1')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await closed;
    expect(resource.signal.aborted).toBe(true);
    expect(effects.holdStatus('probe','g1')).toBe('inflight');
    expect(effects.unreleased('probe')).toEqual({failed:0,inflight:1});
    expect(() => effects.enter('probe',scope,'g1')).toThrow('closing');
    // The same scope's next generation is another hold: admitted and untouched.
    const next = effects.enter('probe',scope,'g2');
    expect(next.signal.aborted).toBe(false);
    finish();
    await effects.closeHold('probe','g1');
    expect(calls).toBe(1);
    expect(seen).toEqual(['last','first']);
    expect(effects.holdStatus('probe','g1')).toBe('released');
    expect(next.signal.aborted).toBe(false);
    expect(effects.unreleased('probe')).toEqual({failed:0,inflight:0});
  });
  it('drains a callback a running Job registers after the drain snapshot, and is released only after the Job leaves', async () => {
    const effects = new PluginEffectScopes(1000), scope = {spaceId:'space',userId:'person'};
    const job = effects.enter('probe',scope,'g');
    const seen: string[] = [];
    let open!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const inFirst = new Promise<void>(resolve => { started = resolve; });
    job.onDispose(async () => { seen.push('first'); started(); await gate; });
    let closed = false;
    const closing = effects.closeHold('probe','g').then(() => { closed = true; });
    await inFirst;
    // Barrier: the drain took its snapshot and is inside `first`; the Job registers now.
    job.onDispose(() => { seen.push('late'); });
    open();
    await flush();
    expect(seen).toEqual(['first','late']);
    // Every callback is done, but the Job has not left: not released, not reported done.
    expect(closed).toBe(false);
    expect(effects.holdStatus('probe','g')).toBe('inflight');
    job.onDispose(() => { seen.push('after-drain'); });
    await flush();
    expect(seen).toEqual(['first','late','after-drain']);
    expect(effects.unreleased('probe')).toEqual({failed:0,inflight:1});
    job.leave();
    await closing;
    expect(effects.holdStatus('probe','g')).toBe('released');
    expect(seen).toEqual(['first','late','after-drain']);
  });
  it('refuses a registration through a closed handle, keeps a lingering handle registering, and runs callbacks only inside a claimed attempt', async () => {
    const effects = new PluginEffectScopes(1000), scope = {spaceId:'space',userId:'person'};
    const job = effects.enter('probe',scope,'old'), next = effects.enter('probe',scope,'new');
    const seen: string[] = [];
    job.onDispose(() => { seen.push('first'); });
    job.leave();
    await effects.closeHold('probe','old');
    expect(effects.holdStatus('probe','old')).toBe('released');
    // A closed handle registers nothing (bounded contract): refused synchronously, nothing tracked.
    expect(() => job.onDispose(() => { seen.push('closed'); })).toThrow(PluginRegistrationClosed);
    expect(effects.holdStatus('probe','old')).toBe('released');
    // A pinned handle accepts registrations until its release, then refuses them too.
    const pinned = job.pin();
    expect(effects.holdStatus('probe','old')).toBe('inflight');
    pinned.onDispose(() => { seen.push('pinned'); });
    pinned.close();
    expect(() => pinned.onDispose(() => { seen.push('after-release'); })).toThrow(PluginRegistrationClosed);
    await flush();
    // Registered and released, but no attempt was claimed: nothing ran.
    expect(seen).toEqual(['first']);
    expect(effects.closingHolds('probe')).toEqual(['old']);
    await effects.closeHold('probe','old');
    expect(seen).toEqual(['first','pinned']);
    expect(effects.holdStatus('probe','old')).toBe('released');
    // An original-contract handle lingers after its handler returned: registrations stay open, the attempt ends
    // without waiting for it, and the hold is never released here.
    const legacy = effects.enter('probe',scope,'legacy');
    legacy.linger();
    const started = Date.now();
    await effects.closeHold('probe','legacy');
    expect(Date.now() - started).toBeLessThan(500);
    expect(effects.holdStatus('probe','legacy')).toBe('registering');
    legacy.onDispose(() => { seen.push('lingering'); });
    await flush();
    expect(seen).toEqual(['first','pinned']);
    await effects.closeHold('probe','legacy');
    expect(seen).toEqual(['first','pinned','lingering']);
    expect(effects.holdStatus('probe','legacy')).toBe('registering');
    expect(effects.unreleased('probe')).toEqual({failed:0,inflight:1});
    // An early dispose with no scope owner here is refused without running.
    const early = legacy.onDispose(() => { seen.push('early'); });
    await expect(early()).rejects.toMatchObject({name: 'PluginDisposeRefused'});
    expect(seen).not.toContain('early');
    expect(next.signal.aborted).toBe(false);
    // Lease loss: every hold aborts and is refused, but no callback runs until a claimed attempt.
    next.onDispose(() => { seen.push('next'); });
    next.leave();
    effects.fence();
    effects.abortAll();
    expect(next.signal.aborted).toBe(true);
    await flush();
    expect(seen).not.toContain('next');
    expect(effects.closingHolds('probe')).toEqual(['new','legacy']);
    expect(() => effects.enter('probe',scope,'other')).toThrow('closing');
    await effects.closeHold('probe','new');
    expect(seen.at(-1)).toBe('next');
  });
  it('leaves a registration made after an attempt ended for the next claimed attempt', async () => {
    vi.useFakeTimers();
    const effects = new PluginEffectScopes(25), scope = {spaceId:'space',userId:'person'};
    const job = effects.enter('probe',scope,'g');
    const seen: string[] = [];
    job.onDispose(() => { seen.push('first'); });
    // The Job is still running: the attempt drains `first`, then times out waiting for it to leave.
    const first = expect(effects.closeHold('probe','g')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await first;
    expect(seen).toEqual(['first']);
    job.onDispose(() => { seen.push('after'); });
    job.leave();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual(['first']);
    expect(effects.holdStatus('probe','g')).toBe('inflight');
    await effects.closeHold('probe','g');
    expect(seen).toEqual(['first','after']);
    expect(effects.holdStatus('probe','g')).toBe('released');
  });
  it('tracks a callback registered after the deadline, retries only what failed, and never re-enters one in flight', async () => {
    vi.useFakeTimers();
    const effects = new PluginEffectScopes(25), scope = {spaceId:'space',userId:'person'};
    const job = effects.enter('probe',scope,'g');
    let finish!: () => void, heldCalls = 0, lateCalls = 0, failLate = true;
    const held = new Promise<void>(resolve => { finish = resolve; });
    job.onDispose(async () => { heldCalls++; await held; });
    const first = expect(effects.closeHold('probe','g')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await first;
    // After the deadline, while `held` is still in flight: the Job registers another resource.
    job.onDispose(() => { lateCalls++; if (failLate) throw new Error('late failure'); });
    // A second close while in flight joins the same drain: `held` is not invoked again.
    const second = effects.closeHold('probe','g').catch((e: unknown) => e);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toBeInstanceOf(AggregateError);
    expect(heldCalls).toBe(1);
    expect(lateCalls).toBe(1);
    expect(effects.holdStatus('probe','g')).toBe('inflight');
    job.leave();
    await vi.advanceTimersByTimeAsync(0);
    expect(effects.holdStatus('probe','g')).toBe('failed');
    expect(effects.unreleased('probe')).toEqual({failed:1,inflight:0});
    expect(() => effects.enter('probe',scope,'g')).toThrow('closing');
    // Retry: only the failed callback runs again; the done one never does.
    failLate = false;
    await effects.closeHold('probe','g');
    expect(heldCalls).toBe(1);
    expect(lateCalls).toBe(2);
    expect(effects.holdStatus('probe','g')).toBe('released');
    expect(effects.unreleased('probe')).toEqual({failed:0,inflight:0});
  });
});
describe('Plugin early dispose runner', () => {
  /** Settles within a bounded number of event-loop turns: a request left pending fails here, without a sleep or timeout. */
  const settles = async <T>(work: Promise<T>, turns = 50): Promise<{ok: true; value: T} | {ok: false; error: unknown}> => {
    let done = false;
    const out = work.then(value => { done = true; return {ok: true as const, value}; }, (error: unknown) => { done = true; return {ok: false as const, error}; });
    for (let i = 0; i < turns && !done; i++) await new Promise<void>(resolve => { setImmediate(resolve); });
    if (!done) throw new Error('early dispose request left pending');
    return out;
  };
  /** A claiming owner stub: every attempt claimed (or refused) as the SQL claim would; counts overlapping runners. */
  const owner = (effects: PluginEffectScopes, decide: (attempt: number) => boolean | 'throw' = () => true, after?: (attempt: number) => void) => {
    const stats = {claims: 0, running: 0, maxRunning: 0};
    const attempt: PluginEarlyAttempt = async (_id, _hold, run) => {
      stats.running++;
      stats.maxRunning = Math.max(stats.maxRunning, stats.running);
      try {
        const n = ++stats.claims;
        await Promise.resolve();
        const verdict = decide(n);
        if (verdict === 'throw') throw new Error('claim fault');
        if (!verdict) return false;
        await run({round: null, attempt: n});
        after?.(n);
        return true;
      } finally { stats.running--; }
    };
    effects.earlyAttempt = attempt;
    return stats;
  };
  const scope = {spaceId: 'space', userId: 'person'};
  it('starts a runner for a request made right after the previous caller settled (await A(); await B())', async () => {
    const effects = new PluginEffectScopes(1000), stats = owner(effects);
    const job = effects.enter('probe', scope, 'g');
    const seen: string[] = [];
    const a = job.onDispose(() => { seen.push('a'); }), b = job.onDispose(() => { seen.push('b'); });
    await a();
    expect(await settles(b())).toEqual({ok: true, value: undefined});
    expect(seen).toEqual(['a', 'b']);
    expect(stats).toMatchObject({claims: 2, maxRunning: 1});
  });
  it('after a caught failure, the next request runs at once; the failed one is retried only by a later claim', async () => {
    const effects = new PluginEffectScopes(1000), stats = owner(effects);
    const job = effects.enter('probe', scope, 'g');
    let failCalls = 0;
    const fail = job.onDispose(() => { failCalls++; if (failCalls === 1) throw new Error('boom'); });
    const next = job.onDispose(() => {});
    let caught: unknown;
    try { await fail(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({message: 'boom'});
    expect(await settles(next())).toEqual({ok: true, value: undefined});
    expect(failCalls).toBe(1);
    expect(await settles(fail())).toEqual({ok: true, value: undefined});
    expect(failCalls).toBe(2);
    expect(stats).toMatchObject({claims: 3, maxRunning: 1});
  });
  it('shares repeated and concurrent requests of one callback: one invocation, never re-entered while in flight', async () => {
    const effects = new PluginEffectScopes(1000), stats = owner(effects);
    const job = effects.enter('probe', scope, 'g');
    let calls = 0, open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const slow = job.onDispose(async () => { calls++; await gate; });
    const first = slow(), second = slow();
    await new Promise<void>(resolve => { setImmediate(resolve); });
    const during = slow();
    open();
    expect(await Promise.all([settles(first), settles(second), settles(during)])).toEqual(Array(3).fill({ok: true, value: undefined}));
    await slow();
    expect(calls).toBe(1);
    expect(stats).toMatchObject({claims: 1, maxRunning: 1});
  });
  it('claims again for a request registered in the runner\'s last step', async () => {
    const effects = new PluginEffectScopes(1000);
    const job = effects.enter('probe', scope, 'g');
    const seen: string[] = [];
    let late: Promise<void> | undefined;
    const stats = owner(effects, () => true, n => {
      // Inside the claim, after its run: a new resource is registered and its early dispose requested.
      if (n === 1) late = job.onDispose(() => { seen.push('late'); })();
    });
    const a = job.onDispose(() => { seen.push('a'); });
    await a();
    expect(await settles(late!)).toEqual({ok: true, value: undefined});
    expect(seen).toEqual(['a', 'late']);
    expect(stats).toMatchObject({claims: 2, maxRunning: 1});
  });
  it('refuses, never strands, requests when the owner claims nothing (not due, attention, no lease) or the claim faults', async () => {
    const effects = new PluginEffectScopes(1000);
    let verdict: boolean | 'throw' = false;
    const stats = owner(effects, () => verdict);
    const job = effects.enter('probe', scope, 'g');
    let calls = 0;
    const a = job.onDispose(() => { calls++; }), b = job.onDispose(() => { calls++; });
    const refusedA = await settles(a());
    expect(refusedA).toMatchObject({ok: false, error: {name: 'PluginDisposeRefused'}});
    expect(await settles(b())).toMatchObject({ok: false, error: {name: 'PluginDisposeRefused'}});
    // Concurrent requests during a refused claim are refused by the same runner's next claim, not left waiting.
    const both = [a(), b()];
    expect((await Promise.all(both.map(p => settles(p)))).map(r => r.ok)).toEqual([false, false]);
    verdict = 'throw';
    expect(await settles(a())).toMatchObject({ok: false, error: {name: 'PluginDisposeRefused'}});
    expect(calls).toBe(0);
    // Once claimable again, the same callbacks run.
    verdict = true;
    expect(await settles(a())).toEqual({ok: true, value: undefined});
    expect(await settles(b())).toEqual({ok: true, value: undefined});
    expect(calls).toBe(2);
    expect(stats.maxRunning).toBe(1);
  });
  it('still refuses inside the Job transaction without starting a runner', async () => {
    const effects = new PluginEffectScopes(1000), stats = owner(effects);
    const job = effects.enter('probe', scope, 'g');
    let calls = 0;
    const a = job.onDispose(() => { calls++; });
    const inTxn = inJobTransaction(() => a());
    await expect(inTxn.result).rejects.toMatchObject({name: 'PluginDisposeRefused'});
    inTxn.close();
    expect(stats.claims).toBe(0);
    expect(calls).toBe(0);
    expect(await settles(a())).toEqual({ok: true, value: undefined});
    expect(calls).toBe(1);
  });
});
