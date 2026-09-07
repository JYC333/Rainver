import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { instanceUpdatePending } from "../deployment/drainAdmission.js";
import { AutomationService } from "./service.js";
import { PgAutomationRepository } from "./repository.js";

export async function scanAutomationsAndFire(config: ServerConfig): Promise<number> {
  if (!config.databaseUrl) return 0;
  // ADR 0020 section 4: while an instance update waits or drains, a due
  // automation stays due. Skipping the whole tick is what makes this a
  // deferral — the next tick fires it, no schedule advances, no Run is
  // created or failed, and no automation target learns about deployment.
  if (await instanceUpdatePending(config)) return 0;
  const db = getDbPool(config.databaseUrl);
  const service = new AutomationService(config, new PgAutomationRepository(db));
  return service.scanAndFire();
}
