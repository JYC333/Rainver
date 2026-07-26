import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const knowledgePromotionModule: ServerModule = { name: "knowledge_promotion", registerRoutes };

export { KnowledgePromotionCandidateService } from "./candidateService";
export { emitDomainChangeEvent, type PinnedSourceRef } from "./outbox";
export { processUnclaimedDomainChangeEvents, processAllUnclaimedDomainChangeEvents } from "./revalidationService";
