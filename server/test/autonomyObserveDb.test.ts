import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { autonomyDiscovererRegistry } from "../src/modules/autonomy/registry.js";
import { AutonomyService } from "../src/modules/autonomy/service.js";
import { registerPeriodicDigestAutonomyDiscoverer } from "../src/modules/projects/autonomyDiscoverer.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const AUTOMATION = "55555555-5555-4555-8555-555555555555";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-07-26T12:00:00.000Z");

const sharedPostgres = inject("sharedPostgres");
const describeWithPostgres = describe.skipIf(
  !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
);

const db = useTestDatabase(import.meta.filename, { max: 5 });

beforeEach(async () => {
  if (!db.pool) return;
  autonomyDiscovererRegistry.__resetForTests();
  registerPeriodicDigestAutonomyDiscoverer();
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  const now = NOW.toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Autonomy Owner', 'active', $2, $2)`,
    [USER, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Autonomy Space', 'personal', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       visibility, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Autonomy Agent', 'active', NULL, 'private', $4, $4)`,
    [AGENT, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
  await db.pool.query(
    `INSERT INTO automations (
       id, space_id, owner_user_id, agent_id, name, trigger_type, status,
       config_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Autonomous tick', 'schedule', 'active',
               '{"target_type":"autonomous_tick","observe_only":true}'::jsonb, $5, $5)`,
    [AUTOMATION, SPACE, USER, AGENT, now],
  );
});

describeWithPostgres("observe-only autonomy candidate lifecycle", () => {
  it("deduplicates one logical candidate across repeated and concurrent ticks without creating a Run", async () => {
    await db.pool.query(
      `INSERT INTO projects (
         id, space_id, owner_user_id, name, status, primary_mode,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'Digest Project', 'active', 'delivery', $4, $4)`,
      [PROJECT, SPACE, USER, "2026-07-24T12:00:00.000Z"],
    );
    const tick = () => new AutonomyService(db.pool).observeTick({
      spaceId: SPACE,
      automationId: AUTOMATION,
      ownerUserId: USER,
      config: { observe_only: true },
      now: NOW,
    });
    const [first, second] = await Promise.all([tick(), tick()]);
    expect(first.candidate_ids).toHaveLength(1);
    expect(second.candidate_ids).toEqual(first.candidate_ids);
    const counts = await db.pool.query<{
      ticks: number;
      candidates: number;
      links: number;
      runs: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM autonomy_ticks) AS ticks,
         (SELECT count(*)::int FROM autonomy_candidates) AS candidates,
         (SELECT count(*)::int FROM autonomy_tick_candidates) AS links,
         (SELECT count(*)::int FROM runs) AS runs`,
    );
    expect(counts.rows[0]).toEqual({ ticks: 2, candidates: 1, links: 2, runs: 0 });
  });

  it("persists a successful zero-candidate coordinator audit", async () => {
    const result = await new AutonomyService(db.pool).observeTick({
      spaceId: SPACE,
      automationId: AUTOMATION,
      ownerUserId: USER,
      now: NOW,
    });
    expect(result).toMatchObject({ status: "succeeded", candidates_seen: 0, candidates_launched: 0 });
    const row = await db.pool.query<{ status: string; summary_json: { zero_candidate_tick: boolean } }>(
      `SELECT status, summary_json FROM autonomy_ticks WHERE id = $1`,
      [result.tick_id],
    );
    expect(row.rows[0]).toEqual({
      status: "succeeded",
      summary_json: {
        candidate_kinds: [],
        zero_candidate_tick: true,
        ranking: "deterministic_score_desc_kind_key",
      },
    });
  });
});

describe("AutonomyDiscovererRegistry", () => {
  it("fails exact completeness checks for missing or undeclared discoverers", () => {
    autonomyDiscovererRegistry.__resetForTests();
    expect(() => autonomyDiscovererRegistry.assertComplete(["periodic_digest"])).toThrow(/missing/);
    registerPeriodicDigestAutonomyDiscoverer();
    expect(() => autonomyDiscovererRegistry.assertComplete(["periodic_digest"])).not.toThrow();
    expect(() => autonomyDiscovererRegistry.assertComplete([])).toThrow(/undeclared/);
  });
});
