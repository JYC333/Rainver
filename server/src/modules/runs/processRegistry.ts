import { LocalCliProcessRegistry } from "./localCliExecution";

/**
 * Process-wide active-execution registry. CLI adapters register their Runner
 * process callbacks here; managed API adapters register an AbortController
 * through the same callback seam. A cancel from any other request or worker
 * in this OS process can therefore stop either kind of in-flight execution.
 *
 * Like the Runner process registry it replaces, this is deliberately
 * process-local. Deployments that split job execution across server processes
 * must route execute/cancel for a Run to the same worker or add a distributed
 * cancellation transport.
 */
export const sharedCliProcessRegistry = new LocalCliProcessRegistry();
