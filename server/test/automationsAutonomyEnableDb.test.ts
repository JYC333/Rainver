import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { __setAuthIdentityForTests } from "../src/modules/auth";

/**
 * Before this route existed, no code path anywhere could create an
 * `autonomous_tick` Automation: the generic create endpoint rejects it
 * (`user_selectable: false`), and nothing provisioned one automatically. The
 * Phase 3-5 autonomy lifecycle was fully implemented and covered by
 * `autonomyLaunchDb.test.ts`, but only reachable by inserting the Automation
 * row directly via SQL in a test — never by any real user or admin action.
 * This suite proves the self-service activation path an ordinary Space
 * member (not owner/admin) actually reaches end to end.
 */
const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const OTHER_MEMBER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const VERSION = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-07-26T12:00:00.000Z";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
    app = buildServer(loadConfig({ SERVER_DATABASE_URL: database.getConnectionUri() }), { logger: false });
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[automations-autonomy-enable-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE spaces, users CASCADE");
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Member One', 'active', $3, $3), ($2, 'Member Two', 'active', $3, $3)`,
    [MEMBER, OTHER_MEMBER, NOW],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Space', 'team', $2, $3, $3)`,
    [SPACE, MEMBER, NOW],
  );
  // Deliberately 'member', not 'owner'/'admin' — the whole point of this
  // suite is proving an ordinary member can self-service enable their own
  // Always-on without elevated Space authority.
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4), ($5, $2, $6, 'member', 'active', $4, $4)`,
    [randomUUID(), SPACE, MEMBER, NOW, randomUUID(), OTHER_MEMBER],
  );
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Agent', 'active', NULL, 'private', $4, $4)`,
    [AGENT, SPACE, MEMBER, NOW],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb, '[]'::jsonb, '{"allowed_tools":[]}'::jsonb, '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, NOW],
  );
  await pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
});

describe("self-service Always-on activation (autonomous_tick)", () => {
  it("lets an ordinary member enable, read back, and idempotently reconfigure their own tick", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });

    const missing = await app!.inject({
      method: "GET",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
    });
    expect(missing.statusCode).toBe(404);

    const enabled = await app!.inject({
      method: "PUT",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    expect(enabled.statusCode).toBe(200);
    const body = enabled.json();
    expect(body.owner_user_id).toBe(MEMBER);
    expect(body.config_json).toMatchObject({
      target_type: "autonomous_tick",
      observe_only: true,
      cron: "0 * * * *",
    });
    const automationId = body.id as string;

    const grant = await pool!.query(
      `SELECT status FROM automation_credential_grants WHERE automation_id = $1`,
      [automationId],
    );
    expect(grant.rows).toEqual([{ status: "active" }]);

    const read = await app!.inject({
      method: "GET",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().id).toBe(automationId);

    // Re-enabling with a different config must reconfigure the same row, not
    // create a second one — Always-on is a per-(space, owner) singleton.
    const reconfigured = await app!.inject({
      method: "PUT",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT, project_ids: ["some-project-id-placeholder"] },
    });
    expect(reconfigured.statusCode).toBe(200);
    expect(reconfigured.json().id).toBe(automationId);

    const rows = await pool!.query(
      `SELECT count(*)::int AS total FROM automations
        WHERE space_id = $1 AND owner_user_id = $2
          AND config_json->>'target_type' = 'autonomous_tick'`,
      [SPACE, MEMBER],
    );
    expect(rows.rows[0]?.total).toBe(1);
  });

  it("scopes Always-on strictly per member: another member sees none and cannot manage it", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const enabled = await app!.inject({
      method: "PUT",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    const automationId = enabled.json().id as string;

    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER_MEMBER });
    const otherRead = await app!.inject({
      method: "GET",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
    });
    expect(otherRead.statusCode).toBe(404);

    // A plain member (not admin/owner, not the tick's own owner) must not be
    // able to reconfigure or manually fire someone else's tick.
    const otherUpdate = await app!.inject({
      method: "PATCH",
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}`,
      payload: { status: "paused" },
    });
    expect(otherUpdate.statusCode).toBe(403);

    const otherFire = await app!.inject({
      method: "POST",
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}/fire`,
      payload: {},
    });
    expect(otherFire.statusCode).toBe(403);
  });

  it("reaches the autonomy dispatch end to end when the owner fires their own tick", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const enabled = await app!.inject({
      method: "PUT",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    const automationId = enabled.json().id as string;

    const fired = await app!.inject({
      method: "POST",
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}/fire`,
      payload: {},
    });
    expect(fired.statusCode).toBe(200);
    expect(fired.json()).toMatchObject({ mode: "observe_only", status: "succeeded" });

    const ticks = await pool!.query(
      `SELECT owner_user_id, mode, status FROM autonomy_ticks WHERE space_id = $1`,
      [SPACE],
    );
    expect(ticks.rows).toEqual([{ owner_user_id: MEMBER, mode: "observe_only", status: "succeeded" }]);
  });

  it("requires a complete autonomy_budget before enabling launch mode", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });

    const missingBudget = await app!.inject({
      method: "PUT",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT, observe_only: false },
    });
    expect(missingBudget.statusCode).toBe(422);

    const withBudget = await app!.inject({
      method: "PUT",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: {
        agent_id: AGENT,
        observe_only: false,
        autonomy_budget: {
          daily_run_limit: 5,
          max_subscription_utilization_pct: 80,
          quota_max_age_seconds: 3_600,
        },
      },
    });
    expect(withBudget.statusCode).toBe(200);
    expect(withBudget.json().config_json).toMatchObject({ observe_only: false });
  });
});
