/**
 * The single site that chooses which `ManagedAgentLoopPort` implementation the
 * server runs. Callers depend on the port and import from here; nothing else
 * imports the implementation module directly.
 */
import type { ManagedAgentLoopPort } from "./managedAgentLoopPort.js";
import { piManagedAgentLoop } from "./piManagedAgentLoop.js";

export const managedAgentLoop: ManagedAgentLoopPort = piManagedAgentLoop;
