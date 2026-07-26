import { describe, expect, it } from "vitest";
import { PgTaskRepository } from "../src/modules/tasks/repository";

class FakePool {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    if (/FROM tasks t/.test(sql)) {
      return {
        rows: [{
          id: "task-1",
          space_id: "space-1",
          visibility: "space_shared",
          created_by_user_id: "creator-1",
          assigned_user_id: null,
          claimed_by_user_id: null,
        }] as Row[],
        rowCount: 1,
      };
    }
    if (/count\(\*\)::text AS total/.test(sql)) {
      return { rows: [{ total: "0" }] as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe("task artifact repository visibility", () => {
  it("applies canonical workspace scope to task artifacts", async () => {
    const db = new FakePool();
    await new PgTaskRepository(db as never).listTaskArtifacts(
      { spaceId: "space-1", userId: "user-1" },
      "task-1",
      10,
      0,
    );

    const artifactQueries = db.queries.filter((query) => /FROM task_artifacts/.test(query.sql));
    expect(artifactQueries).toHaveLength(2);
    for (const query of artifactQueries) {
      expect(query.sql).toContain("JOIN tasks t ON t.id = ta.task_id AND t.space_id = ta.space_id");
      expect(query.sql).toContain("space_memberships content_member");
      expect(query.sql).toContain("a.visibility = 'space_shared'");
      expect(query.sql).toContain("content_access_grants content_grant");
      expect(query.sql).toContain("project_folders");
      expect(query.sql).toContain("project_members");
    }
  });
});
