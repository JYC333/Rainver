import { describe, expect, it } from "vitest";
import { enqueueDueSourceChannelScans } from "../src/modules/sources/scanSchedule.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

class DueScanDb implements Queryable {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    if (sql.includes("FROM scheduler_tasks")) {
      return {
        rows: [{
          id: "task-1",
          task_type: "source_channel_scan",
          task_key: "channel-1",
          scope_type: "space",
          scope_id: "space-1",
          space_id: "space-1",
          user_id: "user-1",
          status: "active",
          next_run_at: params[1],
          last_run_at: null,
          state_json: {},
          created_at: params[1],
          updated_at: params[1],
        }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT ch.id, ch.space_id")) {
      return {
        rows: [{ id: "channel-1", space_id: "space-1", source_connection_id: "conn-1" }] as Row[],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO extraction_jobs")) {
      return { rows: [] as Row[], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

describe("source due channel scheduler", () => {
  it("enqueues connection_scan jobs for due active scheduled channels", async () => {
    const db = new DueScanDb();

    await expect(enqueueDueSourceChannelScans(db, 10)).resolves.toBe(1);

    const insert = db.calls.find(call => call.sql.includes("INSERT INTO extraction_jobs"));
    expect(insert?.params[1]).toBe("space-1");
    expect(insert?.params[2]).toBe("conn-1");
    expect(JSON.parse(String(insert?.params[3]))).toEqual({ created_by: "scheduler", source_channel_id: "channel-1" });
  });

  it("skips manual, inactive, not-due, and already pending-running scan rows in the due query", async () => {
    const db = new DueScanDb();

    await enqueueDueSourceChannelScans(db, 10);

    const taskSelect = db.calls.find(call => call.sql.includes("FROM scheduler_tasks"))!.sql.replace(/\s+/g, " ");
    expect(taskSelect).toContain("task_type = $1");
    expect(taskSelect).toContain("next_run_at <= $2");
    expect(taskSelect).toContain("LIMIT $3");

    const sourceSelect = db.calls.find(call => call.sql.includes("SELECT ch.id, ch.space_id"))!.sql.replace(/\s+/g, " ");
    expect(sourceSelect).toContain("ch.status = 'active'");
    expect(sourceSelect).toContain("ch.fetch_frequency <> 'manual'");
    expect(sourceSelect).toContain("sc.handler_kind = 'built_in'");
    expect(sourceSelect).toContain("ej.job_type = 'connection_scan'");
    expect(sourceSelect).toContain("ej.status IN ('pending', 'running')");
  });
});
