import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";
export { __setRoomServiceFactoryForTests } from "./routes";

export const roomsModule: ServerModule = {
  name: "rooms",
  registerRoutes,
};

export { PgRoomRepository } from "./repository";
export { RoomService } from "./service";
