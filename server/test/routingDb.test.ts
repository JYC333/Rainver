import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedServerHost, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgRouteDecisionRepository, RouteSelectionError } from "../src/modules/routing/repository.js";
import { resolveRemoteRunBinding } from "../src/modules/runs/remoteProviderBinding.js";
import type { AgentRunRecord } from "../src/modules/runs/runRepositoryTypes.js";

// Real-Postgres coverage for the deterministic route: what the persisted
// Profile snapshot must carry, which execution targets are admissible, where
// capability authority lives, and which admission failures stay distinguishable.

const SPACE = "c1111111-1111-4111-8111-111111111111";
const OWNER = "c2222222-2222-4222-8222-222222222222";
const OTHER_USER = "c2222222-2222-4222-8222-222222222223";
const PROJECT = "c3333333-3333-4333-8333-333333333333";
const SERVER_HOST = "c4444444-4444-4444-8444-444444444441";
const PAIRED_HOST = "c4444444-4444-4444-8444-444444444442";
const PAIRED_MACHINE = "c4444444-4444-4444-8444-444444444443";
const PROVIDER = "c5555555-5555-4555-8555-555555555551";
const CREDENTIAL = "c5555555-5555-4555-8555-555555555552";
const PROVIDER_CREDENTIAL = "c5555555-5555-4555-8555-555555555553";
const PROVIDER_GRANT = "c5555555-5555-4555-8555-555555555554";

const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users", "hosts", "machines"], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES ($1,'Other Member','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OTHER_USER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'member','active',$4,$4)`,
    [randomUUID(), SPACE, OTHER_USER, now],
  );
  await seedServerHost(db.pool, {
    id: SERVER_HOST,
    now,
    installations: {
      opencode: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }],
    },
  });
  // A paired personal Host: its owner installs runtimes explicitly, and it is
  // the only execution target that is not the instance's strict Server Host.
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1,$2,'Laptop','laptop',$3,$3)`,
    [PAIRED_MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (
       id, owner_user_id, machine_id, name, kind, environment_kind, status,
       capabilities_json, last_heartbeat_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'Laptop','remote','linux_native','online',$4::jsonb, now(), $5, $5)`,
    [
      PAIRED_HOST,
      OWNER,
      PAIRED_MACHINE,
      JSON.stringify({
        runtimes: ["opencode"],
        versions: {},
        installations: { opencode: [{ id: "own", version: "1.0.0", logged_in: true, options: null }] },
      }),
      now,
    ],
  );
  await db.pool.query(
    `INSERT INTO credentials (id, space_id, owner_user_id, name, credential_type, secret_ref, scopes_json, created_at, updated_at)
     VALUES ($1,$2,$3,'Routing Test Credential','api_key','test-secret-ref','{}'::jsonb,$4,$4)`,
    [CREDENTIAL, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, default_model,
       credential_id, enabled, capabilities_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'Routing Test Provider','openai','test-model',$4,true,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
    [PROVIDER, SPACE, OWNER, CREDENTIAL, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_credentials (
       id, space_id, provider_id, credential_id, position, enabled, healthy,
       request_count, failure_count, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,0,true,true,0,0,$5,$5)`,
    [PROVIDER_CREDENTIAL, SPACE, PROVIDER, CREDENTIAL, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (
       id, provider_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
    [PROVIDER_GRANT, PROVIDER, SPACE, OWNER, now],
  );
});

/**
 * An Agent whose current AgentVersion uses the product default risk level
 * unless the test is about a different one. `capabilities` is AgentVersion
 * authority: a Runtime Profile never declares them.
 */
async function seedAgent(input: {
  capabilities?: string[];
  riskLevel?: "low" | "medium" | "high" | "critical";
}= {}): Promise<{ agentId: string; versionId: string }> {
  const agentId = randomUUID();
  const versionId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, visibility, created_at, updated_at)
     VALUES ($1,$2,$3,'Routing Agent','active',NULL,'space_shared',$4,$4)`,
    [agentId, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json, created_at
       ${input.riskLevel ? ", risk_level" : ""}
     ) VALUES ($1,$2,$3,'v1','You are a routing test agent.','{}'::jsonb,'{}'::jsonb,$4::jsonb,'{}'::jsonb,$5
       ${input.riskLevel ? ", $6" : ""})`,
    input.riskLevel
      ? [versionId, agentId, SPACE, JSON.stringify(input.capabilities ?? []), now, input.riskLevel]
      : [versionId, agentId, SPACE, JSON.stringify(input.capabilities ?? []), now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [agentId, versionId]);
  return { agentId, versionId };
}

async function seedProfile(input: {
  agentId: string;
  backendMode?: "runtime_native" | "model_provider";
  hostId?: string | null;
  runtimeInstallation?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  name?: string;
}): Promise<string> {
  const profileId = randomUUID();
  const now = new Date().toISOString();
  const backendMode = input.backendMode ?? "runtime_native";
  const hostId = input.hostId === undefined ? SERVER_HOST : input.hostId;
  const installation = input.runtimeInstallation === undefined
    ? (hostId === PAIRED_HOST ? "own" : "managed:1.0.0")
    : input.runtimeInstallation;
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, runtime_key, backend_mode,
       model_provider_id, model_name, execution_host_id, workspace_mode,
       runtime_installation, runtime_config_json, runtime_policy_json,
       enabled, is_default, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'opencode',$5,$6,$7,$8,$9,$10,'{}'::jsonb,'{}'::jsonb,$11,$12,$13,$13)`,
    [
      profileId,
      SPACE,
      input.agentId,
      input.name ?? "Default",
      backendMode,
      backendMode === "model_provider" ? PROVIDER : null,
      backendMode === "model_provider" ? "test-model" : null,
      hostId,
      hostId ? "managed" : null,
      hostId ? installation : null,
      input.enabled ?? true,
      input.isDefault ?? true,
      now,
    ],
  );
  return profileId;
}

async function queueRun(input: {
  agentId: string;
  capabilities?: string[];
  userId?: string;
}): Promise<AgentRunRecord> {
  return new PgRunRepository(db.pool).createQueuedRun({
    execution_kind: "agent",
    agent_id: input.agentId,
    space_id: SPACE,
    user_id: input.userId ?? OWNER,
    mode: "live",
    run_type: "agent",
    trigger_origin: "manual",
    prompt: "Route this run.",
    capabilities_json: input.capabilities ?? null,
    contract_snapshot: { source: { kind: "direct", id: null } },
  });
}

async function persistedSnapshot(runId: string): Promise<Record<string, unknown>> {
  const result = await db.pool.query<{ runtime_profile_snapshot_json: Record<string, unknown> | null }>(
    `SELECT runtime_profile_snapshot_json FROM runs WHERE id = $1`,
    [runId],
  );
  return result.rows[0]?.runtime_profile_snapshot_json ?? {};
}

interface PersistedRejection {
  runtime_profile_id?: string;
  reasons?: string[];
  baseline_trust_level?: string | null;
  effective_trust_level?: string | null;
}

async function rejections(runId: string): Promise<PersistedRejection[]> {
  const result = await db.pool.query<{ rejected_json: PersistedRejection[] | null }>(
    `SELECT rejected_json FROM route_decisions WHERE run_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
    [runId],
  );
  return result.rows[0]?.rejected_json ?? [];
}

async function rejectionReasons(runId: string): Promise<string[]> {
  return (await rejections(runId)).flatMap((entry) => entry.reasons ?? []);
}

/**
 * A Conversation pinned to a Host thread, with the backend snapshot the
 * Conversation froze. Routing reads the snapshot instead of the Profile's
 * current binding, so the snapshot's own backend mode and Provider are what
 * must answer the credential question.
 */
async function pinConversation(input: {
  agentId: string;
  profileId: string;
  backendMode: "runtime_native" | "model_provider";
  providerId?: string | null;
  modelName?: string | null;
}): Promise<{ sessionId: string; threadId: string }> {
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, user_id, title, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Pinned conversation','active',$4,$4)`,
    [sessionId, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO host_threads (
       id, space_id, execution_host_id, workspace_mode, session_id, agent_id,
       container_kind, runtime_key, runtime_installation, status,
       created_by_user_id, created_at, updated_at
     ) VALUES ($1,$2,$3,'managed',$4,$5,'conversation','opencode','managed:1.0.0','active',$6,$7,$7)`,
    [threadId, SPACE, SERVER_HOST, sessionId, input.agentId, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO session_conversation_backends (
       id, space_id, session_id, bound_by_user_id, agent_id, runtime_profile_id,
       runtime_key_snapshot, backend_mode_snapshot, model_name_snapshot,
       model_provider_id_snapshot, runtime_config_snapshot_json,
       runtime_policy_snapshot_json, runtime_state_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'opencode',$7,$8,$9,'{}'::jsonb,'{}'::jsonb,$10,$11,$11)`,
    [
      randomUUID(), SPACE, sessionId, OWNER, input.agentId, input.profileId,
      input.backendMode, input.modelName ?? null, input.providerId ?? null,
      randomUUID(), now,
    ],
  );
  return { sessionId, threadId };
}

async function queuePinnedRun(input: {
  agentId: string;
  profileId: string;
  sessionId: string;
  threadId: string;
}): Promise<AgentRunRecord> {
  return new PgRunRepository(db.pool).createQueuedRun({
    execution_kind: "agent",
    agent_id: input.agentId,
    space_id: SPACE,
    user_id: OWNER,
    mode: "live",
    run_type: "agent",
    trigger_origin: "manual",
    prompt: "Route this pinned conversation turn.",
    session_id: input.sessionId,
    runtime_profile_id: input.profileId,
    runtime_profile_selection_source: "explicit",
    model_override_json: {
      host_thread: { schema_version: "host_thread.v1", thread_id: input.threadId },
    },
    contract_snapshot: { source: { kind: "direct", id: null } },
  });
}

describe("deterministic routing against shared PostgreSQL", () => {
  it("stamps the Profile backend mode so a model_provider Run resolves its proxied lease", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent();
    const profileId = await seedProfile({ agentId, backendMode: "model_provider" });
    const run = await queueRun({ agentId });

    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(run);

    expect(routed.runtime_profile_id).toBe(profileId);
    expect(await persistedSnapshot(run.id)).toMatchObject({
      id: profileId,
      backend_mode: "model_provider",
      model_provider_id: PROVIDER,
      model_name: "test-model",
    });
    // Without the frozen backend mode the runtime would silently fall back to
    // the Host's native login instead of the server-issued provider lease.
    await expect(resolveRemoteRunBinding(db.pool, { id: run.id })).resolves.toEqual({
      provider_id: PROVIDER,
      model: "test-model",
    });
  });

  it("leaves a runtime_native Run without a provider binding", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent();
    await seedProfile({ agentId });
    const run = await queueRun({ agentId });

    await new PgRouteDecisionRepository(db.pool).routeRun(run);

    expect(await persistedSnapshot(run.id)).toMatchObject({ backend_mode: "runtime_native", model_provider_id: null });
    await expect(resolveRemoteRunBinding(db.pool, { id: run.id })).resolves.toBeNull();
  });

  it("routes an Agent at the product default risk level through the strict Server Host", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    // No explicit risk level: `POST /api/v1/agents` publishes `medium`, and the
    // strict Server Host's per-Run namespace is the enforcement that answers it.
    const { agentId } = await seedAgent();
    const profileId = await seedProfile({ agentId });
    const run = await queueRun({ agentId });

    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(run);

    expect(routed.runtime_profile_id).toBe(profileId);
    const decision = await db.pool.query<{ candidates_json: Array<{ effective_trust_level: string }> }>(
      `SELECT candidates_json FROM route_decisions WHERE run_id = $1`,
      [run.id],
    );
    expect(decision.rows[0]?.candidates_json[0]).toMatchObject({
      baseline_trust_level: "low",
      effective_trust_level: "medium",
    });
  });

  it("counts a paired Host owner's own Run as medium trust", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    // ADR 0016 amendment (2026-09-21): a paired Host is the owner's own
    // machine, so a Run the owner is responsible for carries the trust that
    // owner already extends to it. No explicit risk level here, so this is the
    // product-default `medium` Agent every ordinary Agent starts as.
    const { agentId } = await seedAgent();
    const profileId = await seedProfile({ agentId, hostId: PAIRED_HOST });
    const run = await queueRun({ agentId });

    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(run);

    expect(routed.runtime_profile_id).toBe(profileId);
    expect(await persistedSnapshot(run.id)).toMatchObject({ execution_host_id: PAIRED_HOST });
    const decision = await db.pool.query<{
      candidates_json: Array<{ baseline_trust_level: string; effective_trust_level: string }>;
    }>(`SELECT candidates_json FROM route_decisions WHERE run_id = $1`, [run.id]);
    expect(decision.rows[0]?.candidates_json[0]).toMatchObject({
      baseline_trust_level: "low",
      effective_trust_level: "medium",
    });
  });

  it("leaves a high-risk Run with no candidate on either Host", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    // Owner trust on a paired Host reaches `medium` and the Server Host's
    // namespace reaches `medium`; nothing reaches `high`, so `high`/`critical`
    // Agents still have nowhere to run.
    const { agentId } = await seedAgent({ riskLevel: "high" });
    await seedProfile({ agentId, name: "Server" });
    await seedProfile({ agentId, hostId: PAIRED_HOST, isDefault: false, name: "Paired" });
    const run = await queueRun({ agentId });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toBeInstanceOf(RouteSelectionError);
    const rejected = await rejections(run.id);
    expect(rejected).toHaveLength(2);
    for (const entry of rejected) {
      expect(entry.reasons).toContain("trust_level_too_low");
      expect(entry.effective_trust_level).toBe("medium");
    }
  });

  it("admits a paired Host default Profile for an ordinary Run with no pinned thread", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent({ riskLevel: "low" });
    const profileId = await seedProfile({ agentId, hostId: PAIRED_HOST });
    const run = await queueRun({ agentId });

    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(run);

    expect(routed.runtime_profile_id).toBe(profileId);
    expect(await persistedSnapshot(run.id)).toMatchObject({ execution_host_id: PAIRED_HOST });
  });

  it("does not dispatch another member's Run to a paired Host its owner alone trusts", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent({ riskLevel: "low" });
    await seedProfile({ agentId, hostId: PAIRED_HOST });
    const run = await queueRun({ agentId, userId: OTHER_USER });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toBeInstanceOf(RouteSelectionError);
    const rejected = await rejections(run.id);
    expect(rejected[0]?.reasons).toContain("execution_host_not_permitted");
    // The owner-trust rule is about whose machine bears the Run, so it does not
    // reach another member's Run: that one stays at the runtime baseline.
    expect(rejected[0]?.effective_trust_level).toBe("low");
  });

  it("matches a capability declared by the current AgentVersion with no Profile capability bag", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent({ capabilities: ["research.monitor_compare"] });
    const profileId = await seedProfile({ agentId });
    const run = await queueRun({ agentId, capabilities: ["research.monitor_compare"] });

    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(run);

    expect(routed.runtime_profile_id).toBe(profileId);
    const candidates = await new PgRouteDecisionRepository(db.pool).listCandidates(SPACE, agentId, OWNER);
    expect(candidates[0]?.capabilities).toEqual(["research.monitor_compare"]);
  });

  it("rejects a capability the current AgentVersion does not declare", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent({ capabilities: ["research.source_collect"] });
    await seedProfile({ agentId });
    const run = await queueRun({ agentId, capabilities: ["research.monitor_compare"] });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toBeInstanceOf(RouteSelectionError);
    expect(await rejectionReasons(run.id)).toContain("required_capability_missing");
  });

  it("refuses a model_provider Profile whose Provider has been disabled", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    // A `model_provider` Profile is always Host-bound, so asking the Host
    // first would admit it and leave the withdrawn Provider to surface at
    // launch as `model_provider_not_found`, after dispatch.
    const { agentId } = await seedAgent();
    await seedProfile({ agentId, backendMode: "model_provider" });
    await db.pool.query(`UPDATE model_providers SET enabled = false WHERE id = $1`, [PROVIDER]);
    const run = await queueRun({ agentId });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toBeInstanceOf(RouteSelectionError);
    expect(await rejectionReasons(run.id)).toContain("credential_unavailable");
  });

  it("refuses a model_provider Profile after its Space grant is withdrawn", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent();
    await seedProfile({ agentId, backendMode: "model_provider" });
    await db.pool.query(
      `UPDATE model_provider_space_grants SET enabled = false WHERE id = $1`,
      [PROVIDER_GRANT],
    );
    const run = await queueRun({ agentId });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toBeInstanceOf(RouteSelectionError);
    expect(await rejectionReasons(run.id)).toContain("credential_unavailable");
  });

  it("separates a disabled Profile from an installation the Server Runtime has not finished", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const { agentId } = await seedAgent();
    await seedProfile({ agentId, name: "Installing", runtimeInstallation: "managed:pending" });
    await seedProfile({ agentId, name: "Retired", enabled: false, isDefault: false });
    const run = await queueRun({ agentId });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toBeInstanceOf(RouteSelectionError);
    const reasons = await rejectionReasons(run.id);
    expect(reasons).toContain("candidate_disabled");
    expect(reasons).toContain("runtime_installation_not_ready");
  });

  it("refuses a pinned Conversation whose snapshotted Provider has been disabled", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    // The Profile alone would still route: it is `runtime_native` and carries
    // its own login on the Host. What the Run would spend is the Provider the
    // Conversation froze, so that is the credential the gate has to ask about.
    const { agentId } = await seedAgent();
    const profileId = await seedProfile({ agentId });
    await db.pool.query(`UPDATE model_providers SET enabled = false WHERE id = $1`, [PROVIDER]);
    const pinned = await pinConversation({
      agentId,
      profileId,
      backendMode: "model_provider",
      providerId: PROVIDER,
      modelName: "test-model",
    });
    const run = await queuePinnedRun({ agentId, profileId, ...pinned });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run))
      .rejects.toMatchObject({
        name: RouteSelectionError.name,
        code: "conversation_model_provider_unavailable",
      });
  });

  it("answers credential availability from the Conversation snapshot, not the Profile's current Provider", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    // The Profile was re-pointed at a Provider that is now disabled; the
    // Conversation is still bound to the one it froze, which is usable. The
    // candidate's own `credential_available` answered for the Profile, so
    // inheriting it rejected a Run whose snapshot was perfectly routable.
    const retiredProvider = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO model_providers (
         id, space_id, owner_user_id, name, provider_type, default_model,
         credential_id, enabled, capabilities_json, config_json, created_at, updated_at
       ) VALUES ($1,$2,$3,'Retired Provider','openai','retired-model',$4,false,'{}'::jsonb,'{}'::jsonb,$5,$5)`,
      [retiredProvider, SPACE, OWNER, CREDENTIAL, now],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id, provider_id, space_id, owner_user_id, granted_by_user_id,
         enabled, is_default, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$4,true,false,$5,$5)`,
      [randomUUID(), retiredProvider, SPACE, OWNER, now],
    );
    const { agentId } = await seedAgent();
    const profileId = await seedProfile({ agentId, backendMode: "model_provider" });
    await db.pool.query(
      `UPDATE agent_runtime_profiles SET model_provider_id = $2, model_name = 'retired-model' WHERE id = $1`,
      [profileId, retiredProvider],
    );
    const pinned = await pinConversation({
      agentId,
      profileId,
      backendMode: "model_provider",
      providerId: PROVIDER,
      modelName: "test-model",
    });
    const run = await queuePinnedRun({ agentId, profileId, ...pinned });

    await expect(new PgRouteDecisionRepository(db.pool).routeRun(run)).resolves.toMatchObject({
      runtime_profile_id: profileId,
    });
    expect(await rejectionReasons(run.id)).not.toContain("credential_unavailable");
    expect(await persistedSnapshot(run.id)).toMatchObject({
      backend_mode: "model_provider",
      model_provider_id: PROVIDER,
      model_name: "test-model",
    });
  });
});
