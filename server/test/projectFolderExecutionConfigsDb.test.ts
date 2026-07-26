import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { __setAuthIdentityForTests } from "../src/modules/auth";

// Real-Postgres coverage for the Project Folder Execution Config routes:
// CRUD against the real table, Folder existence gating, and space isolation.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";
const FOLDER = "44444444-4444-4444-8444-444444444444";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
    app = buildServer(loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri() }), { logger: false });
  } catch (err) {
    console.warn(`[project-folder-execution-configs-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE project_folder_execution_configs, project_folders, projects, users, spaces CASCADE",
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', now(), now()),
            ($2, 'Viewer', 'active', now(), now())`,
    [USER, VIEWER],
  );
  for (const spaceId of [SPACE, OTHER_SPACE]) {
    await pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Space', 'household', $2, now(), now())`,
      [spaceId, USER],
    );
    await pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
      [spaceId, USER],
    );
  }
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Project','active',now(),now()),
            ($4,$2,$3,'Other Project','active',now(),now())`,
    [PROJECT, SPACE, USER, OTHER_PROJECT],
  );
  await pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status, kind, is_primary, execution_enabled, protected, system_managed, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Folder','active','code',true,true,false,false,now(),now())`,
    [FOLDER, SPACE, PROJECT, USER],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'member', 'active', now(), now())`,
    [SPACE, VIEWER],
  );
  await pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'viewer', 'active', now(), now())`,
    [SPACE, PROJECT, VIEWER],
  );
});

describe("project folder execution config routes", () => {
  it("404s before creation, then creates/reads/updates in real Postgres", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });

    const missing = await app!.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
    });
    expect(missing.statusCode).toBe(404);

    const created = await app!.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      payload: { repo_type: "node", test_commands_json: ["npm test"] },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.project_folder_id).toBe(FOLDER);
    expect(createdBody.repo_type).toBe("node");
    expect(createdBody.test_commands_json).toEqual(["npm test"]);

    const fetched = await app!.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().repo_type).toBe("node");

    const updated = await app!.inject({
      method: "PATCH",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      payload: { repo_type: "python" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().repo_type).toBe("python");
    expect(updated.json().test_commands_json).toEqual(["npm test"]);

    const row = await pool!.query(
      `SELECT space_id, project_folder_id FROM project_folder_execution_configs WHERE project_folder_id = $1`,
      [FOLDER],
    );
    expect(row.rows[0]).toEqual({ space_id: SPACE, project_folder_id: FOLDER });
  });

  it("rejects creation against a Folder outside the caller's space", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: OTHER_SPACE, userId: USER });
    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("isolates reads across spaces", async (ctx) => {
    if (!available || !pool || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    await app!.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      payload: {},
    });

    __setAuthIdentityForTests({ spaceId: OTHER_SPACE, userId: USER });
    const crossSpace = await app!.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
    });
    expect(crossSpace.statusCode).toBe(404);
  });

  it("allows Project viewers to read but not mutate execution config", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      payload: {},
    });

    __setAuthIdentityForTests({ spaceId: SPACE, userId: VIEWER });
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
    });
    expect(read.statusCode).toBe(200);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${PROJECT}/folders/${FOLDER}/execution-config`,
      payload: { repo_type: "python" },
    });
    expect(update.statusCode).toBe(403);
  });

  it("rejects a Folder that belongs to another Project in the route", async (ctx) => {
    if (!available || !app) return ctx.skip();
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${OTHER_PROJECT}/folders/${FOLDER}/execution-config`,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});
