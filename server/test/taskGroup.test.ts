import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { explicitRunTimeLimit } from "../src/modules/runs/runTimeLimit.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion } from "./support/domainSeeds.js";
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

  /**
   * `task_runs` and everything hanging off it is Run-derived: a Task is a
   * shared object, a Run inside a Room is not. These lists carry the content
   * predicate and the Room term. Do not drop the Room term. Dispatch refuses
   * a `session_id` that names a Room conversation, so no Room-scoped Run
   * reaches `task_runs`; the Room term on the list is the second of the two.
   */
  describe("task run-derived lists carry the Room boundary", () => {
    it("applies the Room term to runs, evaluations, proposals and artifacts", async () => {
      const db = new FakePool();
      const repository = new PgTaskRepository(db as never);
      const identity = { spaceId: "space-1", userId: "user-1" };
      await repository.listTaskRuns(identity, "task-1", 10, 0);
      await repository.listTaskEvaluations(identity, "task-1", 10, 0);
      await repository.listTaskProposals(identity, "task-1", 10, 0);
      await repository.listTaskArtifacts(identity, "task-1", 10, 0);

      for (const table of ["FROM task_runs", "FROM task_evaluations", "FROM task_proposals", "FROM task_artifacts"]) {
        const queries = db.queries.filter((query) => query.sql.includes(table));
        expect(queries.length, table).toBeGreaterThan(0);
        for (const query of queries) {
          expect(query.sql, table).toContain("room_user_members room_member");
        }
      }
    });
  });

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
    await resetTables(db.pool, ["tasks", "projects", "space_memberships", "users", "spaces"], { cascade: true });
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1, 'Task Contract Owner', 'active', $2, $2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
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

    it("gives a new Task run and cost defaults but no default time limit", async () => {
      if (!db.available) return;
      const repository = new PgTaskRepository(db.pool);
      const unlimited = await repository.createTask(identity, { title: "Long-running research" });
      expect(unlimited).toMatchObject({ max_runs: 3, max_cost: 10, max_duration_seconds: null });
      const limited = await repository.createTask(identity, { title: "Bounded check", max_duration_seconds: 600 });
      expect(limited.max_duration_seconds).toBe(600);
      const stored = await db.pool.query<{ id: string; max_duration_seconds: number | null }>(
        "SELECT id, max_duration_seconds FROM tasks WHERE id = ANY($1::text[]) ORDER BY max_duration_seconds NULLS FIRST",
        [[unlimited.id, limited.id]],
      );
      expect(stored.rows.map((row) => row.max_duration_seconds)).toEqual([null, 600]);
    });

    it("clears a stored time limit with null so the next Run has none", async () => {
      if (!db.available) return;
      const agent = randomUUID();
      await seedAgentWithVersion(db.pool, { agent, version: randomUUID(), space: SPACE, owner: OWNER });
      const repository = new PgTaskRepository(db.pool);
      const task = await repository.createTask(identity, { title: "Bounded then open", max_duration_seconds: 3600 });

      // Omitting the field keeps the stored limit.
      expect((await repository.updateTask(identity, task.id, { title: "Still bounded" })).max_duration_seconds).toBe(3600);
      // An explicit null is "no limit", not "unchanged".
      expect((await repository.updateTask(identity, task.id, { max_duration_seconds: null })).max_duration_seconds).toBeNull();
      const stored = await db.pool.query<{ max_duration_seconds: number | null }>(
        "SELECT max_duration_seconds FROM tasks WHERE id = $1",
        [task.id],
      );
      expect(stored.rows[0]?.max_duration_seconds).toBeNull();

      const created = await repository.createTaskRun(identity, task.id, { agent_id: agent });
      const runId = (created as { id: string }).id;
      const run = await db.pool.query<{ contract_snapshot_json: Record<string, unknown> }>(
        "SELECT contract_snapshot_json FROM runs WHERE id = $1",
        [runId],
      );
      expect(run.rows[0]?.contract_snapshot_json.max_duration_seconds).toBeNull();
      expect(explicitRunTimeLimit(run.rows[0]?.contract_snapshot_json, null)).toBeNull();
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
      // A Task can be `waiting_for_review`, the same hold a Run and a Plan Node
      // use. Do not leave a Task parked on a decision with no status for it.
      const repository = new PgTaskRepository(db.pool);
      const task = await repository.createTask(identity, {
        title: "Held for a decision",
        status: "waiting_for_review",
      });
      expect(task.status).toBe("waiting_for_review");
    });

    it("refuses new work in an archived Project, whatever the entry point", async () => {
      if (!db.available) return;
      const projectId = randomUUID();
      await db.pool.query(
        `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
         VALUES ($1, $2, 'Wrapped up', 'archived', $3, now(), now())`,
        [projectId, SPACE, OWNER],
      );
      const repository = new PgTaskRepository(db.pool);
      await expect(repository.createTask(identity, { title: "Late addition", project_id: projectId }))
        .rejects.toMatchObject({ statusCode: 409 });
      await db.pool.query(`UPDATE projects SET status = 'active' WHERE id = $1`, [projectId]);
      await expect(repository.createTask(identity, { title: "After reactivation", project_id: projectId }))
        .resolves.toMatchObject({ project_id: projectId });
    });
  });
});

describe("Task Run runtime authority", () => {
  it("rejects deployment and backend fields outside the selected Runtime Profile", async () => {
    const repository = new PgTaskRepository({} as never);
    const identity = { spaceId: "space-1", userId: "user-1" };

    for (const field of ["runtime_key", "installation", "model_provider_id", "model", "reasoning_effort"]) {
      await expect(repository.createTaskRun(identity, "task-1", { [field]: "caller-value" }))
        .rejects.toThrow(`${field} is owned by the selected Runtime Profile`);
    }
  });
});
