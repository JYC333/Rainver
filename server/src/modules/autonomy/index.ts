import type { ServerModule } from "../../gateway/routeRegistry";
import { registerAutonomousTickAutomationTarget } from "./automationTarget";
import { autonomyDiscovererRegistry } from "./registry";
import { registerAutonomyRunFinalizationReconciler } from "./finalizationReconciler";

export const autonomyModule: ServerModule = {
  name: "autonomy",
  registerRoutes: (app) => {
    registerAutonomousTickAutomationTarget();
    registerAutonomyRunFinalizationReconciler();
    app.addHook("onReady", async () => {
      autonomyDiscovererRegistry.assertComplete(["periodic_digest", "evolution_review"]);
    });
  },
};

export { AutonomyService } from "./service";
export { AutonomyRecoveryService } from "./recoveryService";
export { autonomyDiscovererRegistry } from "./registry";
