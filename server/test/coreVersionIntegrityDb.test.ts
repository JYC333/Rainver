import { beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { withTransaction } from "../src/db/tx.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { createDefaultProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { refreshSourcePostProcessingAgentPrompt } from "../src/modules/sources/postProcessing/service.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

const SPACE = "version-integrity-space";
const USER = "version-integrity-user";
const AGENT = "version-integrity-agent";
const VERSION = "version-integrity-v1";
const PROVIDER = "version-integrity-provider";
const CAPABILITY_KEY = "research.search";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["capability_versions", "runs", "workflow_executions", "plan_versions", "evolvable_asset_versions", "evolvable_assets", "agent_versions", "agents", "model_provider_space_grants", "model_providers", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Version integrity', 'personal', $2, $2)`,
    [SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', $2, $2)`,
    [USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (
       id, space_id, user_id, role, status, created_at, updated_at
     ) VALUES ('version-integrity-membership', $1, $2, 'owner', 'active', $3, $3)`,
    [SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, default_model,
       enabled, capabilities_json, config_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Version provider', 'openai', 'test-model',
               true, '{}'::jsonb, '{}'::jsonb, $4, $4)`,
    [PROVIDER, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (
       id, provider_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES ('version-provider-grant', $1, $2, $3, $3, true, true, $4, $4)`,
    [PROVIDER, SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, agent_kind,
       current_version_id, visibility, created_at, updated_at
     ) VALUES ($1, $2, NULL, 'Source processor', 'active',
               'system_source_post_processor', NULL, 'space_shared', $3, $3)`,
    [AGENT, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_provider_id, model_name, model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, tool_policy_json, output_policy_json,
       schedule_config_json, output_schema_json, created_at
     ) VALUES (
       $1, $2, $3, 'v1', 'old prompt', $5, 'test-model', '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4
     )`,
    [VERSION, AGENT, SPACE, now, PROVIDER],
  );
  await db.pool.query(
    `UPDATE agents SET current_version_id = $2 WHERE id = $1`,
    [AGENT, VERSION],
  );
});

describe("core version integrity", () => {
  it("publishes a new AgentVersion and leaves the historical version unchanged", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);

    const published = await repository.publishSystemManagedPrompt({
      spaceId: SPACE,
      agentId: AGENT,
      agentKind: "system_source_post_processor",
      systemPrompt: "new prompt",
    });
    expect(published.changed).toBe(true);
    expect(published.versionId).not.toBe(VERSION);

    const versions = await db.pool.query<{ id: string; version_label: string; system_prompt: string }>(
      `SELECT id, version_label, system_prompt
         FROM agent_versions
        WHERE agent_id = $1
        ORDER BY version_label`,
      [AGENT],
    );
    expect(versions.rows).toEqual([
      { id: VERSION, version_label: "v1", system_prompt: "old prompt" },
      { id: published.versionId, version_label: "v2", system_prompt: "new prompt" },
    ]);

    const repeated = await repository.publishSystemManagedPrompt({
      spaceId: SPACE,
      agentId: AGENT,
      agentKind: "system_source_post_processor",
      systemPrompt: "new prompt",
    });
    expect(repeated).toEqual({ changed: false, versionId: published.versionId });
    const count = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_versions WHERE agent_id = $1`,
      [AGENT],
    );
    expect(count.rows[0]?.count).toBe("2");
  });

  it("serializes concurrent Agent version publishers without mutating history", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);

    await Promise.all([
      repository.publishSystemManagedPrompt({
        spaceId: SPACE,
        agentId: AGENT,
        agentKind: "system_source_post_processor",
        systemPrompt: "managed prompt",
      }),
      repository.updateConfig(SPACE, AGENT, {
        userId: USER,
        systemPrompt: "configured prompt",
      }),
      repository.restoreVersion(SPACE, AGENT, VERSION, USER),
    ]);

    const versions = await db.pool.query<{ id: string; version_label: string; system_prompt: string }>(
      `SELECT id, version_label, system_prompt
         FROM agent_versions
        WHERE agent_id = $1
        ORDER BY version_label`,
      [AGENT],
    );
    expect(versions.rows.map((row) => row.version_label)).toEqual(["v1", "v2", "v3", "v4"]);
    expect(versions.rows.map((row) => row.system_prompt).sort()).toEqual([
      "configured prompt",
      "managed prompt",
      "old prompt",
      "old prompt",
    ]);
    expect(versions.rows[0]).toEqual({
      id: VERSION,
      version_label: "v1",
      system_prompt: "old prompt",
    });
    const current = await db.pool.query<{ current_version_id: string }>(
      `SELECT current_version_id FROM agents WHERE id = $1`,
      [AGENT],
    );
    expect(versions.rows.slice(1).map((row) => row.id)).toContain(current.rows[0]?.current_version_id);
  });

  it("reuses transaction connections for model validation under pool saturation", async (ctx) => {
    if (!db.available) return ctx.skip();
    const saturatedPool = new Pool({ connectionString: db.connectionUri, max: 2 });
    try {
      const repository = new PgAgentRepository(saturatedPool);
      await Promise.all([
        repository.updateConfig(SPACE, AGENT, { userId: USER, systemPrompt: "prompt A" }),
        repository.updateConfig(SPACE, AGENT, { userId: USER, systemPrompt: "prompt B" }),
      ]);
    } finally {
      await saturatedPool.end();
    }

    const versions = await db.pool.query<{ version_label: string }>(
      `SELECT version_label FROM agent_versions WHERE agent_id = $1 ORDER BY version_label`,
      [AGENT],
    );
    expect(versions.rows.map((row) => row.version_label)).toEqual(["v1", "v2", "v3"]);
  }, 15_000);

  it("does not refresh prompts for user-defined source post-processing Agents", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    await db.pool.query(
      `UPDATE agents SET agent_kind = 'standard' WHERE space_id = $1 AND id = $2`,
      [SPACE, AGENT],
    );

    await expect(refreshSourcePostProcessingAgentPrompt(db.pool, SPACE, AGENT)).resolves.toBeUndefined();
    const versions = await db.pool.query<{ version_label: string; system_prompt: string }>(
      `SELECT version_label, system_prompt
         FROM agent_versions
        WHERE agent_id = $1
        ORDER BY version_label`,
      [AGENT],
    );
    expect(versions.rows).toEqual([{ version_label: "v1", system_prompt: "old prompt" }]);
  });

  it("keeps evolvable assets and workflow history references non-deletable", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const constraints = await db.pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [[
        "evolvable_asset_versions_asset_id_fkey",
        "plan_versions_reference_workflow_version_fkey",
        "runs_workflow_version_fkey",
        "workflow_executions_workflow_version_fkey",
      ]],
    );
    expect(constraints.rows).toEqual([
      { conname: "evolvable_asset_versions_asset_id_fkey", confdeltype: "a" },
      { conname: "plan_versions_reference_workflow_version_fkey", confdeltype: "a" },
      { conname: "runs_workflow_version_fkey", confdeltype: "a" },
      { conname: "workflow_executions_workflow_version_fkey", confdeltype: "a" },
    ]);

    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, owner_scope_type,
         owner_scope_id, status, metadata_json, created_at, updated_at
       ) VALUES ('asset-1', $1, 'workflow_template', 'workflow.one', 'Workflow',
                 'space', $1, 'active', '{}'::jsonb, $2, $2)`,
      [SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO evolvable_asset_versions (
         id, asset_id, space_id, scope_type, scope_id, version, status,
         source, content_json, created_at, updated_at
       ) VALUES ('asset-version-1', 'asset-1', $1, 'space', $1, 1,
                 'approved', 'user_authored', '{}'::jsonb, $2, $2)`,
      [SPACE, now],
    );
    await expect(db.pool.query(`DELETE FROM evolvable_assets WHERE id = 'asset-1'`)).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("allows multiple available capability versions for independently pinned scopes", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO capability_versions (
         id, capability_key, space_id, version, source, status,
         metadata_json, created_at, updated_at
       ) VALUES ('capability-v1', 'research.search', $1, '1.0.0',
                 'builtin', 'available', '{}'::jsonb, $2, $2)`,
      [SPACE, now],
    );
    await expect(db.pool.query(
      `INSERT INTO capability_versions (
         id, capability_key, space_id, version, source, status,
         metadata_json, created_at, updated_at
       ) VALUES ('capability-v2', 'research.search', $1, '2.0.0',
                 'builtin', 'available', '{}'::jsonb, $2, $2)`,
      [SPACE, now],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("publishes capability versions without rewriting existing scope pins", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO capability_versions (
         id, capability_key, space_id, version, source, status,
         metadata_json, created_at, updated_at
       ) VALUES
         ('capability-v1', $1, $2, '1.0.0', 'builtin', 'available', '{}'::jsonb, $3, $3),
         ('capability-v2', $1, $2, '2.0.0', 'builtin', 'draft', '{}'::jsonb, $3, $3),
         ('capability-v3', $1, $2, '3.0.0', 'builtin', 'draft', '{}'::jsonb, $3, $3)`,
      [CAPABILITY_KEY, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO capability_enablements (
         id, space_id, project_id, agent_id, user_id, capability_key,
         capability_version_id, enabled, config_json, created_at, updated_at
       ) VALUES
         ('enablement-space', $1, NULL, NULL, NULL, $2, 'capability-v1', true, '{}'::jsonb, $3, $3),
         ('enablement-user', $1, NULL, NULL, $4, $2, 'capability-v1', true, '{}'::jsonb, $3, $3),
         ('enablement-follow', $1, NULL, $5, NULL, $2, NULL, true, '{}'::jsonb, $3, $3)`,
      [SPACE, CAPABILITY_KEY, now, USER, AGENT],
    );
    const registry = createDefaultProposalApplierRegistry();
    const applyAvailable = (versionId: string, proposalId: string) => withTransaction(
      db.pool,
      (db) => registry.apply({
        config: loadConfig({}),
        db,
        proposal: capabilityUpdateProposal(versionId, proposalId),
        userId: USER,
      }),
    );

    await Promise.all([
      applyAvailable("capability-v2", "proposal-v2"),
      applyAvailable("capability-v3", "proposal-v3"),
    ]);

    const availableVersions = await db.pool.query<{ id: string }>(
      `SELECT id
         FROM capability_versions
        WHERE capability_key = $1 AND space_id = $2
          AND status = 'available'`,
      [CAPABILITY_KEY, SPACE],
    );
    expect(availableVersions.rows.map((row) => row.id).sort()).toEqual([
      "capability-v1",
      "capability-v2",
      "capability-v3",
    ]);
    const enablements = await db.pool.query<{ id: string; capability_version_id: string | null }>(
      `SELECT id, capability_version_id
         FROM capability_enablements
        WHERE space_id = $1 AND capability_key = $2
        ORDER BY id`,
      [SPACE, CAPABILITY_KEY],
    );
    expect(enablements.rows).toEqual([
      { id: "enablement-follow", capability_version_id: null },
      { id: "enablement-space", capability_version_id: "capability-v1" },
      { id: "enablement-user", capability_version_id: "capability-v1" },
    ]);
  });

  it("concurrently enables different versions without changing another scope's pin", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const capabilityKey = "research.extract";
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO capability_versions (
         id, capability_key, space_id, version, source, status,
         metadata_json, created_at, updated_at
       ) VALUES
         ('extract-v1', $1, $2, '1.0.0', 'builtin', 'available', '{}'::jsonb, $3, $3),
         ('extract-v2', $1, $2, '2.0.0', 'builtin', 'draft', '{}'::jsonb, $3, $3),
         ('extract-v3', $1, $2, '3.0.0', 'builtin', 'draft', '{}'::jsonb, $3, $3)`,
      [capabilityKey, SPACE, now],
    );
    await db.pool.query(
      `INSERT INTO capability_enablements (
         id, space_id, project_id, agent_id, user_id, capability_key,
         capability_version_id, enabled, config_json, created_at, updated_at
       ) VALUES
         ('extract-space', $1, NULL, NULL, NULL, $2, 'extract-v1', true, '{}'::jsonb, $3, $3),
         ('extract-user', $1, NULL, NULL, $4, $2, 'extract-v1', true, '{}'::jsonb, $3, $3)`,
      [SPACE, capabilityKey, now, USER],
    );
    const registry = createDefaultProposalApplierRegistry();
    const applyEnable = (proposal: ApplyProposal) => withTransaction(
      db.pool,
      (db) => registry.apply({ config: loadConfig({}), db, proposal, userId: USER }),
    );

    await Promise.all([
      applyEnable(capabilityEnableProposal(capabilityKey, "extract-v2", "enable-space", null)),
      applyEnable(capabilityEnableProposal(capabilityKey, "extract-v3", "enable-user", USER)),
    ]);

    const availableVersions = await db.pool.query<{ id: string }>(
      `SELECT id FROM capability_versions
        WHERE capability_key = $1 AND space_id = $2
          AND status = 'available'`,
      [capabilityKey, SPACE],
    );
    expect(availableVersions.rows.map((row) => row.id).sort()).toEqual([
      "extract-v1",
      "extract-v2",
      "extract-v3",
    ]);
    const enablements = await db.pool.query<{ capability_version_id: string }>(
      `SELECT capability_version_id FROM capability_enablements
        WHERE space_id = $1 AND capability_key = $2 ORDER BY id`,
      [SPACE, capabilityKey],
    );
    expect(enablements.rows).toEqual([
      { capability_version_id: "extract-v2" },
      { capability_version_id: "extract-v3" },
    ]);
  });
});

function capabilityUpdateProposal(versionId: string, id: string): ApplyProposal {
  return {
    id,
    space_id: SPACE,
    proposal_type: "capability_update",
    title: "Publish capability version",
    payload_json: {
      proposal_type: "capability_update",
      operation: "capability_update",
      capability_version_id: versionId,
      status: "available",
    },
    project_folder_id: null,
    created_by_user_id: USER,
    project_id: null,
  };
}

function capabilityEnableProposal(
  capabilityKey: string,
  versionId: string,
  id: string,
  userId: string | null,
): ApplyProposal {
  return {
    id,
    space_id: SPACE,
    proposal_type: "capability_enable",
    title: "Enable capability version",
    payload_json: {
      proposal_type: "capability_enable",
      operation: "capability_enable",
      capability_key: capabilityKey,
      capability_version_id: versionId,
      ...(userId ? { user_id: userId } : {}),
    },
    project_folder_id: null,
    created_by_user_id: USER,
    project_id: null,
  };
}
