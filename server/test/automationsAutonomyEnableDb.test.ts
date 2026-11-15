import {AUTOMATION_FIRE_JOB} from '@rainver/protocol';
import {registerAutomationFireJob} from '../src/modules/automations/fireRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { AutomationService } from "../src/modules/automations/service.js";
import { operationTransaction } from "../src/db/operationTransaction.js";
import { updateSpaceRetrievalSettings } from "../src/modules/retrieval/settings.js";

/**
 * This route is how an `autonomous_tick` Automation is created. The generic
 * create endpoint rejects it (`user_selectable: false`), and nothing
 * provisions one automatically. Do not insert the row with SQL.
 * This suite proves the self-service activation path an ordinary Space
 * member (not owner/admin) actually reaches end to end.
 */
const SPACE = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const OTHER_MEMBER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const VERSION = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-07-26T12:00:00.000Z";

let app: FastifyInstance | undefined;

const db = useTestDatabase(import.meta.filename);

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
});

beforeAll(async () => {
  if (!db.available) return;
  app = buildServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), { logger: false });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["policy_decision_records", "spaces", "users"], { cascade: true });
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Member One', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Member Two', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [MEMBER, OTHER_MEMBER, NOW],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Space', 'team', $2, $3, $3)`,
    [SPACE, MEMBER, NOW],
  );
  // Deliberately 'member', not 'owner'/'admin'. An ordinary member can
  // self-service enable their own Always-on without elevated Space authority.
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4), ($5, $2, $6, 'member', 'active', $4, $4)`,
    [randomUUID(), SPACE, MEMBER, NOW, randomUUID(), OTHER_MEMBER],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Agent', 'active', NULL, 'private', $4, $4)`,
    [AGENT, SPACE, MEMBER, NOW],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       created_at
     ) VALUES (
       $1,
       $2,
       $3,
       'v1',
       'test',
       '{}'::jsonb,
       '{}'::jsonb,
       '[]'::jsonb,
       '{"allowed_tools":[]}'::jsonb,
       $4
     )`,
    [VERSION, AGENT, SPACE, NOW],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
});

describe("self-service Always-on activation (autonomous_tick)", () => {
  it.each(["raw", "branded"] as const)("rolls configuration archive and credential revocation back with its %s owner", async (kind) => {
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const enabled = await app!.inject({ method: "PUT", headers: { "idempotency-key": randomUUID() }, url: `/api/v1/spaces/${SPACE}/automations/autonomy`, payload: { agent_id: AGENT } });
    expect(enabled.statusCode).toBe(200);
    const id = enabled.json().data.id;
    const client = await db.pool.connect();
    const port = operationTransaction(client);
    try {
      await client.query("BEGIN");
      const owner = AutomationService.forConfigurationTransaction(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), kind === "branded" ? port.db : client);
      await owner.update({ spaceId: SPACE, automationId: id, actorUserId: MEMBER, body: { status: "archived" } });
      expect((await client.query("SELECT status FROM automation_credential_grants WHERE automation_id=$1", [id])).rows[0]?.status).toBe("revoked");
      expect((await client.query("SELECT status FROM scheduler_tasks WHERE task_type='automation' AND task_key=$1", [id])).rows[0]?.status).toBe("archived");
      await client.query("ROLLBACK");
      expect((await db.pool.query("SELECT status FROM automations WHERE id=$1", [id])).rows[0]?.status).toBe("active");
      expect((await db.pool.query("SELECT status FROM automation_credential_grants WHERE automation_id=$1", [id])).rows[0]?.status).toBe("active");
      expect((await db.pool.query("SELECT status FROM scheduler_tasks WHERE task_type='automation' AND task_key=$1", [id])).rows[0]?.status).toBe("active");
    } finally {
      await client.query("ROLLBACK");
      port.close();
      client.release();
    }
  });

  it("uses the configuration transaction's Context Ops settings rather than a second connection", async () => {
    await db.pool.query("UPDATE space_memberships SET role='owner' WHERE space_id=$1 AND user_id=$2", [SPACE, MEMBER]);
    const client = await db.pool.connect();
    const port = operationTransaction(client);
    try {
      await client.query("BEGIN");
      await updateSpaceRetrievalSettings(port.db, SPACE, { context_ops_review_mode: "admins" });
      const owner = AutomationService.forConfigurationTransaction(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), port.db);
      const row = await owner.create({
        spaceId: SPACE, ownerUserId: MEMBER,
        body: { agent_id: AGENT, name: "Review", config_json: { target_type: "context_ops_review_cycle", review_scope: "space_ops" } },
      });
      expect(row.preflight_snapshot_json?.executable).toBe(true);
      await client.query("ROLLBACK");
      expect((await db.pool.query("SELECT id FROM automations WHERE id=$1", [row.id])).rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      port.close();
      client.release();
    }
  });

  it("rolls REST enablement back when the mandatory audit fails at commit", async () => {
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    await db.pool.query(`CREATE FUNCTION refuse_automation_configuration_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='automation.create' AND COALESCE(NEW.metadata_json->>'operation_outcome','') <> 'failed' THEN
          RAISE EXCEPTION 'test deferred audit refusal';
        END IF;
        RETURN NEW;
      END $$`);
    await db.pool.query(`CREATE CONSTRAINT TRIGGER refuse_automation_configuration_audit
      AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION refuse_automation_configuration_audit()`);
    try {
      const response = await app!.inject({ method: "PUT", headers: { "idempotency-key": randomUUID() }, url: `/api/v1/spaces/${SPACE}/automations/autonomy`, payload: { agent_id: AGENT } });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      for (const table of ["automations", "automation_credential_grants", "scheduler_tasks"]) {
        expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toHaveLength(0);
      }
      const audits = (await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE action='automation.create' AND actor_id=$1", [MEMBER])).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata_json.operation_outcome).toBe("failed");
    } finally {
      await db.pool.query("DROP TRIGGER refuse_automation_configuration_audit ON policy_decision_records");
      await db.pool.query("DROP FUNCTION refuse_automation_configuration_audit()");
    }
  });

  it.each(["raw", "branded"] as const)("keeps enablement, grant, schedule and policy audit in the %s outer transaction", async (kind) => {
    const client = await db.pool.connect();
    const port = operationTransaction(client);
    try {
      await client.query("BEGIN");
      const transaction = kind === "branded" ? port.db : client;
      const owner = AutomationService.forConfigurationTransaction(
        loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), transaction,
      );
      const row = await owner.enableAutonomy({ spaceId: SPACE, actorUserId: MEMBER, body: { agent_id: AGENT } });
      expect((await client.query("SELECT id FROM automation_credential_grants WHERE automation_id=$1 AND status='active'", [row.id])).rows).toHaveLength(1);
      expect((await client.query("SELECT id FROM scheduler_tasks WHERE task_type='automation' AND task_key=$1", [row.id])).rows).toHaveLength(1);
      expect((await client.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND actor_id=$2 AND action='automation.create' AND decision='allow'", [SPACE, MEMBER])).rows).toHaveLength(1);
      expect((await db.pool.query("SELECT id FROM automations WHERE id=$1", [row.id])).rows).toHaveLength(0);
      await client.query("ROLLBACK");
      for (const table of ["automations", "automation_credential_grants", "scheduler_tasks", "policy_decision_records"]) {
        expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toHaveLength(0);
      }
    } finally {
      await client.query("ROLLBACK");
      port.close();
      client.release();
    }
  });

  it("lets an ordinary member enable, read back, and idempotently reconfigure their own tick", async (ctx) => {
    if (!db.available || !db.pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });

    const missing = await app!.inject({
      method: "GET",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
    });
    expect(missing.statusCode).toBe(404);

    const enabled = await app!.inject({
      method: "PUT", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    expect(enabled.statusCode).toBe(200);
    const body = enabled.json().data;
    expect(body.owner_user_id).toBe(MEMBER);
    expect(body.config_json).toMatchObject({
      target_type: "autonomous_tick",
      observe_only: true,
      cron: "0 * * * *",
    });
    const automationId = body.id as string;

    const grant = await db.pool.query(
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
      method: "PUT", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT, project_ids: ["some-project-id-placeholder"] },
    });
    expect(reconfigured.statusCode).toBe(200);
    expect(reconfigured.json().data.id).toBe(automationId);

    const rows = await db.pool.query(
      `SELECT count(*)::int AS total FROM automations
        WHERE space_id = $1 AND owner_user_id = $2
          AND config_json->>'target_type' = 'autonomous_tick'`,
      [SPACE, MEMBER],
    );
    expect(rows.rows[0]?.total).toBe(1);
  });

  it("scopes Always-on strictly per member: another member sees none and cannot manage it", async (ctx) => {
    if (!db.available || !db.pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const enabled = await app!.inject({
      method: "PUT", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    const automationId = enabled.json().data.id as string;

    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER_MEMBER });
    const otherRead = await app!.inject({
      method: "GET",
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
    });
    expect(otherRead.statusCode).toBe(404);

    // A plain member (not admin/owner, not the tick's own owner) must not be
    // able to reconfigure or manually fire someone else's tick — it is absent
    // to them.
    const otherUpdate = await app!.inject({
      method: "PATCH", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}`,
      payload: { status: "paused" },
    });
    expect(otherUpdate.statusCode).toBe(404);

    const otherFire = await app!.inject({
      method: "POST",headers:{'idempotency-key':randomUUID()},
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}/fire`,
      payload: {},
    });
    expect(otherFire.statusCode).toBe(404);
  });

  it("reaches the autonomy dispatch end to end when the owner fires their own tick", async (ctx) => {
    if (!db.available || !db.pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const enabled = await app!.inject({
      method: "PUT", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    const automationId = enabled.json().data.id as string;

    const fired = await app!.inject({
      method: "POST",headers:{'idempotency-key':randomUUID()},
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}/fire`,
      payload: {},
    });
    expect(fired.statusCode,fired.body).toBe(202);
    const handlers=new JobHandlerRegistry();
    registerAutomationFireJob(handlers,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
    expect(await new JobWorker(new PgJobQueueRepository(db.pool),handlers,'autonomy-fire-test',[AUTOMATION_FIRE_JOB]).processOne()).toMatchObject({status:'completed'});
    const result=await app.inject({method:'GET',url:`/api/v1/spaces/${SPACE}/automations/${automationId}/fire-requests/${fired.json().data.job_id}`});
    expect(result.json()).toMatchObject({outcome:'completed',result:{ mode: "observe_only", status: "succeeded" }});

    const ticks = await db.pool.query(
      `SELECT owner_user_id, mode, status FROM autonomy_ticks WHERE space_id = $1`,
      [SPACE],
    );
    expect(ticks.rows).toEqual([{ owner_user_id: MEMBER, mode: "observe_only", status: "succeeded" }]);
  });

  it("lets the owner pause and archive a tick whose Agent can no longer run it", async (ctx) => {
    if (!db.available || !db.pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const enabled = await app!.inject({
      method: "PUT", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT },
    });
    const automationId = enabled.json().data.id as string;
    // The tick now fails every fire. Stopping it must not depend on it being
    // runnable, or the only way out of a failing schedule is closed.
    await db.pool.query(`UPDATE agents SET status = 'archived' WHERE id = $1`, [AGENT]);

    const paused = await app!.inject({
      method: "PATCH", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}`,
      payload: { status: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().data).toMatchObject({ status: "paused" });

    // Turning it back on is where runnability is checked.
    const resumed = await app!.inject({
      method: "PATCH", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}`,
      payload: { status: "active" },
    });
    expect(resumed.statusCode).toBe(422);

    const archived = await app!.inject({
      method: "PATCH", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/${automationId}`,
      payload: { status: "archived" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data).toMatchObject({ status: "archived" });
  });

  it("requires a complete autonomy_budget before enabling launch mode", async (ctx) => {
    if (!db.available || !db.pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });

    const missingBudget = await app!.inject({
      method: "PUT", headers: { "idempotency-key": randomUUID() },
      url: `/api/v1/spaces/${SPACE}/automations/autonomy`,
      payload: { agent_id: AGENT, observe_only: false },
    });
    expect(missingBudget.statusCode).toBe(422);

    const withBudget = await app!.inject({
      method: "PUT", headers: { "idempotency-key": randomUUID() },
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
    expect(withBudget.json().data.config_json).toMatchObject({ observe_only: false });
  });
});
