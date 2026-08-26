import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { AutomationService } from "./service.js";
import { PgAutomationRepository } from "./repository.js";

export async function scanAutomationsAndFire(config: ServerConfig): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const service = new AutomationService(config, new PgAutomationRepository(db));
  return service.scanAndFire();
}
