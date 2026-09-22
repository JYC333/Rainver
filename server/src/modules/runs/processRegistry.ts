import { LocalCliProcessRegistry } from "./localCliExecution.js";

/**
 * Process-wide active-execution registry. ACP execution registers the callbacks
 * that stop the runtime process a Run is talking to, so a cancel arriving on
 * any other request or worker in this OS process can reach in-flight execution.
 *
 * Like the Runner process registry it replaces, this is deliberately
 * process-local. Deployments that split job execution across server processes
 * must route execute/cancel for a Run to the same worker or add a distributed
 * cancellation transport.
 */
export const sharedCliProcessRegistry = new LocalCliProcessRegistry();
