import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const knowledgePromotionModule: ServerModule = { name: "knowledge_promotion", registerRoutes };

export { KnowledgePromotionCandidateService } from "./candidateService.js";
export { emitDomainChangeEvent, type PinnedSourceRef } from "./outbox.js";
export { processUnclaimedDomainChangeEvents, processAllUnclaimedDomainChangeEvents } from "./revalidationService.js";
