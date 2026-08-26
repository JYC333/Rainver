import type { SystemActionId } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { RunRecord } from "../runs/repository.js";
import type { SystemActionExecutor } from "./gateway.js";
import { registerInquirySystemActionExecutors } from "../inquiry/inquirySystemActionExecutors.js";
import { registerKnowledgePromotionSystemActionExecutors } from "../knowledgePromotion/knowledgePromotionSystemActionExecutors.js";
import { registerProjectResearchSystemActionExecutors } from "../projectResearch/projectResearchSystemActionExecutors.js";
import { registerSourcesSystemActionExecutors } from "../sources/sourcesSystemActionExecutors.js";
import { registerProjectsSystemActionExecutors } from "../projects/projectsSystemActionExecutors.js";
import { registerPlansSystemActionExecutors } from "../plans/plansSystemActionExecutors.js";
import { registerPolicySystemActionExecutors } from "../policy/policySystemActionExecutors.js";

/**
 * Central import of per-module `registerXxxSystemActionExecutors` functions,
 * mirroring `proposals/applierRegistry.ts` (action authority consolidation
 * plan, D4). Owning modules register their own System Action executors here
 * instead of `SystemActionDispatcher` hand-maintaining them; adding an
 * executor means adding one call, not editing the dispatcher.
 *
 * `granted` carries each family's own pre-check (mirroring what the
 * dispatcher already computed to decide whether it is worth resolving a
 * database pool at all) — the two families gate independently because a
 * Run can hold one without the other.
 */
export function registerModuleSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
  granted: { generic: boolean; researchAcquisition: boolean },
): void {
  if (granted.generic && config.databaseUrl && run.instructed_by_user_id) {
    registerInquirySystemActionExecutors(executors, config, run);
    registerKnowledgePromotionSystemActionExecutors(executors, config, run);
    registerSourcesSystemActionExecutors(executors, config, run);
    registerProjectsSystemActionExecutors(executors, config, run);
    registerPlansSystemActionExecutors(executors, config, run);
    registerPolicySystemActionExecutors(executors, config, run);
  }
  if (granted.researchAcquisition && config.databaseUrl && run.instructed_by_user_id) {
    registerProjectResearchSystemActionExecutors(executors, config, run);
  }
}
