import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { keyed, refused, succeeded } from "./support/systemCommandHarness.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;

function user(id: string, email: string): CurrentUser {
  return { id, email, display_name: id, avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), default_space_id: null, last_login_at: null };
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    // The keyed request fingerprint reads the instance key from here; never a real instance home.
    RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-instance-settings-")),
    INSTANCE_ADMIN_EMAIL: "admin@example.test",
    BACKUP_ENABLED: "true",
  }), [systemModule]);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["operation_idempotency", "policy_decision_records", "settings", "space_memberships", "spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id,email,display_name,status,created_at,updated_at, registration_source) VALUES
      ($1,'admin@example.test','Admin','active',$3,$3, 'system'),
      ($2,'member@example.test','Member','active',$3,$3, 'system')`,
    [ADMIN, MEMBER, now],
  );
  // Settings commands are admitted for an active member of the request Space.
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
      managed_host_egress_mode: "direct",
      managed_host_proxy_url: null,
      managed_host_no_proxy: null,
      updated_at: null,
    });

    // `system.instance_settings.update`: the member is not told it exists.
    __setAuthIdentityForTests({ userId: MEMBER, spaceId: SPACE } as never);
    expect(refused(await keyed(app, { method: "PUT", url: "/api/v1/system/instance-settings", payload: { backup_interval_hours: 12 } }), 404)).toBe("operation_not_found");
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const key = "instance-settings-1";
    const savedResponse = await keyed(app, {
      method: "PUT",
      url: "/api/v1/system/instance-settings",
      payload: {
        backup_interval_hours: 12,
        backup_retention_count: 14,
        backup_include_logs: true,
        backup_on_startup: false,
        content_access_log_retention_enabled: false,
        content_access_log_retention_days: 365,
        managed_host_egress_mode: "system_tun",
      },
    }, key);
    const saved = succeeded<Record<string, unknown>>(savedResponse);
    expect(saved).toMatchObject({
      backup_interval_hours: 12,
      backup_retention_count: 14,
      backup_include_logs: true,
      backup_on_startup: false,
      content_access_log_retention_enabled: false,
      content_access_log_retention_days: 365,
      managed_host_egress_mode: "system_tun",
      managed_host_proxy_url: null,
    });
    expect(saved.updated_at).toBeTruthy();
    // The same key replays the recorded result; a different body under it is refused.
    const replay = await keyed(app, { method: "PUT", url: "/api/v1/system/instance-settings", payload: {
      backup_interval_hours: 12, backup_retention_count: 14, backup_include_logs: true, backup_on_startup: false,
      content_access_log_retention_enabled: false, content_access_log_retention_days: 365, managed_host_egress_mode: "system_tun",
    } }, key);
    expect(succeeded(replay)).toEqual(saved);
    expect(refused(await keyed(app, { method: "PUT", url: "/api/v1/system/instance-settings", payload: { backup_interval_hours: 6 } }, key), 422)).toBe("idempotency_key_reused");
    // Demoted, the admin no longer receives the recorded result.
    await db.pool.query(`UPDATE users SET email='former-admin@example.test' WHERE id=$1`, [ADMIN]);
    expect(refused(await keyed(app, { method: "PUT", url: "/api/v1/system/instance-settings", payload: {
      backup_interval_hours: 12, backup_retention_count: 14, backup_include_logs: true, backup_on_startup: false,
      content_access_log_retention_enabled: false, content_access_log_retention_days: 365, managed_host_egress_mode: "system_tun",
    } }, key), 404)).toBe("operation_not_found");

    const row = await db.pool.query<{ settings_key: string; updated_by_user_id: string }>(
      `SELECT settings_key,updated_by_user_id FROM settings WHERE scope_type='instance' AND scope_id='instance'`,
    );
    expect(row.rows).toEqual([{ settings_key: "system.instance_operations", updated_by_user_id: ADMIN }]);
  });

  it("rejects invalid retention and schedule values", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);
    const response = await keyed(app, { method: "PUT", url: "/api/v1/system/instance-settings", payload: { backup_interval_hours: 0 } });
    expect(refused(response, 422)).toBe("operation_invalid_input");
  });

  it("validates and normalizes the built-in Host route", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthIdentityForTests({ userId: ADMIN, spaceId: SPACE } as never);

    const missing = await keyed(app, {
      method: "PUT",
      url: "/api/v1/system/instance-settings",
      payload: { managed_host_egress_mode: "http_proxy" },
    });
    expect(missing.statusCode).toBe(422);

    const credentials = await keyed(app, {
      method: "PUT",
      url: "/api/v1/system/instance-settings",
      payload: {
        managed_host_egress_mode: "http_proxy",
        managed_host_proxy_url: "http://user:secret@proxy.example:7890",
      },
    });
    expect(credentials.statusCode).toBe(422);
    expect(credentials.body).not.toContain("secret");
    // A refused proxy URL with credentials leaves nothing derived from it alone: the stored
    // fingerprint covers a keyed digest, and the refusal body does not echo it.
    const stored = await db.pool.query(`SELECT fingerprint, result_json::text AS body FROM operation_idempotency WHERE operation_id='system.instance_settings.update'`);
    expect(JSON.stringify(stored.rows)).not.toContain("user:secret");

    const saved = await keyed(app, {
      method: "PUT",
      url: "/api/v1/system/instance-settings",
      payload: {
        managed_host_egress_mode: "http_proxy",
        managed_host_proxy_url: "http://proxy.example:7890",
        managed_host_no_proxy: " .internal.example ",
      },
    });
    expect(succeeded(saved)).toMatchObject({
      managed_host_egress_mode: "http_proxy",
      managed_host_proxy_url: "http://proxy.example:7890",
      managed_host_no_proxy: ".internal.example",
    });
  });
});
