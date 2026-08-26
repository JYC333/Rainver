import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { getDbPool } from "../src/db/pool.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { runtimeToolsModule } from "../src/modules/runtimeTools/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";

vi.mock("../src/db/pool.js", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;
const tmpPaths: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
  for (const path of tmpPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function config(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "aspace-runtime-routes-"));
  tmpPaths.push(root);
  return loadConfig({
    AGENT_SPACE_HOME: root,
    RUNTIME_TOOLS_ROOT: join(root, "runtime-tools"),
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    ...env,
  });
}

describe("runtime tool routes", () => {
  it("serves space policy routes before runtime parameter routes", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(await config(), [runtimeToolsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runtime-tools/space-policy",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().map((row: { runtime: string }) => row.runtime)).toEqual([
      "claude_code",
      "codex_cli",
      "opencode",
    ]);
    expect(res.json().map((row: { enabled: boolean }) => row.enabled)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("requires the configured instance admin for tool installs", async () => {
    const query = vi.fn(async () => ({
      rows: [{ email: "user@example.test" }],
      rowCount: 1,
    }));
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildModuleServer(await config({ INSTANCE_ADMIN_EMAIL: "admin@example.test" }), [runtimeToolsModule], {
      logger: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-tools/codex_cli/install",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ version: "latest" }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error_code: "instance_admin_required" });
  });

  it("updates space policy as a patch and allows disabling stale defaults", async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("FROM space_runtime_tool_policies") && sql.includes("LIMIT 1")) {
        return {
          rows: [
            {
              id: "policy-1",
              space_id: "space-1",
              runtime: "codex_cli",
              enabled: true,
              default_version: "9.9.9",
              allowed_versions_json: ["9.9.9"],
              updated_by_user_id: "user-1",
              created_at: "2026-06-18T00:00:00.000Z",
              updated_at: "2026-06-18T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM space_memberships")) {
        return { rows: [{ role: "owner" }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO space_runtime_tool_policies")) {
        return {
          rows: [
            {
              id: "policy-1",
              space_id: params[1],
              runtime: params[2],
              enabled: params[3],
              default_version: params[4],
              allowed_versions_json: JSON.parse(String(params[5])),
              updated_by_user_id: params[6],
              created_at: params[7],
              updated_at: params[7],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    // The route also reconciles the space's managed-assistant CLI profiles
    // after the policy write, which runs inside its own withTransaction
    // (needs pool.connect(), not just pool.query()); the space lookup at
    // the start of that reconciliation finds nothing against this mock's
    // empty-row fallback, so it no-ops cleanly once connect() exists.
    vi.mocked(getDbPool).mockReturnValue({
      query,
      connect: async () => ({ query, release: () => {} }),
    } as never);
    app = buildModuleServer(await config(), [runtimeToolsModule]);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/runtime-tools/space-policy/codex_cli",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ enabled: false }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      runtime: "codex_cli",
      enabled: false,
      default_version: "9.9.9",
      allowed_versions: ["9.9.9"],
    });
  });
});
