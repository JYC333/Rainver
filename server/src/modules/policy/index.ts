/**
 * Policy enforcement module.
 *
 * server policy enforcement context: the canonical action registry, hard-invariant
 * guard, rule engine, decision orchestration, and durable audit writer. Exposes
 * service-authenticated internal enforcement ports as the single policy
 * decision authority.
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const policyModule: ServerModule = {
  name: "policy",
  registerRoutes,
};

export { enforce, enforceProposalApply } from "./service.js";
export { computeDecision, checkProposalApplyPolicy } from "./gateway.js";
export { loadActionRegistry } from "./actionRegistry.js";
export { RuntimeContextPolicyRepository } from "./runtimeContextPolicyRepository.js";
export { resolveRuntimeContextPolicies } from "./runtimeContextPolicyResolver.js";
export { ExecutionControlSnapshotRepository } from "./executionControlSnapshots.js";
