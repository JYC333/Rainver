import { JobDeferredError } from "../jobs/handlerRegistry.js";

/**
 * Whether a Run's finalization is done as far as its post-run steps are
 * concerned. Owed settlement (`settlement_pending`) is: the evaluation and its
 * record are durable and the settlement sweep finishes the rest, so the steps
 * that follow a terminal Run (chat turn and delegation terminal) may run now.
 * Host thread release and domain projections belong to durable settlement.
 */
export function finalizedForPostRun(finalization: { status: string; error_code?: string | null }): boolean {
  return finalization.status === "succeeded" || finalization.error_code === "settlement_pending";
}
/** Contention is completion work still owned elsewhere, never another model attempt. */
export function requireFinalizedForPostRun(finalization: { status: string; error_code?: string | null; error_message?: string | null }): void {
  if (finalization.error_code === "finalization_in_progress") {
    throw new JobDeferredError(finalization.error_message ?? "Run finalization is already in progress", 1_000);
  }
  if (!finalizedForPostRun(finalization)) throw new Error(finalization.error_message ?? "Run finalization reconciliation failed.");
}
