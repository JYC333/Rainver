import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { systemModule } from "../src/modules/system/index.js";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
  type CurrentUser,
} from "../src/modules/auth/identity.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;

function user(id: string, email: string): CurrentUser {
  return { id, email, display_name: id, avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), last_login_at: null };
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    INSTANCE_ADMIN_EMAIL: "admin@example.test",
    BACKUP_ENABLED: "true",
  }), [systemModule]);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["settings", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id,email,display_name,status,created_at,updated_at) VALUES
      ($1,'admin@example.test','Admin','active',$3,$3),
      ($2,'member@example.test','Member','active',$3,$3)`,
    [ADMIN, MEMBER, now],
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

describe("instance operations settings", () => {
  it("allows only the instance admin to read and update persisted runtime policy", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: MEMBER, spaceId: SPACE } as never);
    expect((await app.inject({ method: "GET", url: "/api/v1/system/instance-settings" })).statusCode).toBe(403);

    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const initial = await app.inject({ method: "GET", url: "/api/v1/system/instance-settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      backup_service_enabled: true,
      backup_interval_hours: 24,
      backup_retention_count: 7,
      content_access_log_retention_enabled: true,
      content_access_log_retention_days: 90,
      updated_at: null,
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/system/instance-settings",
      payload: {
        backup_interval_hours: 12,
        backup_retention_count: 14,
        backup_include_logs: true,
        backup_on_startup: false,
        content_access_log_retention_enabled: false,
        content_access_log_retention_days: 365,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      backup_interval_hours: 12,
      backup_retention_count: 14,
      backup_include_logs: true,
      backup_on_startup: false,
      content_access_log_retention_enabled: false,
      content_access_log_retention_days: 365,
    });
    expect(saved.json().updated_at).toBeTruthy();

    const row = await db.pool.query<{ settings_key: string; updated_by_user_id: string }>(
      `SELECT settings_key,updated_by_user_id FROM settings WHERE scope_type='instance' AND scope_id='instance'`,
    );
    expect(row.rows).toEqual([{ settings_key: "system.instance_operations", updated_by_user_id: ADMIN }]);
  });

  it("rejects invalid retention and schedule values", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const response = await app.inject({ method: "PUT", url: "/api/v1/system/instance-settings", payload: { backup_interval_hours: 0 } });
    expect(response.statusCode).toBe(422);
  });
});
