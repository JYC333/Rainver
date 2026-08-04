import { automationTargetHandlerRegistry } from "./targetRegistry";

export function registerAutomationOwnedTargetHandlers(): void {
  automationTargetHandlerRegistry.register("agent_run", {
    preflight: ({ host, input }) => host.preflightAgentRun(input),
    execute: ({ host, ...context }) => host.executeAgentRun({ host, ...context }),
  });
  automationTargetHandlerRegistry.register("workflow", {
    preflight: ({ host, input }) => host.preflightWorkflow(input),
    execute: ({ host, ...context }) => host.executeWorkflow({ host, ...context }),
  });
}
