import { providerProxyLeases } from "../providers/proxy/lease.js";
import { sharedHostConnectionRegistry } from "./connectionRegistry.js";

/**
 * The process-local consequences of a revoked Host: its live socket closes,
 * a hello still in flight is refused, and provider-proxy leases stop. The
 * revoke itself is the committed `hosts.status = 'revoked'`; this is only its
 * immediate reach. A connection this process missed is cut at its next
 * heartbeat, which finds the row revoked (`routes.ts`).
 */
export function cutOffRevokedHost(hostId: string): void {
  sharedHostConnectionRegistry.closeConnection(hostId, 1008, "host_revoked");
  sharedHostConnectionRegistry.forgetRevokedHost(hostId);
  providerProxyLeases.revokeHost(hostId);
}
