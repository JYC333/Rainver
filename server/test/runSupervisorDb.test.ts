import { beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgVerificationRepository } from "../src/modules/runs/verification/repository.js";
import { PgRunSupervisor } from "../src/modules/runs/supervisor.js";
import { PostRunFinalizationService } from "../src/modules/runs/finalizationService.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { PgUsageRepository } from "../src/modules/usage/repository.js";
import { normalizeUsageObservation } from "../src/modules/usage/normalizer.js";
import { EvolutionSignalEmitter } from "../src/modules/evolution/signalEmitters.js";
import { insertProposalRow } from "../src/modules/proposals/reviewPackets.js";

const SPACE = "81111111-1111-4111-8111-111111111111";
const USER = "82222222-2222-4222-8222-222222222222";
const AGENT = "83333333-3333-4333-8333-333333333333";
const VERSION = "84444444-4444-4444-8444-444444444444";
const PROFILE = "85555555-5555-4555-8555-555555555555";
const FALLBACK_PROFILE = "86666666-6666-4666-8666-666666666666";
const PROVIDER = "87777777-7777-4777-8777-777777777777";
const CREDENTIAL = "88888888-8888-4888-8888-888888888888";
const PROVIDER_CREDENTIAL = "89999999-9999-4999-8999-999999999999";
const PROVIDER_GRANT = "8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Supervisor Test User', 'active', $2, $2)`,
    [USER, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Supervisor Test Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('86666666-6666-4666-8666-666666666666', $1, $2, 'owner', 'active', $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id,
                         created_at, updated_at, visibility)
     VALUES ($1, $2, $3, 'Supervisor Test Agent', 'active', NULL, $4, $4, 'space_shared')`,
    [AGENT, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'You are a test agent.',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '["research.brief_synthesize"]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(
    `UPDATE agents SET current_version_id = $2 WHERE id = $1 AND space_id = $3`,
    [AGENT, VERSION, SPACE],
  );
  await db.pool.query(
    `INSERT INTO credentials (
       id, space_id, owner_user_id, name, credential_type, secret_ref,
       scopes_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Supervisor Test Credential', 'api_key', 'test-secret-ref', '{}'::jsonb, $4, $4)`,
    [CREDENTIAL, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, default_model,
       credential_id, enabled, capabilities_json, config_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Supervisor Test Provider', 'openai', 'test-model', $4, true, '{}'::jsonb, '{}'::jsonb, $5, $5)`,
    [PROVIDER, SPACE, USER, CREDENTIAL, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_credentials (
       id, space_id, provider_id, credential_id, position, enabled, healthy,
       request_count, failure_count, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 0, true, true, 0, 0, $5, $5)`,
    [PROVIDER_CREDENTIAL, SPACE, PROVIDER, CREDENTIAL, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (
       id, provider_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4, true, true, $5, $5)`,
    [PROVIDER_GRANT, PROVIDER, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type,
       model_provider_id, runtime_config_json, runtime_policy_json, enabled, is_default,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 'Default', 'model_api', $4, '{}', '{}', true, true, $5, $5)`,
    [PROFILE, SPACE, AGENT, PROVIDER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, model_provider_id,
       runtime_config_json, runtime_policy_json, enabled, is_default,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 'Fallback', 'model_api', $4, '{}', '{}', true, false, $5, $5)`,
    [FALLBACK_PROFILE, SPACE, AGENT, PROVIDER, now],
  );
});

describe("run attempts and supervisor against shared PostgreSQL", () => {
  it("records physical attempts and retries the same route before human review", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 2 });
    const repository = new PgRunRepository(db.pool);
    const supervisor = new PgRunSupervisor(db.pool, new EvolutionSignalEmitter(db.pool));
    const finalizer = new PostRunFinalizationService(repository, undefined, undefined, undefined, undefined, supervisor);

    await db.pool.query(
      `INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'queued', now(), now())`,
      [randomUUID(), SPACE, runId],
    );
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_stall_timeout", error_text: "no output" },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);
    expect((await db.pool.query<{ committed: string | null }>(
      `SELECT metadata_json->>'completion_gate_committed' AS committed
         FROM run_finalizations
        WHERE space_id = $1 AND run_id = $2
        ORDER BY finalized_at DESC
        LIMIT 1`,
      [SPACE, runId],
    )).rows[0]?.committed).toBe("true");

    const firstAttempt = await db.pool.query<{ attempt_number: number; status: string }>(
      `SELECT attempt_number, status FROM run_attempts WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    );
    expect(firstAttempt.rows).toEqual([
      { attempt_number: 1, status: "failed" },
      { attempt_number: 2, status: "queued" },
    ]);
    expect((await repository.getRun(SPACE, runId))?.status).toBe("queued");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE space_id = $1 AND payload_json->>'run_id' = $2`,
      [SPACE, runId],
    )).rows[0]?.count).toBe("1");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM evolution_signals
        WHERE space_id = $1 AND signal_type = 'supervisor_outcome'
          AND source_type = 'supervisor'`,
      [SPACE],
    )).rows[0]?.count).toBe("1");

    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_stall_timeout", error_text: "no output again" },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);

    const decisions = await db.pool.query<{ decision: string; reason_code: string }>(
      `SELECT decision, reason_code
         FROM run_supervisor_decisions decision
         JOIN run_attempts attempt
           ON attempt.id = decision.attempt_id
          AND attempt.space_id = decision.space_id
        WHERE decision.space_id = $1 AND decision.run_id = $2
        ORDER BY attempt.attempt_number`,
      [SPACE, runId],
    );
    expect(decisions.rows).toEqual([
      { decision: "retry_same_route", reason_code: "cli_stall_timeout" },
      { decision: "human_review", reason_code: "retry_attempt_cap_reached" },
    ]);
    expect((await repository.getRun(SPACE, runId))?.status).toBe("waiting_for_review");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE space_id = $1 AND payload_json->>'run_id' = $2`,
      [SPACE, runId],
    )).rows[0]?.count).toBe("1");
  });

  it("leaves a non-retryable interactive chat failure terminal for its conversation reply", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({
      max_attempts: 2,
      model_override_json: {
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: "chat-session",
          user_id: USER,
          user_message_id: "chat-message",
          agent_id: AGENT,
          agent_version_id: VERSION,
          project_id: null,
        },
      },
    });
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: {
        error_code: "run_orchestration_failed",
        error_text: "Conversation context loading failed.",
      },
      completed_at: new Date().toISOString(),
    });

    const decision = await new PgRunSupervisor(db.pool).supervise({
      run: (await repository.getRun(SPACE, runId))!,
      evaluation: {
        outcome_status: "failed",
        failure_reason_code: "run_orchestration_failed",
      },
    });

    expect(decision).toBeNull();
    expect((await repository.getRun(SPACE, runId))?.status).toBe("failed");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM run_supervisor_decisions
        WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows[0]?.count).toBe("0");
  });

  it("retries semantic rejection through RunEvaluation and honors the attempt cap", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 2 });
    const repository = new PgRunRepository(db.pool);
    const finalizer = new PostRunFinalizationService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgRunSupervisor(db.pool),
    );

    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      output_json: {
        schema_version: "run_output.v1",
        status: "rejected",
        result: { rejection: { reason: "missing evidence" } },
      },
      error_json: { error_code: "semantic_rejection" },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);

    expect((await repository.getRun(SPACE, runId))?.status).toBe("queued");
    expect((await repository.getLatestRunEvaluation(SPACE, runId))).toMatchObject({
      outcome_status: "failed",
      failure_layer: "task_spec",
      failure_reason_code: "semantic_rejection",
    });

    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "semantic_rejection" },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);

    expect((await repository.getRun(SPACE, runId))?.status).toBe("waiting_for_review");
    expect((await db.pool.query<{ decision: string; reason_code: string }>(
      `SELECT decision, reason_code
         FROM run_supervisor_decisions decision
         JOIN run_attempts attempt
           ON attempt.id = decision.attempt_id
          AND attempt.space_id = decision.space_id
        WHERE decision.space_id = $1 AND decision.run_id = $2
        ORDER BY attempt.attempt_number`,
      [SPACE, runId],
    )).rows).toEqual([
      { decision: "retry_same_route", reason_code: "semantic_rejection" },
      { decision: "human_review", reason_code: "retry_attempt_cap_reached" },
    ]);
  });

  it("keeps cancellation in cancelling until the terminal write confirms the attempt", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun();
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    const cancelling = await repository.markRunCancelling({
      run_id: runId,
      space_id: SPACE,
      requested_at: new Date().toISOString(),
      reason: "operator requested stop",
      requested_by_user_id: USER,
    });
    expect(cancelling?.status).toBe("cancelling");
    expect((await repository.getLatestRunAttempt(SPACE, runId))?.status).toBe("cancelling");

    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "cancelled",
      error_json: { error_code: "run_cancelled", confirmed_exit: true },
      completed_at: new Date().toISOString(),
    });
    const attempt = await repository.getLatestRunAttempt(SPACE, runId);
    expect(attempt?.status).toBe("cancelled");
    expect(attempt?.cancel_confirmed_at).toBeTruthy();
  });

  it("linearizes cancellation against execution-owned terminal publication", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun();
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    expect(await repository.tryAcquireExecutionLock({
      run_id: runId,
      worker_id: "worker-1",
      job_id: null,
    })).toBe(true);
    await insertProposalRow(db.pool, {
      spaceId: SPACE,
      createdByRunId: runId,
      createdByAgentId: AGENT,
      createdByUserId: USER,
      proposalType: "memory_create",
      title: "Staged output",
      payload: { content: "must not escape cancellation" },
      rationale: "Cancellation race fixture",
      visibility: "space_shared",
      status: "staged",
    });
    await repository.markRunCancelling({
      run_id: runId,
      space_id: SPACE,
      requested_at: new Date().toISOString(),
      reason: "operator requested stop",
      requested_by_user_id: USER,
    });

    const publicCancellation = await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "cancelled",
      error_json: { error_code: "run_cancelled" },
      completed_at: new Date().toISOString(),
    });
    expect(publicCancellation).toBeNull();
    const staleSuccess = await repository.publishRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "succeeded",
      output_json: { status: "succeeded" },
      completed_at: new Date().toISOString(),
    });
    expect(staleSuccess).toBeNull();

    const cancelled = await repository.publishRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "cancelled",
      error_json: { error_code: "run_cancelled" },
      completed_at: new Date().toISOString(),
    });
    expect(cancelled?.status).toBe("cancelled");
    expect((await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_execution_locks WHERE run_id = $1",
      [runId],
    )).rows[0]?.count).toBe("0");
    expect((await db.pool.query<{ status: string }>(
      "SELECT status FROM proposals WHERE created_by_run_id = $1",
      [runId],
    )).rows).toEqual([{ status: "rejected" }]);
  });

  it("selects terminal chat Runs for recovery before finalization exists", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun();
    const repository = new PgRunRepository(db.pool);
    await db.pool.query(
      `UPDATE runs
          SET model_override_json = jsonb_build_object(
            'chat_turn',
            jsonb_build_object(
              'schema_version', 'chat_turn.v1',
              'session_id', 'session-1',
              'user_id', $3::text,
              'user_message_id', 'message-1',
              'agent_id', $4::text,
              'agent_version_id', $5::text
            )
          )
        WHERE space_id = $1 AND id = $2`,
      [SPACE, runId, USER, AGENT, VERSION],
    );
    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "succeeded",
      output_json: { status: "succeeded" },
      completed_at: new Date().toISOString(),
    });

    expect(await repository.getLatestRunFinalization(SPACE, runId)).toBeNull();
    expect(await repository.listTerminalChatRunsAwaitingCompletion()).toContainEqual({
      id: runId,
      space_id: SPACE,
    });
  });

  it("serializes concurrent finalization before writing evaluation evidence", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun();
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "succeeded",
      output_json: { status: "succeeded" },
      completed_at: new Date().toISOString(),
    });

    const constrainedPool = new Pool({
      connectionString: db.connectionUri,
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    try {
      const constrainedRepository = new PgRunRepository(constrainedPool);
      const finalize = () => new PostRunFinalizationService(
        constrainedRepository,
        undefined,
        new EvolutionSignalEmitter(constrainedPool),
        new PgUsageRepository(constrainedPool),
      ).finalize(runId, SPACE);
      await Promise.all([finalize(), finalize(), finalize(), finalize()]);
    } finally {
      await constrainedPool.end();
    }

    expect((await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_finalizations WHERE space_id = $1 AND run_id = $2",
      [SPACE, runId],
    )).rows[0]?.count).toBe("1");
    expect((await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_evaluations WHERE space_id = $1 AND run_id = $2",
      [SPACE, runId],
    )).rows[0]?.count).toBe("1");
  });

  it("leaves managed fail-fast runs failed for their owning operation", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({
      trigger_origin: "job",
      policy_context_json: {
        managed_execution: "source_post_processing",
        credential_pre_authorized: true,
        failure_policy: "fail_fast",
      },
    });
    const repository = new PgRunRepository(db.pool);
    const finalizer = new PostRunFinalizationService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgRunSupervisor(db.pool),
    );

    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_adapter_nonzero_exit", error_text: "provider rejected the request" },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);

    expect((await repository.getRun(SPACE, runId))?.status).toBe("failed");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM run_supervisor_decisions WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows[0]?.count).toBe("0");
  });

  it("automatically retries transient managed failures before returning final failure to the owning operation", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({
      trigger_origin: "system",
      max_attempts: 2,
      policy_context_json: {
        managed_execution: "project_research",
        credential_pre_authorized: true,
        failure_policy: "fail_fast",
      },
    });
    const repository = new PgRunRepository(db.pool);
    const finalizer = new PostRunFinalizationService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgRunSupervisor(db.pool),
    );

    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: {
        error_code: "provider_network_error",
        error_text: "Provider connection timed out",
      },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);

    expect((await repository.getRun(SPACE, runId))?.status).toBe("queued");
    expect((await db.pool.query<{ decision: string }>(
      `SELECT decision FROM run_supervisor_decisions
        WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows).toEqual([{ decision: "retry_same_route" }]);

    await repository.markRunRunning({
      run_id: runId,
      space_id: SPACE,
      started_at: new Date().toISOString(),
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: {
        error_code: "provider_network_error",
        error_text: "Provider connection timed out again",
      },
      completed_at: new Date().toISOString(),
    });
    await finalizer.finalize(runId, SPACE);

    expect((await repository.getRun(SPACE, runId))?.status).toBe("failed");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM run_supervisor_decisions
        WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows[0]?.count).toBe("1");
  });

  it("reroutes a retry through the persisted C2 fallback chain", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 2 });
    const repository = new PgRunRepository(db.pool);
    const routing = new PgRouteDecisionRepository(db.pool);
    const initial = await repository.getRun(SPACE, runId);
    if (!initial) throw new Error("seeded run not found");
    const firstRoute = await routing.routeRun(initial);
    expect(firstRoute.runtime_profile_id).toBe(PROFILE);

    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_stall_timeout" },
      completed_at: new Date().toISOString(),
    });
    await new PostRunFinalizationService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgRunSupervisor(db.pool),
    ).finalize(runId, SPACE);

    const queuedRetry = await repository.getRun(SPACE, runId);
    if (!queuedRetry) throw new Error("retry run not found");
    const secondRoute = await routing.routeRun(queuedRetry);
    expect(secondRoute.runtime_profile_id).toBe(FALLBACK_PROFILE);
    expect((await db.pool.query<{ attempt_number: number; selected_runtime_profile_id: string }>(
      `SELECT attempt_number, selected_runtime_profile_id
         FROM route_decisions WHERE space_id = $1 AND run_id = $2 ORDER BY attempt_number`,
      [SPACE, runId],
    )).rows).toEqual([
      { attempt_number: 1, selected_runtime_profile_id: PROFILE },
      { attempt_number: 2, selected_runtime_profile_id: FALLBACK_PROFILE },
    ]);
    expect((await db.pool.query<{ decision: string; next_attempt_number: number | null }>(
      `SELECT decision, next_attempt_number
         FROM run_supervisor_decisions WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows[0]).toEqual({ decision: "retry_fallback_route", next_attempt_number: 2 });
  });

  it("loads routing capabilities from the agent's current version when profiles do not duplicate them", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const routing = new PgRouteDecisionRepository(db.pool);
    const candidates = await routing.listCandidates(SPACE, AGENT, USER);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.capabilities).toContain("research.brief_synthesize");
    expect(candidates[1]?.capabilities).toContain("research.brief_synthesize");
  });

  it("keeps the current route when the persisted fallback chain has no remainder", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    await db.pool.query(
      `UPDATE agent_runtime_profiles SET enabled = false WHERE space_id = $1 AND id = $2`,
      [SPACE, FALLBACK_PROFILE],
    );
    const runId = await seedRun({ max_attempts: 2 });
    const repository = new PgRunRepository(db.pool);
    const routing = new PgRouteDecisionRepository(db.pool);
    const initial = await repository.getRun(SPACE, runId);
    if (!initial) throw new Error("seeded run not found");
    expect((await routing.routeRun(initial)).runtime_profile_id).toBe(PROFILE);
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_stall_timeout" },
      completed_at: new Date().toISOString(),
    });
    await new PostRunFinalizationService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgRunSupervisor(db.pool),
    ).finalize(runId, SPACE);
    const retry = await repository.getRun(SPACE, runId);
    if (!retry) throw new Error("retry run not found");
    expect((await routing.routeRun(retry)).runtime_profile_id).toBe(PROFILE);
    expect((await db.pool.query<{ decision: string }>(
      `SELECT decision FROM run_supervisor_decisions WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows[0]?.decision).toBe("retry_same_route");
  });

  it("keeps approval-paused attempts resumable without inventing a duplicate attempt", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun();
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    const paused = await repository.markRunWaitingForReview({
      run_id: runId,
      space_id: SPACE,
      approval_code: "policy_requires_approval_runtime_execute",
      message: "approval required",
      paused_at: new Date().toISOString(),
    });
    expect(paused?.status).toBe("waiting_for_review");
    expect((await repository.getLatestRunAttempt(SPACE, runId))?.status).toBe("waiting_for_review");

    await repository.grantRunApprovalAndRequeue({
      run_id: runId,
      space_id: SPACE,
      granted_by_user_id: USER,
      granted_at: new Date().toISOString(),
    });
    const requeuedAttempt = await repository.getLatestRunAttempt(SPACE, runId);
    expect(requeuedAttempt?.status).toBe("queued");
    expect(requeuedAttempt?.error_code).toBe("policy_requires_approval_runtime_execute");
    expect(requeuedAttempt?.error_json).toMatchObject({
      error_code: "policy_requires_approval_runtime_execute",
      approval_granted_by_user_id: USER,
    });
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    const attempts = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM run_attempts WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    );
    expect(attempts.rows[0]?.count).toBe("1");
  });

  it("keeps each attempt's verification results and stamps evidence with the producing attempt", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 2 });
    const repository = new PgRunRepository(db.pool);
    const verifications = new PgVerificationRepository(db.pool);
    const check = (status: "passed" | "failed") => [{
      verifier_type: "output_schema",
      verifier_version: "verification_engine.v1",
      status: status as "passed" | "failed",
      summary: `schema ${status}`,
      evidence_refs_json: {},
      details_json: {},
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }];

    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    const backfilled = await repository.getLatestRunAttempt(SPACE, runId);
    expect(backfilled?.attempt_number).toBe(1);
    expect(backfilled?.error_json).toMatchObject({ error_code: "attempt_backfilled_on_dispatch" });
    await verifications.upsertResults(SPACE, runId, check("failed"));
    await repository.appendRunEvent({
      run_id: runId,
      space_id: SPACE,
      event_type: "validation_completed",
      status: "failed",
    });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_stall_timeout" },
      completed_at: new Date().toISOString(),
    });

    await repository.requeueRunForRetry({
      run_id: runId,
      space_id: SPACE,
      updated_at: new Date().toISOString(),
      reason_code: "cli_stall_timeout",
      attempt_number: 2,
    });
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await verifications.upsertResults(SPACE, runId, check("passed"));

    const rows = await db.pool.query<{ attempt_number: number; status: string }>(
      `SELECT attempt_number, status FROM verification_results
        WHERE space_id = $1 AND run_id = $2 ORDER BY attempt_number`,
      [SPACE, runId],
    );
    expect(rows.rows).toEqual([
      { attempt_number: 1, status: "failed" },
      { attempt_number: 2, status: "passed" },
    ]);
    const current = await repository.listVerificationResults(SPACE, runId);
    expect(current.map((row) => [row.attempt_number, row.status])).toEqual([[2, "passed"]]);

    const events = await db.pool.query<{ attempt_number: number | null; event_type: string }>(
      `SELECT attempt_number, event_type FROM run_events
        WHERE space_id = $1 AND run_id = $2 ORDER BY event_index`,
      [SPACE, runId],
    );
    expect(events.rows).toEqual([{ attempt_number: 1, event_type: "validation_completed" }]);
    await repository.appendRunEvent({
      run_id: runId,
      space_id: SPACE,
      event_type: "validation_completed",
      status: "succeeded",
    });
    expect((await db.pool.query<{ attempt_number: number | null }>(
      `SELECT attempt_number FROM run_events
        WHERE space_id = $1 AND run_id = $2 ORDER BY event_index DESC LIMIT 1`,
      [SPACE, runId],
    )).rows[0]?.attempt_number).toBe(2);
  });

  it("allows a human to abandon a supervisor-held run and finalize it", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 1 });
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "adapter_runtime_error" },
      completed_at: new Date().toISOString(),
    });
    await repository.holdRunForSupervisorReview({
      run_id: runId,
      space_id: SPACE,
      updated_at: new Date().toISOString(),
      reason_code: "retry_attempt_cap_reached",
      message: "review required",
    });
    const abandoned = await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "cancelled",
      output_json: {},
      error_json: { error_code: "run_abandoned", abandoned_by_user_id: USER },
      completed_at: new Date().toISOString(),
    });
    expect(abandoned?.status).toBe("cancelled");
    expect((await repository.getLatestRunAttempt(SPACE, runId))?.status).toBe("cancelled");
    const finalization = await new PostRunFinalizationService(repository).finalize(runId, SPACE);
    expect(finalization.outcome_status).toBe("failed");
  });

  it("resumes a supervisor terminal hold as a new explicitly authorized attempt", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 1 });
    const repository = new PgRunRepository(db.pool);
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "adapter_runtime_error" },
      completed_at: new Date().toISOString(),
    });
    await repository.holdRunForSupervisorReview({
      run_id: runId,
      space_id: SPACE,
      updated_at: new Date().toISOString(),
      reason_code: "retry_attempt_cap_reached",
      message: "review required",
    });
    const resumed = await repository.resumeRunAfterSupervisorReview({
      run_id: runId,
      space_id: SPACE,
      resumed_by_user_id: USER,
      resumed_at: new Date().toISOString(),
    });
    expect(resumed?.status).toBe("queued");
    expect((await db.pool.query<{ attempt_number: number; status: string }>(
      `SELECT attempt_number, status
         FROM run_attempts WHERE space_id = $1 AND run_id = $2 ORDER BY attempt_number`,
      [SPACE, runId],
    )).rows).toEqual([
      { attempt_number: 1, status: "waiting_for_review" },
      { attempt_number: 2, status: "queued" },
    ]);
  });

  it("enforces a run cost cap across attempts before scheduling a retry", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun({ max_attempts: 2, max_cost: 1 });
    const repository = new PgRunRepository(db.pool);
    const usage = new PgUsageRepository(db.pool);
    const instanceId = await usage.getOrCreateInstanceId();
    await usage.appendEvent(normalizeUsageObservation(
      {
        space_id: SPACE,
        event_type: "llm.generation",
        source_type: "local_run",
        execution_channel: "managed_api",
        run_id: runId,
        agent_id: AGENT,
        estimated_cost_usd: 1.25,
        cost_accuracy: "catalog",
        usage_details: { input: 10, output: 10 },
        usage_accuracy: "estimated",
        idempotency_key: `supervisor-cost:${runId}`,
      },
      instanceId,
      {
        owner_user_id: USER,
        visibility: "space_shared",
        access_level: "full",
        source_resource_type: null,
        source_resource_id: null,
        project_folder_id: null,
        project_id: null,
        grant_snapshots: [],
      },
    ));

    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: new Date().toISOString() });
    await repository.markRunTerminal({
      run_id: runId,
      space_id: SPACE,
      status: "failed",
      error_json: { error_code: "cli_stall_timeout" },
      completed_at: new Date().toISOString(),
    });
    await new PostRunFinalizationService(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      new PgRunSupervisor(db.pool),
    ).finalize(runId, SPACE);

    expect((await repository.getRun(SPACE, runId))?.status).toBe("waiting_for_review");
    expect((await db.pool.query<{ decision: string }>(
      `SELECT decision FROM run_supervisor_decisions WHERE space_id = $1 AND run_id = $2`,
      [SPACE, runId],
    )).rows[0]?.decision).toBe("budget_exceeded");
    expect((await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE space_id = $1 AND payload_json->>'run_id' = $2`,
      [SPACE, runId],
    )).rows[0]?.count).toBe("0");
  });

  it("marks lost executions orphaned during startup recovery", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const runId = await seedRun();
    const repository = new PgRunRepository(db.pool);
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    await repository.markRunRunning({ run_id: runId, space_id: SPACE, started_at: startedAt });
    expect(await repository.tryAcquireExecutionLock({
      run_id: runId,
      worker_id: "lost-worker",
      job_id: null,
    })).toBe(true);
    await insertProposalRow(db.pool, {
      spaceId: SPACE,
      createdByRunId: runId,
      createdByAgentId: AGENT,
      createdByUserId: USER,
      proposalType: "memory_create",
      title: "Staged output",
      payload: { content: "staged" },
      rationale: "Recovery fixture",
      visibility: "space_shared",
      status: "staged",
    });
    await insertProposalRow(db.pool, {
      spaceId: SPACE,
      createdByRunId: runId,
      createdByAgentId: AGENT,
      createdByUserId: USER,
      proposalType: "memory_create",
      title: "Promoted before crash",
      payload: { content: "pending" },
      rationale: "Recovery fixture",
      visibility: "space_shared",
      status: "pending",
    });
    expect(await repository.listProposalSummaries(SPACE, runId)).toEqual([]);
    await db.pool.query(
      `UPDATE runs SET started_at = $3, updated_at = $3 WHERE space_id = $1 AND id = $2`,
      [SPACE, runId, startedAt],
    );
    const recovered = await repository.recoverStaleRuns(60, new Date());
    expect(recovered).toBe(1);
    expect((await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_execution_locks WHERE run_id = $1",
      [runId],
    )).rows[0]?.count).toBe("0");
    expect(await repository.tryAcquireExecutionLock({
      run_id: runId,
      worker_id: "retry-worker",
      job_id: null,
    })).toBe(true);
    await repository.releaseExecutionLock(runId);
    expect((await repository.getRun(SPACE, runId))?.status).toBe("orphaned");
    expect((await repository.getLatestRunAttempt(SPACE, runId))?.status).toBe("orphaned");
    expect((await repository.listProposalSummaries(SPACE, runId)).map((proposal) =>
      proposal.status
    )).toEqual(["rejected", "rejected"]);
  });
});

async function seedRun(contract: {
  max_runs?: number;
  max_attempts?: number;
  max_cost?: number;
  trigger_origin?: "manual" | "job" | "system";
  policy_context_json?: Record<string, unknown>;
  model_override_json?: Record<string, unknown>;
} = {}): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, runtime_profile_id,
       run_type, trigger_origin, status, mode,
       adapter_type, instructed_by_user_id, owner_user_id,
       required_sandbox_level, contract_snapshot_json, model_override_json,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'agent', $7, 'queued', 'live',
       'model_api', $6, $6, 'none', $8::jsonb, $9::jsonb, $10, $10)`,
    [
      runId,
      SPACE,
      AGENT,
      VERSION,
      PROFILE,
      USER,
      contract.trigger_origin ?? "manual",
      JSON.stringify({
        contract_version: "run_contract.v1",
        // Supervisor signals are targeted only for runs with an evolvable
        // source.  Use a task source here so the test exercises that path.
        source: { kind: "task", id: "supervisor-test-task" },
        max_runs: contract.max_runs ?? null,
        max_attempts: contract.max_attempts ?? null,
        max_cost: contract.max_cost ?? null,
        policy_context_json: contract.policy_context_json ?? null,
      }),
      JSON.stringify(contract.model_override_json ?? {}),
      now,
    ],
  );
  return runId;
}
