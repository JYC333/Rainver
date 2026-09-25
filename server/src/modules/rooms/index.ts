import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
import { registerDiscussionRoutes } from "./discussionRoutes.js";
import { registerQuotaRoutes } from "./quotaRoutes.js";
export { __setRoomServiceFactoryForTests } from "./routes.js";

export const roomsModule: ServerModule = {
  name: "rooms",
  registerRoutes: (app, context) => {
    registerRoutes(app, context);
    registerDiscussionRoutes(app, context);
    registerQuotaRoutes(app, context);
  },
};

export { PgRoomRepository } from "./repository.js";
export { RoomService } from "./service.js";
