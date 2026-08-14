import { registerResearchPassExecutionHandlers } from "./researchPassExecution";
import { registerSynthesisOnlyHandlers } from "./synthesisOnlyExecution";

/** Register every Project Research contribution to Automations-owned registries. */
export function registerProjectResearchExecutionHandlers(): void {
  registerResearchPassExecutionHandlers();
  registerSynthesisOnlyHandlers();
}
