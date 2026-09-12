import type { RiskLevel } from "../policy/decisions.js";

export class RunPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunPreparationError";
  }
}

/**
 * Thrown when a policy gate returns `require_approval` (not `deny`).
 * The outer executeRun catch transitions the run to `waiting_for_review`
 * rather than `failed`, and stores the approval code so a resume can bypass
 * the same check on re-execution.
 */
export class RunApprovalRequiredError extends Error {
  /** `riskLevel` is the gate's risk, which decides who may grant the approval. */
  constructor(readonly code: string, message: string, readonly riskLevel: RiskLevel) {
    super(message);
    this.name = "RunApprovalRequiredError";
  }
}
