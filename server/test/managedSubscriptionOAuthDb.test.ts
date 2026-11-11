import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import {
  __setManagedSubscriptionFetchForTests,
  __setManagedSubscriptionOAuthForTests,
  __setManagedSubscriptionRefreshClockForTests,
  loginManagedSubscription,
  refreshManagedSubscriptionQuota,
  resolveManagedSubscriptionCredential,
} from "../src/modules/providers/subscriptionOAuth.js";
import { getDbPool } from "../src/db/pool.js";
import type { ManagedOAuthCredential } from "../src/modules/providers/managedOAuth.js";
import { useTestDatabase } from "./support/testDatabase.js";

const SPACE = "7b000000-0000-4000-8000-000000000001";
const OWNER = "7b000000-0000-4000-8000-000000000002";
const OTHER = "7b000000-0000-4000-8000-000000000003";

let rainverHome: string | undefined;

const db = useTestDatabase(import.meta.filename, { max: 5 });

beforeAll(async () => {
  if (!db.available) return;
  rainverHome = await mkdtemp(join(tmpdir(), "rainver-managed-subscription-"));
  await db.pool.query(
    `INSERT INTO spaces (id,name,type,created_at,updated_at)
     VALUES ($1,'Managed subscription','personal',now(),now())`,
    [SPACE],
  );
  await db.pool.query(
    `INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source)
     VALUES ($1,'Owner','active',now(),now(), 'managed-owner@test.invalid', 'system'),($2,'Other','active',now(),now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OWNER, OTHER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,'owner','active',now(),now()),
            ($4,$2,$5,'member','active',now(),now())`,
    [randomUUID(), SPACE, OWNER, randomUUID(), OTHER],
  );
}, 180_000);

afterAll(async () => {
  __setManagedSubscriptionOAuthForTests(null);
  __setManagedSubscriptionFetchForTests(null);
  if (rainverHome) await rm(rainverHome, { recursive: true, force: true });
});

describe("provider command responses", () => {
  it("answers create and update with the key and ownership state the list shows", async () => {
    if (!db.available || !rainverHome) return;
    const store = resolveProviderCommandStore({ databaseUrl: db.connectionUri, rainverHome } as ServerConfig);
    const created = await store.createProvider(SPACE, OWNER, {
      name: "Keyed provider",
      provider_type: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test-key",
    }) as Record<string, unknown>;
    expect(created).toMatchObject({ has_api_key: true, manageable: true });

    const renamed = await store.updateProvider(SPACE, OWNER, String(created.id), { name: "Renamed" }) as Record<string, unknown>;
    expect(renamed).toMatchObject({ name: "Renamed", has_api_key: true, manageable: true });
    expect(renamed.grant_id).toBeTruthy();
  });
});

describe("managed subscription OAuth persistence", () => {
  it("keeps Codex tokens encrypted, owner-bound, and refreshes once under a row lock", async () => {
    if (!db.available || !rainverHome) return;
    let refreshes = 0;
    __setManagedSubscriptionOAuthForTests(async () => ({
      async login() {
        return {
          type: "oauth",
          access: "codex-login-access-secret",
          refresh: "codex-login-refresh-secret",
          expires: Date.now() - 1,
          accountId: "chatgpt-account-1",
        };
      },
      async refresh(credential) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ...credential,
          access: "codex-refreshed-access-secret",
          refresh: "codex-refreshed-refresh-secret",
          expires: Date.now() + 3_600_000,
        };
      },
    }));
    __setManagedSubscriptionFetchForTests(async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 34, limit_window_seconds: 604_800 },
      },
    }), { status: 200 }));

    const config = {
      databaseUrl: db.connectionUri,
      rainverHome,
      instanceAdminEmail: "managed-owner@test.invalid",
    } as ServerConfig;
    const provider = await loginManagedSubscription(
      config,
      "openai_codex",
      SPACE,
      OWNER,
      { signal: new AbortController().signal, notify() {}, async prompt() { return "device_code"; } },
    );
    expect(provider).toMatchObject({
      provider_type: "openai_codex",
      has_api_key: false,
      has_subscription: true,
      subscription_type: "openai_codex",
    });

    const stored = await db.pool.query<{ secret_ref: string; credential_type: string }>(
      `SELECT c.secret_ref,c.credential_type
         FROM credentials c JOIN model_providers p ON p.credential_id=c.id
        WHERE p.id=$1`,
      [provider.id],
    );
    expect(stored.rows[0]?.credential_type).toBe("subscription_oauth");
    expect(stored.rows[0]?.secret_ref).toMatch(/^model_provider_oauth:v1:/);
    expect(stored.rows[0]?.secret_ref).not.toContain("codex-login-access-secret");
    const poolMembers = await db.pool.query(
      `SELECT id FROM model_provider_credentials WHERE provider_id=$1`,
      [provider.id],
    );
    expect(poolMembers.rowCount).toBe(0);

    const store = resolveProviderCommandStore(config);
    const renamed = await store.updateProvider(SPACE, OWNER, String(provider.id), {
      name: "Renamed Codex subscription",
    }) as Record<string, unknown>;
    expect(renamed.name).toBe("Renamed Codex subscription");
    await expect(store.listPool(SPACE, String(provider.id)))
      .rejects.toThrow(/do not support credential pools/i);
    await expect(store.getInvocationTarget(SPACE, String(provider.id), OTHER))
      .rejects.toMatchObject({ statusCode: 403 });

    let unauthorizedProbeCalls = 0;
    __setManagedSubscriptionFetchForTests(async () => {
      unauthorizedProbeCalls += 1;
      return new Response("{}", { status: 200 });
    });
    await expect(refreshManagedSubscriptionQuota(config, SPACE, OTHER, String(provider.id)))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(unauthorizedProbeCalls).toBe(0);

    const [first, second] = await Promise.all([
      store.getInvocationTarget(SPACE, String(provider.id), OWNER),
      store.getInvocationTarget(SPACE, String(provider.id), OWNER),
    ]);
    expect(refreshes).toBe(1);
    expect(first.candidates[0]).toMatchObject({
      api_key: "codex-refreshed-access-secret",
      credential_kind: "subscription_oauth",
    });
    expect(second.candidates[0]?.api_key).toBe("codex-refreshed-access-secret");
  });
});

const ADMIN_EMAIL = "managed-owner@test.invalid";
const interaction = { signal: new AbortController().signal, notify() {}, async prompt() { return "device_code"; } };

/**
 * A local stand-in for a vendor that rotates refresh tokens: a refresh spends
 * the token it is given (a second use is refused, as reuse detection would)
 * and issues a new one. No real account or network is involved.
 */
function rotatingVendor(options: { duringRefresh?: () => Promise<void>; failAfterRotation?: boolean } = {}) {
  const valid = new Set<string>(["rotating-refresh-0"]);
  const sent: string[] = [];
  let issued = 0;
  return {
    valid, sent,
    flow: {
      async login(): Promise<ManagedOAuthCredential> {
        return { type: "oauth", access: "rotating-access-0", refresh: "rotating-refresh-0", expires: Date.now() - 1, accountId: "acct" };
      },
      async refresh(credential: ManagedOAuthCredential): Promise<ManagedOAuthCredential> {
        sent.push(credential.refresh);
        if (!valid.has(credential.refresh)) throw new Error("OpenAI Codex token refresh failed (400): invalid_grant");
        valid.delete(credential.refresh);
        issued += 1;
        valid.add(`rotating-refresh-${issued}`);
        await options.duringRefresh?.();
        if (options.failAfterRotation) throw new Error("OpenAI Codex token refresh error: socket hang up");
        return { ...credential, access: `rotating-access-${issued}`, refresh: `rotating-refresh-${issued}`, expires: Date.now() + 3_600_000 };
      },
    },
  };
}
const adminConfig = () => ({ databaseUrl: db.connectionUri, rainverHome, instanceAdminEmail: ADMIN_EMAIL } as ServerConfig);
async function connect(vendor: ReturnType<typeof rotatingVendor>) {
  __setManagedSubscriptionOAuthForTests(async () => vendor.flow);
  __setManagedSubscriptionFetchForTests(async () => new Response("{}", { status: 500 }));
  return loginManagedSubscription(adminConfig(), "openai_codex", SPACE, OWNER, interaction);
}
const refreshState = async (providerId: string) => (await db.pool.query<{ state: Record<string, unknown> | null; secret_ref: string }>(
  `SELECT c.metadata_json->'oauth_refresh' AS state,c.secret_ref FROM credentials c JOIN model_providers p ON p.credential_id=c.id WHERE p.id=$1`, [providerId])).rows[0]!;

describe("managed subscription OAuth refresh is a once-only credential step", () => {
  afterEach(() => __setManagedSubscriptionRefreshClockForTests(null));

  it("calls the vendor outside every transaction and leaves no token in the refresh record", async () => {
    if (!db.available || !rainverHome) return;
    let locksDuringCall = -1;
    let rowFreeDuringCall = false;
    const vendor = rotatingVendor({
      async duringRefresh() {
        locksDuringCall = Number((await db.pool.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          WHERE c.relname='credentials' AND l.pid<>pg_backend_pid()`)).rows[0].n);
        const probe = await db.pool.connect();
        try {
          await probe.query("BEGIN");
          rowFreeDuringCall = (await probe.query(`SELECT 1 FROM credentials WHERE credential_type='subscription_oauth' FOR UPDATE NOWAIT`)).rowCount! > 0;
          const state = (await probe.query(`SELECT metadata_json->'oauth_refresh' AS s, metadata_json::text AS t FROM credentials WHERE credential_type='subscription_oauth'`)).rows[0];
          expect(state.s).toMatchObject({ state: "in_flight", from: expect.stringMatching(/^hmac-sha256:/) });
          expect(state.t).not.toContain("rotating-refresh-0");
          await probe.query("ROLLBACK");
        } finally { probe.release(); }
      },
    });
    const provider = await connect(vendor);
    const resolved = await resolveManagedSubscriptionCredential(adminConfig(), getDbPool(db.connectionUri), SPACE, String(provider.id), OWNER);
    expect(resolved.credential.refresh).toBe("rotating-refresh-1");
    expect(locksDuringCall).toBe(0);
    expect(rowFreeDuringCall).toBe(true);
    expect((await refreshState(String(provider.id))).state).toBeNull();
    expect(vendor.sent).toEqual(["rotating-refresh-0"]);
  });

  it("never re-sends a spent token after a real database disconnect between rotation and the local commit", async () => {
    if (!db.available || !rainverHome) return;
    const holder = await db.pool.connect();
    let killer: Promise<void> | undefined;
    const vendor = rotatingVendor({
      async duringRefresh() {
        // Hold the row so the settle transaction waits on it, then terminate that backend.
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM credentials WHERE credential_type='subscription_oauth' FOR UPDATE`);
        killer = (async () => {
          for (let i = 0; i < 200; i += 1) {
            const waiting = (await db.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%oauth_refresh%'`)).rows;
            if (waiting.length) { for (const w of waiting) await db.pool.query("SELECT pg_terminate_backend($1)", [w.pid]); return; }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("settle never waited");
        })();
      },
    });
    const provider = await connect(vendor);
    const pool = getDbPool(db.connectionUri);
    try {
      await expect(resolveManagedSubscriptionCredential(adminConfig(), pool, SPACE, String(provider.id), OWNER)).rejects.toThrow();
      await killer;
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    // The vendor rotated; the local commit never happened. The intent survives.
    expect(vendor.valid.has("rotating-refresh-0")).toBe(false);
    expect((await refreshState(String(provider.id))).state).toMatchObject({ state: "in_flight" });
    // Once its lease ran out the outcome is unknown: refused, never re-sent (concurrent waiting is the first suite's case).
    __setManagedSubscriptionRefreshClockForTests(() => Date.now() + 120_000);
    await expect(resolveManagedSubscriptionCredential(adminConfig(), pool, SPACE, String(provider.id), OWNER))
      .rejects.toMatchObject({ code: "subscription_reconnect_required" });
    await expect(resolveManagedSubscriptionCredential(adminConfig(), pool, SPACE, String(provider.id), OWNER))
      .rejects.toMatchObject({ code: "subscription_reconnect_required" });
    expect((await refreshState(String(provider.id))).state).toMatchObject({ state: "unknown" });
    expect(vendor.sent).toEqual(["rotating-refresh-0"]);
    // A new login replaces the credential and clears the unknown state.
    __setManagedSubscriptionRefreshClockForTests(null);
    const relogin = rotatingVendor();
    await connect(relogin);
    expect((await refreshState(String(provider.id))).state).toBeNull();
  });

  it("treats a vendor call that ended without a definite refusal as unknown, and a refusal as nothing rotated", async () => {
    if (!db.available || !rainverHome) return;
    const lost = rotatingVendor({ failAfterRotation: true });
    const provider = await connect(lost);
    const pool = getDbPool(db.connectionUri);
    await expect(resolveManagedSubscriptionCredential(adminConfig(), pool, SPACE, String(provider.id), OWNER))
      .rejects.toMatchObject({ code: "subscription_reconnect_required" });
    await expect(resolveManagedSubscriptionCredential(adminConfig(), pool, SPACE, String(provider.id), OWNER))
      .rejects.toMatchObject({ code: "subscription_reconnect_required" });
    expect(lost.sent).toEqual(["rotating-refresh-0"]);
    // A refusal: the vendor answered, so the token was not spent by this attempt and nothing is left pending.
    const refusing = rotatingVendor();
    refusing.valid.clear();
    await connect(refusing);
    await expect(resolveManagedSubscriptionCredential(adminConfig(), pool, SPACE, String(provider.id), OWNER)).rejects.toThrow(/invalid_grant/);
    expect((await refreshState(String(provider.id))).state).toBeNull();
  });
});

describe("managed subscription login writes only under the authority it still has", () => {
  async function waitingLogin(revoke: (userId: string, spaceId: string) => Promise<void>) {
    const space = randomUUID(), user = randomUUID(), email = `${user}@test.invalid`;
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Login','personal',now(),now())`, [space]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Admin','active',now(),now(),$2,'system')`, [user, email]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES (gen_random_uuid(),$1,$2,'owner','active',now(),now())`, [space, user]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    __setManagedSubscriptionOAuthForTests(async () => ({
      async login() { await gate; return { type: "oauth", access: "late-access", refresh: "late-refresh", expires: Date.now() + 3_600_000, accountId: "acct" }; },
      async refresh(c) { return c; },
    }));
    __setManagedSubscriptionFetchForTests(async () => new Response("{}", { status: 500 }));
    const login = loginManagedSubscription({ databaseUrl: db.connectionUri, rainverHome, instanceAdminEmail: email } as ServerConfig, "openai_codex", space, user, interaction);
    await revoke(user, space);
    release();
    await expect(login).rejects.toMatchObject({ statusCode: 404 });
    const written = await db.pool.query(`SELECT (SELECT count(*)::int FROM model_providers WHERE owner_user_id=$1) AS p,
      (SELECT count(*)::int FROM credentials WHERE owner_user_id=$1) AS c,
      (SELECT count(*)::int FROM model_provider_space_grants WHERE owner_user_id=$1) AS g`, [user]);
    expect(written.rows[0]).toEqual({ p: 0, c: 0, g: 0 });
  }

  it("writes nothing when the person was disabled while the login waited", async () => {
    if (!db.available || !rainverHome) return;
    await waitingLogin((user) => db.pool.query(`UPDATE users SET status='disabled' WHERE id=$1`, [user]).then(() => undefined));
  });
  it("writes nothing when the Space membership was removed while the login waited", async () => {
    if (!db.available || !rainverHome) return;
    await waitingLogin((user, space) => db.pool.query(`UPDATE space_memberships SET status='removed' WHERE user_id=$1 AND space_id=$2`, [user, space]).then(() => undefined));
  });
  it("writes nothing when instance administration was withdrawn while the login waited", async () => {
    if (!db.available || !rainverHome) return;
    await waitingLogin((user) => db.pool.query(`UPDATE users SET email=$2 WHERE id=$1`, [user, `former-${user}@test.invalid`]).then(() => undefined));
  });
});
