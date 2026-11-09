import type { RuntimeStateBoundary } from "../runtimeAdapters/specs.js";

/**
 * State boundaries of registry agents, by registry id.
 *
 * The ACP registry says how an agent is obtained and launched, not where it
 * keeps its state or its credential — and nothing infers that: each product
 * decides it. Without a boundary an enabled agent can be installed and
 * logged in but not dispatched to, because Rainver cannot give each Agent
 * its own state root while sharing the login (B68). An entry here is the
 * two facts that unlock dispatch; the rest of the adapter stays what the
 * registry entry generates. Verified against the product's own source or
 * documentation — a wrong credential path silently breaks login sharing.
 * Retire an entry when the registry starts carrying this itself.
 */
export const ACP_AGENT_STATE_BOUNDARIES: Readonly<Record<string, RuntimeStateBoundary>> = {
  "antigravity-acp": {
    env: { RAINVER_ANTIGRAVITY_STATE_DIR: ".gemini" },
    home_subdir: ".gemini/antigravity-cli",
    credential_file: "antigravity-oauth-token",
  },
};

export function acpAgentStateBoundary(registryId: string): RuntimeStateBoundary | undefined {
  return ACP_AGENT_STATE_BOUNDARIES[registryId];
}
