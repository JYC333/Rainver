import { describe, expect, it } from "vitest";
import type { PoolClient } from "../src/db/pool.js";
import { setupTargetsForMissingBackend } from "../src/modules/agents/spaceAssistantService.js";
import { seedSpaceDefaults } from "../src/modules/spaces/spaceSeeds.js";

describe("spaceAssistantService", () => {
  describe("managed Assistant backend setup targets", () => {
    // Both destinations are always real work now: a Space with no backend can
    // either add a ModelProvider or log a CLI in on an execution host. The
    // second used to be conditional on the server having a CLI installed,
    // which is no longer a thing that can be true (ADR 0016).
    it("names both places a missing backend can be configured", () => {
      expect(setupTargetsForMissingBackend()).toEqual(["model_providers", "execution_hosts"]);
    });
  });
});

describe("spaceSeeds", () => {
  class SeedClient {
    readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      this.queries.push({ sql, params });
      if (sql.includes("SELECT count(*)::text AS count FROM note_collections")) {
        return { rows: [{ count: "1" }] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    }
  }

  describe("space default seeds", () => {
    it("does not seed policy text into user/project memory", async () => {
      const client = new SeedClient();

      await seedSpaceDefaults(client as unknown as PoolClient, "space-1", "user-1");

      const memoryInserts = client.queries.filter(call => call.sql.includes("INSERT INTO memory_entries"));
      expect(memoryInserts).toHaveLength(0);
      expect(client.queries.some(call => call.sql.includes("INSERT INTO runtime_context_policy_versions"))).toBe(true);
    });
  });
});
