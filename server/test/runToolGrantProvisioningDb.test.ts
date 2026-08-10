import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { PgRunRepository, type RunRecord } from "../src/modules/runs/repository";
import { assembleRunInputEnvelope } from "../src/modules/runs/runInputEnvelope";
import { AuthorizationRequestService } from "../src/modules/policy/authorizationRequestService";
import { ActionApprovalGrantService } from "../src/modules/policy/actionApprovalGrantService";
import { loadActionRegistry } from "../src/modules/policy/actionRegistry";
import { enforce } from "../src/modules/policy/service";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry";
import { PgJobQueueRepository } from "../src/modules/jobs/repository";
import { JobWorker } from "../src/modules/jobs/worker";
import { registerAgentRunHandler } from "../src/modules/runs/agentRunHandler";
import { loadConfig } from "../src/config";

// The real creation path must persist the fail-closed intersection of Run
// capabilities, immutable AgentVersion permissions, and the System Action
// Registry. A FakeDb cannot prove which columns the INSERT actually writes.

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

const SPACE = "space-1";
const USER = "user-1";
const AGENT = "agent-1";
let agentVersionId = "";

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri() });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[run-tool-grant-provisioning] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  const now = new Date().toISOString();
  await pool.query(
    "TRUNCATE runs, agent_versions, agents, space_memberships, spaces, users CASCADE",
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'User', 'active', $2, $2)`,
    [USER, now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, 'Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, USER, now],
  );
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, USER, now],
  );
  agentVersionId = randomUUID();
  // The AgentVersion declares a capability ceiling and an allowed tool, so a
  // missing grant cannot be blamed on an agent that was never allowed a tool.
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1','You are a test agent.','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
       '{}'::jsonb,$4::jsonb,$5::jsonb,'{}'::jsonb,$6)`,
    [
      agentVersionId,
      AGENT,
      SPACE,
      JSON.stringify(["agent.delegate"]),
      JSON.stringify({ allowed_tools: ["agent.delegate"] }),
      now,
    ],
  );
  await pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, agentVersionId]);
});

async function readSnapshot(runId: string): Promise<unknown> {
  const result = await pool!.query<{ permission_snapshot_json: unknown }>(
    `SELECT permission_snapshot_json FROM runs WHERE id = $1`,
    [runId],
  );
  return result.rows[0]?.permission_snapshot_json ?? null;
}

describe("run tool grant provisioning", () => {
  it("persists declared and permitted agent-tool grants when a run is created", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repository = new PgRunRepository(pool);

    const created = await repository.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Coordinate with the other room member",
      capabilities_json: ["agent.delegate"],
    });

    const snapshot = await readSnapshot(created.id);
    expect(snapshot).toEqual({
      tool_grants: [
        {
          action_id: "authorization.request",
          capability_id: null,
          approval_behavior: "none",
          side_effecting: true,
        },
        {
          action_id: "agent.delegate",
          capability_id: null,
          approval_behavior: "none",
          side_effecting: true,
        },
      ],
    });
  });

  it("projects durable grants into the CLI run input envelope", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repository = new PgRunRepository(pool);

    const created = await repository.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Coordinate with the other room member",
      capabilities_json: ["agent.delegate"],
    });

    const stored = await repository.getRun(SPACE, created.id);
    expect(stored).not.toBeNull();

    const envelope = assembleRunInputEnvelope(stored as RunRecord);
    expect(envelope.tool_grants).toEqual([
      {
        action_id: "authorization.request",
        capability_id: null,
        approval_behavior: "none",
        side_effecting: true,
      },
      {
        action_id: "agent.delegate",
        capability_id: null,
        approval_behavior: "none",
        side_effecting: true,
      },
    ]);
    expect(stored?.capabilities_json).toEqual(["agent.delegate"]);
  });

  it("does not grant undeclared, unpermitted, or unknown actions", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const repository = new PgRunRepository(pool);

    const created = await repository.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Use only the explicitly authorized action",
      capabilities_json: [
        "agent.delegate",
        "retrieval.search",
        "unknown.action",
      ],
    });

    expect(await readSnapshot(created.id)).toEqual({
      tool_grants: [
        {
          action_id: "authorization.request",
          capability_id: null,
          approval_behavior: "none",
          side_effecting: true,
        },
        {
          action_id: "agent.delegate",
          capability_id: null,
          approval_behavior: "none",
          side_effecting: true,
        },
      ],
    });
  });

  it("creates and approves a request bound to an audited same-Run denial", async (ctx) => {
    if (!available || !pool || !container) return ctx.skip();
    const repository = new PgRunRepository(pool);
    const created = await repository.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Request a bounded authorization",
      capabilities_json: ["agent.delegate"],
    });
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE runs
          SET status = 'running', started_at = $3, updated_at = $3
        WHERE id = $1 AND space_id = $2`,
      [created.id, SPACE, now],
    );
    await pool.query(
      `UPDATE run_attempts
          SET status = 'running', started_at = $3, last_activity_at = $3, updated_at = $3
        WHERE run_id = $1 AND space_id = $2 AND attempt_number = 1`,
      [created.id, SPACE, now],
    );
    const policyResult = await enforce(
      { databaseUrl: container.getConnectionUri() },
      await loadActionRegistry(),
      {
        action: "project.source.bind",
        actor_type: "agent",
        actor_id: AGENT,
        space_id: SPACE,
        resource_space_id: SPACE,
        resource_type: "projects",
        resource_id: created.id,
        run_id: created.id,
        force_record: true,
        context: {
          action_id: "project.source.propose_bind",
          surface: "managed_run_system_action_gateway",
          has_action_approval_grant: false,
        },
        metadata_json: {
          surface: "managed_run_system_action_gateway",
          action_id: "project.source.propose_bind",
        },
      },
    );
    expect(policyResult).toMatchObject({
      status: "blocked",
      decision: {
        decision: "deny",
        policy_rule_id: "managed_system_action_grant_required",
      },
    });
    const policyDecisionRecordId = policyResult.policy_decision_record_id!;

    const service = new AuthorizationRequestService(pool, {
      databaseUrl: container!.getConnectionUri(),
    });
    const wrongActorDecision = await enforce(
      { databaseUrl: container.getConnectionUri() },
      await loadActionRegistry(),
      {
        action: "project.source.bind",
        actor_type: "user",
        actor_id: USER,
        space_id: SPACE,
        resource_space_id: SPACE,
        resource_type: "projects",
        resource_id: created.id,
        run_id: created.id,
        force_record: true,
        context: {
          action_id: "project.source.propose_bind",
          surface: "managed_run_system_action_gateway",
          has_action_approval_grant: false,
        },
        metadata_json: {
          surface: "managed_run_system_action_gateway",
          action_id: "project.source.propose_bind",
        },
      },
    );
    await expect(service.createFromDeniedDecision({
      spaceId: SPACE,
      runId: created.id,
      agentId: AGENT,
      policyDecisionRecordId: wrongActorDecision.policy_decision_record_id!,
      reason: "This user-authored record must not authorize an Agent request.",
    })).rejects.toMatchObject({ statusCode: 403 });
    const request = await service.createFromDeniedDecision({
      spaceId: SPACE,
      runId: created.id,
      agentId: AGENT,
      policyDecisionRecordId,
      reason: "The requested Project source setup needs this bounded action.",
    });
    expect(request).toMatchObject({
      action_id: "project.source.propose_bind",
      status: "pending",
    });
    const pausedRun = await pool.query(
      `SELECT status, error_json FROM runs WHERE id = $1 AND space_id = $2`,
      [created.id, SPACE],
    );
    expect(pausedRun.rows[0]).toMatchObject({
      status: "waiting_for_review",
      error_json: {
        error_code: "authorization_request_pending",
        authorization_request_id: request.id,
      },
    });

    const approved = await service.decide(
      { spaceId: SPACE, userId: USER },
      request.id,
      "approved",
    );
    expect(approved.status).toBe("approved");
    expect(approved.resulting_action_grant_id).toBeTruthy();
    const grant = await pool.query(
      `SELECT action_id, target_run_id, project_id, resource_kind, resource_id,
              max_uses, status
         FROM action_approval_grants
        WHERE id = $1`,
      [approved.resulting_action_grant_id],
    );
    expect(grant.rows[0]).toMatchObject({
      action_id: "project.source.propose_bind",
      target_run_id: created.id,
      project_id: null,
      resource_kind: null,
      resource_id: null,
      max_uses: 1,
      status: "active",
    });
    const grantService = new ActionApprovalGrantService(pool);
    await expect(grantService.hasMatching({
      spaceId: SPACE,
      agentId: AGENT,
      actionId: "project.source.propose_bind",
      runId: created.id,
    })).resolves.toBe(true);
    await expect(grantService.hasMatching({
      spaceId: SPACE,
      agentId: AGENT,
      actionId: "project.source.propose_bind",
      runId: "another-run",
    })).resolves.toBe(false);
    const waitingRun = await pool.query(
      `SELECT status, error_json FROM runs WHERE id = $1 AND space_id = $2`,
      [created.id, SPACE],
    );
    expect(waitingRun.rows[0]).toMatchObject({ status: "waiting_for_review" });
    const reconcileJob = await pool.query<{
      id: string;
      payload_json: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, payload_json, attempts, max_attempts
         FROM jobs
        WHERE job_type = 'authorization_request_reconcile'
          AND payload_json->>'authorization_request_id' = $1`,
      [request.id],
    );
    expect(reconcileJob.rows).toHaveLength(1);
    await pool.query(
      `INSERT INTO run_execution_locks (run_id, locked_at, worker_id, job_id)
       VALUES ($1, $2, 'old-worker', NULL)`,
      [created.id, now],
    );
    const registry = new JobHandlerRegistry();
    registerAgentRunHandler(registry, loadConfig({
      SERVER_DATABASE_URL: container.getConnectionUri(),
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    }));
    const queue = new PgJobQueueRepository(pool);
    const worker = new JobWorker(
      queue,
      registry,
      "test-worker",
      ["authorization_request_reconcile"],
    );
    await expect(worker.processOne()).resolves.toEqual({
      status: "deferred",
      job_id: reconcileJob.rows[0]!.id,
    });
    const deferred = await pool.query<{
      status: string;
      attempts: number;
      scheduled_at: Date;
    }>(
      "SELECT status, attempts, scheduled_at FROM jobs WHERE id = $1",
      [reconcileJob.rows[0]!.id],
    );
    expect(deferred.rows[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(deferred.rows[0]!.scheduled_at.getTime()).toBeGreaterThan(Date.now());
    await pool.query(`DELETE FROM run_execution_locks WHERE run_id = $1`, [created.id]);
    await pool.query(
      "UPDATE jobs SET scheduled_at = now() WHERE id = $1",
      [reconcileJob.rows[0]!.id],
    );
    await expect(worker.processOne()).resolves.toMatchObject({
      status: "completed",
    });
    const resumedRun = await pool.query(
      `SELECT status, error_json FROM runs WHERE id = $1 AND space_id = $2`,
      [created.id, SPACE],
    );
    expect(resumedRun.rows[0]).toMatchObject({ status: "queued", error_json: null });
    await pool.query(
      `DELETE FROM jobs
        WHERE job_type = 'agent_run'
          AND payload_json->>'run_id' = $1`,
      [created.id],
    );
    await registry.dispatch({
      job_id: reconcileJob.rows[0]!.id,
      space_id: SPACE,
      user_id: USER,
      job_type: "authorization_request_reconcile",
      attempts: 1,
      max_attempts: reconcileJob.rows[0]!.max_attempts,
      worker_id: "test-worker",
      payload: reconcileJob.rows[0]!.payload_json,
    });
    const recoveredAgentJob = await pool.query(
      `SELECT id
         FROM jobs
        WHERE job_type = 'agent_run'
          AND payload_json->>'run_id' = $1
          AND status IN ('pending', 'claimed', 'running')`,
      [created.id],
    );
    expect(recoveredAgentJob.rows).toHaveLength(1);

    const rejectedRun = await repository.createQueuedRun({
      agent_id: AGENT,
      space_id: SPACE,
      user_id: USER,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Reject this bounded authorization",
      capabilities_json: ["agent.delegate"],
    });
    await pool.query(
      `UPDATE runs
          SET status = 'running', started_at = $3, updated_at = $3
        WHERE id = $1 AND space_id = $2`,
      [rejectedRun.id, SPACE, now],
    );
    await pool.query(
      `UPDATE run_attempts
          SET status = 'running', started_at = $3, last_activity_at = $3, updated_at = $3
        WHERE run_id = $1 AND space_id = $2 AND attempt_number = 1`,
      [rejectedRun.id, SPACE, now],
    );
    const rejectedPolicy = await enforce(
      { databaseUrl: container.getConnectionUri() },
      await loadActionRegistry(),
      {
        action: "project.source.bind",
        actor_type: "agent",
        actor_id: AGENT,
        space_id: SPACE,
        resource_space_id: SPACE,
        resource_type: "projects",
        resource_id: rejectedRun.id,
        run_id: rejectedRun.id,
        force_record: true,
        context: {
          action_id: "project.source.propose_bind",
          surface: "managed_run_system_action_gateway",
          has_action_approval_grant: false,
        },
        metadata_json: {
          surface: "managed_run_system_action_gateway",
          action_id: "project.source.propose_bind",
        },
      },
    );
    const rejectedRequest = await service.createFromDeniedDecision({
      spaceId: SPACE,
      runId: rejectedRun.id,
      agentId: AGENT,
      policyDecisionRecordId: rejectedPolicy.policy_decision_record_id!,
      reason: "Request owner review before continuing.",
    });
    await service.decide(
      { spaceId: SPACE, userId: USER },
      rejectedRequest.id,
      "rejected",
    );
    const rejectedJob = await pool.query<{
      id: string;
      payload_json: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, payload_json, attempts, max_attempts
         FROM jobs
        WHERE job_type = 'authorization_request_reconcile'
          AND payload_json->>'authorization_request_id' = $1`,
      [rejectedRequest.id],
    );
    await registry.dispatch({
      job_id: rejectedJob.rows[0]!.id,
      space_id: SPACE,
      user_id: USER,
      job_type: "authorization_request_reconcile",
      attempts: 1,
      max_attempts: rejectedJob.rows[0]!.max_attempts,
      worker_id: "test-worker",
      payload: rejectedJob.rows[0]!.payload_json,
    });
    const cancelled = await pool.query(
      `SELECT status, error_json FROM runs WHERE id = $1 AND space_id = $2`,
      [rejectedRun.id, SPACE],
    );
    expect(cancelled.rows[0]).toMatchObject({
      status: "cancelled",
      error_json: {
        error_code: "run_cancelled",
        requested_by_user_id: USER,
      },
    });

  });
});
