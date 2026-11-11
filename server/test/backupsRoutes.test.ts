import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { backupsModule } from "../src/modules/backups/index.js";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
  type CurrentUser,
} from "../src/modules/auth/identity.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { keyed, refused } from "./support/systemCommandHarness.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;

function user(id: string, email: string): CurrentUser {
  return {
    id,
    email,
    display_name: id,
    avatar_url: null,
    is_instance_admin: false,
    created_at: new Date().toISOString(),
    default_space_id: null, last_login_at: null,
  };
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    INSTANCE_ADMIN_EMAIL: "admin@example.test",
    BACKUP_ENABLED: "false",
  }), [backupsModule]);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["system_command_intents", "jobs", "operation_idempotency", "policy_decision_records", "space_memberships", "spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id,email,display_name,status,created_at,updated_at, registration_source) VALUES
      ($1,'admin@example.test','Admin','active',$3,$3, 'system'),
      ($2,'member@example.test','Member','active',$3,$3, 'system')`,
    [ADMIN, MEMBER, now],
  );
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Main','team',$2,$2)`, [SPACE, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES (gen_random_uuid(),$1,$2,'owner','active',$4,$4),(gen_random_uuid(),$1,$3,'member','active',$4,$4)`,
    [SPACE, ADMIN, MEMBER, now],
  );
  const users: Record<string, CurrentUser> = {
    [ADMIN]: user(ADMIN, "admin@example.test"),
    [MEMBER]: user(MEMBER, "member@example.test"),
  };
  __setAuthRepositoryForTests({
    async getCurrentUser() { return users[ADMIN]!; },
  } as unknown as AuthRepository);
});

afterEach(() => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
});

afterAll(async () => {
  await app?.close();
});

describe("backup routes", () => {
  it("refuses a signed-in non-admin for list and manual trigger", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: MEMBER, spaceId: SPACE } as never);
    expect((await app.inject({ method: "GET", url: "/api/v1/system/backups" })).statusCode).toBe(403);
    // `system.backup.create` answers a non-admin the hidden 404 and admits nothing.
    expect(refused(await keyed(app, { method: "POST", url: "/api/v1/system/backups/manual" }), 404)).toBe("operation_not_found");
    expect((await db.pool.query(`SELECT 1 FROM system_command_intents`)).rowCount).toBe(0);
  });

  it("refuses a manual backup while the service is disabled, without admitting a command", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const response = await keyed(app, { method: "POST", url: "/api/v1/system/backups/manual" });
    expect(refused(response, 409)).toBe("operation_conflict");
    expect(response.json().error.message).toMatch(/BACKUP_ENABLED/);
    expect((await db.pool.query(`SELECT 1 FROM system_command_intents`)).rowCount).toBe(0);
  });

  it("lets the instance admin list backups when the service is disabled", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const listed = await app.inject({ method: "GET", url: "/api/v1/system/backups" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([]);
  });
});
