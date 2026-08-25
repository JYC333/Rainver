import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ServerConfig } from "../src/config";
import { resolveProviderCommandStore } from "../src/modules/providers/commands/store";
import {
  __setManagedSubscriptionFetchForTests,
  __setManagedSubscriptionOAuthForTests,
  loginManagedSubscription,
  refreshManagedSubscriptionQuota,
} from "../src/modules/providers/subscriptionOAuth";
import {
  getTestPostgres,
  isTestPostgresUnavailableError,
  type TestPostgresDatabase,
} from "./support/sharedPostgres";

const SPACE = "7b000000-0000-4000-8000-000000000001";
const OWNER = "7b000000-0000-4000-8000-000000000002";
const OTHER = "7b000000-0000-4000-8000-000000000003";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let agentSpaceHome: string | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 5 });
    agentSpaceHome = await mkdtemp(join(tmpdir(), "aspace-managed-subscription-"));
    await pool.query(
      `INSERT INTO spaces (id,name,type,created_at,updated_at)
       VALUES ($1,'Managed subscription','personal',now(),now())`,
      [SPACE],
    );
    await pool.query(
      `INSERT INTO users (id,display_name,status,created_at,updated_at)
       VALUES ($1,'Owner','active',now(),now()),($2,'Other','active',now(),now())`,
      [OWNER, OTHER],
    );
    await pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',now(),now()),
              ($4,$2,$5,'member','active',now(),now())`,
      [randomUUID(), SPACE, OWNER, randomUUID(), OTHER],
    );
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[managed-subscription-oauth-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setManagedSubscriptionOAuthForTests(null);
  __setManagedSubscriptionFetchForTests(null);
  await pool?.end();
  await database?.stop();
  if (agentSpaceHome) await rm(agentSpaceHome, { recursive: true, force: true });
});

describe("managed subscription OAuth persistence", () => {
  it("keeps Codex tokens encrypted, owner-bound, and refreshes once under a row lock", async () => {
    if (!available || !pool || !database || !agentSpaceHome) return;
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
      databaseUrl: database.getConnectionUri(),
      agentSpaceHome,
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

    const stored = await pool.query<{ secret_ref: string; credential_type: string }>(
      `SELECT c.secret_ref,c.credential_type
         FROM credentials c JOIN model_providers p ON p.credential_id=c.id
        WHERE p.id=$1`,
      [provider.id],
    );
    expect(stored.rows[0]?.credential_type).toBe("subscription_oauth");
    expect(stored.rows[0]?.secret_ref).toMatch(/^model_provider_oauth:v1:/);
    expect(stored.rows[0]?.secret_ref).not.toContain("codex-login-access-secret");
    const poolMembers = await pool.query(
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
