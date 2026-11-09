import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import type { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import {
  listHostRuntimeChanges,
  mergeRunQuota,
  readHostUsage,
  recordHostRuntimeChange,
  refreshAllHostUsage,
  refreshHostUsage,
  invalidateHostUsage,
} from "../src/modules/hosts/usageService.js";
import { readSubscriptionQuotaPools } from "../src/modules/hosts/subscriptionUsage.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { hostsModule } from "../src/modules/hosts/index.js";

/**
 * Subscription quota is readable only on the host that holds the login (ADR
 * 0016 §7), so the control plane asks and caches. These pin what is cached —
 * numbers and a reason, never a credential — and that the cache is the only
 * thing a page read touches.
 */
const db = useTestDatabase(import.meta.filename);

afterEach(() => { __setAuthIdentityForTests(null); });

function registry(answers: Record<string, unknown>, online = true): HostConnectionRegistry {
  return {
    isOnline: () => online,
    requestUsageProbe: (_hostId: string, frame: { runtime_key: string }) =>
      Promise.resolve(answers[frame.runtime_key] ?? {
        available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null,
        error: "no answer",
      }),
  } as unknown as HostConnectionRegistry;
}

beforeEach(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await resetTables(db.pool, ["hosts", "machines", "users"], { cascade: true });
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ('user-1', 'Owner', 'active', $1, $1, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ('machine-1', NULL, 'Instance', 'server', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO hosts (
       id, owner_user_id, machine_id, name, kind, environment_kind, status,
       capabilities_json, last_heartbeat_at, created_at, updated_at
     ) VALUES (
       'host-1', NULL, 'machine-1', 'Server', 'server', 'server', 'online',
       $2::jsonb, $1, $1, $1
     )`,
    [now, JSON.stringify({
      runtimes: [], versions: {},
      installations: {
        claude_code: [{ id: "own", version: "1.0.0", logged_in: true, options: null }],
        codex_cli: [{ id: "managed:2.0.0", version: "2.0.0", logged_in: false, options: null }],
        opencode: [{ id: "own", version: "3.0.0", logged_in: true, options: null }],
      },
    })],
  );
});

describe("host subscription quota cache (real Postgres)", () => {
  it("preserves Antigravity model windows through the shared quota cache", async (ctx) => {
    if (!db.available) return ctx.skip();
    const windows = [{ id: "gemini-weekly", label: "Gemini weekly", used_pct: 62, resets: null }];
    await refreshHostUsage(db.pool, "host-1", "acp_antigravity_acp", "managed:1.4.3", registry({
      acp_antigravity_acp: { available: true, session_pct: null, session_resets: null, week_pct: 62, week_resets: null, error: null, windows },
    }));
    const cached = (await readHostUsage(db.pool, "host-1")).find(row => row.runtime_key === "acp_antigravity_acp");
    expect(cached?.quota.windows).toEqual(windows);
  });

  it("caches what the host answered, including a reason it could not answer", async (ctx) => {
    if (!db.available) return ctx.skip();
    const answered = await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 61, session_resets: "Resets soon", week_pct: 18, week_resets: null, error: null },
    }));

    expect(answered.quota).toMatchObject({ available: true, session_pct: 61, week_pct: 18 });
    const [cached] = await readHostUsage(db.pool, "host-1");
    expect(cached).toMatchObject({ runtime_key: "claude_code", installation: "own" });
    expect(cached!.quota.session_pct).toBe(61);
  });

  it("answers without a probe for a runtime that has no subscription to report", async (ctx) => {
    if (!db.available) return ctx.skip();
    let probed = false;
    const watching = {
      isOnline: () => true,
      requestUsageProbe: () => { probed = true; return Promise.resolve({} as never); },
    } as unknown as HostConnectionRegistry;

    const answered = await refreshHostUsage(db.pool, "host-1", "opencode", "own", watching);

    // OpenCode bills through whichever provider it is pointed at; launching it
    // to be told there is nothing to say is a CLI launch for no information.
    expect(probed).toBe(false);
    expect(answered.quota.available).toBe(false);
    expect(answered.quota.error).toMatch(/no subscription quota/);
  });

  it("sweeps only copies someone has logged into, on hosts that are actually connected", async (ctx) => {
    if (!db.available) return ctx.skip();
    const asked: string[] = [];
    const watching = {
      isOnline: () => true,
      requestUsageProbe: (_hostId: string, frame: { runtime_key: string; installation: string }) => {
        asked.push(`${frame.runtime_key}:${frame.installation}`);
        return Promise.resolve({
          available: true, session_pct: 5, session_resets: null, week_pct: null, week_resets: null, error: null,
        });
      },
    } as unknown as HostConnectionRegistry;

    const probed = await refreshAllHostUsage(db.pool, watching);

    // codex_cli reports `logged_in: false` and opencode has no quota, so the
    // only copy worth a round trip is Claude's.
    expect(asked).toEqual(["claude_code:own"]);
    expect(probed).toBe(1);
  });

  it("skips a host whose row says online but whose socket is gone", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect(await refreshAllHostUsage(db.pool, registry({}, false))).toBe(0);
    expect(await readHostUsage(db.pool, "host-1")).toEqual([]);
  });

  it("folds a Run's live reading into one window without blanking the other", async (ctx) => {
    if (!db.available) return ctx.skip();
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 10, session_resets: null, week_pct: 40, week_resets: "Resets later", error: null },
    }));

    await mergeRunQuota(db.pool, {
      hostId: "host-1",
      runtimeKey: "claude_code",
      installation: "own",
      quota: { rate_limit_type: "five_hour", utilization: 0.72, resets_at: 1_800_000_000 },
    });

    const [row] = await readHostUsage(db.pool, "host-1");
    expect(row!.quota.session_pct).toBe(72);
    // A partial reading must not erase what the last probe knew about the
    // other window.
    expect(row!.quota.week_pct).toBe(40);
    expect(row!.quota.week_resets).toBe("Resets later");
  });

  it("updates the overall week from an explicitly named seven-day reading", async (ctx) => {
    if (!db.available) return ctx.skip();
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 10, session_resets: "Resets soon", week_pct: 40, week_resets: null, error: null },
    }));

    await mergeRunQuota(db.pool, {
      hostId: "host-1", runtimeKey: "claude_code", installation: "own",
      quota: { rate_limit_type: "seven_day", utilization: 0.72, resets_at: 1_800_000_000 },
    });

    const [row] = await readHostUsage(db.pool, "host-1");
    expect(row!.quota).toMatchObject({
      session_pct: 10, session_resets: "Resets soon", week_pct: 72,
      week_resets: `Resets ${new Date(1_800_000_000_000).toISOString()}`,
    });
  });

  it.for(["seven_day_fable", "seven_day_sonnet", "seven_day_opus", "seven_day_oauth_apps", "weekly", "some_new_window"])(
    "does not overwrite the account reading or its freshness with %s", async (rateLimitType, ctx) => {
      if (!db.available) return ctx.skip();
      await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
        claude_code: { available: true, session_pct: 10, session_resets: null, week_pct: 40, week_resets: null, error: null },
      }));
      const [before] = await readHostUsage(db.pool, "host-1");

      await mergeRunQuota(db.pool, {
        hostId: "host-1",
        runtimeKey: "claude_code",
        installation: "own",
        quota: { rate_limit_type: rateLimitType, utilization: 0.99, resets_at: 1 },
      });

      const [row] = await readHostUsage(db.pool, "host-1");
      expect(row?.checked_at).toEqual(before?.checked_at);
      expect(row?.quota.session_pct).toEqual(before?.quota.session_pct);
      expect(row?.quota.week_pct).toEqual(before?.quota.week_pct);
      if (/^(five_hour|seven_day)_/.test(rateLimitType)) {
        expect(row?.quota.windows?.find(item => item.id === rateLimitType)?.used_pct).toBe(99);
      } else {
        expect(row).toEqual(before);
      }
    },
  );

  it("retains an unexpired live model reading when a refresh omits it", async (ctx) => {
    if (!db.available) return ctx.skip();
    await mergeRunQuota(db.pool, {
      hostId: "host-1", runtimeKey: "claude_code", installation: "own",
      quota: { rate_limit_type: "seven_day_fable", utilization: 0.8, resets_at: Date.now() / 1000 + 3600 },
    });
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({
      claude_code: { available: true, session_pct: 20, session_resets: null, week_pct: 40, week_resets: null, error: null },
    }));
    const [row] = await readHostUsage(db.pool, "host-1");
    expect(row?.quota.windows?.find(window => window.id === "seven_day_fable")?.used_pct).toBe(80);
    expect(row?.quota.week_pct).toBe(40);
  });

  it("does not create an overall reading from a model-specific week", async (ctx) => {
    if (!db.available) return ctx.skip();
    await mergeRunQuota(db.pool, {
      hostId: "host-1", runtimeKey: "claude_code", installation: "own",
      quota: { rate_limit_type: "seven_day_fable", utilization: 0.99, resets_at: 1_800_000_000 },
    });
    const [row] = await readHostUsage(db.pool, "host-1");
    expect(row?.quota).toMatchObject({ session_pct: null, week_pct: null });
    expect(row?.quota.windows?.[0]).toMatchObject({ id: "seven_day_fable", used_pct: 99 });
  });
});

describe("subscription account projection (real Postgres)", () => {
  const account = { provider: "anthropic" as const, product: "claude" as const, account_id: "a".repeat(64), organization_id: "b".repeat(64) };
  const quota = (session: number, identity: typeof account | null = account) => ({ available: true, account: identity, session_pct: session, session_resets: null, week_pct: null, week_resets: null, error: null });
  async function remote(id: string, owner = "user-1") {
    await db.pool.query(`INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,$1,'desktop',now(),now())`, [id, owner]);
    await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at)
      VALUES($1,$2,$1,$1,'remote','linux_native','online',$3::jsonb,now(),now(),now())`, [id, owner, JSON.stringify({ installations: { claude_code: [{ id: "own", logged_in: true, version: "1", options: null }] } })]);
  }
  it("deduplicates copies across visible Hosts and filters other owners before grouping", async ctx => {
    if (!db.available) return ctx.skip();
    await remote("visible-host");
    await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES('user-2','Other','active','other@test.invalid','system',now(),now())`);
    await remote("private-host", "user-2");
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: quota(10) }));
    await refreshHostUsage(db.pool, "visible-host", "claude_code", "own", registry({ claude_code: quota(20) }));
    await refreshHostUsage(db.pool, "private-host", "claude_code", "own", registry({ claude_code: quota(99) }));
    const admin = await readSubscriptionQuotaPools(db.pool, "user-1", true);
    expect(admin).toHaveLength(2); // The unchecked Codex installation stays independent.
    const shared = admin.find(pool => pool.account);
    expect(shared?.connections.map(item => item.host_id).sort()).toEqual(["host-1", "visible-host"]);
    expect(shared?.windows[0]?.used_pct).toBe(20);
    expect(JSON.stringify(admin)).not.toContain("private-host");
    const member = await readSubscriptionQuotaPools(db.pool, "user-1", false);
    expect(member).toHaveLength(1);
    expect(member[0]?.connections.map(item => item.host_id)).toEqual(["visible-host"]);
    expect(member[0]?.windows[0]?.used_pct).toBe(20);
  });
  it("does not merge unidentified copies or independent organizations", async ctx => {
    if (!db.available) return ctx.skip();
    await remote("visible-host");
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: quota(40, null) }));
    await refreshHostUsage(db.pool, "visible-host", "claude_code", "own", registry({ claude_code: quota(40, null) }));
    expect((await readSubscriptionQuotaPools(db.pool, "user-1", true)).filter(pool => pool.windows.length)).toHaveLength(2);
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: quota(40) }));
    await refreshHostUsage(db.pool, "visible-host", "claude_code", "own", registry({ claude_code: quota(40, { ...account, organization_id: "c".repeat(64) }) }));
    expect((await readSubscriptionQuotaPools(db.pool, "user-1", true)).filter(pool => pool.account)).toHaveLength(2);
  });
  it("groups Codex email identities across server and personal Host without merging workspaces or people", async ctx => {
    if (!db.available) return ctx.skip();
    await remote("visible-host");
    await db.pool.query(`UPDATE hosts SET capabilities_json = $1::jsonb WHERE id = 'visible-host'`,
      [JSON.stringify({ installations: { codex_cli: [{ id: "own", logged_in: true, version: "1", options: null }] } })]);
    await db.pool.query(`UPDATE hosts SET capabilities_json = jsonb_set(capabilities_json, '{installations,codex_cli,0,logged_in}', 'true') WHERE id = 'host-1'`);
    const identity = { provider: "openai" as const, product: "codex" as const, identity_kind: "email" as const,
      account_id: "d".repeat(64), organization_id: "e".repeat(64) };
    const reading = { ...quota(42), account: identity, account_display: { email: "person@example.test", workspace_name: "Personal" } };
    await refreshHostUsage(db.pool, "host-1", "codex_cli", "managed:2.0.0", registry({ codex_cli: reading }));
    await refreshHostUsage(db.pool, "visible-host", "codex_cli", "own", registry({ codex_cli: reading }));
    const pools = await readSubscriptionQuotaPools(db.pool, "user-1", true);
    const codex = pools.filter(pool => pool.account?.product === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]?.connections.map(item => item.host_id).sort()).toEqual(["host-1", "visible-host"]);
    expect(codex[0]?.windows[0]?.used_pct).toBe(42);
    expect(codex[0]?.account_display).toEqual(reading.account_display);
    expect((await readHostUsage(db.pool, "host-1")).find(row => row.runtime_key === "codex_cli")?.quota.account_display).toEqual(reading.account_display);
    expect(JSON.stringify(await readSubscriptionQuotaPools(db.pool, "other-viewer", false))).not.toContain("person@example.test");
    for (const other of [{ ...identity, organization_id: "f".repeat(64) }, { ...identity, account_id: "f".repeat(64) }]) {
      await refreshHostUsage(db.pool, "visible-host", "codex_cli", "own", registry({ codex_cli: { ...reading, account: other } }));
      expect((await readSubscriptionQuotaPools(db.pool, "user-1", true)).filter(pool => pool.account?.product === "codex")).toHaveLength(2);
    }
  });
  it("does not retain the previous account's model windows after a login switch", async ctx => {
    if (!db.available) return ctx.skip();
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: { ...quota(10), windows: [{ id: "seven_day_fable", label: "Fable weekly", used_pct: 99, resets: new Date(Date.now()+3600000).toISOString() }] } }));
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: quota(5, { ...account, account_id: "c".repeat(64) }) }));
    const pools = await readSubscriptionQuotaPools(db.pool, "user-1", true);
    expect(pools.find(pool => pool.account)?.windows.map(item => item.id)).toEqual(["session"]);
    await db.pool.query(`UPDATE hosts SET capabilities_json = jsonb_set(capabilities_json,'{installations,claude_code,0,logged_in}','false') WHERE id='host-1'`);
    expect((await readSubscriptionQuotaPools(db.pool, "user-1", true)).some(pool => pool.account)).toBe(false);
  });
  it("invalidates a slow probe when login starts instead of restoring the old account", async ctx => {
    if (!db.available) return ctx.skip();
    let answer!: (value: ReturnType<typeof quota>) => void;
    const pending = refreshHostUsage(db.pool, "host-1", "claude_code", "own", { requestUsageProbe: () => new Promise(resolve => { answer = resolve; }) } as unknown as HostConnectionRegistry);
    await invalidateHostUsage(db.pool, "host-1", "claude_code", "own");
    answer(quota(95));
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(await readHostUsage(db.pool, "host-1")).toEqual([]);
  });
  it("keeps each window's actual measurement time when a later Run updates only one", async ctx => {
    if (!db.available) return ctx.skip();
    await remote("visible-host");
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: { ...quota(10), week_pct: 80 } }));
    await refreshHostUsage(db.pool, "visible-host", "claude_code", "own", registry({ claude_code: { ...quota(20), week_pct: 30 } }));
    const old = new Date(Date.now() - 120000).toISOString();
    const newer = new Date(Date.now() - 60000).toISOString();
    await db.pool.query(`UPDATE host_runtime_usage SET checked_at=$1, quota_json=jsonb_set(quota_json,'{window_checked_at}',$2::jsonb) WHERE host_id='host-1'`, [old, JSON.stringify({ session: old, week: old })]);
    await db.pool.query(`UPDATE host_runtime_usage SET checked_at=$1, quota_json=jsonb_set(quota_json,'{window_checked_at}',$2::jsonb) WHERE host_id='visible-host'`, [newer, JSON.stringify({ session: newer, week: newer })]);
    await mergeRunQuota(db.pool, { hostId: "host-1", runtimeKey: "claude_code", installation: "own", quota: { rate_limit_type: "five_hour", utilization: 0.9, resets_at: Date.now()/1000+3600 } });
    const pooled = (await readSubscriptionQuotaPools(db.pool, "user-1", true)).find(item => item.account);
    expect(pooled?.windows.find(item => item.id === "session")?.used_pct).toBe(90);
    expect(pooled?.windows.find(item => item.id === "week")).toMatchObject({ used_pct: 30, checked_at: newer });
  });
  it("serves the account projection through current Host permissions, including the built-in admin gate", async ctx => {
    if (!db.available) return ctx.skip();
    await remote("visible-host");
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({ claude_code: quota(80) }));
    await refreshHostUsage(db.pool, "visible-host", "claude_code", "own", registry({ claude_code: quota(20) }));
    const email = (await db.pool.query<{email:string}>("SELECT email FROM users WHERE id='user-1'")).rows[0]!.email;
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: email }), [hostsModule]);
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/hosts/subscription-usage" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items.find((item: { account: unknown }) => item.account).connections).toHaveLength(2);
      __setAuthIdentityForTests({ spaceId: "space-1", userId: "non-owner" });
      const hidden = await app.inject({ method: "GET", url: "/api/v1/hosts/subscription-usage" });
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json()).toEqual({ items: [] });
    } finally { __setAuthIdentityForTests(null); await app.close(); }
  });
});

describe("host runtime change log (real Postgres)", () => {
  it("records what changed, newest first, with the host it changed on", async (ctx) => {
    if (!db.available) return ctx.skip();
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", runtimeKey: "codex_cli", action: "install",
      fromVersion: null, toVersion: "1.0.0", actorUserId: "user-1",
    });
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", runtimeKey: "codex_cli", action: "upgrade",
      fromVersion: "1.0.0", toVersion: "2.0.0", actorUserId: "user-1",
    });
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", runtimeKey: "codex_cli", action: "rollback",
      fromVersion: "2.0.0", toVersion: "1.0.0", actorUserId: null,
    });

    const changes = await listHostRuntimeChanges(db.pool, "user-1");

    expect(changes.map((change) => change.action)).toEqual(["rollback", "upgrade", "install"]);
    expect(changes[0]).toMatchObject({ host_name: "Server", from_version: "2.0.0", to_version: "1.0.0" });
  });

  it("keeps the record when the person who made the change is gone", async (ctx) => {
    if (!db.available) return ctx.skip();
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", runtimeKey: "claude_code", action: "upgrade",
      fromVersion: "1.0.0", toVersion: "2.0.0", actorUserId: "user-1",
    });
    await db.pool.query("DELETE FROM users WHERE id = 'user-1'");

    // The point of the log is answering "since when" long after the fact.
    const [change] = await listHostRuntimeChanges(db.pool, "user-1");
    expect(change).toMatchObject({ runtime_key: "claude_code", actor_user_id: null });
  });

  it("goes with the host it belongs to", async (ctx) => {
    if (!db.available) return ctx.skip();
    await recordHostRuntimeChange(db.pool, {
      hostId: "host-1", runtimeKey: "claude_code", action: "install",
      fromVersion: null, toVersion: "1.0.0", actorUserId: null,
    });
    await refreshHostUsage(db.pool, "host-1", "claude_code", "own", registry({}));
    await db.pool.query("DELETE FROM hosts WHERE id = 'host-1'");

    expect(await listHostRuntimeChanges(db.pool, "user-1")).toEqual([]);
    expect(await readHostUsage(db.pool, "host-1")).toEqual([]);
  });
});
