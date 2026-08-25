import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, inject, it } from "vitest";
import {
  admitAutonomousRun,
  type AutonomousAdmissionPolicy,
  type AutonomousQuotaSnapshot,
} from "../src/modules/runs/autonomousAdmission";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-07-26T12:00:00.000Z");
const policy: AutonomousAdmissionPolicy = {
  daily_run_limit: 1,
  daily_cost_limit_usd: 10,
  max_subscription_utilization_pct: 80,
  quota_max_age_seconds: 3_600,
};
const freshQuota: AutonomousQuotaSnapshot = {
  runtime: "codex_cli",
  credential_profile_id: "profile-1",
  available: true,
  utilization_pct: 25,
  checked_at: "2026-07-26T11:55:00.000Z",
  source: "live_probe",
};

const sharedPostgres = inject("sharedPostgres");
const describeWithPostgres = describe.skipIf(
  !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
);

const db = useTestDatabase(__filename, { max: 4 });

beforeEach(async () => {
  if (!db.pool) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Autonomy Owner', 'active', $2, $2)`,
    [USER, NOW.toISOString()],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Autonomy Space', 'personal', $2, $3, $3)`,
    [SPACE, USER, NOW.toISOString()],
  );
  await db.pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       visibility, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Autonomy Agent', 'active', NULL, 'private', $4, $4)`,
    [AGENT, SPACE, USER, NOW.toISOString()],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, NOW.toISOString()],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
});

describeWithPostgres("autonomous admission transaction", () => {
  it("serializes a Space/owner/day db.pool and admits only one concurrent root Run", async () => {
    const create = (suffix: string) => admitAutonomousRun(db.pool, {
      spaceId: SPACE,
      ownerUserId: USER,
      policy,
      quota: freshQuota,
      now: NOW,
      create: async (db, trace) => {
        const runId = randomUUID();
        await db.query(
          `INSERT INTO runs (
             id, space_id, agent_id, agent_version_id, run_role, run_type,
             trigger_origin, status, mode, owner_user_id, visibility,
             contract_snapshot_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'execution', 'system', 'autonomous',
                     'queued', 'live', $5, 'private', $6::jsonb, $7, $7)`,
          [runId, SPACE, AGENT, VERSION, USER, JSON.stringify({ autonomous_admission: trace }), NOW.toISOString()],
        );
        await db.query(
          `INSERT INTO settings (
             id, scope_type, scope_id, settings_key, settings_json,
             updated_by_user_id, created_at, updated_at
           ) VALUES ($1, 'space_user', $2, $3, $4::jsonb, $5, $6, $6)`,
          [randomUUID(), `${SPACE}:${USER}`, `test.admission.${suffix}`, JSON.stringify(trace), USER, NOW.toISOString()],
        );
        return runId;
      },
    });
    const [first, second] = await Promise.all([create("a"), create("b")]);
    expect([first.allowed, second.allowed].sort()).toEqual([false, true]);
    expect([first, second].find((decision) => !decision.allowed)?.reason).toBe("daily_run_limit_reached");
    const rows = await db.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM runs WHERE trigger_origin = 'autonomous'`,
    );
    expect(rows.rows[0]?.total).toBe(1);
  });

  it("refuses unavailable, stale, and over-utilized subscription quota with stable reasons", async () => {
    const decide = (quota: AutonomousQuotaSnapshot) => admitAutonomousRun(db.pool, {
      spaceId: SPACE,
      ownerUserId: USER,
      policy: { ...policy, daily_run_limit: 5 },
      quota,
      now: NOW,
      create: async () => "must-not-run",
    });
    await expect(decide({ ...freshQuota, available: false, utilization_pct: null })).resolves.toMatchObject({
      allowed: false,
      reason: "quota_unavailable",
    });
    await expect(decide({ ...freshQuota, checked_at: "2026-07-26T10:00:00.000Z" })).resolves.toMatchObject({
      allowed: false,
      reason: "quota_stale",
    });
    await expect(decide({ ...freshQuota, utilization_pct: 80 })).resolves.toMatchObject({
      allowed: false,
      reason: "quota_utilization_exceeded",
    });
  });

  it("rolls back both the Run and decision when the callback fails", async () => {
    await expect(admitAutonomousRun(db.pool, {
      spaceId: SPACE,
      ownerUserId: USER,
      policy: { ...policy, daily_run_limit: 5 },
      quota: freshQuota,
      now: NOW,
      create: async (db) => {
        await db.query(
          `INSERT INTO settings (
             id, scope_type, scope_id, settings_key, settings_json,
             updated_by_user_id, created_at, updated_at
           ) VALUES ($1, 'space_user', $2, 'test.rollback', '{}'::jsonb, $3, $4, $4)`,
          [randomUUID(), `${SPACE}:${USER}`, USER, NOW.toISOString()],
        );
        throw new Error("callback failure");
      },
    })).rejects.toThrow("callback failure");
    const row = await db.pool.query(`SELECT 1 FROM settings WHERE settings_key = 'test.rollback'`);
    expect(row.rowCount).toBe(0);
  });
});
