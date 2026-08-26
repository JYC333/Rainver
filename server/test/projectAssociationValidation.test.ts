import { describe, expect, it } from "vitest";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgProposalRepository } from "../src/modules/proposals/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import type { QueryResult, Queryable, SpaceUserIdentity } from "../src/modules/routeUtils/common.js";

class FakeDb implements Queryable {
  constructor(private readonly handler: (sql: string, params: readonly unknown[]) => unknown[]) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return { rows: this.handler(sql, params) as Row[], rowCount: null };
  }
}

const identity: SpaceUserIdentity = { spaceId: "space-1", userId: "user-1" };

describe("Project association validation", () => {
  it("hides activity creation project targets outside the caller's project access", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM projects")) return [];
      if (sql.includes("INSERT INTO activity_records")) {
        throw new Error("activity insert should not run");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(
      new PgActivityRepository(db).create(identity, {
        source_type: "user_capture",
        content: "cross-space project",
        project_id: "project-other",
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Project not found" });
  });

  it("hides activity list project filters outside the caller's project access", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM projects")) return [];
      if (sql.includes("FROM activity_records")) {
        throw new Error("activity list should not run");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(
      new PgActivityRepository(db).list(identity, {
        projectId: "project-other",
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Project not found" });
  });

  it("rejects proposal list project filters outside the current space", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM projects")) return [];
      if (sql.includes("FROM proposals")) {
        throw new Error("proposal list should not run");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(
      new PgProposalRepository(db).listVisible("space-1", "user-1", {
        status: "pending",
        projectId: "project-other",
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: "Project not found" });
  });

  it("rejects run list project filters outside the current space", async () => {
    const db = new FakeDb((sql) => {
      if (sql.includes("FROM projects")) return [];
      if (sql.includes("FROM runs")) {
        throw new Error("run list should not run");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(
      new PgRunRepository(db).listRuns({
        space_id: "space-1",
        user_id: "user-1",
        project_id: "project-other",
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: "Project not found" });
  });
});
