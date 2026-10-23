import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedConversationMessages, seedRun, seedServerHost, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgRunSupervisor } from "../src/modules/runs/supervisor.js";
import { SUBSCRIPTION_QUOTA_EXHAUSTED } from "../src/modules/runs/retryPolicy.js";
import { admitAgentOriginRun, continueHeldRuns, enqueueWhenTurnFree, releaseHeldRuns } from "../src/modules/rooms/quotaGate.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { updateQuotaRecovery } from "../src/modules/rooms/quotaRecovery.js";
import { liveQuotaSource } from "../src/modules/rooms/subscriptionLogins.js";
import { withDbTransaction } from "../src/modules/routeUtils/common.js";
import { loadRunTurn } from "../src/modules/runs/turnReadModel.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { runsModule } from "../src/modules/runs/index.js";
import { loadConfig } from "../src/config.js";
import { __setRunsIdentityForTests } from "../src/modules/runs/routes.js";
import type { FastifyInstance } from "fastify";

const db = useTestDatabase(import.meta.filename);
const SPACE = randomUUID(), USER = randomUUID(), PROJECT = randomUUID(), AGENT = randomUUID(), VERSION = randomUUID();
const RUN = randomUUID(), HOST = randomUUID(), THREAD = randomUUID(), SESSION = randomUUID(), TASK = randomUUID();
let app: FastifyInstance | undefined;
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users", "machines"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: USER, project: PROJECT });
  await seedServerHost(db.pool, { id: HOST });
  await seedRun(db.pool, { id: RUN, space: SPACE, owner: USER, agent: AGENT, version: VERSION });
  await db.pool.query(`INSERT INTO sessions (id, space_id, user_id, agent_id, project_id, status, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [SESSION, SPACE, USER, AGENT, PROJECT]);
  await db.pool.query(`INSERT INTO tasks (id, space_id, project_id, title, status, owner_user_id, visibility, created_at, updated_at)
    VALUES ($1,$2,$3,'Continue work','in_progress',$4,'space_shared',now(),now())`, [TASK, SPACE, PROJECT, USER]);
  await db.pool.query(`INSERT INTO host_threads (id, space_id, execution_host_id, workspace_mode, session_id, agent_id,
    container_kind, runtime_key, runtime_installation, dispatch_lock_id, created_by_user_id, created_at, updated_at)
    VALUES ($1,$2,$3,'managed',$4,$5,'conversation','claude_code','managed:1.0.0',$6,$7,now(),now())`,
  [THREAD, SPACE, HOST, SESSION, AGENT, RUN, USER]);
  await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key = 'claude_code', backend_mode = 'runtime_native', model_provider_id = NULL WHERE agent_id = $1`, [AGENT]);
  const reset = Math.floor((Date.now() + 3600_000) / 1000);
  await db.pool.query(`UPDATE runs SET status = 'failed', runtime_key = 'claude_code', model_provider_id = NULL,
    instructed_by_user_id = $2, project_id = $3, session_id = $4, host_task_thread_id = $5,
    runtime_profile_snapshot_json = runtime_profile_snapshot_json || '{"runtime_key":"claude_code","backend_mode":"runtime_native","model_provider_id":null}'::jsonb,
    contract_snapshot_json = $6::jsonb, error_json = $7::jsonb, error_message = $8, started_at = now(), ended_at = now() WHERE id = $1`,
  [RUN, USER, PROJECT, SESSION, THREAD, JSON.stringify({ source: { kind: "direct", id: null }, max_attempts: 2 }),
    JSON.stringify({ error_code: SUBSCRIPTION_QUOTA_EXHAUSTED }), `Claude AI usage limit reached|${reset}`]);
  await db.pool.query(`INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, error_code, started_at, ended_at, created_at, updated_at)
    VALUES ($1,$2,$3,1,'failed',$4,now(),now(),now(),now())`, [randomUUID(), SPACE, RUN, SUBSCRIPTION_QUOTA_EXHAUSTED]);
});
afterEach(async () => { __setRunsIdentityForTests(null); await app?.close(); app = undefined; });

async function supervise() {
  const repository = new PgRunRepository(db.pool);
  const run = (await repository.getRun(SPACE, RUN))!;
  const attempt = await repository.getLatestRunAttempt(SPACE, RUN);
  return new PgRunSupervisor(db.pool).supervise({ run, attempt_number: attempt?.attempt_number ?? 1,
    evaluation: { outcome_status: "failed", failure_reason_code: SUBSCRIPTION_QUOTA_EXHAUSTED } });
}
async function marker() {
  return (await db.pool.query(`SELECT output_json->'waiting_for_quota' AS marker FROM runs WHERE id = $1`, [RUN])).rows[0]!.marker;
}
async function automatic() {
  await db.pool.query(`UPDATE runs SET contract_snapshot_json = jsonb_set(contract_snapshot_json, '{source}', $2::jsonb) WHERE id = $1`,
    [RUN, JSON.stringify({ kind: "task", id: TASK })]);
  await supervise();
  return marker();
}
const emptyQuota = { read: async () => ({ window: null, checked_at: null }) };
async function jobs() {
  return (await db.pool.query(`SELECT * FROM jobs WHERE job_type = 'agent_run' AND payload_json->>'run_id' = $1`, [RUN])).rows;
}

describe("interrupted quota recovery", () => {
  it("parks an ordinary chat with an explicit choice and preserves attempt evidence", async ctx => {
    if (!db.available) return ctx.skip();
    expect(await supervise()).toMatchObject({ decision: "retry_same_route" });
    expect(await marker()).toMatchObject({ recovery: { auto_continue: false, pause_reason: "user" } });
    expect(await jobs()).toHaveLength(0);
    expect((await db.pool.query(`SELECT dispatch_lock_id FROM host_threads WHERE id = $1`, [THREAD])).rows[0]!.dispatch_lock_id).toBeNull();
    expect((await db.pool.query(`SELECT attempt_number, status FROM run_attempts WHERE run_id = $1 ORDER BY attempt_number`, [RUN])).rows)
      .toEqual([{ attempt_number: 1, status: "failed" }, { attempt_number: 2, status: "queued" }]);
    expect(await supervise()).toBeNull();
    expect(await loadRunTurn(db.pool, { spaceId: SPACE, runId: RUN })).toMatchObject({ state: "blocked", blocked_on: "quota" });
    expect(await new PgRunRepository(db.pool).markRunRunning({ space_id: SPACE, run_id: RUN, started_at: new Date().toISOString() })).toBeNull();
  });

  it("waits for the reset and admits exactly one successor under concurrent scheduler passes", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    expect(held.recovery.auto_continue).toBe(true);
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota })).toBe(0);
    const now = new Date(Date.parse(held.resets_at) + 1000);
    const results = await Promise.all([releaseHeldRuns(db.pool, { source: emptyQuota, now }), releaseHeldRuns(db.pool, { source: emptyQuota, now })]);
    expect(results.reduce((a, b) => a + b)).toBe(1);
    expect(await marker()).toBeNull();
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0]!.payload_json).toMatchObject({ run_id: RUN, supervisor_attempt: 2 });
  });

  it("queues a successor while the failed attempt's job is still finishing", async ctx => {
    if (!db.available) return ctx.skip();
    const previous = await new PgJobQueueRepository(db.pool).enqueue({ job_type: "agent_run", space_id: SPACE,
      user_id: USER, agent_id: AGENT, payload: { run_id: RUN } });
    await db.pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [previous.id]);
    const held = await automatic();
    const now = new Date(Date.parse(held.resets_at) + 1000);
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now })).toBe(1);
    // The finishing job has already executed its physical attempt. Reusing
    // it would clear the hold without leaving any worker to run the successor.
    await db.pool.query(`UPDATE jobs SET status = 'completed' WHERE id = $1`, [previous.id]);
    expect((await jobs()).filter(job => job.status === "pending")).toEqual([
      expect.objectContaining({ payload_json: { run_id: RUN, supervisor_attempt: 2 } }),
    ]);
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now })).toBe(0);
  });

  it("honors a later CLI refusal on the account after the interrupted attempt's reset", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    const refusedAt = new Date(Date.parse(held.resets_at) + 1000).toISOString();
    const laterRun = randomUUID();
    await db.pool.query(`INSERT INTO runs (id, space_id, agent_id, agent_version_id, runtime_profile_id, runtime_profile_snapshot_json,
      runtime_profile_selection_source, run_type, trigger_origin, status, mode, runtime_key, owner_user_id, execution_kind,
      host_task_thread_id, session_id, error_json, ended_at, created_at, updated_at)
      SELECT $1, space_id, agent_id, agent_version_id, runtime_profile_id, runtime_profile_snapshot_json,
      runtime_profile_selection_source, run_type, trigger_origin, 'failed', mode, runtime_key, owner_user_id, execution_kind,
      host_task_thread_id, session_id, $3::jsonb, $4::timestamptz, $4::timestamptz, $4::timestamptz
      FROM runs WHERE id = $2`, [laterRun, RUN, JSON.stringify({ error_code: SUBSCRIPTION_QUOTA_EXHAUSTED }), refusedAt]);
    const now = new Date(Date.parse(refusedAt) + 1000);
    expect(await releaseHeldRuns(db.pool, { source: liveQuotaSource(null), now })).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await marker()).toMatchObject({ resets_at: new Date(Date.parse(refusedAt) + 5 * 3600_000).toISOString(),
      recovery: { auto_continue: true } });
  });

  it("persists cancel across new scheduler instances and never probes a disabled recovery", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    await withDbTransaction(db.pool, client => updateQuotaRecovery(client, SPACE, RUN, false));
    const source = { read: async () => { throw new Error("Cancelled recovery must not probe"); } };
    expect(await releaseHeldRuns(db.pool, { source, now: new Date(Date.parse(held.resets_at) + 1000) })).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await marker()).toMatchObject({ recovery: { auto_continue: false, pause_reason: "user" } });
    await withDbTransaction(db.pool, client => updateQuotaRecovery(client, SPACE, RUN, true, new Date(Date.parse(held.resets_at) + 2000)));
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now: new Date(Date.parse(held.resets_at) + 3000) })).toBe(1);
    await expect(withDbTransaction(db.pool, client => updateQuotaRecovery(client, SPACE, RUN, false))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never acknowledges cancellation while concurrently admitting its successor", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    const now = new Date(Date.parse(held.resets_at) + 1000);
    const [cancel, release] = await Promise.allSettled([
      withDbTransaction(db.pool, client => updateQuotaRecovery(client, SPACE, RUN, false)),
      releaseHeldRuns(db.pool, { source: emptyQuota, now }),
    ]);
    expect(release.status).toBe("fulfilled");
    if (cancel.status === "fulfilled") {
      expect(cancel.value.auto_continue).toBe(false);
      expect(await jobs()).toHaveLength(0);
    } else {
      expect(cancel.reason).toMatchObject({ statusCode: 409 });
      expect(await jobs()).toHaveLength(1);
    }
  });

  it("keeps an unknown reset waiting until a newer readable quota says capacity is available", async ctx => {
    if (!db.available) return ctx.skip();
    await db.pool.query(`UPDATE runs SET error_message = 'You''ve hit your session limit' WHERE id = $1`, [RUN]);
    const held = await automatic();
    expect(held.resets_at).toBeNull();
    const now = new Date(Date.parse(held.recovery.next_check_at) + 1000);
    const stale = { read: async () => ({ window: { kind: "session" as const, utilization: 1, resets_at: null }, checked_at: new Date(Date.parse(held.recovery.refused_at) - 1000).toISOString() }) };
    expect(await releaseHeldRuns(db.pool, { source: stale, now })).toBe(0);
    const next = new Date(now.getTime() + 16 * 60_000);
    const fresh = { read: async () => ({ window: { kind: "session" as const, utilization: 1, resets_at: null }, checked_at: next.toISOString() }) };
    expect(await releaseHeldRuns(db.pool, { source: fresh, now: next })).toBe(1);
  });

  it("keeps a cancelled continuation paused through FIFO, reserve overrides and an old job", async ctx => {
    if (!db.available) return ctx.skip();
    await automatic();
    await withDbTransaction(db.pool, client => updateQuotaRecovery(client, SPACE, RUN, false));
    const held = await marker();
    await new PgJobQueueRepository(db.pool).ensureAgentRunJob({ job_type: "agent_run", space_id: SPACE,
      user_id: USER, agent_id: AGENT, payload: { run_id: RUN } });
    await withDbTransaction(db.pool, async client => {
      expect(await admitAgentOriginRun(client, { spaceId: SPACE, runId: RUN, job: held.job, source: emptyQuota })).toBe("held");
      expect(await enqueueWhenTurnFree(client, { spaceId: SPACE, runId: RUN, job: held.job })).toBe("held");
      expect(await continueHeldRuns(client, { spaceId: SPACE, sessionId: SESSION, userId: USER })).toBe(0);
    });
    expect(await marker()).toMatchObject({ recovery: { auto_continue: false } });
  });

  it("honors a newer full weekly window instead of retrying at an old session reset", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    const now = new Date(Date.parse(held.resets_at) + 1000);
    const weekly = new Date(now.getTime() + 86400_000).toISOString();
    const full = { read: async () => ({ window: { kind: "week" as const, utilization: 100, resets_at: weekly }, checked_at: now.toISOString() }) };
    expect(await releaseHeldRuns(db.pool, { source: full, now })).toBe(0);
    expect(await marker()).toMatchObject({ window: "week", resets_at: weekly, recovery: { next_check_at: weekly } });
    expect(await jobs()).toHaveLength(0);
  });

  it("retains the Space's explicitly reserved quota when interrupted work recovers", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    await db.pool.query(`INSERT INTO settings (id, scope_type, scope_id, settings_key, settings_json, created_at, updated_at)
      VALUES ($1,'space',$2,'subscription_quota','{"warn_pct":70,"reserve_pct":85}',now(),now())`, [randomUUID(), SPACE]);
    const now = new Date(Date.parse(held.resets_at) + 1000);
    const reading = { read: async () => ({ window: { kind: "session" as const, utilization: 90, resets_at: new Date(now.getTime() + 3600_000).toISOString() }, checked_at: now.toISOString() }) };
    expect(await releaseHeldRuns(db.pool, { source: reading, now })).toBe(0);
    expect(await jobs()).toHaveLength(0);
  });

  it("keeps another reserved window held after the fuller cached window resets", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    const now = new Date(Date.parse(held.recovery.refused_at) + 60_000);
    const expired = new Date(now.getTime() - 1000).toISOString();
    const sessionReset = new Date(now.getTime() + 3600_000).toISOString();
    held.resets_at = expired;
    held.recovery.next_check_at = expired;
    await db.pool.query(`UPDATE runs SET output_json = jsonb_set(output_json, '{waiting_for_quota}', $2::jsonb) WHERE id = $1`,
      [RUN, JSON.stringify(held)]);
    await db.pool.query(`INSERT INTO settings (id, scope_type, scope_id, settings_key, settings_json, created_at, updated_at)
      VALUES ($1,'space',$2,'subscription_quota','{"warn_pct":70,"reserve_pct":85}',now(),now())`, [randomUUID(), SPACE]);
    await db.pool.query(`INSERT INTO host_runtime_usage (host_id, runtime_key, installation, quota_json, checked_at)
      VALUES ($1,'claude_code','managed:1.0.0',$2::jsonb,$3::timestamptz)`, [HOST, JSON.stringify({ available: true,
      session_pct: 90, session_resets: sessionReset, week_pct: 100, week_resets: expired, error: null }), now.toISOString()]);
    expect(await releaseHeldRuns(db.pool, { source: liveQuotaSource(null), now })).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await marker()).toMatchObject({ window: "session", resets_at: sessionReset });
  });

  it("waits behind active work on the same account in another conversation", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    const otherSession = randomUUID(), otherThread = randomUUID(), otherRun = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id, space_id, user_id, agent_id, project_id, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [otherSession, SPACE, USER, AGENT, PROJECT]);
    await db.pool.query(`INSERT INTO host_threads (id, space_id, execution_host_id, workspace_mode, session_id, agent_id,
      container_kind, runtime_key, runtime_installation, created_by_user_id, created_at, updated_at)
      SELECT $1, space_id, execution_host_id, workspace_mode, $2, agent_id, container_kind, runtime_key, runtime_installation, created_by_user_id, now(), now()
      FROM host_threads WHERE id = $3`, [otherThread, otherSession, THREAD]);
    await db.pool.query(`INSERT INTO runs (id, space_id, agent_id, agent_version_id, runtime_profile_id, runtime_profile_snapshot_json, runtime_profile_selection_source,
      run_type, trigger_origin, status, mode, runtime_key, owner_user_id, execution_kind, host_task_thread_id, session_id, started_at, created_at, updated_at)
      SELECT $1, space_id, agent_id, agent_version_id, runtime_profile_id, runtime_profile_snapshot_json, runtime_profile_selection_source,
      run_type, trigger_origin, 'running', mode, runtime_key, owner_user_id, execution_kind, $2, $3, now(), now(), now() FROM runs WHERE id = $4`,
    [otherRun, otherThread, otherSession, RUN]);
    const now = new Date(Date.parse(held.resets_at) + 1000);
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now })).toBe(0);
    await db.pool.query(`UPDATE runs SET status = 'succeeded', ended_at = now() WHERE id = $1`, [otherRun]);
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now })).toBe(1);
  });

  it("pauses when a new user message arrives and accepts an explicit renewed continuation choice", async ctx => {
    if (!db.available) return ctx.skip();
    const held = await automatic();
    const now = new Date(Date.parse(held.resets_at) + 1000);
    await seedConversationMessages(db.pool, { space: SPACE, session: SESSION, messages: [{ id: randomUUID(), role: "user", userId: USER, content: "Change the task", createdAt: new Date(Date.parse(held.recovery.intent_at) + 1000).toISOString() }] });
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now })).toBe(0);
    expect(await marker()).toMatchObject({ recovery: { auto_continue: false, pause_reason: "conversation_changed" } });
    await withDbTransaction(db.pool, client => updateQuotaRecovery(client, SPACE, RUN, true, now));
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now: new Date(now.getTime() + 1000) })).toBe(1);
  });

  it.each(["task", "task_edit", "membership", "expiry"])("pauses on changed %s without starting work", async change => {
    if (!db.available) return;
    const held = await automatic();
    let now = new Date(Date.parse(held.resets_at) + 1000);
    if (change === "task") await db.pool.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [TASK]);
    if (change === "task_edit") await db.pool.query(`UPDATE tasks SET title = 'New goal', updated_at = $2::timestamptz WHERE id = $1`, [TASK, new Date(Date.parse(held.recovery.intent_at) + 1000).toISOString()]);
    if (change === "membership") await db.pool.query(`UPDATE space_memberships SET status = 'revoked' WHERE space_id = $1 AND user_id = $2`, [SPACE, USER]);
    if (change === "expiry") now = new Date(Date.parse(held.recovery.expires_at) + 1000);
    expect(await releaseHeldRuns(db.pool, { source: emptyQuota, now })).toBe(0);
    expect((await marker()).recovery).toMatchObject({ auto_continue: false, pause_reason: change === "expiry" ? "expired" : "authority_changed" });
    expect(await jobs()).toHaveLength(0);
  });

  it("never widens the physical attempt cap", async ctx => {
    if (!db.available) return ctx.skip();
    await db.pool.query(`UPDATE runs SET contract_snapshot_json = jsonb_set(contract_snapshot_json, '{max_attempts}', '1') WHERE id = $1`, [RUN]);
    expect(await supervise()).toMatchObject({ decision: "human_review" });
    expect(await marker()).toBeNull();
    expect(await jobs()).toHaveLength(0);
  });

  it("authorizes the recovery command, isolates Spaces and reports the admission race", async ctx => {
    if (!db.available) return ctx.skip();
    await automatic();
    app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule]);
    const other = randomUUID();
    await seedSpaceMember(db.pool, { space: SPACE, user: other, role: "member" });
    const request = () => app!.inject({ method: "PATCH", url: `/api/v1/runs/${RUN}/quota-recovery`, payload: { auto_continue: false } });
    __setRunsIdentityForTests({ spaceId: SPACE, userId: other });
    expect((await request()).statusCode).toBe(403);
    __setRunsIdentityForTests({ spaceId: randomUUID(), userId: USER });
    expect((await request()).statusCode).toBe(404);
    __setRunsIdentityForTests({ spaceId: SPACE, userId: USER });
    expect((await request()).statusCode).toBe(200);
    expect((await marker()).recovery.auto_continue).toBe(false);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/runs/${RUN}/quota-recovery`, payload: { auto_continue: "false" } })).statusCode).toBe(422);
    await db.pool.query(`UPDATE runs SET output_json = output_json - 'waiting_for_quota' WHERE id = $1`, [RUN]);
    expect((await request()).statusCode).toBe(409);
  });
});
