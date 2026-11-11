import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { providersModule } from "../src/modules/providers/index.js";
import { networkProfilesModule } from "../src/modules/networkProfiles/index.js";
import { notificationsModule } from "../src/modules/notifications/index.js";
import { pluginsModule } from "../src/modules/plugins/index.js";
import { systemCommandsModule } from "../src/modules/systemCommands/index.js";
import { __setProviderHttpClientForTests } from "../src/modules/providers/invocation/invocation.js";
import { __setNotificationWebhookTransportForTests } from "../src/modules/notifications/service.js";
import { executeSystemCommand } from "../src/modules/systemCommands/worker.js";
import { __setManagedSubscriptionFetchForTests, __setManagedSubscriptionOAuthForTests, loginManagedSubscription } from "../src/modules/providers/subscriptionOAuth.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { openAiChatResponse } from "./support/piAiHttp.js";
import { startMockUpstream, type MockUpstream } from "./support/mockUpstream.js";
import { keyed, refused, succeeded, systemCommandHarness } from "./support/systemCommandHarness.js";

/**
 * The system settings / tool configuration block through its retained URLs,
 * the real operation core, the real system command worker and the
 * issuer-only status read, on shared real PostgreSQL. Vendor and webhook
 * targets are local fakes; nothing leaves this machine.
 */
const SPACE = "51111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "52222222-2222-4222-8222-222222222222";
const OWNER = "5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "sk-settings-block-request-only-7f3a";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;
let config: ServerConfig;
let home: string;
let commands: ReturnType<typeof systemCommandHarness>;
const as = (userId: string, spaceId = SPACE) => __setAuthIdentityForTests({ spaceId, userId });

/** Every place a settled command, its audit or its Job could keep text. */
async function persistedText(): Promise<string> {
  const rows = await Promise.all([
    db.pool.query(`SELECT row_to_json(o)::text AS request FROM operation_idempotency o`),
    db.pool.query(`SELECT row_to_json(p)::text AS audit FROM policy_decision_records p`),
    db.pool.query(`SELECT frozen_json::text, effect_json::text, result_json::text FROM system_command_intents`),
    db.pool.query(`SELECT payload_json::text, result_json::text, error FROM jobs`),
    db.pool.query(`SELECT secret_ref FROM credentials`),
  ]);
  return JSON.stringify(rows.map((r) => r.rows));
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "rainver-settings-ops-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["system_command_intents", "jobs", "operation_idempotency", "policy_decision_records", "model_provider_credentials",
    "model_provider_space_grants", "model_providers", "credentials", "network_profiles", "settings", "space_memberships", "spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id,email,display_name,status,created_at,updated_at,registration_source) VALUES
      ($1,'owner@example.test','Owner','active',$3,$3,'system'),($2,'member@example.test','Member','active',$3,$3,'system')`, [OWNER, MEMBER, now]);
  for (const space of [SPACE, OTHER_SPACE]) await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'S','team',$2,$2)`, [space, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES
      (gen_random_uuid(),$1,$2,'owner','active',$4,$4),(gen_random_uuid(),$1,$3,'member','active',$4,$4),(gen_random_uuid(),$5,$2,'owner','active',$4,$4)`,
    [SPACE, OWNER, MEMBER, now, OTHER_SPACE]);
  config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home, INSTANCE_ADMIN_EMAIL: "owner@example.test" });
  app = buildModuleServer(config, [providersModule, networkProfilesModule, notificationsModule, pluginsModule, systemCommandsModule]);
  commands = systemCommandHarness(db.pool, config);
  as(OWNER);
});
afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setProviderHttpClientForTests(null);
  __setNotificationWebhookTransportForTests(null);
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

const createBody = { name: "Main", provider_type: "openai", base_url: "https://api.openai.com/v1", api_key: SECRET, default_model: "gpt-4o-mini" };

describe("Provider commands", () => {
  it("create keeps the key only in the encrypted credential, and replays or refuses by key", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const created = await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }, "create-main");
    const provider = succeeded<{ id: string; has_api_key: boolean }>(created, 201);
    expect(provider).toMatchObject({ name: "Main", has_api_key: true });
    expect(created.payload).not.toContain(SECRET);
    // Same key, same body: the recorded answer, not a second Provider.
    const replay = await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }, "create-main");
    expect(replay.json()).toEqual(created.json());
    expect((await db.pool.query(`SELECT 1 FROM model_providers`)).rowCount).toBe(1);
    // Same key, another key value: refused, and only a keyed digest of either value is stored.
    expect(refused(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: { ...createBody, api_key: "sk-other" } }, "create-main"), 422)).toBe("idempotency_key_reused");
    expect(await persistedText()).not.toContain(SECRET);
    // Unknown fields are refused by the strict command schema rather than ignored.
    expect(refused(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: { ...createBody, owner_user_id: MEMBER } }), 422)).toBe("operation_invalid_input");
  });

  it("hides another person's Provider and stops releasing a replay once it is no longer theirs", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }), 201);
    const update = { method: "PATCH" as const, url: `/api/v1/providers/${provider.id}`, payload: { name: "Renamed" } };
    expect(succeeded(await keyed(app, update, "rename"))).toMatchObject({ name: "Renamed" });
    as(MEMBER);
    for (const options of [update, { method: "DELETE" as const, url: `/api/v1/providers/${provider.id}` },
      { method: "POST" as const, url: `/api/v1/providers/${provider.id}/credentials`, payload: { api_key: "sk-x" } }]) {
      expect(refused(await keyed(app, options), 404)).toBe("operation_not_found");
    }
    as(OWNER);
    await db.pool.query(`UPDATE model_providers SET owner_user_id=$2 WHERE id=$1`, [provider.id, MEMBER]);
    expect(refused(await keyed(app, update, "rename"), 404)).toBe("operation_not_found");
  });

  it("manages the encrypted key pool, grants and task chains in the operation transaction", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }), 201);
    const member = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: `/api/v1/providers/${provider.id}/credentials`, payload: { api_key: `${SECRET}-pool`, name: "backup" } }), 201);
    expect(succeeded(await keyed(app, { method: "PATCH", url: `/api/v1/providers/${provider.id}/credentials/config`, payload: { rotation_strategy: "round_robin" } }))).toMatchObject({ rotation_strategy: "round_robin" });
    expect(succeeded(await keyed(app, { method: "DELETE", url: `/api/v1/providers/${provider.id}/credentials/${member.id}` }))).toMatchObject({ removed: true });
    const grant = succeeded(await keyed(app, { method: "PUT", url: `/api/v1/providers/${provider.id}/grants`, payload: { space_id: OTHER_SPACE, enabled: true } }));
    expect(grant).toMatchObject({ provider_id: provider.id, space_id: OTHER_SPACE });
    expect(succeeded(await keyed(app, { method: "DELETE", url: `/api/v1/providers/${provider.id}/grants/${OTHER_SPACE}` }))).toMatchObject({ revoked: true, target_space_id: OTHER_SPACE });
    expect(succeeded(await keyed(app, { method: "PUT", url: "/api/v1/providers/task-policies/reflector", payload: { chain: [{ provider_id: provider.id, model: "gpt-4o-mini" }] } }))).toMatchObject({ task: "reflector" });
    expect(succeeded(await keyed(app, { method: "DELETE", url: "/api/v1/providers/task-policies/reflector" }))).toMatchObject({ deleted: true });
    expect(succeeded(await keyed(app, { method: "PUT", url: "/api/v1/providers/subscription-quota-policy", payload: { warn_pct: 60, reserve_pct: 90 } }))).toEqual({ warn_pct: 60, reserve_pct: 90 });
    // Space policy is a Space owner's or admin's: a member is not told it exists.
    as(MEMBER);
    expect(refused(await keyed(app, { method: "PUT", url: "/api/v1/providers/subscription-quota-policy", payload: { warn_pct: 10, reserve_pct: 20 } }), 404)).toBe("operation_not_found");
    as(OWNER);
    expect(succeeded(await keyed(app, { method: "DELETE", url: `/api/v1/providers/${provider.id}` }))).toMatchObject({ deleted: true });
    expect(await persistedText()).not.toContain(SECRET);
    // Every change was audited under the settings policy actions, with no request body in the record.
    const audited = (await db.pool.query<{ action: string }>(`SELECT DISTINCT action FROM policy_decision_records`)).rows.map((r) => r.action).sort();
    expect(audited).toEqual(["provider.manage", "provider.space_policy.manage"]);
  });

  it("resets and re-queues retrieval embeddings with an embedding chain change, atomically", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: { ...createBody, provider_type: "cohere", base_url: "https://api.cohere.com/v2", default_model: "embed-v4.0" } }), 201);
    succeeded(await keyed(app, { method: "PUT", url: "/api/v1/providers/task-policies/retrieval_embedding", payload: { chain: [{ provider_id: provider.id, model: "embed-v4.0" }] } }));
    const jobs = await db.pool.query<{ job_type: string; payload: { trigger: string } }>(`SELECT job_type, payload_json AS payload FROM jobs WHERE space_id=$1`, [SPACE]);
    expect(jobs.rows).toEqual([expect.objectContaining({ job_type: "retrieval_embedding_backfill", payload: expect.objectContaining({ trigger: "retrieval_embedding_policy_update" }) })]);
  });

  it("runs a connection test after commit, releases it only to the issuer, and never repeats an unconfirmed one", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }), 201);
    const vendor = vi.fn(async () => openAiChatResponse({ choices: [{ message: { content: "hi" } }], model: "gpt-4o-mini", usage: {} }));
    __setProviderHttpClientForTests({ fetch: vendor });
    const test = { method: "POST" as const, url: `/api/v1/providers/${provider.id}/test`, payload: {} };
    const { receipt, status } = await commands.run(app, test);
    expect(receipt).toMatchObject({ kind: "provider_test", status: "pending" });
    expect(status).toMatchObject({ status: "succeeded", result: { success: true, message: "Connection successful", model: "gpt-4o-mini" } });
    expect(vendor).toHaveBeenCalledTimes(1);
    as(MEMBER);
    expect((await commands.status(app, receipt.id)).statusCode).toBe(404);
    // A test whose effect started and was never recorded is not run again.
    as(OWNER);
    const second = succeeded<{ id: string; job_id: string }>(await keyed(app, test), 202);
    await db.pool.query(`UPDATE system_command_intents SET status='dispatched', effect_json='{"dispatched_at":"2026-11-11T00:00:00.000Z","attempts":1}'::jsonb WHERE id=$1`, [second.id]);
    await commands.process();
    const read = (await commands.status(app, second.id)).json();
    expect(read).toMatchObject({ status: "needs_attention", result: null, error: { code: "system_command_outcome_unknown" } });
    expect(vendor).toHaveBeenCalledTimes(1);
    expect(await persistedText()).not.toContain(SECRET);
  });

  it("settles a command that never started: expired after its window, or failed when its Job was cancelled", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }), 201);
    const vendor = vi.fn(async () => openAiChatResponse({ choices: [{ message: { content: "hi" } }], model: "m", usage: {} }));
    __setProviderHttpClientForTests({ fetch: vendor });
    const late = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: `/api/v1/providers/${provider.id}/test`, payload: {} }), 202);
    await db.pool.query(`UPDATE system_command_intents SET created_at=now()-interval '11 minutes' WHERE id=$1`, [late.id]);
    await commands.process();
    expect((await commands.status(app, late.id)).json()).toMatchObject({ status: "failed", error: { code: "system_command_expired" } });
    const cancelled = succeeded<{ id: string; job_id: string }>(await keyed(app, { method: "POST", url: `/api/v1/providers/${provider.id}/test`, payload: {} }), 202);
    await db.pool.query(`UPDATE jobs SET status='cancelled' WHERE id=$1`, [cancelled.job_id]);
    expect((await commands.status(app, cancelled.id)).json()).toMatchObject({ status: "failed", error: { code: "system_command_job_cancelled" } });
    expect(vendor).not.toHaveBeenCalled();
  });

  it("does not run a command whose Job belongs to someone else", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }), 201);
    const receipt = succeeded<{ id: string; job_id: string }>(await keyed(app, { method: "POST", url: `/api/v1/providers/${provider.id}/test`, payload: {} }), 202);
    await expect(executeSystemCommand(config, receipt.id, { job_id: randomUUID(), space_id: SPACE, user_id: OWNER, job_type: "system_command", attempts: 1, max_attempts: 3, worker_id: "w", payload: { intent_id: receipt.id } }))
      .rejects.toThrow();
    expect((await db.pool.query(`SELECT status FROM system_command_intents WHERE id=$1`, [receipt.id])).rows[0]).toEqual({ status: "pending" });
  });
});

describe("Provider replays keep the writer's current authority", () => {
  afterEach(() => { __setManagedSubscriptionOAuthForTests(null); __setManagedSubscriptionFetchForTests(null); });
  const subscription = async () => {
    __setManagedSubscriptionOAuthForTests(async () => ({
      async login() { return { type: "oauth", access: "sub-access", refresh: "sub-refresh-0", expires: Date.now() - 1, accountId: "acct" }; },
      async refresh() { throw new Error("OpenAI Codex token refresh error: socket hang up"); },
    }));
    __setManagedSubscriptionFetchForTests(async () => new Response("{}", { status: 500 }));
    return loginManagedSubscription(config, "openai_codex", SPACE, OWNER, { signal: new AbortController().signal, notify() {}, async prompt() { return "device_code"; } });
  };

  it("replays a successful disconnect by key, refuses a second one, and stops once administration is withdrawn", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = await subscription();
    const disconnect = { method: "DELETE" as const, url: `/api/v1/providers/${provider.id}/subscription` };
    const first = await keyed(app, disconnect, "disconnect-1");
    expect(succeeded(first)).toMatchObject({ id: provider.id, enabled: false });
    expect((await db.pool.query(`SELECT 1 FROM credentials WHERE credential_type='subscription_oauth'`)).rowCount).toBe(0);
    expect((await keyed(app, disconnect, "disconnect-1")).json()).toEqual(first.json());
    expect(refused(await keyed(app, disconnect, "disconnect-2"), 404)).toBe("operation_not_found");
    await db.pool.query(`UPDATE users SET email='former-owner@example.test' WHERE id=$1`, [OWNER]);
    expect(refused(await keyed(app, disconnect, "disconnect-1"), 404)).toBe("operation_not_found");
  });

  it("re-authorizes a grant revoke replay as its Provider owner or the target Space admin, without needing the grant", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    // OWNER owns the Provider and grants it into OTHER_SPACE, where MEMBER is also an admin.
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES (gen_random_uuid(),$1,$2,'admin','active',now(),now())`, [OTHER_SPACE, MEMBER]);
    const provider = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/providers", payload: createBody }), 201);
    const grant = { method: "PUT" as const, url: `/api/v1/providers/${provider.id}/grants`, payload: { space_id: OTHER_SPACE, enabled: true } };
    succeeded(await keyed(app, grant));
    const revoke = { method: "DELETE" as const, url: `/api/v1/providers/${provider.id}/grants/${OTHER_SPACE}` };
    // The target Space's admin revokes from their own request Space; demoted, the same key no longer answers.
    as(MEMBER);
    const byAdmin = await keyed(app, revoke, "revoke-admin");
    expect(succeeded(byAdmin)).toMatchObject({ revoked: true, target_space_id: OTHER_SPACE });
    expect((await keyed(app, revoke, "revoke-admin")).json()).toEqual(byAdmin.json());
    await db.pool.query(`DELETE FROM model_provider_space_grants WHERE provider_id=$1`, [provider.id]);
    expect((await keyed(app, revoke, "revoke-admin")).json()).toEqual(byAdmin.json());
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2`, [OTHER_SPACE, MEMBER]);
    expect(refused(await keyed(app, revoke, "revoke-admin"), 404)).toBe("operation_not_found");
    expect(refused(await keyed(app, revoke, "revoke-member"), 404)).toBe("operation_not_found");
    // The owner's own revoke replays while they own it, and not after the Provider is no longer theirs.
    as(OWNER);
    succeeded(await keyed(app, grant));
    const byOwner = await keyed(app, revoke, "revoke-owner");
    expect(succeeded(byOwner)).toMatchObject({ revoked: true });
    expect((await keyed(app, revoke, "revoke-owner")).json()).toEqual(byOwner.json());
    await db.pool.query(`UPDATE model_providers SET owner_user_id=$2 WHERE id=$1`, [provider.id, MEMBER]);
    // Still an owner of the target Space, so still that Space's revoker…
    expect((await keyed(app, revoke, "revoke-owner")).json()).toEqual(byOwner.json());
    // …and neither owner nor target admin any more: refused.
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2`, [OTHER_SPACE, OWNER]);
    expect(refused(await keyed(app, revoke, "revoke-owner"), 404)).toBe("operation_not_found");
  });

  it("fails a quota read whose sign-in renewal may have rotated the token, and never sends it again", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const provider = await subscription();
    let refreshes = 0;
    __setManagedSubscriptionOAuthForTests(async () => ({
      async login() { throw new Error("unused"); },
      async refresh() { refreshes += 1; throw new Error("OpenAI Codex token refresh error: socket hang up"); },
    }));
    const quota = { method: "POST" as const, url: `/api/v1/providers/${provider.id}/subscription/quota`, payload: {} };
    const { status } = await commands.run(app, quota);
    expect(status).toMatchObject({ status: "failed", result: null, error: { code: "subscription_reconnect_required" } });
    const again = await commands.run(app, quota);
    expect(again.status).toMatchObject({ status: "failed", error: { code: "subscription_reconnect_required" } });
    expect(refreshes).toBe(1);
    expect(await persistedText()).not.toContain("sub-refresh-0");
  });
});

describe("network profiles", () => {
  it("are a Space owner's or admin's, credential-free, and replayable by key", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const created = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/network-profiles", payload: { name: "Proxy", mode: "http_proxy", proxy_url: "http://proxy.example:3128" } }, "np"), 201);
    expect(succeeded(await keyed(app, { method: "POST", url: "/api/v1/network-profiles", payload: { name: "Proxy", mode: "http_proxy", proxy_url: "http://proxy.example:3128" } }, "np"), 201)).toEqual(created);
    const withCredentials = await keyed(app, { method: "PATCH", url: `/api/v1/network-profiles/${created.id}`, payload: { proxy_url: "http://user:hunter2@proxy.example:3128" } });
    expect(refused(withCredentials, 422)).toBe("operation_invalid_input");
    expect(await persistedText()).not.toContain("hunter2");
    as(MEMBER);
    expect(refused(await keyed(app, { method: "DELETE", url: `/api/v1/network-profiles/${created.id}` }), 404)).toBe("operation_not_found");
    as(OWNER);
    expect(succeeded(await keyed(app, { method: "DELETE", url: `/api/v1/network-profiles/${created.id}` }))).toMatchObject({ deleted: true });
  });
});

describe("plugin installation", () => {
  it("runs the plugin's migrations in the worker's own transaction and settles the intent with them", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    as(MEMBER);
    expect(refused(await keyed(app, { method: "POST", url: "/api/v1/plugins/diary/install", payload: {} }), 404)).toBe("operation_not_found");
    as(OWNER);
    const { status } = await commands.run(app, { method: "POST", url: "/api/v1/plugins/diary/install", payload: {} });
    expect(status).toMatchObject({ status: "succeeded", error: null, result: { install: { plugin_id: "diary" }, item: { descriptor: { id: "diary" } } } });
    expect((await db.pool.query(`SELECT status FROM plugin_installs WHERE plugin_id='diary'`)).rows).toEqual([{ status: "active" }]);
  });
});

/** Waits until a backend running a statement matching `pattern` is blocked on a lock. */
async function waitForLockWait(pattern: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = (await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE $1`, [pattern])).rows;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no backend waiting on a lock for ${pattern}`);
}

describe("plugin installation keeps its authority until the install commits", () => {
  const revocations = [
    ["instance administration", `UPDATE users SET email='former-admin@example.test' WHERE id=$1`],
    ["the user", `UPDATE users SET status='disabled' WHERE id=$1`],
    ["the membership", `UPDATE space_memberships SET status='removed' WHERE user_id=$1 AND space_id='${SPACE}'`],
  ] as const;

  it.for(revocations)("a revocation of %s waits for an authorized, paused install to commit, and releases nothing after", async ([, revoke], ctx) => {
    if (!db.available || !app) return ctx.skip();
    const accepted = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/plugins/diary/install", payload: {} }, "install-race"), 202);
    // Hold the install's own write so the worker pauses inside its DDL/settlement transaction, after its authority check.
    const blocker = await db.pool.connect();
    const revoker = await db.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE plugin_installs IN ACCESS EXCLUSIVE MODE");
      const work = commands.process();
      await waitForLockWait("%plugin_installs%");
      await revoker.query("BEGIN");
      const revoking = revoker.query(revoke, [OWNER]).then(async () => {
        // Read in the revoking transaction once its write is through: the install has already committed.
        const seen = (await revoker.query(`SELECT status FROM system_command_intents WHERE id=$1`, [accepted.id])).rows[0];
        await revoker.query("COMMIT");
        return seen;
      });
      await waitForLockWait(revoke.startsWith("UPDATE users") ? "UPDATE users%" : "UPDATE space_memberships%");
      await blocker.query("ROLLBACK");
      await work;
      expect(await revoking).toEqual({ status: "succeeded" });
    } finally {
      blocker.release();
      revoker.release();
    }
    // Once withdrawn, neither the status read nor a replay of the receipt releases anything.
    expect((await commands.status(app, accepted.id)).statusCode).toBe(404);
    expect(refused(await keyed(app, { method: "POST", url: "/api/v1/plugins/diary/install", payload: {} }, "install-race"), 404)).toBe("operation_not_found");
  });

  it("an install whose authority was revoked first, while the worker waited, is refused and installs nothing", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const accepted = succeeded<{ id: string }>(await keyed(app, { method: "POST", url: "/api/v1/plugins/diary/install", payload: {} }), 202);
    const before = (await db.pool.query(`SELECT row_to_json(p)::text AS row FROM plugin_installs p WHERE plugin_id='diary'`)).rows;
    const revoker = await db.pool.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(`UPDATE users SET email='former-admin@example.test' WHERE id=$1`, [OWNER]);
      const work = commands.process();
      await waitForLockWait("%FOR SHARE OF m,u%");
      await revoker.query("COMMIT");
      await work;
    } finally {
      revoker.release();
    }
    expect((await db.pool.query(`SELECT status,error_code FROM system_command_intents WHERE id=$1`, [accepted.id])).rows)
      .toEqual([{ status: "failed", error_code: "system_command_authority_withdrawn" }]);
    expect((await db.pool.query(`SELECT row_to_json(p)::text AS row FROM plugin_installs p WHERE plugin_id='diary'`)).rows).toEqual(before);
  });
});

describe("notification webhook dispatch", () => {
  let target: MockUpstream | undefined;
  afterEach(async () => { await target?.close(); target = undefined; });

  it("refuses a disabled or non-allowlisted target without admitting a command", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const denied = await keyed(app, { method: "POST", url: "/api/v1/server/notifications/webhooks/dispatch", payload: { target_url: "https://attacker.example.com/x", event_type: "proposal.pending", payload: {} } });
    expect(refused(denied, 409)).toBe("operation_conflict");
    expect(denied.json().error.metadata).toEqual({ code: "notification_webhook_egress_disabled" });
    expect(denied.payload).not.toContain("attacker.example.com");
    expect((await db.pool.query(`SELECT 1 FROM system_command_intents`)).rowCount).toBe(0);
  });

  it("sends after commit to the allowlisted local target, without client credentials, and drops the payload once settled", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    target = await startMockUpstream((_req, res) => { res.writeHead(204); res.end(); });
    const targetUrl = `${target.baseUrl}/proposal`;
    await app.close();
    config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home, SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true", SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST: targetUrl });
    app = buildModuleServer(config, [notificationsModule, systemCommandsModule], { logger: false });
    commands = systemCommandHarness(db.pool, config);
    const { receipt, status } = await commands.run(app, {
      method: "POST", url: "/api/v1/server/notifications/webhooks/dispatch",
      headers: { authorization: "Bearer secret-token-123", cookie: "session=abc" },
      payload: { target_url: targetUrl, event_type: "proposal.pending", payload: { proposal_id: "p1", title: "Review memory proposal" } },
    });
    expect(status).toMatchObject({ status: "succeeded", result: { delivered: true, target_origin: target.baseUrl, upstream_status: 204 } });
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]!.headers.authorization).toBeUndefined();
    expect(target.requests[0]!.headers.cookie).toBeUndefined();
    expect(JSON.parse(target.requests[0]!.body)).toEqual({ event_type: "proposal.pending", payload: { proposal_id: "p1", title: "Review memory proposal" } });
    const row = (await db.pool.query<{ frozen_json: Record<string, unknown> }>(`SELECT frozen_json FROM system_command_intents WHERE id=$1`, [receipt.id])).rows[0]!;
    expect(row.frozen_json.payload).toBeUndefined();
  });

  it("marks a send that never reported needs_attention and does not send it again", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const targetUrl = "https://hooks.example.test/proposal";
    await app.close();
    config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home, SERVER_ENABLE_NOTIFICATION_WEBHOOK_EGRESS: "true", SERVER_NOTIFICATION_WEBHOOK_ALLOWLIST: targetUrl });
    app = buildModuleServer(config, [notificationsModule, systemCommandsModule], { logger: false });
    commands = systemCommandHarness(db.pool, config);
    const transport = vi.fn(async () => { throw new Error("socket hang up"); });
    __setNotificationWebhookTransportForTests(transport);
    const { status } = await commands.run(app, { method: "POST", url: "/api/v1/server/notifications/webhooks/dispatch", payload: { target_url: targetUrl, event_type: "proposal.pending" } });
    expect(status).toMatchObject({ status: "needs_attention", result: null, error: { code: "system_command_outcome_unknown" } });
    await commands.process();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
