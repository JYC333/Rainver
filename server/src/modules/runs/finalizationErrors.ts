/** Another owner is evaluating/settling this attempt; retry without holding a worker. */
export class RunFinalizationBusyError extends Error {
  readonly code = "finalization_in_progress";
  constructor() {
    super("This Run attempt is already being finalized; retry its durable completion later.");
    this.name = "RunFinalizationBusyError";
  }
}
