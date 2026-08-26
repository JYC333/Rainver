import { describe, expect, it } from "vitest";
import type { PoolClient } from "../src/db/pool.js";
import { setupTargetsForMissingBackend } from "../src/modules/agents/spaceAssistantService.js";
import { seedSpaceDefaults } from "../src/modules/spaces/spaceSeeds.js";

describe("spaceAssistantService", () => {
  describe("managed Assistant backend setup targets", () => {
    it("does not advertise CLI credentials when no CLI runtime can be provisioned", () => {
      expect(setupTargetsForMissingBackend({ cliAdapters: [] })).toEqual(["model_providers"]);
    });

    it("advertises CLI credentials when a supported runtime is provisionable", () => {
      expect(setupTargetsForMissingBackend({
        cliAdapters: [{ adapterType: "codex_cli", version: "1.0.0" }],
      })).toEqual(["model_providers", "cli_credentials"]);
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
