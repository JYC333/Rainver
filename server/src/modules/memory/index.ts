import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const memoryModule: ServerModule = {
  name: "memory",
  registerRoutes,
};

export {
  __setMemoryIdentityForTests,
  __setMemoryServicesFactoryForTests,
} from "./routes.js";

export { MemoryMaintenanceService } from "./maintenance.js";
export {
  MEMORY_MAINTENANCE_PACKET_PROPOSAL_TYPE,
  MEMORY_MAINTENANCE_REPORT_ARTIFACT_TYPE,
  createMemoryMaintenanceProposalPacket,
  persistMemoryMaintenanceReportArtifact,
  registerMemoryMaintenanceProposalAppliers,
} from "./maintenanceArtifacts.js";
