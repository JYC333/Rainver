import type { ServerConfig } from "../../config.js";
import type { OfficialPluginDescriptor } from "@rainver/protocol";
import { diaryDescriptor } from "./official/diary.js";
import { financeLedgerDescriptor } from "./official/financeLedger.js";

/**
 * Static in-memory registry of official optional modules bundled with this
 * codebase. Pure data — no DB access, no side effects.
 *
 * To add a new official optional module:
 *   1. Create its descriptor under `official/<pluginId>.ts`.
 *   2. Add it to OFFICIAL_PLUGINS below.
 *   3. Add its package under `plugins/official/<plugin-id>/` if it contributes
 *      routes, jobs, scheduled tasks, or proposal appliers.
 *   4. Add a frontend entry in the web module registry (apps/web modules/registry.ts).
 *   5. Add installer-managed plugin migrations for any plugin-owned domain tables.
 */
const OFFICIAL_PLUGINS: readonly OfficialPluginDescriptor[] = [
  diaryDescriptor,
  financeLedgerDescriptor,
];

/** All registered official plugin descriptors, indexed by id for O(1) lookup. */
const PLUGIN_MAP = new Map<string, OfficialPluginDescriptor>(
  OFFICIAL_PLUGINS.map((d) => [d.id, d]),
);

export function listOfficialPlugins(config?:ServerConfig): readonly OfficialPluginDescriptor[] {
  return [...OFFICIAL_PLUGINS,...(config ? operationDescriptors.get(config)?.values() ?? [] : [])];
}

export function getOfficialPlugin(pluginId: string,config?:ServerConfig): OfficialPluginDescriptor | undefined {
  return PLUGIN_MAP.get(pluginId) ?? (config ? operationDescriptors.get(config)?.get(pluginId) : undefined);
}

/** Validates that no two descriptors share the same id. Throws at startup if violated. */
export function assertPluginRegistryIntegrity(): void {
  const ids = OFFICIAL_PLUGINS.map((d) => d.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`OfficialPluginRegistry: duplicate plugin id "${id}"`);
    }
    seen.add(id);
  }
}

const contractsByConfig=new WeakMap<ServerConfig,ReadonlyMap<string,string>>();
export function operationContract(id:string,config?:ServerConfig){return config?contractsByConfig.get(config)?.get(id):undefined;}
const pendingByConfig=new WeakMap<ServerConfig,ReadonlySet<string>>();
export function operationPluginPending(id:string,config?:ServerConfig){return !!config&&!!pendingByConfig.get(config)?.has(id);}
const operationDescriptors=new WeakMap<ServerConfig,Map<string,OfficialPluginDescriptor>>();
export function registerOperationDescriptors(config:ServerConfig,descriptors:readonly OfficialPluginDescriptor[],pending:readonly string[]=[],contracts:ReadonlyMap<string,string>=new Map()):()=>void{
  const ids=new Set<string>();
  for(const d of descriptors){if(ids.has(d.id)||getOfficialPlugin(d.id,config))throw new Error('Plugin descriptor collision');ids.add(d.id);}
  const map=new Map(descriptors.map(d=>[d.id,d]));
  operationDescriptors.set(config,map);pendingByConfig.set(config,new Set(pending));contractsByConfig.set(config,contracts);
  return ()=>{operationDescriptors.delete(config);pendingByConfig.delete(config);contractsByConfig.delete(config);};
}
