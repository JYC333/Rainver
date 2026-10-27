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
  // `GEMINI_HOME` names the `.gemini` directory itself; the ACP server keeps
  // its own credential apart from the Antigravity IDE's and CLI's under
  // `antigravity-acp/` (acp_server/paths.py in the published archive).
  "antigravity-acp": {
    env: { GEMINI_HOME: ".gemini" },
    home_subdir: ".gemini/antigravity-acp",
    credential_file: "acp_token.json",
  },
};

export function acpAgentStateBoundary(registryId: string): RuntimeStateBoundary | undefined {
  return ACP_AGENT_STATE_BOUNDARIES[registryId];
}
