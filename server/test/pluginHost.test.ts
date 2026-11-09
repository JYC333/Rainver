import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginEffectScopes } from '../src/modules/plugins/effectScopes.js';
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
  it('returns at the deadline but quarantines unfinished cleanup until it actually settles', async () => {
    vi.useFakeTimers();
    const effects = new PluginEffectScopes(25), scope = {spaceId:'space',userId:'person'};
    const resource = effects.enter('probe',scope);
    let finish!: () => void, calls = 0;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const seen: string[] = [];
    resource.onDispose(() => { seen.push('first'); });
    resource.onDispose(async () => { calls++; await held; seen.push('last'); });
    // A Job can already be disposing when disable requests cleanup again.
    const jobDisposal = expect(resource.dispose()).rejects.toThrow('timed out');
    const closed = expect(effects.closeWhere('probe',scopeValue=>scopeValue.userId==='person','attempt')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await closed;
    await jobDisposal;
    expect(resource.signal.aborted).toBe(true);
    effects.reopenWhere('probe',()=>true,'attempt');
    expect(effects.hasPendingCleanup('probe',()=>true)).toBe(true);
    expect(() => effects.enter('probe',scope)).toThrow('closing');
    expect(effects.enter('probe',{...scope,userId:'other'}).signal.aborted).toBe(false);
    finish();
    await effects.closeWhere('probe',s=>s.userId==='person','retry');
    expect(calls).toBe(1);
    expect(seen).toEqual(['last','first']);
    expect(effects.hasPendingCleanup('probe',s=>s.userId==='person')).toBe(false);
    effects.reopenWhere('probe',()=>true,'retry');
    const fresh = effects.enter('probe',scope);
    expect(fresh.signal.aborted).toBe(false);
    await resource.dispose();
    expect(effects.enter('probe',scope).signal).toBe(fresh.signal);
  });
});
