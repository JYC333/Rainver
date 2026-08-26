import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerAutonomousTickAutomationTarget } from "./automationTarget.js";
import { autonomyDiscovererRegistry } from "./registry.js";
import { registerAutonomyRunFinalizationReconciler } from "./finalizationReconciler.js";

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

export { AutonomyService } from "./service.js";
export { AutonomyRecoveryService } from "./recoveryService.js";
export { autonomyDiscovererRegistry } from "./registry.js";
