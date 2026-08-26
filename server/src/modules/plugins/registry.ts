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

export function listOfficialPlugins(): readonly OfficialPluginDescriptor[] {
  return OFFICIAL_PLUGINS;
}

export function getOfficialPlugin(pluginId: string): OfficialPluginDescriptor | undefined {
  return PLUGIN_MAP.get(pluginId);
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
