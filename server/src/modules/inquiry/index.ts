import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const inquiryModule: ServerModule = { name: "inquiry", registerRoutes };
