import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, sessionCookieName } from "../src/modules/auth/identity.js";
import { providersModule } from "../src/modules/providers/index.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { listApiPlanUsageProviders, refreshApiPlanUsage } from "../src/modules/providers/planUsage/service.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { keyed, refused, succeeded, systemCommandHarness } from "./support/systemCommandHarness.js";
import { systemCommandsModule } from "../src/modules/systemCommands/index.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), other = randomUUID(), otherSpace = randomUUID();
let home: string, config: ServerConfig, providerId: string;
const vendorResponse = () => Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 75 }] });
beforeAll(async () => {
  if (!db.available) return;
  home = await mkdtemp(join(tmpdir(), "rainver-api-plan-"));
  config = { databaseUrl: db.connectionUri, rainverHome: home } as ServerConfig;
  await seedSpaceOwnerProject(db.pool, { space, owner, project: randomUUID() });
  await seedSpaceOwnerProject(db.pool, { space: otherSpace, owner: other, project: randomUUID() });
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, other]);
  const provider = await resolveProviderCommandStore(config).createProvider(space, owner, { name: "MiniMax plan", provider_type: "minimax", base_url: "https://api.minimaxi.com/anthropic", api_key: "test-plan-secret" }) as { id: string };
  providerId = provider.id;
});
afterEach(() => { vi.unstubAllGlobals(); __setAuthIdentityForTests(null); });
afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }); });

it("lists only the owner's active-space supported providers, without secrets or vendor calls", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(await listApiPlanUsageProviders(config, space, owner)).toEqual([{ provider_id: providerId, name: "MiniMax plan", vendor: "minimax" }]);
  expect(await listApiPlanUsageProviders(config, space, other)).toEqual([]);
  expect(await listApiPlanUsageProviders(config, otherSpace, owner)).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
it("refuses a shared-space member, wrong Space or missing provider before any request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(refreshApiPlanUsage(config, space, other, providerId)).rejects.toMatchObject({ statusCode: 404 });
  await expect(refreshApiPlanUsage(config, otherSpace, owner, providerId)).rejects.toMatchObject({ statusCode: 404 });
  await expect(refreshApiPlanUsage(config, space, owner, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses the primary encrypted credential and returns only normalized quota without changing the credential pool", async () => {
  const store = resolveProviderCommandStore(config);
  await store.addPoolCredential(space, owner, providerId, { api_key: "other-account-secret" });
  const before = await store.listPool(space, providerId);
  const fetcher = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
    expect((options?.headers as Record<string, string>).Authorization).toBe("Bearer test-plan-secret");
    return vendorResponse();
  });
  vi.stubGlobal("fetch", fetcher);
  const snapshot = await refreshApiPlanUsage(config, space, owner, providerId);
  expect(snapshot).toMatchObject({ provider_id: providerId, windows: [{ used_pct: 25 }] });
  expect(JSON.stringify(snapshot)).not.toMatch(/secret|credential/);
  expect(await store.listPool(space, providerId)).toEqual(before);
});
it("does not return a result after its grant is revoked during the vendor request", async () => {
  vi.stubGlobal("fetch", async () => {
    await db.pool.query("UPDATE model_provider_space_grants SET enabled=false WHERE provider_id=$1 AND space_id=$2", [providerId, space]);
    return vendorResponse();
  });
  try { await expect(refreshApiPlanUsage(config, space, owner, providerId)).rejects.toMatchObject({ statusCode: 409 }); }
  finally { await db.pool.query("UPDATE model_provider_space_grants SET enabled=true WHERE provider_id=$1 AND space_id=$2", [providerId, space]); }
});
it("does not return a result after the Space grant's network profile changes during the vendor request", async () => {
  // A grant's profile is not part of the provider row, so provider_revision does not move with it.
  const profileId = randomUUID();
  await db.pool.query(`INSERT INTO network_profiles (id,space_id,name,mode,enabled,created_at,updated_at) VALUES ($1,$2,'Direct','direct',true,now(),now())`, [profileId, space]);
  vi.stubGlobal("fetch", async () => {
    await db.pool.query("UPDATE model_provider_space_grants SET network_profile_id=$3 WHERE provider_id=$1 AND space_id=$2", [providerId, space, profileId]);
    return vendorResponse();
  });
  try { await expect(refreshApiPlanUsage(config, space, owner, providerId)).rejects.toMatchObject({ statusCode: 409 }); }
  finally {
    await db.pool.query("UPDATE model_provider_space_grants SET network_profile_id=NULL WHERE provider_id=$1 AND space_id=$2", [providerId, space]);
    await db.pool.query("DELETE FROM network_profiles WHERE id=$1", [profileId]);
  }
});
it("does not label old-account quota as a replacement key's quota", async () => {
  vi.stubGlobal("fetch", async () => {
    await resolveProviderCommandStore(config).updateProvider(space, owner, providerId, { api_key: "replacement-secret" });
    return vendorResponse();
  });
  try { await expect(refreshApiPlanUsage(config, space, owner, providerId)).rejects.toMatchObject({ statusCode: 409 }); }
  finally { await resolveProviderCommandStore(config).updateProvider(space, owner, providerId, { api_key: "test-plan-secret" }); }
});
it("joins concurrent queries for one owner, Space and key into one vendor request", async () => {
  let release!: () => void;
  const fetcher = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return vendorResponse(); });
  vi.stubGlobal("fetch", fetcher);
  const first = refreshApiPlanUsage(config, space, owner, providerId);
  const second = refreshApiPlanUsage(config, space, owner, providerId);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  // Another person is still authorized separately and never joins this request.
  await expect(refreshApiPlanUsage(config, space, other, providerId)).rejects.toMatchObject({ statusCode: 404 });
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  // Settled: the next query asks the vendor again.
  vi.stubGlobal("fetch", vi.fn(async () => vendorResponse()));
  await refreshApiPlanUsage(config, space, owner, providerId);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("returns a safe failure instead of a zero meter or vendor error body", async () => {
  vi.stubGlobal("fetch", async () => new Response("test-plan-secret", { status: 401 }));
  await expect(refreshApiPlanUsage(config, space, owner, providerId)).rejects.toMatchObject({ statusCode: 502, message: expect.not.stringContaining("test-plan-secret") });
});

it("serves owner-only public quota routes and keeps the list route distinct from provider detail", async () => {
  const routeConfig = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home, SERVER_DEBUG: "true" });
  const app = buildModuleServer(routeConfig, [providersModule, systemCommandsModule]);
  const commands = systemCommandHarness(db.pool, routeConfig);
  vi.stubGlobal("fetch", async () => vendorResponse());
  try {
    __setAuthIdentityForTests({ spaceId: space, userId: owner });
    const listed = await app.inject({ method: "GET", url: "/api/v1/providers/plan-usage" });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toContain("no-store");
    expect(listed.json()).toEqual({ items: [{ provider_id: providerId, name: "MiniMax plan", vendor: "minimax" }] });
    // `provider.plan_usage.refresh`: a receipt; the vendor read runs after commit and the
    // snapshot is released only by the issuer's status read.
    const { receipt, status } = await commands.run(app, { method: "POST", url: `/api/v1/providers/${providerId}/plan-usage`, payload: {} });
    expect(receipt.kind).toBe("provider_plan_usage_refresh");
    expect(status).toMatchObject({ status: "succeeded", error: null });
    expect((status.result as { windows: Array<{ used_pct: number }> }).windows[0]!.used_pct).toBe(25);
    expect(JSON.stringify(status)).not.toContain("secret");
    __setAuthIdentityForTests({ spaceId: space, userId: other });
    const denied = await keyed(app, { method: "POST", url: `/api/v1/providers/${providerId}/plan-usage`, payload: {} });
    expect(denied.statusCode).toBe(404);
    expect(denied.payload).not.toContain("secret");
    // Nor may anyone else read the owner's command.
    expect((await commands.status(app, receipt.id)).statusCode).toBe(404);
  } finally { await app.close(); }
});

it("does not return a result after the Space grant's network profile is changed or disabled in place", async () => {
  // Same profile id throughout: only its content and enabled flag move.
  const profileId = randomUUID();
  await db.pool.query(`INSERT INTO network_profiles (id,space_id,name,mode,enabled,created_at,updated_at) VALUES ($1,$2,'Direct','direct',true,now(),now())`, [profileId, space]);
  await db.pool.query("UPDATE model_provider_space_grants SET network_profile_id=$3 WHERE provider_id=$1 AND space_id=$2", [providerId, space, profileId]);
  try {
    for (const change of [
      "UPDATE network_profiles SET enabled=false, updated_at=now() + interval '1 second' WHERE id=$1",
      "UPDATE network_profiles SET mode='http_proxy', proxy_url='http://proxy.invalid:8080', updated_at=now() + interval '2 seconds' WHERE id=$1",
    ]) {
      vi.stubGlobal("fetch", async () => { await db.pool.query(change, [profileId]); return vendorResponse(); });
      await expect(refreshApiPlanUsage(config, space, owner, providerId), change).rejects.toMatchObject({ statusCode: 409 });
    }
  } finally {
    await db.pool.query("UPDATE model_provider_space_grants SET network_profile_id=NULL WHERE provider_id=$1 AND space_id=$2", [providerId, space]);
    await db.pool.query("DELETE FROM network_profiles WHERE id=$1", [profileId]);
  }
});

describe("the refresh command releases the quota only to a session that still holds the authority", () => {
  // No identity override: the real session table and account status decide.
  const routeConfig = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home, SERVER_DEBUG: "true" });
  async function signIn(): Promise<{ sessionId: string; headers: Record<string, string> }> {
    const raw = `plan-usage-session-${randomUUID()}`, sessionId = randomUUID();
    await db.pool.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, created_at, expires_at, updated_at) VALUES ($1,$2,$3,now(),now() + interval '1 day',now())`,
      [sessionId, owner, createHash("sha256").update(raw).digest("hex")],
    );
    const cfg = routeConfig();
    return { sessionId, headers: { cookie: `${sessionCookieName(cfg)}=${raw}`, origin: cfg.frontendUrl, "x-rainver-space-id": space } };
  }
  function slowVendor() {
    let release!: () => void;
    const fetcher = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return vendorResponse(); });
    vi.stubGlobal("fetch", fetcher);
    return { fetcher, release: async () => { await vi.waitFor(() => expect(fetcher).toHaveBeenCalled()); release(); } };
  }
  const submit = (app: ReturnType<typeof buildModuleServer>, headers: Record<string, string>) =>
    keyed(app, { method: "POST", url: `/api/v1/providers/${providerId}/plan-usage`, headers, payload: {} });
  const status = (app: ReturnType<typeof buildModuleServer>, id: string, headers: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/v1/system/commands/${id}`, headers });
  afterEach(async () => {
    await db.pool.query("UPDATE users SET status='active' WHERE id=$1", [owner]);
    await db.pool.query("DELETE FROM user_sessions WHERE user_id=$1", [owner]);
  });

  it("returns the quota to a session that is still signed in", async () => {
    const app = buildModuleServer(routeConfig(), [providersModule, systemCommandsModule]);
    const commands = systemCommandHarness(db.pool, routeConfig());
    try {
      const { headers } = await signIn();
      vi.stubGlobal("fetch", async () => vendorResponse());
      const receipt = succeeded<{ id: string }>(await submit(app, headers), 202);
      await commands.process();
      const read = await status(app, receipt.id, headers);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().result.windows[0].used_pct).toBe(25);
    } finally { await app.close(); }
  });

  it("refuses, without the quota, a session signed out during the vendor request", async () => {
    const app = buildModuleServer(routeConfig(), [providersModule, systemCommandsModule]);
    const commands = systemCommandHarness(db.pool, routeConfig());
    try {
      const { sessionId, headers } = await signIn();
      const receipt = succeeded<{ id: string }>(await submit(app, headers), 202);
      const vendor = slowVendor();
      const running = commands.process();
      await vi.waitFor(() => expect(vendor.fetcher).toHaveBeenCalled());
      await db.pool.query("DELETE FROM user_sessions WHERE id=$1", [sessionId]);
      await vendor.release();
      await running;
      const read = await status(app, receipt.id, headers);
      expect(read.statusCode, read.body).toBe(401);
      expect(read.body).not.toContain("used_pct");
    } finally { await app.close(); }
  });

  it("records no quota for an account disabled during the vendor request", async () => {
    const app = buildModuleServer(routeConfig(), [providersModule, systemCommandsModule]);
    const commands = systemCommandHarness(db.pool, routeConfig());
    try {
      const { sessionId, headers } = await signIn();
      const receipt = succeeded<{ id: string }>(await submit(app, headers), 202);
      const vendor = slowVendor();
      const running = commands.process();
      await vi.waitFor(() => expect(vendor.fetcher).toHaveBeenCalled());
      await db.pool.query("UPDATE users SET status='disabled' WHERE id=(SELECT user_id FROM user_sessions WHERE id=$1)", [sessionId]);
      await vendor.release();
      await running;
      // The worker's settle step found the person no longer active: nothing is kept to release.
      const row = (await db.pool.query<{ status: string; result_json: unknown; error_code: string }>(`SELECT status,result_json,error_code FROM system_command_intents WHERE id=$1`, [receipt.id])).rows[0]!;
      expect(row).toMatchObject({ status: "needs_attention", result_json: null, error_code: "system_command_authority_withdrawn" });
      const read = await status(app, receipt.id, headers);
      expect(read.statusCode, read.body).toBe(401);
      expect(read.body).not.toContain("used_pct");
    } finally { await app.close(); }
  });

  it("gives a second request for the same read the active command instead of a second vendor request", async () => {
    const app = buildModuleServer(routeConfig(), [providersModule, systemCommandsModule]);
    const commands = systemCommandHarness(db.pool, routeConfig());
    try {
      const kept = await signIn(), lost = await signIn();
      const vendor = slowVendor();
      const receipt = succeeded<{ id: string }>(await submit(app, kept.headers), 202);
      const busy = await submit(app, lost.headers);
      expect(refused(busy, 409)).toBe("operation_conflict");
      expect(busy.json().error.metadata).toEqual({ code: "system_command_busy", command_id: receipt.id });
      const running = commands.process();
      await vi.waitFor(() => expect(vendor.fetcher).toHaveBeenCalled());
      await db.pool.query("DELETE FROM user_sessions WHERE id=$1", [lost.sessionId]);
      await vendor.release();
      await running;
      expect(vendor.fetcher).toHaveBeenCalledTimes(1);
      const a = await status(app, receipt.id, kept.headers), b = await status(app, receipt.id, lost.headers);
      expect(a.statusCode, a.body).toBe(200);
      expect(b.statusCode, b.body).toBe(401);
      expect(b.body).not.toContain("used_pct");
    } finally { await app.close(); }
  });
});
