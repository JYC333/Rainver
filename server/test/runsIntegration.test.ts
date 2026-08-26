import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { canonicalRunOutput } from "../src/modules/runs/orchestrationResults.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import {
  NonTerminalRunError,
  PostRunFinalizationService,
} from "../src/modules/runs/finalizationService.js";

// Real-PostgreSQL integration tests for the server runs repositories. The unit
// suites use a FakeDb that does not execute SQL, so they cannot catch parameter
// type inference, CHECK/UNIQUE constraints, varchar length, or CTE column
// ambiguity. These run the actual SQL against the repository's shared
// PostgreSQL Testcontainers template loaded from migrations/0001_baseline.sql.
//
// The whole suite skips gracefully when Docker is unavailable so `pnpm test`
// still runs everywhere; where Docker is present (dev, CI) it always runs.


const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeEach(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  await resetTables(
    db.pool,
    ["content_access_grants", "space_memberships", "actors", "agents", "agent_versions", "agent_runtime_profiles", "agent_run_groups", "agent_run_group_members", "agent_run_messages", "runs", "run_delegations", "run_steps", "run_events", "run_execution_locks", "run_evaluations", "verification_results", "run_finalizations", "jobs", "job_events", "artifacts", "tasks", "task_runs", "task_evaluations"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ('user-1', 'Runs Test User', 'active', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ('space-1', 'Runs Test Space', 'team', 'user-1', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, 'space-1', 'user-1', 'owner', 'active', $2, $2)`,
    [randomUUID(), now],
  );
  await db.pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       created_at, updated_at, visibility
     ) VALUES ('agent-1', 'space-1', 'user-1', 'Runs Test Agent', 'active', NULL, $1, $1, 'space_shared')`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ('version-1', 'agent-1', 'space-1', 'v1', 'You are a test agent.',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $1)`,
    [now],
  );
  await db.pool.query("UPDATE agents SET current_version_id = 'version-1' WHERE id = 'agent-1'");
  await db.pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, enabled,
       capabilities_json, config_json, created_at, updated_at
     ) VALUES ('provider-1', 'space-1', 'user-1', 'Runs Test Provider', 'openai', true,
       '{}'::jsonb, '{}'::jsonb, $1, $1)`,
    [now],
  );
});

async function seedAgent(
  overrides: Partial<{
    agent_id: string;
    version_id: string;
    space_id: string;
    status: string;
    system_prompt: string | null;
    runtime_config_json: Record<string, unknown>;
    skip_runtime_profile: boolean;
  }> = {},
): Promise<{ agentId: string; versionId: string }> {
  const agentId = overrides.agent_id ?? randomUUID();
  const versionId = overrides.version_id ?? randomUUID();
  const spaceId = overrides.space_id ?? "space-1";
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, current_version_id,
       created_at, updated_at, visibility
     ) VALUES ($1,$2,'user-1','Agent',$3,NULL,$4,$4,'space_shared')`,
    [agentId, spaceId, overrides.status ?? "active", now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1',$4,'{}'::jsonb,$6::jsonb,'{}'::jsonb,'{}'::jsonb,
       '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$5)`,
    [
      versionId,
      agentId,
      spaceId,
      overrides.system_prompt ?? "You are a test agent.",
      now,
      JSON.stringify(overrides.runtime_config_json ?? {}),
    ],
  );
  await db.pool.query(
    `UPDATE agents SET current_version_id = $2 WHERE id = $1 AND space_id = $3`,
    [agentId, versionId, spaceId],
  );
  if (!overrides.skip_runtime_profile) {
    const adapterType =
      typeof overrides.runtime_config_json?.adapter_type === "string"
        ? overrides.runtime_config_json.adapter_type
        : "model_api";
    await seedRuntimeProfile(agentId, {
      adapter_type: adapterType,
      runtime_config_json: { adapter_type: adapterType },
      is_default: true,
    });
  }
  return { agentId, versionId };
}

async function seedRuntimeProfile(
  agentId: string,
  overrides: Partial<{
    id: string;
    space_id: string;
    name: string;
    adapter_type: string;
    model_provider_id: string | null;
    model_name: string | null;
    runtime_config_json: Record<string, unknown>;
    is_default: boolean;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const adapterType = overrides.adapter_type ?? "model_api";
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, model_provider_id,
       model_name, runtime_config_json, runtime_policy_json, enabled,
       is_default, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,true,$10,$11,$11)`,
    [
      id,
      overrides.space_id ?? "space-1",
      agentId,
      overrides.name ?? "Default",
      adapterType,
      overrides.model_provider_id ?? null,
      overrides.model_name ?? null,
      JSON.stringify(overrides.runtime_config_json ?? { adapter_type: adapterType }),
      JSON.stringify({ default_adapter_type: adapterType }),
      overrides.is_default ?? true,
      now,
    ],
  );
  return id;
}

async function seedRun(
  overrides: Partial<{
    space_id: string;
    status: string;
    adapter_type: string;
    model_provider_id: string | null;
    instructed_by_user_id: string | null;
    required_sandbox_level: string;
  }> = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin,
       status, mode, adapter_type, model_provider_id,
       instructed_by_user_id, required_sandbox_level, created_at, updated_at
     ) VALUES ($1,$2,'agent-1','version-1','agent','manual',$3,'live',
       $4,$5,$6,$7,$8,$8)`,
    [
      id,
      overrides.space_id ?? "space-1",
      overrides.status ?? "queued",
      overrides.adapter_type ?? "model_api",
      overrides.model_provider_id ?? "provider-1",
      overrides.instructed_by_user_id ?? null,
      overrides.required_sandbox_level ?? "none",
      now,
    ],
  );
  return id;
}

async function seedJob(
  overrides: Partial<{
    job_type: string;
    status: string;
    attempts: number;
    claimed_by: string | null;
    heartbeat_at: string | null;
    payload: Record<string, unknown>;
  }> = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO jobs (
       id, space_id, job_type, status, priority, payload_json, attempts,
       max_attempts, scheduled_at, created_at, updated_at, claimed_by, heartbeat_at
     ) VALUES ($1,'space-1',$2,$3,0,$4::jsonb,$5,3,$6,$6,$6,$7,$8)`,
    [
      id,
      overrides.job_type ?? "agent_run",
      overrides.status ?? "pending",
      JSON.stringify(overrides.payload ?? { run_id: "run-1" }),
      overrides.attempts ?? 0,
      now,
      overrides.claimed_by ?? null,
      overrides.heartbeat_at ?? null,
    ],
  );
  return id;
}

describe("runs repositories against real PostgreSQL", () => {
  it("creates a queued run without a legacy context snapshot", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const { agentId, versionId } = await seedAgent();

    const run = await repo.createQueuedRun({
      agent_id: agentId,
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "hello",
    });

    expect(run.status).toBe("queued");
    expect(run.agent_version_id).toBe(versionId);
    const snapshots = await db.pool.query(
      "SELECT id FROM invocation_snapshots WHERE invocation_id = $1",
      [run.id],
    );
    expect(snapshots.rows).toEqual([]);
    await expect(repo.getRun("space-1", run.id)).resolves.toMatchObject({
      id: run.id,
      system_prompt: "You are a test agent.",
    });
  });

  it("creates an unrouted Run without copying AgentVersion runtime config", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const { agentId } = await seedAgent({
      runtime_config_json: { adapter_type: "claude_code" },
      skip_runtime_profile: true,
    });

    const run = await repo.createQueuedRun({
      agent_id: agentId,
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "hi",
    });
    expect(run.requested_runtime_profile_id).toBeNull();
    expect(run.runtime_profile_id).toBeNull();
    expect(run.adapter_type).toBeNull();
  });

  it("leaves the space default ModelProvider to Router selection", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const { agentId } = await seedAgent();
    const providerId = randomUUID();
    await db.pool.query(
      `INSERT INTO model_providers (
         id, space_id, owner_user_id, name, provider_type, default_model,
         enabled, capabilities_json, config_json, created_at, updated_at
       ) VALUES ($1,'space-1','user-1','Default Test Provider','openai','MiniMax-M3',
         true,'{}'::jsonb,'{"is_default": true}'::jsonb,$2,$2)`,
      [providerId, new Date().toISOString()],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id, provider_id, space_id, owner_user_id, granted_by_user_id,
         enabled, is_default, created_at, updated_at
       ) VALUES ($1,$2,'space-1','user-1','user-1',true,true,$3,$3)`,
      [randomUUID(), providerId, new Date().toISOString()],
    );

    const run = await repo.createQueuedRun({
      agent_id: agentId,
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "hi",
    });

    expect(run.adapter_type).toBeNull();
    expect(run.model_provider_id).toBeNull();
    expect(run.route_decision_id).toBeNull();
  });

  it("does not stamp CLI execution state before Router selection", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const { agentId } = await seedAgent({
      runtime_config_json: { adapter_type: "claude_code" },
    });

    const run = await repo.createQueuedRun({
      agent_id: agentId,
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "chat",
    });

    expect(run.adapter_type).toBeNull();
    expect(run.project_folder_id).toBeNull();
    expect(run.required_sandbox_level).toBe("none");
  });

  it("persists a requested runtime profile without preselecting or snapshotting it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const { agentId } = await seedAgent({
      runtime_config_json: { adapter_type: "model_api" },
    });
    const profileId = await seedRuntimeProfile(agentId, {
      name: "CLI review",
      adapter_type: "codex_cli",
      runtime_config_json: {
        adapter_type: "codex_cli",
        runtime_tool_version: "1.2.3",
      },
      is_default: false,
    });

    const run = await repo.createQueuedRun({
      agent_id: agentId,
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      runtime_profile_id: profileId,
      prompt: "review",
    });

    expect(run.requested_runtime_profile_id).toBe(profileId);
    expect(run.runtime_profile_id).toBeNull();
    expect(run.adapter_type).toBeNull();
    expect(run.runtime_profile_snapshot_json).toBeNull();

    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET runtime_config_json = '{"adapter_type":"model_api"}'::jsonb
        WHERE id = $1`,
      [profileId],
    );
    const loaded = await repo.getRun("space-1", run.id);
    expect(loaded?.requested_runtime_profile_id).toBe(profileId);
    expect(loaded?.runtime_profile_id).toBeNull();
    expect(loaded?.runtime_config_json).toEqual({});
  });

  it("appends run events with a DB-computed monotonic event_index", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();

    const e0 = await repo.appendRunEvent({
      run_id: runId,
      space_id: "space-1",
      event_type: "policy_checked",
      status: "succeeded",
    });
    const e1 = await repo.appendRunEvent({
      run_id: runId,
      space_id: "space-1",
      event_type: "adapter_invoked",
      status: "running",
    });

    // The scalar subquery + ::varchar casts must execute; the old
    // INSERT...SELECT shape failed real "inconsistent types deduced" inference.
    expect(e0.event_index).toBe(0);
    expect(e1.event_index).toBe(1);
  });

  it("accepts delegation lifecycle run events", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();

    const event = await repo.appendRunEvent({
      run_id: runId,
      space_id: "space-1",
      event_type: "delegation_requested",
      status: "succeeded",
      metadata_json: {
        group_id: "group-1",
        delegation_id: "delegation-1",
        target_agent_id: "agent-reader",
      },
    });

    expect(event.event_type).toBe("delegation_requested");
  });

  it("rejects an event_type outside ck_run_events_event_type", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();

    // "run_orchestration_failed" is NOT in the CHECK list — this is exactly why
    // orchestration had to switch to the constraint-valid "adapter_completed".
    await expect(
      repo.appendRunEvent({
        run_id: runId,
        space_id: "space-1",
        event_type: "run_orchestration_failed",
        status: "failed",
      }),
    ).rejects.toThrow();
  });

  it("creates a coarse run step and enforces actor_id length + step_type CHECK", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();
    const actorId = await repo.resolveRunActorId(
      { space_id: "space-1", instructed_by_user_id: null },
      "job",
    );

    const step = await repo.createRunStep({
      run_id: runId,
      space_id: "space-1",
      actor_id: actorId,
      step_type: "adapter_started",
      status: "running",
    });
    expect(step.step_index).toBe(0);

    // The original defect wrote a worker-id string (>36 chars, not an Actor) to
    // actor_id; varchar(36) rejects it.
    await expect(
      repo.createRunStep({
        run_id: runId,
        space_id: "space-1",
        actor_id: `http:${randomUUID()}:${randomUUID()}`,
        step_type: "adapter_started",
        status: "running",
      }),
    ).rejects.toThrow();
  });

  it("resolves/creates real actors and reuses them per type", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);

    const user1 = await repo.resolveRunActorId(
      { space_id: "space-1", instructed_by_user_id: "user-1" },
      "http",
    );
    const user1Again = await repo.resolveRunActorId(
      { space_id: "space-1", instructed_by_user_id: "user-1" },
      "http",
    );
    expect(user1Again).toBe(user1); // reused, not duplicated

    const jobActor = await repo.resolveRunActorId(
      { space_id: "space-1", instructed_by_user_id: null },
      "job",
    );
    const systemActor = await repo.resolveRunActorId(
      { space_id: "space-1", instructed_by_user_id: null },
      "http",
    );
    expect(new Set([user1, jobActor, systemActor]).size).toBe(3);

    const rows = await db.pool.query<{ actor_type: string; service_name: string | null }>(
      "SELECT actor_type, service_name FROM actors WHERE id = ANY($1)",
      [[jobActor, systemActor]],
    );
    const byType = Object.fromEntries(rows.rows.map((r) => [r.actor_type, r.service_name]));
    expect(byType.job).toBe("agent_run");
    expect(byType.system).toBe("run_execution");
  });

  it("marks running then terminal, guarding against overwriting a cancel", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();

    const running = await repo.markRunRunning({
      run_id: runId,
      space_id: "space-1",
      started_at: new Date().toISOString(),
    });
    expect(running?.status).toBe("running");

    const cancelled = await repo.markRunTerminal({
      run_id: runId,
      space_id: "space-1",
      status: "cancelled",
      completed_at: new Date().toISOString(),
      error_json: { error_code: "run_cancelled" },
    });
    expect(cancelled?.status).toBe("cancelled");

    // A late adapter result must NOT overwrite the terminal cancel.
    const late = await repo.markRunTerminal({
      run_id: runId,
      space_id: "space-1",
      status: "succeeded",
      output_text: "late output",
      completed_at: new Date().toISOString(),
    });
    expect(late).toBeNull();

    const after = await repo.getRun("space-1", runId);
    expect(after?.status).toBe("cancelled");
  });

  it("finalizes a terminal run idempotently with evaluation and run_finalized event", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun({ status: "succeeded" });
    await repo.appendRunEvent({
      run_id: runId,
      space_id: "space-1",
      event_type: "adapter_completed",
      status: "succeeded",
    });

    const evolutionSolidifier = {
      solidifyFromRunEvaluation: vi.fn().mockResolvedValue({ id: "experience-1" }),
    };
    const service = new PostRunFinalizationService(repo, evolutionSolidifier);
    const first = await service.finalize(runId, "space-1");
    const second = await service.finalize(runId, "space-1");

    expect(second.id).toBe(first.id);
    expect(first.status).toBe("completed");
    expect(first.outcome_status).toBe("passed");
    expect(first.metadata_json).toMatchObject({ evolution_experience_id: "experience-1" });
    expect(evolutionSolidifier.solidifyFromRunEvaluation).toHaveBeenCalledTimes(1);
    expect(evolutionSolidifier.solidifyFromRunEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      run_id: runId,
      space_id: "space-1",
      outcome_status: "passed",
    }));
    const evaluations = await repo.listRunEvaluations("space-1", runId);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].outcome_status).toBe("passed");
    const finalizations = await repo.listRunFinalizations("space-1", runId);
    expect(finalizations).toHaveLength(1);
    const events = await repo.listRunEvents("space-1", runId);
    expect(events.map((event) => event.event_type)).toEqual([
      "adapter_completed",
      "run_finalized",
    ]);
  });

  it("bridges a linked run evaluation into one task evaluation idempotently", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun({ status: "succeeded" });
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO tasks (id, space_id, title, status, created_at, updated_at)
       VALUES ($1,'space-1','Task bridge target','ready',$2,$2)`,
      [taskId, now],
    );
    await db.pool.query(
      `INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
       VALUES ($1,'space-1',$2,$3,'primary',$4)`,
      [randomUUID(), taskId, runId, now],
    );
    await db.pool.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, artifact_type, title,
         export_formats_json, created_at, updated_at
       ) VALUES ($1,'space-1',$2,'test','Test Artifact','[]'::jsonb,$3,$3)`,
      [artifactId, runId, now],
    );
    await repo.appendRunEvent({
      run_id: runId,
      space_id: "space-1",
      event_type: "adapter_completed",
      status: "succeeded",
    });

    const service = new PostRunFinalizationService(repo);
    const first = await service.finalize(runId, "space-1");
    const second = await service.finalize(runId, "space-1");

    expect(second.id).toBe(first.id);
    expect(first.task_evaluation_id).toBeTruthy();
    expect(first.skipped_reasons_json).toEqual([]);
    const rows = await db.pool.query<{
      id: string;
      task_id: string;
      run_id: string;
      run_evaluation_id: string;
      evaluator_type: string;
      score: number | null;
      confidence: number | null;
      evidence_artifact_ids: string[];
      recommendation: string | null;
    }>(
      `SELECT id, task_id, run_id, run_evaluation_id, evaluator_type, score,
              confidence, evidence_artifact_ids, recommendation
         FROM task_evaluations
        WHERE space_id = 'space-1' AND task_id = $1 AND run_id = $2`,
      [taskId, runId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: first.task_evaluation_id,
      task_id: taskId,
      run_id: runId,
      evaluator_type: "run_evaluation_bridge",
      score: 1,
      confidence: 1,
      evidence_artifact_ids: [artifactId],
      recommendation: "accept",
    });
    expect(rows.rows[0].run_evaluation_id).toBeTruthy();
  });

  it("rejects finalization for non-terminal runs", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun({ status: "running" });

    await expect(
      new PostRunFinalizationService(repo).finalize(runId, "space-1"),
    ).rejects.toBeInstanceOf(NonTerminalRunError);
  });

  it("persists the canonical run_output.v1 summary on the terminal write", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();
    await repo.markRunRunning({
      run_id: runId,
      space_id: "space-1",
      started_at: new Date().toISOString(),
    });

    await repo.markRunTerminal({
      run_id: runId,
      space_id: "space-1",
      status: "succeeded",
      output_text: "final answer",
      output_json: canonicalRunOutput({
        success: true,
        outputText: "final answer",
        outputJson: {},
      }),
      completed_at: new Date().toISOString(),
    });

    const row = await db.pool.query<{ output_json: { schema_version?: string; summary?: string } }>(
      "SELECT output_json FROM runs WHERE id = $1",
      [runId],
    );
    expect(row.rows[0].output_json.schema_version).toBe("run_output.v1");
    expect(row.rows[0].output_json.summary).toBe("final answer");
  });

  it("acquires the execution lock once (ON CONFLICT DO NOTHING)", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repo = new PgRunRepository(db.pool);
    const runId = await seedRun();

    const first = await repo.tryAcquireExecutionLock({ run_id: runId, worker_id: "w1" });
    const second = await repo.tryAcquireExecutionLock({ run_id: runId, worker_id: "w2" });
    expect(first).toBe(true);
    expect(second).toBe(false); // duplicate execution prevented

    await repo.releaseExecutionLock(runId);
    const third = await repo.tryAcquireExecutionLock({ run_id: runId, worker_id: "w3" });
    expect(third).toBe(true);
  });

  it("claims an agent_run job through the real CTE (no ambiguous id)", async (ctx) => {
    if (!db.available) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    await seedJob({ job_type: "memory_consolidation", status: "pending" }); // must be ignored
    const target = await seedJob({ job_type: "agent_run", status: "pending" });

    const claimed = await jobs.claimNextAgentRun("worker-1");
    // The old "column reference \"id\" is ambiguous" defect threw here.
    expect(claimed?.id).toBe(target);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimed_by).toBe("worker-1");

    // Only agent_run is claimable; a second claim finds nothing.
    const none = await jobs.claimNextAgentRun("worker-2");
    expect(none).toBeNull();
  });

  it("reclaims stuck jobs through the multi-CTE statement", async (ctx) => {
    if (!db.available) return ctx.skip();
    const jobs = new PgJobQueueRepository(db.pool);
    const old = new Date(Date.now() - 3600_000).toISOString();
    const retryableId = await seedJob({
      job_type: "agent_run",
      status: "running",
      claimed_by: "dead-worker",
      heartbeat_at: old,
    });
    const exhaustedId = await seedJob({
      job_type: "memory_consolidation",
      status: "running",
      attempts: 3,
      claimed_by: "dead-worker",
      heartbeat_at: old,
    });

    const result = await jobs.reclaimStuckJobs(600);
    expect(result.reclaimed_count).toBeGreaterThanOrEqual(2);
    expect(result.exhausted_jobs).toEqual([
      expect.objectContaining({
        id: exhaustedId,
        space_id: "space-1",
        job_type: "memory_consolidation",
        attempts: 3,
        max_attempts: 3,
      }),
    ]);

    const rows = await db.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM jobs WHERE id = ANY($1::text[]) ORDER BY id",
      [[retryableId, exhaustedId]],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))).toEqual({
      [retryableId]: "pending",
      [exhaustedId]: "failed",
    });
  });

});
