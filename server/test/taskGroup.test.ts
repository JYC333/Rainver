import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("taskArtifactsRepository", () => {
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
});

describe("taskContractDb", () => {
  const SPACE = "22222222-2222-4222-8222-222222222222";
  const OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

  const db = useTestDatabase(`${import.meta.filename}#taskContractDb`, { max: 4 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["tasks", "space_memberships", "users", "spaces"], { cascade: true });
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'Task Contract Owner', 'active', $2, $2)`,
      [OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Task Contract Space', 'personal', $2, $3, $3)`,
      [SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
      [randomUUID(), SPACE, OWNER, now],
    );
  });

  describe("task contract persistence (real Postgres)", () => {
    it("creates and updates the A1 contract fields through the repository boundary", async () => {
      if (!db.available) return;
      const repository = new PgTaskRepository(db.pool);
      const created = await repository.createTask(identity, {
        title: "Initial contract",
        acceptance_criteria_json: { checks: [{ type: "output_schema" }] },
        definition_of_done: "Initial done definition",
        required_outputs_json: ["artifact:report"],
        max_runs: 2,
        max_cost: 3.5,
        max_duration_seconds: 90,
        policy_json: { max_attempts: 2 },
        metadata_json: { source: "ui" },
        tags: ["contract"],
      });

      const updated = await repository.updateTask(identity, created.id, {
        acceptance_criteria_json: { checks: [{ type: "exact_json", value: { ok: true } }] },
        definition_of_done: "Updated done definition",
        required_outputs_json: ["artifact:final"],
        max_runs: 4,
        max_cost: 7,
        max_duration_seconds: 180,
        policy_json: { max_attempts: 3 },
        metadata_json: { source: "ui", revision: 2 },
        tags: ["contract", "updated"],
      });

      expect(updated.acceptance_criteria_json).toEqual({ checks: [{ type: "exact_json", value: { ok: true } }] });
      expect(updated.definition_of_done).toBe("Updated done definition");
      expect(updated.required_outputs_json).toEqual(["artifact:final"]);
      expect(updated.max_runs).toBe(4);
      expect(updated.max_cost).toBe(7);
      expect(updated.max_duration_seconds).toBe(180);
      expect(updated.policy_json).toEqual({ max_attempts: 3 });
      expect(updated.metadata_json).toEqual({ source: "ui", revision: 2 });
      expect(updated.tags).toEqual(["contract", "updated"]);
    });

    it("rejects task statuses outside the canonical lifecycle vocabulary", async () => {
      if (!db.available) return;
      const repository = new PgTaskRepository(db.pool);
      await expect(repository.createTask(identity, { title: "Ghost state", status: "archived" })).rejects.toMatchObject({
        statusCode: 422,
      });

      const now = new Date().toISOString();
      await expect(
        db.pool.query(
          `INSERT INTO tasks (id, space_id, title, status, created_at, updated_at)
           VALUES ($1,$2,'Ghost state','archived',$3,$3)`,
          [randomUUID(), SPACE, now],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("accepts the review hold the levels below it already had", async () => {
      if (!db.available) return;
      // `waiting_for_review` was the one state a Run and a Plan Node could both
      // be in and the product work item above them could not, so a Task parked
      // on a decision had nowhere to say so.
      const repository = new PgTaskRepository(db.pool);
      const task = await repository.createTask(identity, {
        title: "Held for a decision",
        status: "waiting_for_review",
      });
      expect(task.status).toBe("waiting_for_review");
    });
  });
});
