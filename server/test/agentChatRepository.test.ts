import { describe, expect, it } from "vitest";
import { PgAgentChatRepository } from "../src/modules/agents/repository";

describe("PgAgentChatRepository", () => {
  it("applies user visibility and active status to Chat Agent lookup", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const repository = new PgAgentChatRepository({
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    });

    await repository.getAgentForChat("space-1", "user-2", "agent-private");

    expect(calls[0]?.params).toEqual([
      "space-1",
      "agent-private",
      "user-2",
    ]);
    expect(calls[0]?.sql).toContain("a.status = 'active'");
    expect(calls[0]?.sql).toContain("a.agent_kind <> 'system_assistant'");
    expect(calls[0]?.sql).toContain("content_access_grants");
  });
});
