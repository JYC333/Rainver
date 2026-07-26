import { describe, expect, it, vi } from "vitest";
import { PgTaskRepository } from "../src/modules/tasks/repository";
import type { TaskRow } from "../src/modules/tasks/taskRepositoryRows";

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    space_id: "space-1",
    project_folder_id: "workspace-1",
    project_id: null,
    board_id: null,
    column_id: null,
    parent_task_id: null,
    task_role: "source",
    title: "Task",
    description: null,
    task_type: "generic",
    status: "ready",
    priority: "normal",
    risk_level: "medium",
    owner_user_id: "user-1",
    visibility: "space_shared",
    access_level: "full",
    created_by_user_id: "user-1",
    created_by_agent_id: null,
    assigned_user_id: null,
    assigned_agent_id: "agent-1",
    claimed_by_user_id: null,
    claimed_by_agent_id: null,
    source_activity_id: null,
    source_run_id: null,
    source_proposal_id: null,
    source_artifact_id: null,
    due_at: null,
    start_after: null,
    completed_at: null,
    cancelled_at: null,
    blocked_reason: null,
    max_runs: null,
    created_at: "2026-06-26T00:00:00.000Z",
    updated_at: "2026-06-26T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("Task run context artifacts", () => {
  it("rejects unsupported context artifact ids before queueing the run", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push(normalized);
      if (normalized.startsWith("SELECT") && /FROM tasks/.test(normalized)) {
        return { rows: [taskRow()], rowCount: 1 };
      }
      if (/FROM artifacts/.test(normalized)) {
        return {
          rows: [
            {
              id: "artifact-1",
              artifact_type: "raw_runtime_log",
              title: "Raw log",
              content: "{}",
              metadata_json: {},
              visibility: "private",
              owner_user_id: "user-1",
              project_id: null,
              project_folder_id: null,
              created_at: "2026-06-26T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const pool = {
      query,
      async connect() {
        return { query, release() {} };
      },
    };

    await expect(
      new PgTaskRepository(pool as never).createTaskRun(
        { spaceId: "space-1", userId: "user-1" },
        "task-1",
        { context_artifact_ids: ["artifact-1"] },
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "context_artifact_ids invalid: artifact type is not attachable to context",
    });
    expect(calls).toContain("ROLLBACK");
    expect(calls.some((sql) => /INSERT INTO context_snapshots/.test(sql))).toBe(false);
    expect(calls.some((sql) => /INSERT INTO runs/.test(sql))).toBe(false);
  });
});
