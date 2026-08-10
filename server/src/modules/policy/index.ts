/**
 * Policy enforcement module.
 *
 * server policy enforcement context: the canonical action registry, hard-invariant
 * guard, rule engine, decision orchestration, and durable audit writer. Exposes
 * service-authenticated internal enforcement ports as the single policy
 * decision authority.
 */

import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const policyModule: ServerModule = {
  name: "policy",
  registerRoutes,
};

export { enforce, enforceProposalApply } from "./service";
export { computeDecision, checkProposalApplyPolicy } from "./gateway";
export { loadActionRegistry } from "./actionRegistry";
export { RuntimeContextPolicyRepository } from "./runtimeContextPolicyRepository";
export { resolveRuntimeContextPolicies } from "./runtimeContextPolicyResolver";
export { ExecutionControlSnapshotRepository } from "./executionControlSnapshots";
