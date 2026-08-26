import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
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
