/**
 * PluginHost — loads and activates official plugins at server startup.
 *
 * Bundled official plugin source lives under plugins/official/*, is compiled
 * into dist/official-plugins/*, and loaded into BUILT_IN_PLUGINS at startup.
 * Package install state and schema are created only by the installer.
 * Remote package download is not implemented.
 *
 * Usage (in server startup):
 *   const host = new PluginHost(BUILT_IN_PLUGINS)
 *   host.activate(fastify, config)                // during registerServerRoutes
 *   host.applyJobHandlers(jobHandlerRegistry)      // during buildJobHandlerRegistry
 *   host.getSchedulerTasks()                       // during startBackgroundServices
 *   host.applyProposalAppliers(proposalRegistry)   // during createDefaultProposalApplierRegistry
 */

import {registerPluginLifecycle} from "../lifecycle.js";
import {PluginBackground} from "../background.js";
import {pluginProposalContributions,registerPluginProposalContributor} from "../proposalContributions.js";
import {pluginOrder} from "../dependencies.js";
import { composePluginOperations, validateOperationPlugin, installOperationContributions } from "../operationRegistry.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import type { FastifyInstance } from "fastify";
import type {
  RainverPlugin,
  PluginActivationResult,
} from "@rainver/protocol";
import type { JobHandlerRegistry } from "../../jobs/handlerRegistry.js";
import type { ScheduledTask } from "../../scheduler/registry.js";
import type { ProposalApplierRegistry } from "../../proposals/applierRegistry.js";
import type { ServerConfig } from "../../../config.js";
import { PluginHostContextImpl, type PluginContributions } from "./context.js";

export class PluginHost {
  private readonly _plugins: readonly RainverPlugin[];
  private _contributions: PluginContributions[] = [];
  private _activated = false;
  private readonly backgrounds=new Map<string,PluginBackground>();
  getBackground(id:string){return this.backgrounds.get(id);}
  private _pending:readonly string[]=[];
  get pendingPluginIds(){return this._pending;}

  constructor(plugins: readonly RainverPlugin[]) {
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
    const operations:OperationRegistration[]=[];
    const ids=new Set<string>();
    for(const plugin of this._plugins){if(ids.has(plugin.id))throw new Error("Duplicate plugin");ids.add(plugin.id);if(plugin.operationManifest)validateOperationPlugin(plugin);}

    const normalized=this._plugins.map(p=>p.operationManifest?{...p,operationManifest:validateOperationPlugin(p)}:p);
    const topology=pluginOrder(normalized);
    this._pending=topology.pending;
    for (const plugin of topology.ordered) {
      const ctx = new PluginHostContextImpl(plugin, fastify, config);
      let background:PluginBackground|undefined;
      if(plugin.operationManifest){
        background=new PluginBackground(config,plugin);
        this.backgrounds.set(plugin.id,background);
        Object.assign(ctx,{lifecycle:background.port});
        // Operation packages have no raw HTTP route or legacy job/proposal registration escape.
        Object.assign(ctx,{fastify:Object.freeze({}),http:Object.freeze({}),jobs:Object.freeze({}),scheduler:Object.freeze({}),proposals:Object.freeze({})});
      }
      const result = plugin.activate(ctx);
      assertSynchronousActivation(plugin.id, result);
      if(plugin.operationManifest){
        background!.validate();
        operations.push(...composePluginOperations(config,plugin,ctx.operationExecutors,background));
        ctx.getContributions().jobHandlers.push(...[...background!.jobs].map(([jobType,handler])=>({jobType,handler})));
        ctx.getContributions().schedulerTasks.push(...background!.tasks);
        ctx.getContributions().proposalAppliers.push(...pluginProposalContributions(config,plugin,background!));
      }
      this._contributions.push(ctx.getContributions());
    }
    const release=installOperationContributions(config,normalized,operations);
    const releaseLifecycle=registerPluginLifecycle(config,this.backgrounds);
    const releaseProposals=registerPluginProposalContributor(config,this);
    fastify.addHook("onClose",async()=>{const errors:unknown[]=[];try{for(const b of [...this.backgrounds.values()].reverse())try{await b.close();}catch(e){errors.push(e);}}finally{releaseProposals();releaseLifecycle();release();}if(errors.length)throw new AggregateError(errors,"Plugin shutdown cleanup failed");});
    this._activated=true;
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
      for (const { proposalType, applier,payloadSchema } of contrib.proposalAppliers) {
        registry.register(proposalType, applier,payloadSchema);
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
