import { describe, expect, it } from "vitest";
import { seedSpaceDefaults } from "../src/modules/spaces/spaceSeeds";
import type { PoolClient } from "../src/db/pool";

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
