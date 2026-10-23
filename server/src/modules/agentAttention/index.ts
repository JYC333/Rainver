import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
export const agentAttentionModule: ServerModule = { name: "agentAttention", registerRoutes };

export { readAttentionSnapshot, attentionBaseline, type AttentionSnapshot } from "./snapshot.js";
