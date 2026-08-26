import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedArxivSourceChain, seedResearchOperation } from "./support/researchSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { SourceBackfillExecutionService } from "../src/modules/sources/sourceBackfillExecutionService.js";

// Real-Postgres coverage for the shared item budget across sibling
// Project Research backfill plans (one plan per selected Source Monitor,
// all tagged with the same project_operation_id). A Project's configured
// max_items is a project-level total, not a per-monitor allowance, so two
// monitors selected in the same intake must not each independently get the
// full budget.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const CHANNEL_A = "88888888-8888-4888-8888-888888888888";
const CHANNEL_B = "99999999-9999-4999-8999-999999999999";
const PLAN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const PLAN_B = "bbbbbbbb-1111-4111-8111-111111111111";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["extraction_jobs", "source_backfill_segments", "source_backfill_plans", "source_quota_buckets", "project_operations", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedArxivSourceChain(db.pool, {
    connector: CONNECTOR, connection: CONNECTION, space: SPACE, owner: OWNER, now,
    channel: [{ id: CHANNEL_A, fingerprint: "fp-a" }, { id: CHANNEL_B, fingerprint: "fp-b" }],
  });
  await seedResearchOperation(db.pool, { id: OPERATION, space: SPACE, project: PROJECT, owner: OWNER, progress: { history: { max_items: 10 } }, now });
});

async function seedPlan(id: string, channelId: string, maxItems: number, itemsIngested: number, status: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_backfill_plans (
       id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
       strategy_json, quota_policy_json, status, segments_total, segments_completed, segments_failed,
       items_ingested, idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'user',$6::jsonb,$7::jsonb,$8,1,0,0,$9,$10,$11,$11)`,
    [
      id, SPACE, channelId, OPERATION, OWNER,
      JSON.stringify({ window_unit: "date_window", history_mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", window_size: 30, max_items: maxItems, direction: "backward" }),
      JSON.stringify({ window: "minute", limit_count: 10 }),
      status, itemsIngested, `idem-${id}`, now,
    ],
  );
}

async function seedStandalonePlan(id: string, channelId: string, maxItems: number, itemsIngested: number, status: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_backfill_plans (
       id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
       strategy_json, quota_policy_json, status, segments_total, segments_completed, segments_failed,
       items_ingested, idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,NULL,$4,'user',$5::jsonb,$6::jsonb,$7,1,0,0,$8,$9,$10,$10)`,
    [
      id, SPACE, channelId, OWNER,
      JSON.stringify({ window_unit: "date_window", history_mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", window_size: 30, max_items: maxItems, direction: "backward" }),
      JSON.stringify({ window: "minute", limit_count: 10 }),
      status, itemsIngested, `standalone-${id}`, now,
    ],
  );
}

async function seedSegment(id: string, planId: string, status: string, windowJson: Record<string, unknown>): Promise<void> {
  await db.pool.query(
    `INSERT INTO source_backfill_segments (id, plan_id, space_id, seq, window_json, status, attempt_count, items_ingested)
     VALUES ($1,$2,$3,0,$4::jsonb,$5,0,0)`,
    [id, planId, SPACE, JSON.stringify(windowJson), status],
  );
}

describe("SourceBackfillExecutionService shared project budget (real Postgres)", () => {
  it("caps a sibling plan's next page at the project's remaining budget, not its own full max_items", async () => {
    if (!db.available) return;
    await seedPlan(PLAN_A, CHANNEL_A, 100, 7, "completed");
    await seedPlan(PLAN_B, CHANNEL_B, 100, 0, "approved");
    await seedSegment(randomUUID(), PLAN_B, "pending", { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 });

    await new SourceBackfillExecutionService(db.pool).executeNext(SPACE, PLAN_B);

    const segment = await db.pool.query<{ window_json: { page_size?: number; max_items?: number } }>(
      `SELECT window_json FROM source_backfill_segments WHERE plan_id=$1`,
      [PLAN_B],
    );
    expect(segment.rows[0]!.window_json.page_size).toBe(3);
    expect(segment.rows[0]!.window_json.max_items).toBe(3);
  });

  it("reserves an in-flight sibling segment's page size so a concurrent dispatch can't overshoot the shared total", async () => {
    if (!db.available) return;
    await seedPlan(PLAN_A, CHANNEL_A, 100, 0, "running");
    await seedSegment(randomUUID(), PLAN_A, "running", { page_size: 9 });
    await seedPlan(PLAN_B, CHANNEL_B, 100, 0, "approved");
    await seedSegment(randomUUID(), PLAN_B, "pending", { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 });

    await new SourceBackfillExecutionService(db.pool).executeNext(SPACE, PLAN_B);

    const segment = await db.pool.query<{ window_json: { page_size?: number } }>(
      `SELECT window_json FROM source_backfill_segments WHERE plan_id=$1`,
      [PLAN_B],
    );
    expect(segment.rows[0]!.window_json.page_size).toBe(1);
  });

  it("skips a sibling's pending segment and completes the plan once the shared budget is exhausted", async () => {
    if (!db.available) return;
    await seedPlan(PLAN_A, CHANNEL_A, 100, 10, "completed");
    await seedPlan(PLAN_B, CHANNEL_B, 100, 0, "approved");
    await seedSegment(randomUUID(), PLAN_B, "pending", { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 });

    await new SourceBackfillExecutionService(db.pool).executeNext(SPACE, PLAN_B);

    const planB = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_plans WHERE id=$1`, [PLAN_B]);
    const segment = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_segments WHERE plan_id=$1`, [PLAN_B]);
    expect(segment.rows[0]!.status).toBe("skipped");
    expect(planB.rows[0]!.status).toBe("completed");
  });

  it("keeps a standalone (non-Project) plan on its own independent budget", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO source_backfill_plans (
         id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
         strategy_json, quota_policy_json, status, segments_total, segments_completed, segments_failed,
         items_ingested, idempotency_key, created_at, updated_at
       ) VALUES ($1,$2,$3,NULL,$4,'user',$5::jsonb,$6::jsonb,'approved',1,0,0,4,$7,$8,$8)`,
      [
        PLAN_A, SPACE, CHANNEL_A, OWNER,
        JSON.stringify({ window_unit: "date_window", history_mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", window_size: 30, max_items: 10, direction: "backward" }),
        JSON.stringify({ window: "minute", limit_count: 10 }),
        `idem-${PLAN_A}`, now,
      ],
    );
    await seedSegment(randomUUID(), PLAN_A, "pending", { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 });

    await new SourceBackfillExecutionService(db.pool).executeNext(SPACE, PLAN_A);

    const segment = await db.pool.query<{ window_json: { page_size?: number } }>(
      `SELECT window_json FROM source_backfill_segments WHERE plan_id=$1`,
      [PLAN_A],
    );
    expect(segment.rows[0]!.window_json.page_size).toBe(6);
  });

  it("resets a zero-yield segment back to pending and re-dispatches it, leaving already-ingested segments untouched", async () => {
    if (!db.available) return;
    await seedPlan(PLAN_A, CHANNEL_A, 10, 3, "completed");
    const segmentWithItems = randomUUID();
    const segmentZero = randomUUID();
    await db.pool.query(
      `INSERT INTO source_backfill_segments (id, plan_id, space_id, seq, window_json, status, attempt_count, items_ingested)
       VALUES ($1,$2,$3,0,$4::jsonb,'succeeded',1,3)`,
      [segmentWithItems, PLAN_A, SPACE, JSON.stringify({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z", max_items: 10 })],
    );
    await db.pool.query(
      `INSERT INTO source_backfill_segments (id, plan_id, space_id, seq, window_json, status, attempt_count, items_ingested)
       VALUES ($1,$2,$3,1,$4::jsonb,'succeeded',1,0)`,
      [segmentZero, PLAN_A, SPACE, JSON.stringify({ from: "2026-01-15T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 })],
    );

    await new SourceBackfillExecutionService(db.pool).rescanZeroYield(SPACE, PLAN_A, 0);

    const segments = await db.pool.query<{ id: string; status: string; window_json: { page_size?: number } }>(
      `SELECT id, status, window_json FROM source_backfill_segments WHERE plan_id=$1 ORDER BY seq`,
      [PLAN_A],
    );
    expect(segments.rows[0]).toMatchObject({ id: segmentWithItems, status: "succeeded" });
    expect(segments.rows[1]).toMatchObject({ id: segmentZero, status: "running" });
    expect(segments.rows[1]!.window_json.page_size).toBe(7);
    const plan = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_plans WHERE id=$1`, [PLAN_A]);
    expect(plan.rows[0]!.status).toBe("running");
  });

  it("raises the budget by the requested additional items before re-dispatching", async () => {
    if (!db.available) return;
    await seedStandalonePlan(PLAN_A, CHANNEL_A, 5, 5, "completed");
    await seedSegment(randomUUID(), PLAN_A, "succeeded", { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 5 });

    await new SourceBackfillExecutionService(db.pool).rescanZeroYield(SPACE, PLAN_A, 10);

    const plan = await db.pool.query<{ strategy_json: { max_items?: number } }>(`SELECT strategy_json FROM source_backfill_plans WHERE id=$1`, [PLAN_A]);
    expect(plan.rows[0]!.strategy_json.max_items).toBe(15);
    const segment = await db.pool.query<{ window_json: { page_size?: number } }>(`SELECT window_json FROM source_backfill_segments WHERE plan_id=$1`, [PLAN_A]);
    expect(segment.rows[0]!.window_json.page_size).toBe(10);
  });

  it("continues a Project Research partial from the operation budget without updating the plan mirror", async () => {
    if (!db.available) return;
    await seedPlan(PLAN_A, CHANNEL_A, 100, 7, "completed");
    await seedSegment(randomUUID(), PLAN_A, "succeeded", {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      partial: true,
      exhausted: false,
      cursor: 7,
    });

    await new SourceBackfillExecutionService(db.pool).continuePartial(SPACE, PLAN_A, 3);

    const plan = await db.pool.query<{ strategy_json: { max_items?: number } }>(
      `SELECT strategy_json FROM source_backfill_plans WHERE id=$1`,
      [PLAN_A],
    );
    expect(plan.rows[0]!.strategy_json.max_items).toBe(100);
    const segment = await db.pool.query<{ status: string; window_json: { page_size?: number } }>(
      `SELECT status, window_json FROM source_backfill_segments WHERE plan_id=$1`,
      [PLAN_A],
    );
    expect(segment.rows[0]!.status).toBe("running");
    expect(segment.rows[0]!.window_json.page_size).toBe(3);
  });

  it("raises the budget on a still-running plan without dispatching anything, since its own loop rebuilds the request from the live channel query next time it schedules a segment", async () => {
    if (!db.available) return;
    await seedStandalonePlan(PLAN_A, CHANNEL_A, 10, 4, "approved");
    const segmentId = randomUUID();
    await seedSegment(segmentId, PLAN_A, "pending", { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 });

    await new SourceBackfillExecutionService(db.pool).rescanZeroYield(SPACE, PLAN_A, 6);

    const plan = await db.pool.query<{ status: string; strategy_json: { max_items?: number } }>(
      `SELECT status, strategy_json FROM source_backfill_plans WHERE id=$1`,
      [PLAN_A],
    );
    expect(plan.rows[0]!.status).toBe("approved");
    expect(plan.rows[0]!.strategy_json.max_items).toBe(16);
    const segment = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_segments WHERE id=$1`, [segmentId]);
    expect(segment.rows[0]!.status).toBe("pending");
  });

  it("rejects budget changes on a Project Research plan instead of writing a plan mirror", async () => {
    if (!db.available) return;
    await seedPlan(PLAN_A, CHANNEL_A, 100, 4, "approved");

    await expect(new SourceBackfillExecutionService(db.pool).rescanZeroYield(SPACE, PLAN_A, 6)).rejects.toThrow(
      "Project Research item limits are owned by the operation",
    );
    const plan = await db.pool.query<{ strategy_json: { max_items?: number } }>(
      `SELECT strategy_json FROM source_backfill_plans WHERE id=$1`,
      [PLAN_A],
    );
    expect(plan.rows[0]!.strategy_json.max_items).toBe(100);
  });

  it("rejects rescanning a plan in a terminal non-completed status", async () => {
    if (!db.available) return;
    await seedStandalonePlan(PLAN_A, CHANNEL_A, 10, 0, "failed");

    await expect(new SourceBackfillExecutionService(db.pool).rescanZeroYield(SPACE, PLAN_A, 0)).rejects.toThrow(
      "Cannot adjust the item budget for a source backfill plan in status failed",
    );
  });
});
