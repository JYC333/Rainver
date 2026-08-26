import { registerResearchPassExecutionHandlers } from "./researchPassExecution.js";
import { registerSynthesisOnlyHandlers } from "./synthesisOnlyExecution.js";

/** Register every Project Research contribution to Automations-owned registries. */
export function registerProjectResearchExecutionHandlers(): void {
  registerResearchPassExecutionHandlers();
  registerSynthesisOnlyHandlers();
}
