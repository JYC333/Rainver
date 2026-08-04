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

describe("evolution run routes", () => {
  it("rejects a run without an explicit Agent before creating run state", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM evolution_targets et")) {
        return {
          rows: [{
            id: "target-1",
            space_id: "space-1",
            metadata_json: {},
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.mocked(getDbPool).mockReturnValue({ query } as never);
    app = buildServer(loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    }), { logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/evolution/targets/target-1/run",
      payload: { mode: "dry_run" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      detail: "agent_id is required in the request or target metadata",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
