import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";
export { __setRoomServiceFactoryForTests } from "./routes.js";

export const roomsModule: ServerModule = {
  name: "rooms",
  registerRoutes,
};

export { PgRoomRepository } from "./repository.js";
export { RoomService } from "./service.js";
