import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { DAILY_REPORTER_AGENT_KIND, DailyCaptureReportService } from "../src/modules/dailyReports/service.js";
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

describe("daily capture report Agent", () => {
  it("records a report under one system-managed Agent the Space shares and nobody owns", async () => {
    if (!db.available) return;
    // No captures that day: the report records its Run and stops before any
    // model call, which is enough to reach the Agent it is recorded under.
    const first = await report("2026-09-10");
    expect(first).toMatchObject({ status: "skipped", capture_count: 0 });

    const agents = await db.pool.query<{
      id: string; agent_kind: string; visibility: string; owner_user_id: string | null; current_version_id: string | null;
    }>(`SELECT id, agent_kind, visibility, owner_user_id, current_version_id FROM agents WHERE space_id = $1`, [SPACE]);
    expect(agents.rows).toHaveLength(1);
    expect(agents.rows[0]).toMatchObject({
      agent_kind: DAILY_REPORTER_AGENT_KIND,
      visibility: "space_shared",
      owner_user_id: null,
    });
    expect(agents.rows[0]!.current_version_id).toBeTruthy();
    const run = await db.pool.query<{ agent_id: string; agent_version_id: string }>(
      `SELECT agent_id, agent_version_id FROM runs WHERE id = $1`,
      [first.run_id],
    );
    expect(run.rows[0]).toEqual({ agent_id: agents.rows[0]!.id, agent_version_id: agents.rows[0]!.current_version_id });

    // The next report is recorded under the same Agent, not a second one.
    await report("2026-09-11");
    const after = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agents WHERE space_id = $1 AND agent_kind = $2`,
      [SPACE, DAILY_REPORTER_AGENT_KIND],
    );
    expect(after.rows[0]?.count).toBe("1");
  });
});
