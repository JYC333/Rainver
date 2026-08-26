/**
 * PluginHost — loads and activates official plugins at server startup.
 *
 * Bundled official plugin source lives under plugins/official/*, is compiled
 * into dist/official-plugins/*, and loaded into BUILT_IN_PLUGINS at startup.
 * Package install state and schema are still created only by the installer.
 * Level 2 (downloaded): plugins will use the same startup-load shape from the
 * instance plugins directory.
 *
 * Usage (in server startup):
 *   const host = new PluginHost(BUILT_IN_PLUGINS)
 *   host.activate(fastify, config)                // during registerServerRoutes
 *   host.applyJobHandlers(jobHandlerRegistry)      // during buildJobHandlerRegistry
 *   host.getSchedulerTasks()                       // during startBackgroundServices
 *   host.applyProposalAppliers(proposalRegistry)   // during createDefaultProposalApplierRegistry
 */

import type { FastifyInstance } from "fastify";
import type {
  AgentSpacePlugin,
  PluginActivationResult,
} from "@agent-space/protocol";
import type { JobHandlerRegistry } from "../../jobs/handlerRegistry.js";
import type { ScheduledTask } from "../../scheduler/registry.js";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import type { ServerConfig } from "../../../config.js";
import { PluginHostContextImpl, type PluginContributions } from "./context.js";

export class PluginHost {
  private readonly _plugins: readonly AgentSpacePlugin[];
  private _contributions: PluginContributions[] = [];
  private _activated = false;

  constructor(plugins: readonly AgentSpacePlugin[]) {
    this._plugins = plugins;
  }

  get pluginCount(): number {
    return this._plugins.length;
  }

  /**
   * Activate all plugins. Called once during registerServerRoutes, after
   * SERVER_MODULES are mounted. Routes are registered directly via ctx.fastify.
   *
   * Plugins must register routes and contributions synchronously in activate().
   * Async initialization belongs behind lazy route/handler setup, not in the
   * registration lifecycle.
   */
  activate(fastify: FastifyInstance, config: ServerConfig): void {
    if (this._activated) return;
    this._activated = true;

    for (const plugin of this._plugins) {
      const ctx = new PluginHostContextImpl(plugin, fastify, config);
      const result = plugin.activate(ctx);
      assertSynchronousActivation(plugin.id, result);
      this._contributions.push(ctx.getContributions());
    }
  }

  /** Apply all collected job handlers into the registry. */
  applyJobHandlers(registry: JobHandlerRegistry): void {
    for (const contrib of this._contributions) {
      for (const { jobType, handler } of contrib.jobHandlers) {
        registry.register(jobType, handler);
      }
    }
  }

  /** Return all collected scheduler tasks to be added to startBackgroundServices. */
  getSchedulerTasks(): ScheduledTask[] {
    return this._contributions.flatMap((c) => c.schedulerTasks);
  }

  /** Apply all collected proposal appliers into the registry. */
  applyProposalAppliers(registry: ProposalApplierRegistry): void {
    for (const contrib of this._contributions) {
      for (const { proposalType, applier } of contrib.proposalAppliers) {
        registry.register(proposalType, applier);
      }
    }
  }
}

function assertSynchronousActivation(
  pluginId: string,
  result: PluginActivationResult | PromiseLike<unknown>,
): asserts result is PluginActivationResult {
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    throw new Error(`plugin ${pluginId} activate() must register synchronously`);
  }
  if (!result || (result as PluginActivationResult).activated !== true) {
    throw new Error(`plugin ${pluginId} activate() did not return an activation result`);
  }
}
