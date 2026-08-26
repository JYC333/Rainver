import { describe, expect, it } from "vitest";
import { PgSchedulerTaskStore } from "../src/modules/scheduler/taskStore.js";

class FakeSchedulerTaskDb {
  row: Record<string, unknown> | null = null;

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("SELECT") && norm.includes("WHERE task_type = $1 AND task_key = $2")) {
      return this.row && this.row.task_type === params[0] && this.row.task_key === params[1]
        ? { rows: [this.row as Row], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("SELECT") && norm.includes("AND status = 'active'")) {
      return this.row && this.row.task_type === params[0] && this.row.status === "active"
        ? { rows: [this.row as Row], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("INSERT INTO scheduler_tasks")) {
      this.row = {
        id: this.row?.id ?? params[0],
        task_type: params[1],
        task_key: params[2],
        scope_type: params[3],
        scope_id: params[4],
        space_id: params[5] ?? null,
        user_id: params[6] ?? null,
        status: params[7],
        next_run_at: params[8] ?? null,
        last_run_at: params[9] ?? this.row?.last_run_at ?? null,
        state_json: JSON.parse(String(params[10] ?? "{}")),
        created_at: this.row?.created_at ?? params[11],
        updated_at: params[11],
      };
      return { rows: [this.row as Row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("PgSchedulerTaskStore", () => {
  it("upserts and reads a typed scheduler task row", async () => {
    const store = new PgSchedulerTaskStore(new FakeSchedulerTaskDb());

    await store.upsert({
      taskType: "daily_capture_report",
      taskKey: "space-1:user-1",
      scopeType: "space_user",
      scopeId: "space-1:user-1",
      spaceId: "space-1",
      userId: "user-1",
      nextRunAt: "2026-06-17T09:00:00.000Z",
      stateJson: { last_report_date: "2026-06-16" },
    });
    const row = await store.get("daily_capture_report", "space-1:user-1");

    expect(row).toMatchObject({
      task_type: "daily_capture_report",
      task_key: "space-1:user-1",
      scope_type: "space_user",
      scope_id: "space-1:user-1",
      space_id: "space-1",
      user_id: "user-1",
      status: "active",
      state_json: { last_report_date: "2026-06-16" },
    });
  });

  it("lists due active tasks by task type", async () => {
    const store = new PgSchedulerTaskStore(new FakeSchedulerTaskDb());
    await store.upsert({
      taskType: "daily_capture_report",
      taskKey: "space-1:user-1",
      scopeType: "space_user",
      scopeId: "space-1:user-1",
      nextRunAt: "2026-06-17T09:00:00.000Z",
    });

    const rows = await store.listDue("daily_capture_report", "2026-06-17T09:00:00.000Z");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.task_key).toBe("space-1:user-1");
  });
});
