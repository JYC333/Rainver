import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { PgAgentGroupRepository } from "../src/modules/agentGroups/repository";

// Real-Postgres coverage for the run_delegations idempotency guarantee added
// for the Runtime I/O Convergence "Governed CLI tools" requirement: a CLI/MCP
// reconnect or retry of agent.delegate with the same tool_call_id must not
// duplicate the durable delegation/child-run side effect. This exercises the
// actual partial UNIQUE INDEX (uq_run_delegations_parent_tool_call), which a
// FakeDb unit test cannot verify.


const SPACE = "space-1";
const USER = "user-1";
const MANAGER_AGENT = "agent-manager";
const TARGET_AGENT = "agent-target";
const GROUP = "group-1";
let parentRunId = "";

const db = useTestDatabase(__filename, { max: 10 });

beforeEach(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await resetTables(
    db.pool,
    ["run_delegations", "agent_run_groups", "runs", "agent_versions", "agents", "space_memberships", "spaces", "users"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'User', 'active', $2, $2)`,
    [USER, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, 'Space', 'team', $2, $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, USER, now],
  );
  let managerVersionId = "";
  for (const agentId of [MANAGER_AGENT, TARGET_AGENT]) {
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
       VALUES ($1,$2,$3,'Agent','active',NULL,$4,$4,'space_shared')`,
      [agentId, SPACE, USER, now],
    );
    const versionId = randomUUID();
    await db.pool.query(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, system_prompt, model_config_json,
         runtime_config_json, context_policy_json, memory_policy_json,
         capabilities_json, tool_permissions_json, runtime_policy_json, created_at
       ) VALUES ($1,$2,$3,'v1','You are a test agent.','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
         '{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
      [versionId, agentId, SPACE, now],
    );
    await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [agentId, versionId]);
    if (agentId === MANAGER_AGENT) managerVersionId = versionId;
  }
  parentRunId = randomUUID();
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, adapter_type, required_sandbox_level, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'agent','manual','running','live','model_api','none',$5,$5)`,
    [parentRunId, SPACE, MANAGER_AGENT, managerVersionId, now],
  );
  await db.pool.query(
    `INSERT INTO agent_run_groups (id, space_id, root_run_id, manager_user_id, title, goal, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Room','Coordinate',$5,$6,$6)`,
    [GROUP, SPACE, parentRunId, USER, "active", now],
  );
});

describe("run_delegations tool_call_id idempotency", () => {
  it("returns the existing delegation for a repeated tool_call_id instead of inserting a duplicate row", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgAgentGroupRepository(db.pool);
    const first = await repo.createDelegation({
      space_id: SPACE,
      group_id: GROUP,
      parent_run_id: parentRunId,
      requesting_agent_id: MANAGER_AGENT,
      target_agent_id: TARGET_AGENT,
      instruction: "Summarize the packet.",
      tool_call_id: "call-1",
    });

    const found = await repo.findDelegationByToolCallId(SPACE, parentRunId, "call-1");
    expect(found?.id).toBe(first.id);

    await expect(
      repo.createDelegation({
        space_id: SPACE,
        group_id: GROUP,
        parent_run_id: parentRunId,
        requesting_agent_id: MANAGER_AGENT,
        target_agent_id: TARGET_AGENT,
        instruction: "Summarize the packet.",
        tool_call_id: "call-1",
      }),
    ).rejects.toThrow();

    const rows = await db.pool.query(
      `SELECT id FROM run_delegations WHERE space_id = $1 AND parent_run_id = $2 AND tool_call_id = $3`,
      [SPACE, parentRunId, "call-1"],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("allows multiple delegations with no tool_call_id (partial index only applies when it is set)", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgAgentGroupRepository(db.pool);
    const first = await repo.createDelegation({
      space_id: SPACE,
      group_id: GROUP,
      parent_run_id: parentRunId,
      requesting_agent_id: MANAGER_AGENT,
      target_agent_id: TARGET_AGENT,
      instruction: "First manual delegation.",
      tool_call_id: null,
    });
    const second = await repo.createDelegation({
      space_id: SPACE,
      group_id: GROUP,
      parent_run_id: parentRunId,
      requesting_agent_id: MANAGER_AGENT,
      target_agent_id: TARGET_AGENT,
      instruction: "Second manual delegation.",
      tool_call_id: null,
    });
    expect(first.id).not.toBe(second.id);
  });
});
