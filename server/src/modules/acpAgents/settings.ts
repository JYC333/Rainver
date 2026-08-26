import { SETTINGS_KEYS } from "../settings/keys.js";
import { defineScopedSetting, settingsRecord } from "../settings/scopedSettings.js";
import { parseEntry, type AcpRegistryEntry } from "./registry.js";

/**
 * An agent an operator enabled, as a snapshot of the registry entry at that
 * moment. A snapshot rather than a reference: the registry moves, and what
 * a host was told to install must stay what the server dispatches to until
 * someone chooses to update it.
 */
export interface EnabledAcpAgent extends AcpRegistryEntry {
  enabled_at: string;
  enabled_by_user_id: string | null;
}

export interface AcpAgentsSettingsValue {
  agents: EnabledAcpAgent[];
}

export const ACP_AGENTS_SETTINGS = defineScopedSetting<AcpAgentsSettingsValue>({
  key: SETTINGS_KEYS.acpAgents,
  scopeType: "instance",
  defaults: { agents: [] },
  parse(value) {
    const agents = settingsRecord(value).agents;
    return {
      agents: (Array.isArray(agents) ? agents : []).flatMap((raw) => {
        const entry = parseEntry(raw);
        if (!entry) return [];
        const meta = settingsRecord(raw);
        return [{
          ...entry,
          enabled_at: typeof meta.enabled_at === "string" ? meta.enabled_at : new Date(0).toISOString(),
          enabled_by_user_id: typeof meta.enabled_by_user_id === "string" ? meta.enabled_by_user_id : null,
        }];
      }),
    };
  },
  serialize: (value) => ({ agents: value.agents }),
});

/** The settings row for the whole instance. */
export const ACP_AGENTS_SCOPE_ID = "instance";

/** The registry entries builtin adapters are installed from, as last fetched. */
export interface AcpRegistryCacheValue {
  entries: AcpRegistryEntry[];
  fetched_at: string | null;
}

export const ACP_REGISTRY_CACHE_SETTINGS = defineScopedSetting<AcpRegistryCacheValue>({
  key: SETTINGS_KEYS.acpRegistryCache,
  scopeType: "instance",
  defaults: { entries: [], fetched_at: null },
  parse(value) {
    const record = settingsRecord(value);
    return {
      entries: (Array.isArray(record.entries) ? record.entries : []).flatMap((raw) => { const entry = parseEntry(raw); return entry ? [entry] : []; }),
      fetched_at: typeof record.fetched_at === "string" ? record.fetched_at : null,
    };
  },
  serialize: (value) => ({ entries: value.entries, fetched_at: value.fetched_at }),
});
