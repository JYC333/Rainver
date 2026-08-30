import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { runsModule } from "../src/modules/runs/index.js";
import { PgRunToolIdentityRepository } from "../src/modules/runs/runToolIdentityRepository.js";
import { dispatchToolAllowance } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

/**
 * The REST surface a dispatched agent reaches Rainver through.
 *
 * Against a real database because the identity it authenticates with is a row:
 * a stub would prove the route reads *something*, not that the token, its Run
 * binding, its expiry and its revocation are the thing standing between an
 * agent and someone else's Run.
 */

const SPACE = "61111111-1111-4111-8111-111111111111";
const USER = "6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "6ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "6ddddddd-dddd-4ddd-8ddd-dddddddddddd";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule]);
});

afterAll(async () => {
  await app?.close();
});

async function makeRun(runId: string, status = "running"): Promise<void> {
  const allowance = dispatchToolAllowance("trusted_host");
  const grants = await buildRunToolGrants([...allowance], { allowed_tools: [...allowance] });
  await db.pool!.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type,
       trigger_origin, status, mode, owner_user_id, instructed_by_user_id,
       capabilities_json, permission_snapshot_json, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'trusted_host', 'system', 'manual', $6, 'live', $7, $7,
       $8::jsonb, $9::jsonb, now(), now())`,
    [
      runId, SPACE, AGENT, VERSION, PROJECT, status, USER,
      JSON.stringify([...allowance]),
      JSON.stringify({ tool_grants: grants, scenario_tool_allowance: [...allowance] }),
    ],
  );
}

function get(runId: string, path: string, token: string | null) {
  return app!.inject({
    method: "GET",
    url: `/internal/runs/${runId}/${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool!,
    ["run_tool_identities", "runs", "actors", "agent_versions", "agents", "projects",
      "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool!.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now())`, [USER],
  );
  await db.pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Tool Surface Space', 'household', $2, now(), now())`, [SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`, [randomUUID(), SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Tool Surface Project', 'active', now(), now())`, [PROJECT, SPACE, USER],
  );
  await seedMainlineRoomsForAllProjects(db.pool!);
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Worker', 'active', 'standard', 'private', now(), now())`, [AGENT, SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, model_config_json, runtime_config_json,
       context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', '{}', '{}', '{}', '{}', '[]', '{}', '{}', now())`,
    [VERSION, AGENT, SPACE],
  );
  await db.pool!.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
});

describe("the Run tool surface", () => {
  it("lists exactly the actions the Run was granted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const response = await get(run, "tools", token);

    expect(response.statusCode).toBe(200);
    const names = (response.json() as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["task.list", "task.report", "artifact.submit"]));
    expect(names).not.toContain("memory.remember");
  });

  it("describes one action with the schema its input is validated against", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const response = await get(run, "tools/artifact.submit", token);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; input_schema: { required?: string[] } };
    expect(body.name).toBe("artifact.submit");
    expect(body.input_schema.required).toEqual(
      expect.arrayContaining(["task_id", "path", "artifact_type"]),
    );
  });

  it("answers 404 for an action this Run was not granted, without confirming it exists", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const granted = await get(run, "tools/memory.remember", token);
    const invented = await get(run, "tools/not.an.action", token);

    expect(granted.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);
    // Identical but for the name the caller itself sent: a real action this Run
    // does not hold and a name nobody registered are indistinguishable, so the
    // surface never confirms what exists elsewhere.
    const shape = (body: unknown, action: string) =>
      JSON.stringify(body).split(action).join("<action>");
    expect(shape(granted.json(), "memory.remember")).toEqual(shape(invented.json(), "not.an.action"));
  });

  it("refuses a request with no token, a wrong token, or another Run's token", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    const other = randomUUID();
    await makeRun(run);
    await makeRun(other);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    const otherToken = await identities.issue({ id: other, space_id: SPACE }, 60_000, "hash");

    expect((await get(run, "tools", null)).statusCode).toBe(401);
    expect((await get(run, "tools", "not-a-token")).statusCode).toBe(401);
    // The token is live — for a different Run. It must not reach this one.
    expect((await get(run, "tools", otherToken)).statusCode).toBe(401);
  });

  it("refuses a live token once its Run has stopped running", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");
    await db.pool!.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [run]);

    const response = await get(run, "tools", token);

    expect(response.statusCode).toBe(403);
  });

  it("refuses a revoked token", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    const token = await identities.issue({ id: run, space_id: SPACE }, 60_000, "hash");
    await identities.revoke(run);

    expect((await get(run, "tools", token)).statusCode).toBe(401);
  });

  it("refuses to call an action the Run was not granted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const response = await app!.inject({
      method: "POST",
      url: `/internal/runs/${run}/tools/memory.remember`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { content: "remember this", rationale: "because" },
    });

    // A refusal the agent can read, not a transport error: the dispatcher
    // answers `ok: false` for an ungranted action.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, error_code: "system_action_not_granted" });
  });

  it("refuses a call with no token before it reaches any action", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);

    const response = await app!.inject({
      method: "POST",
      url: `/internal/runs/${run}/tools/task.list`,
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });
});
