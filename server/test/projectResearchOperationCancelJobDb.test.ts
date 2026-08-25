import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject, seedAgentWithVersion } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import * as poolModule from "../src/db/pool";
import { loadConfig } from "../src/config";
import { JobHandlerRegistry, type JobEnvelopeForHandler } from "../src/modules/jobs/handlerRegistry";
import { registerResearchOperationCancelHandler } from "../src/modules/projectResearch/pipeline/researchOperationCancelJob";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";
import { RESEARCH_OPERATION_CANCEL_JOB } from "../src/modules/projectResearch/researchOperationCancel";

// Real-Postgres coverage for the process half of the research cancel. The
// service half only writes "cancelled" and enqueues; this handler is what
// actually stops the three kinds of live work a research Operation owns, and
// the property that matters is that it stops all of them and that re-running
// it can never undo work that legitimately finished first.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const OTHER_OPERATION = "77777777-7777-4777-8777-777777777778";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";


const db = useTestDatabase(__filename);

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["source_backfill_plans", "project_research_checkpoints", "project_research_workflows", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "workflow_executions", "jobs", "runs", "project_operations", "agent_versions", "agents", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','cancelled',$4,'{}'::jsonb,$5,$5)`,
    [OPERATION, SPACE, PROJECT, OWNER, now],
  );
});

async function seedRun(operationId: string, status: string, stageKey = "synthesis"): Promise<string> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       created_at, updated_at, owner_user_id, visibility, access_level, project_id,
       instructed_by_user_id, contract_snapshot_json
     ) VALUES ($1,$2,$3,$4,'agent','system',$5,'live',$6,$6,$7,'space_shared','full',$8,$7,$9::jsonb)`,
    [
      runId, SPACE, AGENT, AGENT_VERSION, status, now, OWNER, PROJECT,
      JSON.stringify({ workflow_input_json: { project_research: { operation_id: operationId, stage_key: stageKey } } }),
    ],
  );
  return runId;
}

async function seedScreeningBatch(operationId: string, status: string): Promise<string> {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO jobs (
       id, space_id, user_id, job_type, status, priority, payload_json,
       attempts, max_attempts, scheduled_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'source_post_processing_event',$4,0,$5::jsonb,0,3,$6,$6,$6)`,
    [jobId, SPACE, OWNER, status, JSON.stringify({ phase: "research_recovery", recovery_for_operation_id: operationId }), now],
  );
  return jobId;
}

async function seedExecution(operationId: string, status: string): Promise<string> {
  const executionId = randomUUID();
  const automationId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO automations (id, space_id, owner_user_id, agent_id, name, trigger_type, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Research pass','manual','active',$5,$5)`,
    [automationId, SPACE, OWNER, AGENT, now],
  );
  const assetId = randomUUID();
  const versionId = randomUUID();
  await db.pool.query(
    `INSERT INTO evolvable_assets (id, space_id, asset_type, asset_key, display_name, owner_scope_type, status, created_at, updated_at)
     VALUES ($1,$2,'workflow_template',$3,'Research pass','space','active',$4,$4)`,
    [assetId, SPACE, `research_pass_${assetId.slice(0, 8)}`, now],
  );
  await db.pool.query(
    `INSERT INTO evolvable_asset_versions (id, asset_id, space_id, scope_type, version, status, source, created_at, updated_at)
     VALUES ($1,$2,$3,'space',1,'approved','built_in',$4,$4)`,
    [versionId, assetId, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO workflow_executions (
       id, space_id, automation_id, workflow_version_id, status, trigger_type, definition_json,
       research_operation_id, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'manual','{}'::jsonb,$6,$7,$7)`,
    [executionId, SPACE, automationId, versionId, status, operationId, now],
  );
  return executionId;
}

/** Seeds the minimal source chain a backfill plan's FKs require, then the
 * plan bound to the operation. */
async function seedBackfillPlan(operationId: string, status: string): Promise<string> {
  const now = new Date().toISOString();
  const connectorId = randomUUID();
  const providerId = randomUUID();
  const mappingId = randomUUID();
  const connectionId = randomUUID();
  const channelId = randomUUID();
  const planId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,'arXiv','external_feed','pull','active','{}'::jsonb,$3,$3)`,
    [connectorId, `arxiv_${connectorId.slice(0, 8)}`, now],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,'arXiv','generic','academic','active','{}'::jsonb,$3,$3)`,
    [providerId, `arxiv_${providerId.slice(0, 8)}`, now],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, providerId, connectorId, now],
  );
  await db.pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'arXiv','active','reference_only','normal','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
    [connectionId, SPACE, mappingId, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO source_channels (
       id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
       query_json, provider_query_json, query_fingerprint, status, fetch_frequency, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'Monitor','search','https://example.org','{}'::jsonb,'{}'::jsonb,$5,'active','daily',$6,$6)`,
    [channelId, SPACE, connectionId, OWNER, `fp-${channelId.slice(0, 8)}`, now],
  );
  await db.pool.query(
    `INSERT INTO source_backfill_plans (
       id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
       strategy_json, quota_policy_json, status, idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'user','{}'::jsonb,'{}'::jsonb,$6,$7,$8,$8)`,
    [planId, SPACE, channelId, operationId, OWNER, status, `key-${planId}`, now],
  );
  return planId;
}

async function seedPendingCheckpoint(operationId: string): Promise<string> {
  const workflowId = randomUUID();
  const checkpointId = randomUUID();
  const now = new Date().toISOString();
  await insertResearchWorkflowFixture(db.pool, {
    id: workflowId, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER, now,
  });
  await db.pool.query(
    `INSERT INTO project_research_checkpoints (
       id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
       machine_result_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'screening','screening_gate','pending',$5::jsonb,$6,$6)`,
    [checkpointId, SPACE, PROJECT, workflowId, JSON.stringify({ operation_id: operationId }), now],
  );
  return checkpointId;
}

function envelope(operationId = OPERATION): JobEnvelopeForHandler {
  return {
    job_id: randomUUID(),
    space_id: SPACE,
    user_id: OWNER,
    job_type: RESEARCH_OPERATION_CANCEL_JOB,
    attempts: 0,
    max_attempts: 3,
    worker_id: "test-worker",
    payload: { operation_id: operationId, project_id: PROJECT },
  };
}

async function runHandler(operationId = OPERATION): Promise<Record<string, unknown>> {
  vi.spyOn(poolModule, "getDbPool").mockReturnValue(db.pool);
  const registry = new JobHandlerRegistry();
  registerResearchOperationCancelHandler(
    registry,
    loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
  );
  const handler = registry.get(RESEARCH_OPERATION_CANCEL_JOB);
  expect(handler).toBeDefined();
  return (await handler!(envelope(operationId))) as Record<string, unknown>;
}

async function runStatus(runId: string): Promise<string | undefined> {
  const row = await db.pool.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1`, [runId]);
  return row.rows[0]?.status;
}

async function jobStatus(jobId: string): Promise<string | undefined> {
  const row = await db.pool.query<{ status: string }>(`SELECT status FROM jobs WHERE id=$1`, [jobId]);
  return row.rows[0]?.status;
}

async function executionStatus(executionId: string): Promise<string | undefined> {
  const row = await db.pool.query<{ status: string }>(`SELECT status FROM workflow_executions WHERE id=$1`, [executionId]);
  return row.rows[0]?.status;
}

describe("research_operation_cancel job (real Postgres)", () => {
  it("stops the operation's runs, screening batches, backfill plans, and pass execution together", async () => {
    if (!db.available) return;
    const queuedRun = await seedRun(OPERATION, "queued");
    const runningRun = await seedRun(OPERATION, "running", "synthesis_critique");
    const batch = await seedScreeningBatch(OPERATION, "pending");
    const execution = await seedExecution(OPERATION, "running");
    const plan = await seedBackfillPlan(OPERATION, "running");
    const checkpoint = await seedPendingCheckpoint(OPERATION);

    const result = await runHandler();

    expect(await runStatus(queuedRun)).toBe("cancelled");
    expect(await runStatus(runningRun)).toBe("cancelled");
    expect(await jobStatus(batch)).toBe("cancelled");
    expect(await executionStatus(execution)).toBe("cancelled");
    // The backfill is the acquisition itself — the expensive phase. The
    // segment scheduler never consults the Operation's status, so leaving the
    // plan `running` would keep fetching from the provider after "Stop".
    const planRow = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_plans WHERE id=$1`, [plan]);
    expect(planRow.rows[0]?.status).toBe("cancelled");
    // Pre-reform the checkpoint decision WAS the stop lever, so stopping
    // resolved the row; a surviving pending gate would keep the web UI
    // advertising a review whose approval no-ops on a cancelled operation.
    const checkpointRow = await db.pool.query<{ status: string }>(`SELECT status FROM project_research_checkpoints WHERE id=$1`, [checkpoint]);
    expect(checkpointRow.rows[0]?.status).toBe("waived");
    expect(result).toMatchObject({
      operation_id: OPERATION,
      cancelled_runs: 2,
      cancelled_batches: 1,
      cancelled_backfill_plans: 1,
      cancelled_executions: 1,
      waived_checkpoints: 1,
    });
  });

  it("leaves work that already finished alone", async () => {
    if (!db.available) return;
    const succeeded = await seedRun(OPERATION, "succeeded");
    const failed = await seedRun(OPERATION, "failed");
    const doneBatch = await seedScreeningBatch(OPERATION, "completed");
    const endedExecution = await seedExecution(OPERATION, "completed");

    const result = await runHandler();

    // A Run that produced its report between the user's stop and this job is
    // a real result: cancelling it would discard an Artifact the Operation
    // legitimately produced, and mark evidence of work as aborted.
    expect(await runStatus(succeeded)).toBe("succeeded");
    expect(await runStatus(failed)).toBe("failed");
    expect(await jobStatus(doneBatch)).toBe("completed");
    expect(await executionStatus(endedExecution)).toBe("completed");
    expect(result).toMatchObject({ cancelled_runs: 0, cancelled_batches: 0, cancelled_executions: 0 });
  });

  it("finishes a run left mid-cancellation by an interrupted earlier attempt", async () => {
    if (!db.available) return;
    // `cancelling` is not hard-terminal, so this run is still selected and
    // driven to a terminal status rather than being mistaken for done —
    // which is what makes the handler safe to retry after a worker restart.
    const run = await seedRun(OPERATION, "cancelling");

    const result = await runHandler();

    expect(await runStatus(run)).toBe("cancelled");
    expect(result).toMatchObject({ cancelled_runs: 1, unconfirmed_runs: 0 });
  });

  it("reconciles finalization for a cancelled run left by an earlier failed attempt", async () => {
    if (!db.available) return;
    const run = await seedRun(OPERATION, "cancelled");

    await runHandler();

    const finalization = await db.pool.query<{ completion_gate_committed: boolean }>(
      `SELECT (metadata_json->>'completion_gate_committed')::boolean AS completion_gate_committed
         FROM run_finalizations WHERE space_id=$1 AND run_id=$2`,
      [SPACE, run],
    );
    expect(finalization.rows).toEqual([{ completion_gate_committed: true }]);
  });

  it("is idempotent, so a retried job cannot re-cancel or double count", async () => {
    if (!db.available) return;
    const run = await seedRun(OPERATION, "running");
    const batch = await seedScreeningBatch(OPERATION, "pending");
    const execution = await seedExecution(OPERATION, "queued");

    await runHandler();
    const second = await runHandler();

    expect(await runStatus(run)).toBe("cancelled");
    expect(await jobStatus(batch)).toBe("cancelled");
    expect(await executionStatus(execution)).toBe("cancelled");
    expect(second).toMatchObject({ cancelled_runs: 0, cancelled_batches: 0, cancelled_executions: 0 });
  });

  it("never reaches past its own operation", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Another intake','active',$4,'{}'::jsonb,$5,$5)`,
      [OTHER_OPERATION, SPACE, PROJECT, OWNER, now],
    );
    const foreignRun = await seedRun(OTHER_OPERATION, "running");
    const foreignBatch = await seedScreeningBatch(OTHER_OPERATION, "pending");
    const foreignExecution = await seedExecution(OTHER_OPERATION, "running");
    const ownRun = await seedRun(OPERATION, "running");

    await runHandler();

    expect(await runStatus(ownRun)).toBe("cancelled");
    expect(await runStatus(foreignRun)).toBe("running");
    expect(await jobStatus(foreignBatch)).toBe("pending");
    expect(await executionStatus(foreignExecution)).toBe("running");
  });
});
