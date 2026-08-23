import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository";
import { ExecutionControlSnapshotRepository } from "../src/modules/policy/executionControlSnapshots";
import { updateSpaceRetrievalSettings } from "../src/modules/retrieval/settings";
import type { RunRecord } from "../src/modules/runs/repository";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const FOLDER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const AGENT_VERSION = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const AUTOMATION = "77777777-7777-4777-8777-777777777777";
const CHILD_RUN = "89898989-8989-4989-8989-898989898989";
const PROVIDER_HOME_SPACE = "99999999-9999-4999-8999-999999999999";
const HOST = "12121212-1212-4212-8212-121212121212";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[runtime-context-policy-db] skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE runtime_context_policy_audits, runtime_context_policy_bindings,
    runtime_context_policy_versions, agents, workspace_locations, project_folders, project_members, projects,
    policy_decision_records, space_memberships, users, spaces, hosts, machines CASCADE`);
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Team', 'household', now(), now())`,
    [SPACE],
  );
  await pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, NULL, 'Test server', 'server', now(), now())`,
    [HOST],
  );
  await pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, NULL, $1, 'server', 'server', 'server', 'online', now(), now())`,
    [HOST],
  );
  for (const id of [OWNER, ADMIN, MEMBER, OTHER]) {
    await pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  for (const [id, role] of [[OWNER, "owner"], [ADMIN, "admin"], [MEMBER, "member"], [OTHER, "member"]] as const) {
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',now(),now())`,
      [`sm-${id}`.slice(0, 36), SPACE, id, role],
    );
  }
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Project','active',now(),now())`,
    [PROJECT, SPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
    ["pm-member", SPACE, PROJECT, MEMBER],
  );
  await pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, name, status, created_at, updated_at, kind,
       is_primary, protected, system_managed, allow_external_root
     ) VALUES ($1,$2,$3,'Folder','active',now(),now(),'code',true,false,false,false)`,
    [FOLDER, SPACE, PROJECT],
  );
  await pool.query(
    `INSERT INTO workspace_locations (
       id,space_id,project_folder_id,execution_host_id,execution_host_kind,
       execution_ready,status,preferred,created_at,updated_at
     ) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'server',true,'active',true,now(),now())`,
    [SPACE, FOLDER, HOST],
  );
  await pool.query(
    `INSERT INTO agents (
       id, space_id, project_id, owner_user_id, name, status, agent_kind,
       created_at, updated_at, visibility, access_level
     ) VALUES ($1,$2,$3,$4,'Agent','active','standard',now(),now(),'private','full')`,
    [AGENT, SPACE, PROJECT, OWNER],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json, capabilities_json,
       tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1','test','{}','{}','{}','{}','[]','{}','{}',now())`,
    [AGENT_VERSION, AGENT, SPACE],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
  await pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status,
       mode, adapter_type, required_sandbox_level, project_id, project_folder_id,
       instructed_by_user_id, owner_user_id, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'agent','manual','running','live','codex_cli','ephemeral',$5,$6,$7,$7,now(),now())`,
    [RUN, SPACE, AGENT, AGENT_VERSION, PROJECT, FOLDER, OWNER],
  );
});

function repository() {
  return new RuntimeContextPolicyRepository(pool!);
}

const reason = "Policy test change";

describe("Runtime Context Policy persistence and ACL (real Postgres)", () => {
  it("resolves Space to Project constraints deterministically and preserves explicit disables", async () => {
    if (!available) return;
    await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: {
        constraints: { retrieval_domains: ["knowledge"], retrieval_max_candidates: 10, allow_project_brief: true },
        preferences: { retrieval_enabled: true },
      },
      reason,
    });
    await repository().write({ spaceId: SPACE, userId: OWNER }, "project", PROJECT, {
      base_version_id: null,
      policy: {
        constraints: { retrieval_domains: [], retrieval_max_candidates: 4, allow_project_brief: false },
        preferences: { retrieval_enabled: false },
      },
      reason,
    });
    const resolved = await repository().resolve(
      { spaceId: SPACE, userId: MEMBER },
      { project_id: PROJECT, include_user_policy: true },
    );
    expect(resolved.policy.constraints).toMatchObject({
      retrieval_domains: [], retrieval_max_candidates: 4, allow_project_brief: false,
    });
    expect(resolved.policy.preferences.retrieval_enabled).toBe(false);
  });

  it("rejects lower-scope widening and leaves no partial version, binding, or audit", async () => {
    if (!available || !pool) return;
    await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: { retrieval_max_candidates: 5 }, preferences: {} },
      reason,
    });
    await expect(repository().write({ spaceId: SPACE, userId: OWNER }, "project", PROJECT, {
      base_version_id: null,
      policy: { constraints: { retrieval_max_candidates: 6 }, preferences: {} },
      reason,
    })).rejects.toMatchObject({ statusCode: 409 });
    const counts = await pool.query<{ versions: string; bindings: string; audits: string }>(
      `SELECT
        (SELECT count(*) FROM runtime_context_policy_versions)::text AS versions,
        (SELECT count(*) FROM runtime_context_policy_bindings)::text AS bindings,
        (SELECT count(*) FROM runtime_context_policy_audits)::text AS audits`,
    );
    expect(counts.rows[0]).toEqual({ versions: "1", bindings: "1", audits: "1" });
  });

  it("fails stale writes atomically", async () => {
    if (!available || !pool) return;
    await repository().write({ spaceId: SPACE, userId: OWNER }, "project", PROJECT, {
      base_version_id: null,
      policy: { constraints: {}, preferences: { retrieval_enabled: true } },
      reason,
    });
    await expect(repository().write({ spaceId: SPACE, userId: OWNER }, "project", PROJECT, {
      base_version_id: null,
      policy: { constraints: {}, preferences: { retrieval_enabled: false } },
      reason,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query(`SELECT 1 FROM runtime_context_policy_versions WHERE scope_type='project'`)).rows).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM runtime_context_policy_audits WHERE scope_type='project'`)).rows).toHaveLength(1);
  });

  it("serializes concurrent first writes and reports the loser as stale", async () => {
    if (!available || !pool) return;
    const attempts = await Promise.allSettled([
      repository().write({ spaceId: SPACE, userId: OWNER }, "project", PROJECT, {
        base_version_id: null,
        policy: { constraints: {}, preferences: { retrieval_enabled: true } },
        reason,
      }),
      repository().write({ spaceId: SPACE, userId: OWNER }, "project", PROJECT, {
        base_version_id: null,
        policy: { constraints: {}, preferences: { retrieval_enabled: false } },
        reason,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect((await pool.query(`SELECT 1 FROM runtime_context_policy_versions WHERE scope_type='project'`)).rows).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM runtime_context_policy_audits WHERE scope_type='project'`)).rows).toHaveLength(1);
  });

  it("does not expose a private Agent policy to an ordinary Project reader", async () => {
    if (!available) return;
    await repository().write({ spaceId: SPACE, userId: OWNER }, "agent", AGENT, {
      base_version_id: null,
      policy: { constraints: {}, preferences: { retrieval_enabled: false } },
      reason,
    });
    await expect(repository().getActive(
      { spaceId: SPACE, userId: MEMBER },
      "agent",
      AGENT,
    )).rejects.toMatchObject({ statusCode: 404 });
    expect((await repository().getActive(
      { spaceId: SPACE, userId: OWNER },
      "agent",
      AGENT,
    ))?.scope_id).toBe(AGENT);
  });

  it("enforces Project, Agent, and User mutation ownership", async () => {
    if (!available || !pool) return;
    await expect(repository().write({ spaceId: SPACE, userId: MEMBER }, "project", PROJECT, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    })).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository().write({ spaceId: SPACE, userId: MEMBER }, "agent", AGENT, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    })).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository().write({ spaceId: SPACE, userId: OWNER }, "user", OTHER, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    })).rejects.toMatchObject({ statusCode: 403 });
    expect((await pool.query(`SELECT 1 FROM runtime_context_policy_versions`)).rows).toHaveLength(0);

    await expect(repository().write({ spaceId: SPACE, userId: OWNER }, "user", OWNER, {
      base_version_id: null,
      policy: { constraints: { retrieval_max_candidates: 1 }, preferences: {} },
      reason,
    })).rejects.toMatchObject({ statusCode: 422 });
    const agentVersion = await repository().write({ spaceId: SPACE, userId: OWNER }, "agent", AGENT, {
      base_version_id: null, policy: { constraints: {}, preferences: { retrieval_enabled: false } }, reason,
    });
    expect(agentVersion.scope_id).toBe(AGENT);
  });

  it("allows Space admin and Project owner authority without granting ordinary Project writers policy control", async () => {
    if (!available) return;
    expect((await repository().write({ spaceId: SPACE, userId: ADMIN }, "space", SPACE, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    })).scope_type).toBe("space");
    expect((await repository().write({ spaceId: SPACE, userId: ADMIN }, "agent", AGENT, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    })).scope_id).toBe(AGENT);
    const projectVersion = await repository().write({ spaceId: SPACE, userId: ADMIN }, "project", PROJECT, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    });
    expect((await repository().getActive(
      { spaceId: SPACE, userId: ADMIN }, "project", PROJECT,
    ))?.id).toBe(projectVersion.id);
    expect((await repository().getActive(
      { spaceId: SPACE, userId: ADMIN }, "agent", AGENT,
    ))?.scope_id).toBe(AGENT);
    expect((await repository().write({ spaceId: SPACE, userId: OWNER }, "project_folder", FOLDER, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason,
    })).scope_id).toBe(FOLDER);
    const audit = await pool!.query<{ policy_decision_record_id: string | null }>(
      `SELECT policy_decision_record_id FROM runtime_context_policy_audits
        WHERE scope_type='project_folder' AND scope_id=$1`,
      [FOLDER],
    );
    expect(audit.rows[0]?.policy_decision_record_id).toEqual(expect.any(String));
    expect((await pool!.query(
      `SELECT 1 FROM policy_decision_records
        WHERE id=$1 AND action='runtime_context_policy.change' AND decision='allow'`,
      [audit.rows[0]?.policy_decision_record_id],
    )).rows).toHaveLength(1);
  });

  it("does not publish Project policy after co-owner authority is revoked concurrently", async () => {
    if (!available || !pool) return;
    await pool.query(
      `UPDATE project_members SET role='owner' WHERE space_id=$1 AND project_id=$2 AND user_id=$3`,
      [SPACE, PROJECT, MEMBER],
    );
    const revocation = await pool.connect();
    try {
      await revocation.query("BEGIN");
      await revocation.query(
        `SELECT 1 FROM project_members
          WHERE space_id=$1 AND project_id=$2 AND user_id=$3 FOR UPDATE`,
        [SPACE, PROJECT, MEMBER],
      );
      let settled = false;
      const writing = repository().write(
        { spaceId: SPACE, userId: MEMBER },
        "project",
        PROJECT,
        { base_version_id: null, policy: { constraints: {}, preferences: {} }, reason },
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await revocation.query(
        `DELETE FROM project_members WHERE space_id=$1 AND project_id=$2 AND user_id=$3`,
        [SPACE, PROJECT, MEMBER],
      );
      await revocation.query("COMMIT");
      await expect(writing).rejects.toMatchObject({ statusCode: 403 });
      expect((await pool.query(
        `SELECT 1 FROM runtime_context_policy_versions WHERE scope_type='project' AND scope_id=$1`,
        [PROJECT],
      )).rows).toHaveLength(0);
    } finally {
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
    }
  });

  it("allows a Project owner to read a private project-owned Agent policy", async () => {
    if (!available || !pool) return;
    const projectAgent = "12121212-1212-4212-8212-121212121212";
    await pool.query(
      `INSERT INTO agents (
         id, space_id, project_id, owner_user_id, name, status, agent_kind,
         created_at, updated_at, visibility, access_level
       ) VALUES ($1,$2,$3,$4,'Project Agent','active','standard',now(),now(),'private','full')`,
      [projectAgent, SPACE, PROJECT, OTHER],
    );
    const version = await repository().write(
      { spaceId: SPACE, userId: OWNER },
      "agent",
      projectAgent,
      { base_version_id: null, policy: { constraints: {}, preferences: {} }, reason },
    );
    await expect(repository().getActive(
      { spaceId: SPACE, userId: OWNER },
      "agent",
      projectAgent,
    )).resolves.toMatchObject({ id: version.id });
  });

  it("rejects nonexistent projects and folders at the public resolution boundary", async () => {
    if (!available) return;
    await expect(repository().resolve(
      { spaceId: SPACE, userId: ADMIN },
      { project_id: "99999999-9999-4999-8999-999999999999", include_user_policy: false },
    )).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository().resolveForExecution({
      spaceId: SPACE,
      projectId: "99999999-9999-4999-8999-999999999999",
      projectFolderId: FOLDER,
      agentId: AGENT,
      userId: OWNER,
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(repository().resolve(
      { spaceId: SPACE, userId: OWNER },
      { project_folder_id: "88888888-8888-4888-8888-888888888888", include_user_policy: false },
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it("persists an immutable typed ExecutionControlSnapshot for execution preflight", async () => {
    if (!available || !pool) return;
    await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: {
        constraints: { explicit_reference_sensitivity_ceiling: "normal" },
        preferences: {},
      },
      reason,
    });
    const resolved = await repository().resolveForExecution({
      spaceId: SPACE,
      projectId: PROJECT,
      projectFolderId: FOLDER,
      agentId: AGENT,
      userId: OWNER,
    });
    const run = {
      id: RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "test",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "ephemeral",
      trigger_origin: "manual",
      instructed_by_user_id: OWNER,
      permission_snapshot_json: {
        tool_grants: [{ action_id: "source.search" }],
        policy_grants: [{ approval_code: "policy_requires_approval_runtime_execute" }],
      },
      contract_snapshot_json: {
        structured_output_json: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      },
      started_at: null,
      ended_at: null,
    } as RunRecord;
    const instructionId = randomUUID();
    const instructionTime = new Date().toISOString();
    await pool.query(
      `INSERT INTO project_instruction_versions (
         id,space_id,project_id,version,title,instruction_text,status,
         reviewed_by_user_id,reviewed_at,published_by_user_id,published_at,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'v1','Pinned authority','Use the pinned authority.','published',
                 $4,$5,$4,$5,$4,$5)`,
      [instructionId, SPACE, PROJECT, OWNER, instructionTime],
    );
    await pool.query(
      `UPDATE projects SET active_instruction_version_id=$1 WHERE id=$2 AND space_id=$3`,
      [instructionId, PROJECT, SPACE],
    );
    const snapshot = await new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved, {
      cliCredentialProfileId: "cli-profile-1",
      policyDecisionRecordIds: ["decision-runtime.execute"],
    });
    expect(snapshot).toMatchObject({
      id: expect.any(String),
      space_id: SPACE,
      project_id: PROJECT,
      project_folder_id: FOLDER,
      agent_id: AGENT,
      project_instruction_ref: {
        type: "project_instruction_version",
        id: instructionId,
        version: "v1",
      },
      readable_scope: {
        unrestricted_source_categories: ["explicit_reference", "pinned_reference", "memory", "retrieval"],
        explicit_reference_types: [],
        explicit_reference_max: null,
        explicit_reference_sensitivity_ceiling: "normal",
        sensitivity_ceiling: "highly_restricted",
      },
      egress: {
        destination_type: "local_cli",
        destination_id: "codex_cli",
        external_egress_allowed: true,
        sensitivity_ceiling: "highly_restricted",
      },
      tool_grant_refs: [{ type: "tool_grant", id: "source.search" }],
      approval_refs: [{ type: "policy_approval", id: "policy_requires_approval_runtime_execute" }],
      credential_channel_ref: { type: "cli_credential_profile", id: "cli-profile-1" },
      policy_decision_refs: [{ type: "policy_decision_record", id: "decision-runtime.execute" }],
      output_contract: {
        schema_ref: {
          type: "run_output_contract",
          id: RUN,
          version: "run_output_contract.v1",
        },
        unstructured_output_allowed: false,
        max_output_tokens: null,
      },
    });
    const stored = await pool.query<{ snapshot_json: unknown }>(
      `SELECT snapshot_json FROM execution_control_snapshots WHERE id=$1 AND run_id=$2`,
      [snapshot.id, RUN],
    );
    expect(stored.rows[0]?.snapshot_json).toEqual(snapshot);

    const setupId = randomUUID();
    const setupDecisionId = randomUUID();
    const setupTime = new Date().toISOString();
    await pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',$5)`,
      [setupDecisionId, SPACE, OWNER, setupId, setupTime],
    );
    await pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,$5,$6,$7,NULL,'[]','[]','{}','{}',
                 NULL,NULL,TRUE,$8::jsonb,'effective-bindings',NULL,'{}','test setup',$9,$4,$10)`,
      [setupId, SPACE, RUN, OWNER, PROJECT, FOLDER, AGENT,
        JSON.stringify(resolved.contributing_versions), setupDecisionId, setupTime],
    );
    const unboundRun = {
      ...run,
      project_id: null,
      project_folder_id: null,
      agent_id: null,
    } as unknown as RunRecord;
    const snapshotRepository = new ExecutionControlSnapshotRepository(pool);
    const effective = await snapshotRepository.resolveEffectiveBindingsForRun(unboundRun);
    expect(effective).toMatchObject({
      workContextScopeId: RUN,
      workContextSetupRef: { type: "work_context_setup", id: setupId, version: "1" },
      projectId: PROJECT,
      projectFolderId: FOLDER,
      agentId: AGENT,
    });
    const effectivePolicy = await repository().resolveForExecution({
      spaceId: SPACE,
      projectId: effective.projectId,
      projectFolderId: effective.projectFolderId,
      agentId: effective.agentId,
      userId: OWNER,
    });
    const effectiveSnapshot = await snapshotRepository.createForRun(
      unboundRun,
      effectivePolicy,
      {},
      effective,
    );
    expect(effectiveSnapshot).toMatchObject({
      project_id: PROJECT,
      project_folder_id: FOLDER,
      agent_id: AGENT,
      work_context_scope_id: RUN,
      work_context_setup_ref: { type: "work_context_setup", id: setupId, version: "1" },
    });
  });

  it("records a model-provider destination for a provider-bound local CLI", async () => {
    if (!available || !pool) return;
    const resolved = await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: {}, preferences: {} },
      reason,
    }).then(() => repository().resolveForExecution({ spaceId: SPACE, agentId: AGENT, userId: OWNER }));
    await pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Provider Home', 'personal', now(), now())`,
      [PROVIDER_HOME_SPACE],
    );
    await pool.query(
      `INSERT INTO model_providers (
         id, space_id, owner_user_id, name, provider_type, base_url, enabled,
         capabilities_json, config_json, created_at, updated_at
       ) VALUES ('provider-1',$1,$2,'Shared','openai','https://api.example.test/v1',TRUE,
         '{}'::jsonb,'{"openai_compatible_base_url":"http://localhost:8080/v1"}'::jsonb,now(),now())`,
      [PROVIDER_HOME_SPACE, OWNER],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id, provider_id, space_id, owner_user_id, granted_by_user_id,
         enabled, is_default, created_at, updated_at
       ) VALUES ('provider-grant-1','provider-1',$1,$2,$2,TRUE,FALSE,now(),now())`,
      [SPACE, OWNER],
    );
    await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: false }, {
      actorUserId: OWNER,
    });
    const run = {
      id: RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "provider-bound CLI",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "opencode",
      model_provider_id: "provider-1",
      required_sandbox_level: "ephemeral",
      trigger_origin: "manual",
      instructed_by_user_id: OWNER,
      started_at: null,
      ended_at: null,
    } as RunRecord;
    const snapshot = await new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved);
    expect(snapshot.egress).toMatchObject({
      destination_type: "model_provider",
      destination_id: "provider-1",
      external_egress_allowed: false,
      allowed_provider_ids: ["provider-1"],
    });
    expect(snapshot.credential_channel_ref).toEqual({
      type: "provider_credential_channel",
      id: "provider-1",
    });
  });

  it("fails subscription CLI preflight when Space external egress is disabled", async () => {
    if (!available || !pool) return;
    const resolved = await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: {}, preferences: {} },
      reason,
    }).then(() => repository().resolveForExecution({ spaceId: SPACE, agentId: AGENT, userId: OWNER }));
    await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: false }, {
      actorUserId: OWNER,
    });
    const run = {
      id: RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "subscription CLI",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "ephemeral",
      trigger_origin: "manual",
      instructed_by_user_id: OWNER,
      started_at: null,
      ended_at: null,
    } as RunRecord;
    await expect(
      new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved),
    ).rejects.toThrow("Execution preflight denied external CLI egress for this Space");
  });

  it("fails execution preflight when external provider egress is disabled", async () => {
    if (!available || !pool) return;
    const resolved = await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: {}, preferences: {} },
      reason,
    }).then(() => repository().resolveForExecution({ spaceId: SPACE, agentId: AGENT, userId: OWNER }));
    await pool.query(
      `INSERT INTO model_providers (
         id, space_id, owner_user_id, name, provider_type, base_url, enabled,
         capabilities_json, config_json, created_at, updated_at
       ) VALUES ('provider-external',$1,$2,'External','openai','https://api.openai.com/v1',TRUE,
         '{}'::jsonb,'{}'::jsonb,now(),now())`,
      [SPACE, OWNER],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id, provider_id, space_id, owner_user_id, granted_by_user_id,
         enabled, is_default, created_at, updated_at
       ) VALUES ('grant-external','provider-external',$1,$2,$2,TRUE,FALSE,now(),now())`,
      [SPACE, OWNER],
    );
    await updateSpaceRetrievalSettings(pool, SPACE, { external_egress_enabled: false }, {
      actorUserId: OWNER,
    });
    const run = {
      id: RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "external",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "model_api",
      model_provider_id: "provider-external",
      required_sandbox_level: "none",
      trigger_origin: "manual",
      instructed_by_user_id: OWNER,
      started_at: null,
      ended_at: null,
    } as RunRecord;
    await expect(
      new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved),
    ).rejects.toThrow("denied external model egress");
    expect((await pool.query(
      `SELECT 1 FROM execution_control_snapshots WHERE run_id=$1`,
      [RUN],
    )).rows).toHaveLength(0);
  });

  it("attributes delegated execution to the instructing Agent", async () => {
    if (!available || !pool) return;
    const resolved = await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: {}, preferences: {} },
      reason,
    }).then(() => repository().resolveForExecution({ spaceId: SPACE, agentId: AGENT, userId: OWNER }));
    const run = {
      id: RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "delegated",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "ephemeral",
      trigger_origin: "delegation",
      instructed_by_user_id: OWNER,
      instructed_by_agent_id: AGENT,
      started_at: null,
      ended_at: null,
    } as RunRecord;
    const snapshot = await new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved);
    expect(snapshot.actor).toEqual({
      type: "agent",
      agent_id: AGENT,
      instructed_by_user_id: OWNER,
    });
  });

  it("attributes background execution to a service while retaining its instructing user", async () => {
    if (!available || !pool) return;
    const resolved = await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: {}, preferences: {} },
      reason,
    }).then(() => repository().resolveForExecution({ spaceId: SPACE, agentId: AGENT, userId: OWNER }));
    const run = {
      id: RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "background",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "ephemeral",
      trigger_origin: "job",
      instructed_by_user_id: OWNER,
      started_at: null,
      ended_at: null,
    } as RunRecord;
    const snapshot = await new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved);
    expect(snapshot.actor).toEqual({
      type: "service",
      service_name: "job_worker",
      instructed_by_user_id: OWNER,
    });
  });

  it("attributes an Automation-linked execution to the Automation", async () => {
    if (!available || !pool) return;
    await repository().write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null,
      policy: { constraints: {}, preferences: {} },
      reason,
    });
    await pool.query(
      `INSERT INTO automations (
         id, space_id, owner_user_id, agent_id, project_id, name,
         trigger_type, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'Policy test','manual','active',now(),now())`,
      [AUTOMATION, SPACE, OWNER, AGENT, PROJECT],
    );
    await pool.query(
      `INSERT INTO automation_runs (
         id, automation_id, run_id, triggered_by_user_id, trigger_type, created_at
       ) VALUES ($1,$2,$3,$4,'manual',now())`,
      ["automation-run-1", AUTOMATION, RUN, OWNER],
    );
    await pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status,
         mode, adapter_type, required_sandbox_level, project_id, project_folder_id,
         root_run_id, instructed_by_user_id, owner_user_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'agent','job','running','live','codex_cli','ephemeral',
         $5,$6,$7,$8,$8,now(),now())`,
      [CHILD_RUN, SPACE, AGENT, AGENT_VERSION, PROJECT, FOLDER, RUN, OWNER],
    );
    const resolved = await repository().resolveForExecution({
      spaceId: SPACE, projectId: PROJECT, agentId: AGENT, userId: OWNER,
    });
    const run = {
      id: CHILD_RUN,
      space_id: SPACE,
      agent_id: AGENT,
      agent_version_id: AGENT_VERSION,
      status: "running",
      mode: "live",
      prompt: "automated",
      instruction: null,
      project_folder_id: FOLDER,
      session_id: null,
      project_id: PROJECT,
      adapter_type: "codex_cli",
      model_provider_id: null,
      required_sandbox_level: "ephemeral",
      root_run_id: RUN,
      trigger_origin: "job",
      instructed_by_user_id: OWNER,
      started_at: null,
      ended_at: null,
    } as RunRecord;
    const snapshot = await new ExecutionControlSnapshotRepository(pool).createForRun(run, resolved);
    expect(snapshot.actor).toEqual({
      type: "automation",
      automation_id: AUTOMATION,
      instructed_by_user_id: OWNER,
    });
  });
});
