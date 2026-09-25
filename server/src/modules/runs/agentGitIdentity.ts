import type { HostGitIdentity } from "@rainver/protocol";

/**
 * The Agent as git sees it, on every commit Rainver writes for it — a Run's
 * settle on the Task branch, a done Task's squashed commit. The address is
 * under `.invalid` (RFC 2606): it names the Agent and reaches nobody, so a
 * pushed branch never carries an address anyone owns.
 */
export function agentGitIdentity(agentId: string | null, agentName: string | null): HostGitIdentity {
  const name = (agentName ?? "").replace(/\s+/g, " ").trim() || "Rainver Agent";
  return { name: name.slice(0, 256), email: `${agentId ?? "agent"}@agents.rainver.invalid` };
}
