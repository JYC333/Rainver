import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { openAiChatResponse } from "./support/piAiHttp.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { __setProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { dailyReportsModule } from "../src/modules/dailyReports/index.js";
import { DailyCaptureReportService } from "../src/modules/dailyReports/service.js";
import { PgDailyReportSettingsRepository } from "../src/modules/dailyReports/repository.js";

const SPACE = "da11da11-0000-4000-8000-000000000001";
const OWNER = "da11da11-0000-4000-8000-000000000002";
const PROJECT = "da11da11-0000-4000-8000-000000000003";
const PROVIDER = "da11da11-0000-4000-8000-000000000004";

const db = useTestDatabase(import.meta.filename);
const config = () => loadConfig({
  ...process.env,
  SERVER_DATABASE_URL: db.connectionUri,
  RAINVER_HOME: "/tmp/rainver-daily-reports-test",
  SERVER_DEBUG: "false",
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["activity_records", "artifacts", "proposals", "model_provider_space_grants", "model_providers", "runs", "agent_versions", "agents", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

afterEach(() => {
  __setProviderHttpClientForTests(null);
  __setAuthIdentityForTests(null);
});

async function report(localDate: string, force = false) {
  const setting = await new PgDailyReportSettingsRepository(db.pool).getOrCreate(SPACE, OWNER);
  return new DailyCaptureReportService(db.pool, config()).generateForDate({
    spaceId: SPACE,
    userId: OWNER,
    setting,
    localDate,
    triggerOrigin: "manual",
    force,
  });
}

/** A default provider with a pool key, so the bounded report task reaches the scripted HTTP fake. */
async function seedProvider(): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`,
    [PROVIDER, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
    [randomUUID(), PROVIDER, SPACE, OWNER, now],
  );
  await resolveProviderCommandStore(config()).addPoolCredential(SPACE, OWNER, PROVIDER, { api_key: "test-daily-report-key" });
}

async function seedCapture(occurredAt: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, activity_type, title, content,
        payload_json, status, visibility, occurred_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'user_capture', 'Captured thought', 'The body of the thought.',
             '{}'::jsonb, 'raw', 'private', $4, $4, $4)`,
    [id, SPACE, OWNER, occurredAt],
  );
  return id;
}

function scriptedReport(body: Record<string, unknown>): void {
  __setProviderHttpClientForTests({
    fetch: async () => openAiChatResponse({
      choices: [{ message: { content: JSON.stringify({ report_title: "Day", overview: "Overview", ...body }) } }],
      model: "test-model",
      usage: {},
    }),
  });
}

async function countRows(table: string, where = ""): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE space_id=$1 ${where}`, [SPACE],
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("daily capture report Run ownership", () => {
  it("does not create an Agent or Run when no bounded provider call is needed", async () => {
    if (!db.available) return;
    const first = await report("2026-09-10");
    expect(first).toMatchObject({ run_id: null, status: "skipped", capture_count: 0 });

    expect(await countRows("agents")).toBe(0);
    expect(await countRows("runs")).toBe(0);

    const second = await report("2026-09-11");
    expect(second.run_id).toBeNull();
  });
});

describe("daily capture report persistence", () => {
  it("keeps one report per day when a second generation finishes while the first is still at the provider", async () => {
    if (!db.available) return;
    await seedProvider();
    await seedCapture("2026-09-12T10:00:00.000Z");
    const settings = new PgDailyReportSettingsRepository(db.pool);
    const setting = await settings.getOrCreate(SPACE, OWNER);
    const service = new DailyCaptureReportService(db.pool, config());
    const generate = () => service.generateForDate({
      spaceId: SPACE, userId: OWNER, setting, localDate: "2026-09-12", triggerOrigin: "manual",
    });

    // The first generation's provider call is where the race lives: a second
    // generation for the same day passes the existence check meanwhile, calls
    // the provider, and persists first.
    let overlapped: Promise<unknown> | null = null;
    __setProviderHttpClientForTests({
      fetch: async () => {
        if (!overlapped) {
          overlapped = generate();
          await overlapped;
        }
        return openAiChatResponse({
          choices: [{ message: { content: JSON.stringify({ report_title: "Day", overview: "Overview" }) } }],
          model: "test-model",
          usage: {},
        });
      },
    });

    const second = await generate();
    const first = await overlapped!;
    expect(first).toMatchObject({ status: "succeeded" });
    expect(await countRows("artifacts", "AND artifact_type='daily_capture_report'")).toBe(1);
    expect(second).toMatchObject({
      status: "skipped",
      skipped: true,
      existing_artifact_id: (first as { artifact_id: string }).artifact_id,
    });
  });

  it("fills the daily proposal cap from the qualifying candidates, not from the first few", async () => {
    if (!db.available) return;
    await seedProvider();
    const capture = await seedCapture("2026-09-13T10:00:00.000Z");
    const settings = new PgDailyReportSettingsRepository(db.pool);
    await settings.update(SPACE, OWNER, {
      create_memory_proposals: true,
      create_experience_proposals: false,
      max_memory_proposals_per_day: 1,
      memory_confidence_threshold: 0.7,
    });
    const low = (title: string) => ({ title, content: title, memory_type: "preference", confidence: 0.5, source_activity_ids: [capture] });
    scriptedReport({
      memory_candidates: [
        low("Too uncertain"),
        low("Also too uncertain"),
        { title: "Confident", content: "Confident", memory_type: "preference", confidence: 0.95, source_activity_ids: [capture] },
        { title: "Over the cap", content: "Over", memory_type: "preference", confidence: 0.9, source_activity_ids: [capture] },
      ],
    });

    const result = await report("2026-09-13");
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.memory_proposal_ids).toHaveLength(1);
    const proposals = await db.pool.query<{ title: string }>(
      `SELECT title FROM proposals WHERE space_id=$1 AND proposal_type='memory_create'`, [SPACE],
    );
    expect(proposals.rows.map((row) => row.title)).toEqual(["Confident"]);
  });
});

describe("daily capture report routes", () => {
  it("refuses a report list limit that is not a positive integer", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    const app = buildModuleServer(config(), [dailyReportsModule]);
    try {
      for (const limit of ["abc", "-1", "1.5", "0"]) {
        const response = await app.inject({ method: "GET", url: `/api/v1/daily-capture-report/reports?limit=${limit}` });
        expect(response.statusCode, limit).toBe(422);
      }
      const ok = await app.inject({ method: "GET", url: "/api/v1/daily-capture-report/reports?limit=5" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual([]);
    } finally {
      await app.close();
    }
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
