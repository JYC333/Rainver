/**
 * Whether a Run's finalization is done as far as its post-run steps are
 * concerned. Owed settlement (`settlement_pending`) is: the evaluation and its
 * record are durable and the settlement sweep finishes the rest, so the steps
 * that follow a terminal Run (host thread outcome, chat turn, delegation
 * terminal, terminal reconcilers) run now, exactly once, as for a success.
 */
export function finalizedForPostRun(finalization: { status: string; error_code?: string | null }): boolean {
  return finalization.status === "succeeded" || finalization.error_code === "settlement_pending";
}
