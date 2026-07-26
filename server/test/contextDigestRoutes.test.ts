import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { getDbPool } from "../src/db/pool";
import { buildServer } from "../src/server";
import { __setAuthIdentityForTests } from "../src/modules/auth";

vi.mock("../src/db/pool", () => ({
  getDbPool: vi.fn(),
}));

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

describe("context digest refresh route", () => {
  it("refreshes all dirty digests for the authenticated space", async () => {
    const query = vi.fn(async (sql: string) => {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (norm.startsWith("SELECT scope_type, scope_id, digest_type")) {
        return {
          rows: [{ scope_type: "space", scope_id: null, digest_type: "policy_bundle" }],
          rowCount: 1,
        };
      }
      if (norm.startsWith("SELECT id, name, domain")) {
        return {
          rows: [{
            id: "policy-1",
            name: "Allow",
            domain: "runtime",
            policy_key: "runtime.allow",
            enforcement_mode: "allow",
            priority: 10,
            policy_json: { rule: "Use safe defaults." },
            rule_json: null,
            applies_to_json: null,
            policy_version: 1,
          }],
          rowCount: 1,
        };
      }
      if (norm.startsWith("SELECT id, version, status, source_hash")) {
        return { rows: [], rowCount: 0 };
      }
      if (norm.startsWith("INSERT INTO context_digests")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/context/digests/refresh",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      refreshed_count: 1,
      digests: [
        {
          digest_type: "policy_bundle",
          scope_type: "space",
          scope_id: null,
          source_policy_count: 1,
        },
      ],
    });
  });

  it("rejects mismatched digest and scope requests", async () => {
    vi.mocked(getDbPool).mockReturnValue({ query: vi.fn() } as never);
    app = buildServer(config(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/context/digests/refresh",
      payload: {
        scope_type: "project_folder",
        scope_id: "ws-1",
        digest_type: "policy_bundle",
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      detail: "policy_bundle refresh requires scope_type=space",
    });
  });
});
