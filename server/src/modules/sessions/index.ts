import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const sessionsModule: ServerModule = {
  name: "sessions",
  registerRoutes,
};

export {
  __setExecutionContextServiceFactoryForTests,
  __setSessionIdentityForTests,
  __setSessionServicesFactoryForTests,
} from "./routes.js";

export { visibleRoomTranscriptSql, visibleMessagePathSql } from "./messagePath.js";
export { openHumanQuestionSql } from "./messagePath.js";
export { attentionSessionReadSql } from "./attentionRead.js";
