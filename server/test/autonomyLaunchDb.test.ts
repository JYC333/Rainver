import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { reconcileAutonomyRun } from "../src/modules/autonomy/finalizationReconciler";
import { AutonomyRecoveryService } from "../src/modules/autonomy/recoveryService";
import { autonomyDiscovererRegistry } from "../src/modules/autonomy/registry";
import { AutonomyService } from "../src/modules/autonomy/service";
import { registerEvolutionReviewAutonomyDiscoverer } from "../src/modules/evolution/autonomyDiscoverer";
import { registerPeriodicDigestAutonomyDiscoverer } from "../src/modules/projects/autonomyDiscoverer";
import { PgRunRepository } from "../src/modules/runs/repository";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = `${process.cwd()}/migrations`;
const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const AUTOMATION = "55555555-5555-4555-8555-555555555555";
const PROFILE = "66666666-6666-4666-8666-666666666666";
const PROJECT_A = "77777777-7777-4777-8777-777777777777";
const PROJECT_B = "88888888-8888-4888-8888-888888888888";
// Anchored to the real current UTC day (noon, to stay clear of day-boundary
// edge cases), not a fixed past literal — `runs.created_at` is always real
// wall-clock time (only the autonomy admission window/policy math takes an
// injected `now`), so a stale hardcoded NOW drifts the two apart: once real
// time moves past NOW's day, every freshly created Run in this test falls
// outside the admission window computed from NOW, and the "already admitted
// today" count silently reads 0 for every candidate.
const NOW = (() => {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0));
})();

/** An ISO timestamp `ms` milliseconds before NOW — keeps every seed date's offset from NOW fixed regardless of the real calendar date. */
function beforeNow(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
const sharedPostgres = inject("sharedPostgres");
const describeWithPostgres = describe.skipIf(
  !sharedPostgres.available || !sharedPostgres.adminUri || !sharedPostgres.templateDatabase || !sharedPostgres.runId,
);

beforeAll(async () => {
  database = await getTestPostgres(__filename);
  pool = new Pool({ connectionString: database.getConnectionUri(), max: 5 });
  await migrate(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!pool) return;
  autonomyDiscovererRegistry.__resetForTests();
  registerPeriodicDigestAutonomyDiscoverer();
  registerEvolutionReviewAutonomyDiscoverer();
  await pool.query("TRUNCATE spaces, users CASCADE");
  const now = NOW.toISOString();
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Autonomy Owner', 'active', $2, $2)`,
    [USER, now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Autonomy Space', 'personal', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       visibility, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Autonomy Agent', 'active', NULL, 'private', $4, $4)`,
    [AGENT, SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, '[]'::jsonb,
               '{"allowed_tools":["project.summary.brief"]}'::jsonb,
               '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
  await pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Autonomous Codex', 'codex_cli', '{}'::jsonb,
               '{}'::jsonb, true, true, $4, $4)`,
    [PROFILE, SPACE, AGENT, now],
  );
  await pool.query(
    `INSERT INTO automations (
       id, space_id, owner_user_id, agent_id, name, trigger_type, status,
       config_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Autonomous tick', 'schedule', 'active',
               '{"target_type":"autonomous_tick","observe_only":false}'::jsonb, $5, $5)`,
    [AUTOMATION, SPACE, USER, AGENT, now],
  );
  await pool.query(
    `INSERT INTO automation_credential_grants (
       id, space_id, automation_id, granted_by_user_id, status, created_at
     ) VALUES ($1, $2, $3, $4, 'active', $5)`,
    [randomUUID(), SPACE, AUTOMATION, USER, now],
  );
});

async function seedProject(id: string, name: string, updatedAt: string): Promise<void> {
  await pool!.query(
    `INSERT INTO projects (
       id, space_id, owner_user_id, name, status, primary_mode,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'active', 'delivery', $5, $5)`,
    [id, SPACE, USER, name, updatedAt],
  );
}

async function seedEvolutionSignals(
  count: number,
  options: { severity?: string; triageStatus?: string; startMinute?: number } = {},
): Promise<string[]> {
  const targetId = randomUUID();
  await pool!.query(
    `INSERT INTO evolution_targets (
       id, space_id, target_type, risk_level, status, enabled,
       engine_policy_json, metadata_json, created_at, updated_at
     ) VALUES ($1, $2, 'system', 'medium', 'active', true, '{}'::jsonb, '{}'::jsonb, $3, $3)`,
    [targetId, SPACE, beforeNow(2 * HOUR_MS)],
  );
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    ids.push(id);
    const createdAt = new Date(
      Date.parse(beforeNow(2 * HOUR_MS)) + ((options.startMinute ?? 0) + index) * 60_000,
    ).toISOString();
    await pool!.query(
      `INSERT INTO evolution_signals (
         id, space_id, target_id, signal_type, source_type, source_id,
         severity, summary, payload_json, triage_status, created_at
       ) VALUES ($1, $2, $3, 'run_finalization_failed', 'run', $4, $5, $6,
                 '{}'::jsonb, $7, $8)`,
      [
        id,
        SPACE,
        targetId,
        `run-${index}`,
        options.severity ?? "warning",
        `Failure signal ${index + 1}.`,
        options.triageStatus ?? "new",
        createdAt,
      ],
    );
  }
  return ids;
}

function launch(
  dailyRunLimit = 5,
  options: { quotaCheckedAt?: string; automationMaxRuns?: number } = {},
) {
  return new AutonomyService(pool!).launchCandidates({
    automation: {
      id: AUTOMATION,
      space_id: SPACE,
      owner_user_id: USER,
      agent_id: AGENT,
      project_folder_id: null,
      project_id: null,
      name: "Autonomous tick",
      description: null,
      trigger_type: "schedule",
      status: "active",
      preflight_snapshot_json: null,
      config_json: {
        target_type: "autonomous_tick",
        observe_only: false,
        ...(options.automationMaxRuns ? { max_runs: options.automationMaxRuns } : {}),
      },
      next_run_at: null,
      last_fired_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
    triggerType: "schedule",
    preflightSnapshot: { executable: true, automation_pre_authorized: true },
    policy: {
      daily_run_limit: dailyRunLimit,
      daily_cost_limit_usd: null,
      max_subscription_utilization_pct: 80,
      quota_max_age_seconds: 3_600,
    },
    quota: {
      runtime: "codex_cli",
      credential_profile_id: "credential-1",
      available: true,
      utilization_pct: 25,
      checked_at: options.quotaCheckedAt ?? beforeNow(5 * 60_000),
      source: "live_probe",
    },
    runtimeProfileId: PROFILE,
    now: NOW,
  });
}

describeWithPostgres("bounded periodic digest launch", () => {
  it("launches owner-private autonomous root Runs independently and persists partial fan-out", async () => {
    await seedProject(PROJECT_A, "Older Project", beforeNow(6 * DAY_MS));
    await seedProject(PROJECT_B, "Newer Project", beforeNow(1 * DAY_MS));
    const result = await launch(1);
    expect(result).toMatchObject({
      candidates_seen: 2,
      candidates_admitted: 1,
      candidates_launched: 1,
    });
    expect(result.refused).toEqual([
      expect.objectContaining({ reason: "daily_run_limit_reached" }),
    ]);
    const runs = await pool!.query<{
      id: string;
      run_role: string;
      trigger_origin: string;
      parent_run_id: string | null;
      root_run_id: string | null;
      instructed_by_user_id: string | null;
      owner_user_id: string | null;
      visibility: string;
      permission_snapshot_json: { tool_grants: Array<{ action_id: string }> };
    }>(
      `SELECT id, run_role, trigger_origin, parent_run_id, root_run_id,
              instructed_by_user_id, owner_user_id, visibility, permission_snapshot_json
         FROM runs ORDER BY run_role DESC, created_at`,
    );
    const coordinator = runs.rows.find((run) => run.run_role === "coordinator")!;
    const child = runs.rows.find((run) => run.trigger_origin === "autonomous")!;
    expect(coordinator.id).toBe(result.coordinator_run_id);
    expect(child).toMatchObject({
      run_role: "execution",
      trigger_origin: "autonomous",
      parent_run_id: coordinator.id,
      root_run_id: null,
      instructed_by_user_id: USER,
      owner_user_id: USER,
      visibility: "private",
    });
    expect(child.permission_snapshot_json.tool_grants.map((grant) => grant.action_id)).toEqual([
      "project.summary.brief",
    ]);
    const audit = await pool!.query<{ run_id: string; trigger_context_json: { autonomy_tick_id: string } }>(
      `SELECT run_id, trigger_context_json FROM automation_runs WHERE id = $1`,
      [result.automation_run_id],
    );
    expect(audit.rows[0]).toMatchObject({
      run_id: coordinator.id,
      trigger_context_json: { autonomy_tick_id: result.tick_id },
    });
  });

  it("serializes concurrent ticks so one logical candidate creates only one Run", async () => {
    await seedProject(PROJECT_A, "Concurrent Project", beforeNow(6 * DAY_MS));
    const results = await Promise.all([launch(), launch()]);
    expect(results.reduce((total, result) => total + result.candidates_launched, 0)).toBe(1);
    const autonomousRuns = await pool!.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM runs
        WHERE space_id = $1 AND trigger_origin = 'autonomous'`,
      [SPACE],
    );
    expect(autonomousRuns.rows[0]?.total).toBe(1);
    const candidate = await pool!.query<{
      launch_tick_id: string;
      run_id: string;
    }>(
      `SELECT launch_tick_id, run_id
         FROM autonomy_candidates
        WHERE candidate_kind = 'periodic_digest'`,
    );
    const winningTick = results.find((result) => result.candidates_launched === 1)?.tick_id;
    expect(candidate.rows[0]).toMatchObject({
      launch_tick_id: winningTick,
      run_id: results.flatMap((result) => result.launched_run_ids)[0],
    });
  });

  it("reconciles a successful child into an immutable private Artifact and settles the coordinator", async () => {
    await seedProject(PROJECT_A, "Digest Project", beforeNow(6 * DAY_MS));
    const launched = await launch();
    const runId = launched.launched_run_ids[0]!;
    const repeatedObservation = await new AutonomyService(pool!).observeTick({
      spaceId: SPACE,
      automationId: AUTOMATION,
      ownerUserId: USER,
      config: {},
      now: NOW,
    });
    expect(repeatedObservation.candidate_ids).toHaveLength(1);
    const provenance = await pool!.query<{ launch_tick_id: string; last_seen_tick_id: string }>(
      `SELECT launch_tick_id, last_seen_tick_id
         FROM autonomy_candidates WHERE run_id = $1`,
      [runId],
    );
    expect(provenance.rows[0]).toEqual({
      launch_tick_id: launched.tick_id,
      last_seen_tick_id: repeatedObservation.tick_id,
    });
    const terminal = await new PgRunRepository(pool!).markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "succeeded",
      output_json: {
        schema_version: "run_output.v1",
        status: "succeeded",
        summary: "# Progress\n\nThe project moved forward.",
        result: {},
        output_manifest: [],
      },
      error_json: {},
      exit_code: 0,
      completed_at: NOW.toISOString(),
    });
    await reconcileAutonomyRun(pool!, terminal!);
    await reconcileAutonomyRun(pool!, terminal!);
    const candidate = await pool!.query<{ status: string; artifact_id: string | null }>(
      `SELECT status, artifact_id FROM autonomy_candidates WHERE run_id = $1`,
      [runId],
    );
    expect(candidate.rows[0]?.status).toBe("completed");
    const artifacts = await pool!.query<{ total: number; visibility: string; owner_user_id: string; content: string }>(
      `SELECT count(*) OVER()::int AS total, visibility, owner_user_id, content
         FROM artifacts WHERE run_id = $1 AND artifact_type = 'autonomous_periodic_digest'`,
      [runId],
    );
    expect(artifacts.rows[0]).toMatchObject({
      total: 1,
      visibility: "private",
      owner_user_id: USER,
      content: "# Progress\n\nThe project moved forward.",
    });
    const coordinator = await pool!.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [launched.coordinator_run_id],
    );
    expect(coordinator.rows[0]?.status).toBe("succeeded");
  });

  it("records a domain-budget refusal without aborting partial fan-out", async () => {
    await seedProject(PROJECT_A, "Budget Project A", beforeNow(6 * DAY_MS));
    await seedProject(PROJECT_B, "Budget Project B", beforeNow(5 * DAY_MS));
    const budgeted = await launch(5, { automationMaxRuns: 1 });
    expect(budgeted.launched_run_ids).toHaveLength(1);
    expect(budgeted.refused).toEqual([
      expect.objectContaining({ reason: "automation_max_runs_exceeded" }),
    ]);

  });

  it("records stale-quota refusals and settles a zero-launch coordinator", async () => {
    await seedProject(PROJECT_A, "Stale Project A", beforeNow(6 * DAY_MS));
    await seedProject(PROJECT_B, "Stale Project B", beforeNow(5 * DAY_MS));
    const stale = await launch(5, { quotaCheckedAt: beforeNow(3 * HOUR_MS) });
    expect(stale.launched_run_ids).toHaveLength(0);
    expect(stale.refused).toEqual([
      expect.objectContaining({ reason: "quota_stale" }),
      expect.objectContaining({ reason: "quota_stale" }),
    ]);
    const coordinator = await pool!.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [stale.coordinator_run_id],
    );
    expect(coordinator.rows[0]?.status).toBe("succeeded");
  });

  it("cancels stale waiting-for-review Runs idempotently and leaves an operational alert", async () => {
    await seedProject(PROJECT_A, "Review Project", beforeNow(6 * DAY_MS));
    const launched = await launch();
    const runId = launched.launched_run_ids[0]!;
    await pool!.query(
      `UPDATE runs SET status = 'waiting_for_review', updated_at = $2 WHERE id = $1`,
      [runId, beforeNow(3 * HOUR_MS)],
    );
    const recovery = new AutonomyRecoveryService(pool!);
    await expect(recovery.cancelStaleWaitingForReview({ maxAgeSeconds: 3_600, now: NOW }))
      .resolves.toMatchObject({ cancelled: 1, run_ids: [runId] });
    await expect(recovery.cancelStaleWaitingForReview({ maxAgeSeconds: 3_600, now: NOW }))
      .resolves.toMatchObject({ cancelled: 0, run_ids: [] });
    const run = await pool!.query<{ status: string; error_json: { error_code: string } }>(
      `SELECT status, error_json FROM runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "cancelled",
      error_json: { error_code: "autonomous_review_timeout" },
    });
    const alerts = await pool!.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM activity_records
        WHERE source_run_id = $1 AND activity_type = 'operational_alert'`,
      [runId],
    );
    expect(alerts.rows[0]?.total).toBe(1);
  });
});

describeWithPostgres("bounded evolution review launch", () => {
  it("deduplicates signal materialization and keeps triage unchanged", async () => {
    const signalIds = [
      ...await seedEvolutionSignals(4),
      ...await seedEvolutionSignals(1, { triageStatus: "acknowledged", startMinute: 10 }),
    ];
    await seedEvolutionSignals(1, { triageStatus: "dismissed", startMinute: 20 });
    const service = new AutonomyService(pool!);
    const [first, second] = await Promise.all([
      service.observeTick({
        spaceId: SPACE,
        automationId: AUTOMATION,
        ownerUserId: USER,
        config: {},
        now: NOW,
      }),
      service.observeTick({
        spaceId: SPACE,
        automationId: AUTOMATION,
        ownerUserId: USER,
        config: {},
        now: NOW,
      }),
    ]);
    expect(first.candidates_seen).toBe(1);
    expect(second.candidates_seen).toBe(1);
    expect(first.candidate_ids).toEqual(second.candidate_ids);
    const candidates = await pool!.query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM autonomy_candidates
        WHERE candidate_kind = 'evolution_review'`,
    );
    expect(candidates.rows[0]?.total).toBe(1);
    const links = await pool!.query<{ signal_id: string; consumed_at: string | null }>(
      `SELECT signal_id, consumed_at
         FROM autonomy_candidate_evolution_signals
        ORDER BY signal_id`,
    );
    expect(links.rows.map((row) => row.signal_id).sort()).toEqual([...signalIds].sort());
    expect(links.rows.every((row) => row.consumed_at === null)).toBe(true);
    const triage = await pool!.query<{ triage_status: string; total: number }>(
      `SELECT triage_status, count(*)::int AS total
         FROM evolution_signals
        GROUP BY triage_status
        ORDER BY triage_status`,
    );
    expect(triage.rows).toEqual([
      { triage_status: "acknowledged", total: 1 },
      { triage_status: "dismissed", total: 1 },
      { triage_status: "new", total: 4 },
    ]);
  });

  it("advances the durable cursor only after a private report and does not relaunch the same set", async () => {
    const signalIds = await seedEvolutionSignals(5);
    const launched = await launch();
    expect(launched).toMatchObject({
      candidates_seen: 1,
      candidates_admitted: 1,
      candidates_launched: 1,
    });
    const runId = launched.launched_run_ids[0]!;
    const runBefore = await pool!.query<{
      capability_id: string;
      visibility: string;
      permission_snapshot_json: { tool_grants: unknown[] };
    }>(
      `SELECT capability_id, visibility, permission_snapshot_json
         FROM runs WHERE id = $1`,
      [runId],
    );
    expect(runBefore.rows[0]).toMatchObject({
      capability_id: "autonomy.evolution_review",
      visibility: "private",
      permission_snapshot_json: { tool_grants: [] },
    });
    const terminal = await new PgRunRepository(pool!).markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "succeeded",
      output_json: {
        schema_version: "run_output.v1",
        status: "succeeded",
        summary: "# Retrospective\n\nRepeated failures need a bounded repair proposal.",
        result: {},
        output_manifest: [],
      },
      error_json: {},
      exit_code: 0,
      completed_at: NOW.toISOString(),
    });
    await reconcileAutonomyRun(pool!, terminal!);
    await reconcileAutonomyRun(pool!, terminal!);

    const report = await pool!.query<{ total: number; visibility: string; content: string }>(
      `SELECT count(*) OVER()::int AS total, visibility, content
         FROM artifacts
        WHERE run_id = $1 AND artifact_type = 'autonomous_evolution_review'`,
      [runId],
    );
    expect(report.rows[0]).toMatchObject({
      total: 1,
      visibility: "private",
      content: "# Retrospective\n\nRepeated failures need a bounded repair proposal.",
    });
    const cursor = await pool!.query<{ candidate_id: string; last_fact_id: string }>(
      `SELECT candidate_id, last_fact_id
         FROM autonomy_review_cursors
        WHERE space_id = $1 AND owner_user_id = $2
          AND candidate_kind = 'evolution_review'`,
      [SPACE, USER],
    );
    expect(signalIds).toContain(cursor.rows[0]?.last_fact_id);
    const consumed = await pool!.query<{ total: number; consumed: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed
         FROM autonomy_candidate_evolution_signals`,
    );
    expect(consumed.rows[0]).toEqual({ total: 5, consumed: 5 });
    const unchanged = await pool!.query<{ states: string[] }>(
      `SELECT array_agg(DISTINCT triage_status ORDER BY triage_status) AS states
         FROM evolution_signals`,
    );
    expect(unchanged.rows[0]?.states).toEqual(["new"]);
    expect((await pool!.query(`SELECT 1 FROM proposals`)).rows).toHaveLength(0);
    expect((await pool!.query(`SELECT 1 FROM evolvable_assets`)).rows).toHaveLength(0);

    const repeated = await launch();
    expect(repeated).toMatchObject({
      candidates_seen: 0,
      candidates_admitted: 0,
      candidates_launched: 0,
    });
    expect(repeated.launched_run_ids).toEqual([]);
  });

  it("launches an error-severity signal immediately after the cursor", async () => {
    await seedEvolutionSignals(5);
    const first = await launch();
    const terminal = await new PgRunRepository(pool!).markRunTerminal({
      run_id: first.launched_run_ids[0]!,
      space_id: SPACE,
      status: "succeeded",
      output_json: {
        schema_version: "run_output.v1",
        status: "succeeded",
        summary: "Reviewed.",
        result: {},
        output_manifest: [],
      },
      error_json: {},
      exit_code: 0,
      completed_at: NOW.toISOString(),
    });
    await reconcileAutonomyRun(pool!, terminal!);
    await seedEvolutionSignals(1, { severity: "error", startMinute: 30 });
    const urgent = await launch();
    expect(urgent).toMatchObject({
      candidates_seen: 1,
      candidates_admitted: 1,
      candidates_launched: 1,
    });
  });

  it("retries the identical signal set after the review Run fails, instead of refusing it forever", async () => {
    await seedEvolutionSignals(5);
    const first = await launch();
    expect(first.candidates_launched).toBe(1);
    const terminal = await new PgRunRepository(pool!).markRunTerminal({
      run_id: first.launched_run_ids[0]!,
      space_id: SPACE,
      status: "failed",
      output_json: {},
      error_json: { error_code: "tool_error", error_message: "The runtime crashed." },
      exit_code: 1,
      completed_at: NOW.toISOString(),
    });
    await reconcileAutonomyRun(pool!, terminal!);

    const failedCandidate = await pool!.query<{ status: string }>(
      `SELECT status FROM autonomy_candidates WHERE candidate_kind = 'evolution_review'`,
    );
    expect(failedCandidate.rows[0]?.status).toBe("failed");

    // No new signals arrived, so the durable fact set — and therefore the
    // candidate_key — is byte-identical to the failed attempt. The cursor
    // never advanced (onCompleted only runs on success), so the same
    // evidence must be retryable rather than permanently refused.
    const retry = await launch();
    expect(retry).toMatchObject({
      candidates_seen: 1,
      candidates_admitted: 1,
      candidates_launched: 1,
      refused: [],
    });
    expect(retry.launched_run_ids[0]).not.toBe(first.launched_run_ids[0]);

    const candidates = await pool!.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM autonomy_candidates WHERE candidate_kind = 'evolution_review'`,
    );
    expect(candidates.rows[0]?.total).toBe(1);
  });
});
