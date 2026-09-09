import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository, type CurrentUser } from "../src/modules/auth/identity.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";

/**
 * Who may do what to the instance's own execution host.
 *
 * The built-in host has no owner — it serves every Space — so the ownership
 * gate that answers for a paired host answers nothing here. Managing it
 * (installing a runtime, logging a copy in) is instance-admin work; being told
 * what is installed on it is not, because that is what says whether a member's
 * Run can run at all. And two things it must keep refusing: being revoked, and
 * being handed an existing directory on the machine (plan decision 12 — a
 * server Location is always a managed workspace).
 */
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_TOKEN = "admin-session-token";
const MEMBER_TOKEN = "member-session-token";
const ADMIN_EMAIL = "admin@example.test";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let app: FastifyInstance | undefined;
let builtinHostId: string;

function user(id: string, email: string | null, admin: boolean): CurrentUser {
  return {
    id,
    email,
    display_name: id,
    avatar_url: null,
    is_instance_admin: admin,
    created_at: new Date().toISOString(),
    last_login_at: null,
  };
}

function stubAuth(): AuthRepository {
  const users: Record<string, CurrentUser> = {
    [ADMIN_TOKEN]: user(ADMIN, ADMIN_EMAIL, true),
    [MEMBER_TOKEN]: user(MEMBER, "member@example.test", false),
  };
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  return {
    resolveIdentity: notImplemented,
    async getCurrentUser(sessionToken?: string) {
      const found = sessionToken ? users[sessionToken] : undefined;
      return found ?? { statusCode: 401, detail: "Not authenticated" };
    },
    getUserSpaces: notImplemented,
    getSpaceForUser: notImplemented,
    logout: notImplemented,
    findOrCreateFromGoogle: notImplemented,
  } as unknown as AuthRepository;
}

const db = useTestDatabase(import.meta.filename);

function baseUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening on a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

/** Routes that validate a ModelProvider are Space-scoped, so they introspect rather than read the session directly. */
function asUser(userId: string, token: string): void {
  __setAuthIdentityForTests({ userId, spaceId: SPACE, sessionToken: token } as never);
}

function get(path: string, token: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, { headers: { cookie: `session_id=${token}` } });
}

function post(path: string, token: string, body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { cookie: `session_id=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(
    loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: ADMIN_EMAIL }),
    [hostsModule],
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
});

beforeEach(async (ctx) => {
  if (!db.available || !db.pool) return ctx.skip();
  await resetTables(db.pool, ["hosts", "machines", "users"], { cascade: true });
  await db.pool.query(
    `INSERT INTO users (id, email, display_name, status, created_at, updated_at)
     VALUES ($1, $2, 'Admin', 'active', now(), now()), ($3, 'member@example.test', 'Member', 'active', now(), now())`,
    [ADMIN, ADMIN_EMAIL, MEMBER],
  );
  builtinHostId = await new PgHostRepository(db.pool).ensureServerHostId();
  __setAuthRepositoryForTests(stubAuth());
});

describe("the built-in host's management surface", () => {
  it("lists the built-in host to every member, with the capacity it runs at", async () => {
    const response = await get("/api/v1/hosts", MEMBER_TOKEN);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string; kind: string; max_concurrent_runs: number | null }> };
    const builtin = body.items.find((item) => item.id === builtinHostId);
    expect(builtin).toMatchObject({ kind: "server", max_concurrent_runs: 3 });
    // bubblewrap has no cgroups, so a paired machine's capacity is its owner's
    // to size and Rainver states none for it.
    expect(body.items.every((item) => item.kind === "server" || item.max_concurrent_runs === null)).toBe(true);
  });

  it("refuses a member's attempt to install a runtime on it, in a way that says why", async () => {
    asUser(MEMBER, MEMBER_TOKEN);
    const response = await post(`/api/v1/hosts/${builtinHostId}/installations/opencode`, MEMBER_TOKEN);
    // 403, not 404: unlike a paired host someone does not own, the built-in
    // host's existence is on every member's host list already.
    expect(response.status).toBe(403);
    expect((await response.json() as { detail: string }).detail).toMatch(/instance admin/i);
  });

  it("lets an instance admin through that gate to the daemon", async () => {
    asUser(ADMIN, ADMIN_TOKEN);
    const response = await post(`/api/v1/hosts/${builtinHostId}/installations/opencode`, ADMIN_TOKEN);
    // Past the gate: whatever answers now is about the adapter or the daemon,
    // not about who is asking. (Here it is the adapter — this test loads no
    // ACP registry, so the install has no distribution to resolve.)
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(404);
    expect((await response.json() as { detail?: string }).detail ?? "").not.toMatch(/instance admin/i);
  });

  it("cannot be revoked, by an admin or anyone else", async () => {
    asUser(ADMIN, ADMIN_TOKEN);
    expect((await post(`/api/v1/hosts/${builtinHostId}/revoke`, ADMIN_TOKEN)).status).toBe(404);
    const row = await db.pool!.query<{ status: string }>(`SELECT status FROM hosts WHERE id = $1`, [builtinHostId]);
    expect(row.rows[0]?.status).not.toBe("revoked");
  });

  it("does not accept an existing directory on the machine as a workspace", async () => {
    asUser(ADMIN, ADMIN_TOKEN);
    // Plan decision 12: a server Location is always a managed workspace under
    // the instance's own root. Attaching a directory that is already there is
    // the trusted host's job.
    const response = await post(`/api/v1/hosts/${builtinHostId}/workspaces`, ADMIN_TOKEN, {
      project_id: "11111111-1111-4111-8111-111111111111",
      path: "/etc",
      name: "etc",
    });
    expect(response.status).toBe(404);
  });
});
