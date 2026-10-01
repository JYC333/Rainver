import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { DailyCaptureReportService } from "../src/modules/dailyReports/service.js";
import { PgDailyReportSettingsRepository } from "../src/modules/dailyReports/repository.js";

const SPACE = "da11da11-0000-4000-8000-000000000001";
const OWNER = "da11da11-0000-4000-8000-000000000002";
const PROJECT = "da11da11-0000-4000-8000-000000000003";

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

async function report(localDate: string) {
  const setting = await new PgDailyReportSettingsRepository(db.pool).getOrCreate(SPACE, OWNER);
  return new DailyCaptureReportService(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri })).generateForDate({
    spaceId: SPACE,
    userId: OWNER,
    setting,
    localDate,
    triggerOrigin: "manual",
  });
}

describe("daily capture report Run ownership", () => {
  it("does not create an Agent or Run when no bounded provider call is needed", async () => {
    if (!db.available) return;
    const first = await report("2026-09-10");
    expect(first).toMatchObject({ run_id: null, status: "skipped", capture_count: 0 });

    const agents = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agents WHERE space_id=$1`, [SPACE],
    );
    expect(agents.rows[0]?.count).toBe("0");
    const runs = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM runs WHERE space_id=$1`, [SPACE],
    );
    expect(runs.rows[0]?.count).toBe("0");

    const second = await report("2026-09-11");
    expect(second.run_id).toBeNull();
  });
});

describe("daily capture report schedule", () => {
  it("keeps the schedule cursor when a report finishes", async () => {
    if (!db.available) return;
    const settings = new PgDailyReportSettingsRepository(db.pool);
    await settings.getOrCreate(SPACE, OWNER);
    // Enabled while a report that began with the schedule off was running.
    const enabled = await settings.update(SPACE, OWNER, { enabled: true, local_time: "09:00", timezone: "UTC" });
    expect(enabled.next_run_at).not.toBeNull();

    await settings.recordReportCompleted(SPACE, OWNER, "2026-09-10", "2026-09-10T12:00:00.000Z");

    const after = await settings.get(SPACE, OWNER);
    expect(after).toMatchObject({ next_run_at: enabled.next_run_at, last_report_date: "2026-09-10" });
  });
});
