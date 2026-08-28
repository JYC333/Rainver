import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { projectWorkModule } from "../src/modules/projectWork/index.js";
import { loadConfig } from "../src/config.js";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
  type CurrentUser,
} from "../src/modules/auth/identity.js";

/**
 * The Updates route, over HTTP.
 *
 * `POST /projects/:projectId/updates` is the only producer of
 * `project.reported`, and the read immediately above it in the same file uses
 * the *read* gate. A test that calls the same functions the handler calls
 * cannot see the handler pick the wrong one — so this one goes through the
 * server.
 */

const SPACE = "51111111-1111-4111-8111-111111111111";
const OWNER = "5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "5ccccccc-cccc-4ccc-8ccc-cccccccccccc";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | null = null;

function currentUser(id: string): CurrentUser {
  return {
    id, email: `${id}@example.test`, display_name: id, avatar_url: null,
    is_instance_admin: false, created_at: new Date().toISOString(), last_login_at: null,
  } as CurrentUser;
}

function stubAuth(): AuthRepository {
  return {
    async getCurrentUser(sessionToken?: string) {
      return sessionToken ? currentUser(sessionToken) : { statusCode: 401, detail: "Not authenticated" };
    },
  } as unknown as AuthRepository;
}

function asUser(userId: string): void {
  __setAuthIdentityForTests({ userId, spaceId: SPACE, sessionToken: userId } as never);
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [projectWorkModule]);
  await app.ready();
});

afterAll(async () => { await app?.close(); });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_work_events", "actors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  for (const id of [OWNER, VIEWER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, $1, 'active', now(), now())`, [id]);
  }
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Updates Space', 'household', $2, now(), now())`, [SPACE, OWNER]);
  for (const [id, role] of [[OWNER, "owner"], [VIEWER, "member"]] as const) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`, [randomUUID(), SPACE, id, role]);
  }
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, primary_mode, created_at, updated_at)
     VALUES ($1, $2, $3, 'Updates Project', 'active', 'delivery', now(), now())`, [PROJECT, SPACE, OWNER]);
  // A Project viewer: may read the account, may not add to it.
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'viewer', 'active', now(), now())`, [randomUUID(), SPACE, PROJECT, VIEWER]);
  __setAuthRepositoryForTests(stubAuth());
});

afterEach(() => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
});

async function post(body: unknown) {
  return app!.inject({ method: "POST", url: `/api/v1/projects/${PROJECT}/updates`, payload: body as never });
}

describe("project updates routes", () => {
  it("appends a person's update and lists it back", async (ctx) => {
    if (!db.available) return ctx.skip();
    asUser(OWNER);
    const created = await post({ summary: "Standing up the pilot" });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).id).toEqual(expect.any(String));

    const listed = await app!.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/updates` });
    const page = JSON.parse(listed.body);
    expect(page.items[0].summary).toBe("Standing up the pilot");
    expect(page.viewer_can_write).toBe(true);
  });

  it("holds the writer gate, which is not the gate the read beside it uses", async (ctx) => {
    if (!db.available) return ctx.skip();
    asUser(VIEWER);
    // Readable…
    const listed = await app!.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/updates` });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).viewer_can_write).toBe(false);
    // …but not writable. Swapping the writer check for the read one here would
    // let any viewer append to the record the Project is judged by.
    expect((await post({ summary: "Not mine to write" })).statusCode).toBe(403);
  });

  it("refuses a malformed body rather than storing an empty account", async (ctx) => {
    if (!db.available) return ctx.skip();
    asUser(OWNER);
    expect((await post({ summary: "   " })).statusCode).toBe(422);
    expect((await post({ note: "wrong field" })).statusCode).toBe(422);

    const listed = await app!.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/updates` });
    expect(JSON.parse(listed.body).items).toEqual([]);
  });

  it("refuses a Project the caller cannot read", async (ctx) => {
    if (!db.available) return ctx.skip();
    asUser(OWNER);
    const other = randomUUID();
    const response = await app!.inject({ method: "GET", url: `/api/v1/projects/${other}/updates` });
    expect(response.statusCode).toBe(404);
  });
});
