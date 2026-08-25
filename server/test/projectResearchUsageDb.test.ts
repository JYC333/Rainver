import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository";
import { normalizeUsageObservation } from "../src/modules/usage/normalizer";
import { PgUsageRepository } from "../src/modules/usage/repository";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// The project research review read model must use the canonical usage ledger.
// Provider-reported usage must remain visible in the review UI through the
// canonical ledger, regardless of the run lifecycle row.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const AGENT = "99999999-9999-4999-8999-999999999999";
const VERSION = "84444444-4444-4444-8444-444444444444";
const RUN = "95555555-5555-4555-8555-555555555555";
const CHECKPOINT = "a6666666-6666-4666-8666-666666666666";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["token_usage_events", "instance_identity", "runs", "agent_versions", "agents", "project_research_checkpoints", "project_research_workflows", "project_operations", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1,'Main','personal',$2,$2)`,
    [SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1,$1,'active',$2,$2)`,
    [OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Research Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1','Test agent.',
       '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
       '[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin,
       status, mode, adapter_type, instructed_by_user_id,
       owner_user_id, project_id, contract_snapshot_json,
       created_at, updated_at, started_at, ended_at
     ) VALUES ($1,$2,$3,$4,'agent','system','succeeded','live','model_api',
       $5,$5,$6,'{}'::jsonb,$7,$7,$7,$7)`,
    [RUN, SPACE, AGENT, VERSION, OWNER, PROJECT, now],
  );
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "idea_review", now,
  });
  await db.pool.query(
    `INSERT INTO project_operations (
       id, space_id, project_id, kind, title, status, created_by_user_id,
       progress_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'research','Initial literature intake','active',$4,$5::jsonb,$6,$6)`,
    [
      OPERATION,
      SPACE,
      PROJECT,
      OWNER,
      JSON.stringify({ workflow_id: WORKFLOW, synthesis_run_id: RUN }),
      now,
    ],
  );
  await db.pool.query(
    `INSERT INTO project_research_checkpoints (
       id, space_id, project_id, workflow_id, stage_key, checkpoint_type,
       status, machine_result_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'idea_review','idea_review','pending',$5::jsonb,$6,$6)`,
    [
      CHECKPOINT,
      SPACE,
      PROJECT,
      WORKFLOW,
      JSON.stringify({ operation_id: OPERATION, artifact_ids: [], idea_count: 1 }),
      now,
    ],
  );

  const usage = new PgUsageRepository(db.pool);
  const instanceId = await usage.getOrCreateInstanceId();
  await usage.appendEvent(normalizeUsageObservation(
    {
      space_id: SPACE,
      event_type: "llm.generation",
      source_type: "local_run",
      execution_channel: "managed_api",
      run_id: RUN,
      agent_id: AGENT,
      provider_type: "minimax",
      model: "MiniMax-M3",
      provider_usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
      },
      idempotency_key: `project-research-usage:${RUN}`,
    },
    instanceId,
    {
      owner_user_id: OWNER,
      visibility: "space_shared",
      access_level: "full",
      source_resource_type: "run",
      source_resource_id: RUN,
      project_folder_id: null,
      project_id: PROJECT,
      grant_snapshots: [],
    },
  ));
});

describe("ProjectResearchRepository review usage (real Postgres)", () => {
  it("reads provider usage from the canonical token ledger", async () => {
    if (!db.available) return;

    const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };
    const checkpoints = await new ProjectResearchRepository(db.pool).listCheckpoints(identity, PROJECT, WORKFLOW);
    const review = checkpoints[0]?.review as { usage?: Record<string, unknown> } | null | undefined;

    expect(review?.usage).toMatchObject({
      agent_run_count: 1,
      completed_agent_run_count: 1,
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      model_names: ["MiniMax-M3"],
    });
    expect(review?.usage?.estimated_cost_usd).toBeNull();

  });
});
