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
const PAIRED_MACHINE = "version-integrity-machine";
const PAIRED_HOST = "version-integrity-paired-host";
const FOREIGN_SPACE = "version-integrity-foreign-space";
const FOREIGN_PROVIDER = "version-integrity-foreign-provider";
const CAPABILITY_KEY = "research.search";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["capability_versions", "runs", "workflow_executions", "plan_versions", "evolvable_asset_versions", "evolvable_assets", "agent_runtime_profiles", "agent_versions", "agents", "hosts", "machines", "model_provider_space_grants", "model_providers", "space_memberships", "users", "spaces"],
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
  // A paired (kind='remote') execution Host with an OpenCode copy of its own,
  // and a Provider in another Space that was never granted to this one.
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Paired laptop', 'desktop', $3, $3)`,
    [PAIRED_MACHINE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (
       id, owner_user_id, machine_id, name, kind, environment_kind, status,
       capabilities_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Paired laptop', 'remote', 'linux_native', 'online',
               '{"installations":{"opencode":[{"id":"own","version":"1.0.0","logged_in":true}]}}'::jsonb,
               $4, $4)`,
    [PAIRED_HOST, USER, PAIRED_MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Foreign', 'personal', $2, $2)`,
    [FOREIGN_SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, default_model,
       enabled, capabilities_json, config_json, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Foreign provider', 'openai', 'test-model',
               true, '{}'::jsonb, '{}'::jsonb, $4, $4)`,
    [FOREIGN_PROVIDER, FOREIGN_SPACE, USER, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (
       id, provider_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES ('foreign-provider-grant', $1, $2, $3, $3, true, true, $4, $4)`,
    [FOREIGN_PROVIDER, FOREIGN_SPACE, USER, now],
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
       context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       tool_policy_json, output_policy_json,
       schedule_config_json, output_schema_json, created_at
     ) VALUES (
       $1, $2, $3, 'v1', 'old prompt',
       '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4
     )`,
    [VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(
    `UPDATE agents SET current_version_id = $2 WHERE id = $1`,
    [AGENT, VERSION],
  );
});

describe("core version integrity", () => {
  it("provisions a stable default ACP Profile and keeps model/runtime selection off new versions", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Default ACP Agent",
      systemPrompt: "Use the selected runtime profile.",
    }));
    const profiles = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      runtime_key: "opencode",
      backend_mode: "runtime_native",
      enabled: true,
      is_default: true,
      workspace_mode: "managed",
      runtime_installation: "managed:pending",
    });
    expect(profiles[0]?.execution_host_id).toBeTruthy();

    const profileId = profiles[0]!.id;
    await repository.updateConfig(SPACE, created.id, {
      userId: USER,
      systemPrompt: "A new version, same deployment.",
    });
    expect(await repository.listRuntimeProfiles(SPACE, created.id)).toMatchObject([
      { id: profileId, runtime_key: "opencode", backend_mode: "runtime_native", is_default: true },
    ]);

    const versions = await db.pool.query<Record<string, unknown>>(
      `SELECT *
         FROM agent_versions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [created.id],
    );
    expect(versions.rows[0]).not.toHaveProperty("model_provider_id");
    expect(versions.rows[0]).not.toHaveProperty("model_name");
    expect(versions.rows[0]).not.toHaveProperty("model_config_json");
    expect(versions.rows[0]).not.toHaveProperty("runtime_config_json");
    expect(versions.rows[0]).not.toHaveProperty("runtime_policy_json");
  });

  it("moves model selection updates to the stable default Profile without creating a new version", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Config update Agent",
      systemPrompt: "Use the selected runtime profile.",
    }));
    const [initialProfile] = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(initialProfile?.is_default).toBe(true);

    await repository.updateRuntimeProfile(SPACE, created.id, initialProfile!.id, {
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
    });

    const [updatedProfile] = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(updatedProfile).toMatchObject({
      id: initialProfile?.id,
      is_default: true,
      enabled: true,
      backend_mode: "model_provider",
      model: { provider_id: PROVIDER, model: "test-model" },
    });
    const version = await db.pool.query<Record<string, unknown>>(
      `SELECT *
         FROM agent_versions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [created.id],
    );
    expect(version.rows[0]).not.toHaveProperty("model_provider_id");
    expect(version.rows[0]).not.toHaveProperty("model_name");
  });

  it("does not allow the enabled default Profile to be disabled or unset", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Protected default Agent",
      systemPrompt: "Keep one enabled default.",
    }));
    const [profile] = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(profile).toBeTruthy();

    await expect(repository.updateRuntimeProfile(SPACE, created.id, profile!.id, {
      enabled: false,
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(repository.updateRuntimeProfile(SPACE, created.id, profile!.id, {
      isDefault: false,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not let concurrent profile edits restore a former default", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Concurrent Profile Agent",
      systemPrompt: "Keep a single current default.",
    }));
    const profiles = await repository.listRuntimeProfiles(SPACE, created.id);
    const currentDefault = profiles.find((candidate) => candidate.is_default);
    expect(currentDefault).toBeTruthy();
    const alternate = await repository.createRuntimeProfile(SPACE, created.id, {
      name: "Alternate",
      runtimeKey: "opencode",
      backendMode: "runtime_native",
      executionHostId: currentDefault!.execution_host_id,
      workspaceMode: "managed",
      runtimeInstallation: "managed:pending",
      allowPendingServerInstallation: true,
      actorUserId: USER,
    });

    let formerDefault = currentDefault!;
    let nextDefault = alternate;
    for (let index = 0; index < 8; index += 1) {
      await Promise.all([
        repository.updateRuntimeProfile(SPACE, created.id, nextDefault.id, { isDefault: true }),
        repository.updateRuntimeProfile(SPACE, created.id, formerDefault.id, {
          name: `Former default ${index}`,
        }),
      ]);

      const after = await repository.listRuntimeProfiles(SPACE, created.id);
      expect(after.find((candidate) => candidate.id === nextDefault.id)?.is_default).toBe(true);
      expect(after.find((candidate) => candidate.id === formerDefault.id)).toMatchObject({
        name: `Former default ${index}`,
        is_default: false,
      });
      expect(after.filter((candidate) => candidate.is_default)).toHaveLength(1);
      [formerDefault, nextDefault] = [nextDefault, formerDefault];
    }
  });

  it("copies an explicit Space Provider template into a new Server Profile", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    await repository.setSpaceAgentRuntimeDefault(SPACE, {
      runtimeKey: "opencode",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
    });
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Provider ACP Agent",
      systemPrompt: "Use the provider proxy.",
    }));
    const profiles = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      runtime_key: "opencode",
      backend_mode: "model_provider",
      model: { provider_id: PROVIDER, model: "test-model" },
      is_default: true,
    });
    expect(profiles[0]?.execution_host_id).toBeTruthy();
  });

  it("rejects unsupported Space-template backend modes before persisting them", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);

    await expect(repository.setSpaceAgentRuntimeDefault(SPACE, {
      runtimeKey: "claude_code",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(repository.setSpaceAgentRuntimeDefault(SPACE, {
      runtimeKey: "opencode",
      backendMode: "runtime_native",
      runtimeConfigJson: { provider: [{ apiKey: "must-not-persist" }] },
    })).rejects.toMatchObject({ statusCode: 422 });

    const stored = await db.pool.query(
      `SELECT runtime_key, backend_mode FROM space_agent_runtime_defaults WHERE space_id = $1`,
      [SPACE],
    );
    expect(stored.rows).toEqual([]);
  });

  it("rejects unsupported backend modes on Profile create and update", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Mode-admission Agent",
      systemPrompt: "Only registered backend modes may be persisted.",
    }));
    const [defaultProfile] = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(defaultProfile).toBeTruthy();

    await expect(repository.createRuntimeProfile(SPACE, created.id, {
      name: "Unsupported Claude Provider",
      runtimeKey: "claude_code",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(repository.updateRuntimeProfile(SPACE, created.id, defaultProfile!.id, {
      runtimeKey: "claude_code",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
    })).rejects.toMatchObject({ statusCode: 422 });

    const after = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: defaultProfile!.id,
      runtime_key: "opencode",
      backend_mode: "runtime_native",
      is_default: true,
    });
  });

  it("binds a ModelProvider Profile to a paired Host through the Space proxy lease", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Paired provider Agent",
      systemPrompt: "Run OpenCode on my own machine against a Space Provider.",
    }));

    // ADR 0022 §1 puts no Host-kind restriction on provider mode, and the
    // remote path implements it: `hostProviderProxyBaseUrl` derives a lease
    // address for `kind = 'remote'`, and the daemon's bound-run environment
    // filter exists for exactly this case.
    const profile = await repository.createRuntimeProfile(SPACE, created.id, {
      name: "Paired provider",
      runtimeKey: "opencode",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
      executionHostId: PAIRED_HOST,
      workspaceMode: "managed",
      runtimeInstallation: "own",
      actorUserId: USER,
    });
    expect(profile).toMatchObject({
      backend_mode: "model_provider",
      execution_host_id: PAIRED_HOST,
      runtime_installation: "own",
      provider_binding: { state: "bound", provider_id: PROVIDER, model: "test-model" },
    });

    // What provider mode still may not be is unbound: with no Host there is
    // nothing to hand the lease to.
    await expect(repository.createRuntimeProfile(SPACE, created.id, {
      name: "Hostless provider",
      runtimeKey: "opencode",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
      actorUserId: USER,
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("admits a foreign-Space Provider only through an explicit Space grant", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Cross-space provider Agent",
      systemPrompt: "Only granted Providers are selectable.",
    }));
    const [defaultProfile] = await repository.listRuntimeProfiles(SPACE, created.id);

    const foreignSelection = {
      backendMode: "model_provider" as const,
      modelProviderId: FOREIGN_PROVIDER,
      modelName: "test-model",
    };
    await expect(repository.createRuntimeProfile(SPACE, created.id, {
      name: "Foreign provider",
      runtimeKey: "opencode",
      executionHostId: PAIRED_HOST,
      workspaceMode: "managed",
      runtimeInstallation: "own",
      actorUserId: USER,
      ...foreignSelection,
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(repository.updateRuntimeProfile(SPACE, created.id, defaultProfile!.id, foreignSelection))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(repository.setSpaceAgentRuntimeDefault(SPACE, {
      runtimeKey: "opencode",
      ...foreignSelection,
    })).rejects.toMatchObject({ statusCode: 400 });

    // Nothing was written by any of the three refusals.
    expect(await repository.listRuntimeProfiles(SPACE, created.id)).toMatchObject([
      { id: defaultProfile!.id, backend_mode: "runtime_native" },
    ]);
    expect(await repository.getSpaceAgentRuntimeDefault(SPACE)).toBeNull();

    // The grant is the whole mechanism: add it and the same selection admits.
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id, provider_id, space_id, owner_user_id, granted_by_user_id,
         enabled, is_default, created_at, updated_at
       ) VALUES ('foreign-provider-shared-grant', $1, $2, $3, $3, true, false, now(), now())`,
      [FOREIGN_PROVIDER, SPACE, USER],
    );
    const updated = await repository.updateRuntimeProfile(SPACE, created.id, defaultProfile!.id, foreignSelection);
    expect(updated).toMatchObject({ provider_binding: { state: "bound", provider_id: FOREIGN_PROVIDER } });
  });

  it("fails Agent creation with a repairable Space-template error and reports the state", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    await repository.setSpaceAgentRuntimeDefault(SPACE, {
      runtimeKey: "opencode",
      backendMode: "model_provider",
      modelProviderId: PROVIDER,
      modelName: "test-model",
    });
    expect(await repository.getSpaceAgentRuntimeDefault(SPACE)).toMatchObject({
      state: "ready",
      state_reason: null,
    });

    // Disabling the Provider must not rewrite the template or any Profile; it
    // makes future provisioning fail visibly.
    await db.pool.query(`UPDATE model_providers SET enabled = false WHERE id = $1`, [PROVIDER]);

    expect(await repository.getSpaceAgentRuntimeDefault(SPACE)).toMatchObject({
      backend_mode: "model_provider",
      model_provider_id: PROVIDER,
      state: "needs_repair",
    });

    const rejection = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Blocked Agent",
      systemPrompt: "Cannot be provisioned from a broken template.",
    })).catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      statusCode: 409,
      responseBody: { code: "space_runtime_default_needs_repair" },
    });
    expect(String((rejection as Error).message)).toContain("runtime default for new Agents");

    // The documented repair: put the template back on the native account.
    // Absence of a provider selection is the product default, so this is the
    // reset path and no second endpoint is needed for it.
    await repository.setSpaceAgentRuntimeDefault(SPACE, {
      runtimeKey: "opencode",
      backendMode: "runtime_native",
    });
    expect(await repository.getSpaceAgentRuntimeDefault(SPACE)).toMatchObject({
      backend_mode: "runtime_native",
      model_provider_id: null,
      state: "ready",
    });
    const repaired = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Repaired Agent",
      systemPrompt: "Provisioned after the repair.",
    }));
    expect(await repository.listRuntimeProfiles(SPACE, repaired.id)).toMatchObject([
      { backend_mode: "runtime_native", is_default: true },
    ]);
  });

  it("rejects nested secret config writes and redacts legacy secrets from Profile reads", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repository = new PgAgentRepository(db.pool);
    const created = await withTransaction(db.pool, (client) => repository.createInTransaction(client, {
      spaceId: SPACE,
      userId: USER,
      name: "Secret-free ACP Agent",
      systemPrompt: "Keep credentials outside runtime configuration.",
    }));
    const [profile] = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(profile).toBeTruthy();

    await expect(repository.updateRuntimeProfile(SPACE, created.id, profile!.id, {
      runtimeConfigJson: { provider: [{ apiKey: "must-not-persist" }] },
    })).rejects.toMatchObject({ statusCode: 422 });

    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET runtime_config_json = $3::jsonb,
              runtime_policy_json = $4::jsonb
        WHERE space_id = $1 AND agent_id = $2`,
      [
        SPACE,
        created.id,
        JSON.stringify({ effort: "medium", provider: [{ api_key: "legacy-secret", keep: true }] }),
        JSON.stringify({ nested: { credential_profile_id: "legacy-credential", keep: true } }),
      ],
    );
    const [readProfile] = await repository.listRuntimeProfiles(SPACE, created.id);
    expect(readProfile?.runtime_config_json).toEqual({ effort: "medium", provider: [{ keep: true }] });
    expect(readProfile?.runtime_policy_json).toEqual({ nested: { keep: true } });

    await repository.updateRuntimeProfile(SPACE, created.id, profile!.id, { name: "Cleaned legacy Profile" });
    const stored = await db.pool.query<{ runtime_config_json: Record<string, unknown>; runtime_policy_json: Record<string, unknown> }>(
      `SELECT runtime_config_json, runtime_policy_json
         FROM agent_runtime_profiles WHERE space_id = $1 AND agent_id = $2`,
      [SPACE, created.id],
    );
    expect(stored.rows[0]?.runtime_config_json).toEqual({ effort: "medium", provider: [{ keep: true }] });
    expect(stored.rows[0]?.runtime_policy_json).toEqual({ nested: { keep: true } });
    expect(stored.rows[0]?.runtime_policy_json.nested).not.toHaveProperty("credential_profile_id");
    const version = await db.pool.query<{ max_run_time_seconds: number; risk_level: string }>(
      `SELECT max_run_time_seconds, risk_level FROM agent_versions
        WHERE agent_id = $1 AND space_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [created.id, SPACE],
    );
    expect(version.rows[0]).toEqual({ max_run_time_seconds: 300, risk_level: "medium" });
  });

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
    visibility: "space_shared",
    owner_user_id: null,
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
    visibility: "space_shared",
    owner_user_id: null,
    project_id: null,
  };
}
