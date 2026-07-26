import { describe, expect, it } from "vitest";
import { OperationalAlertService } from "../src/modules/notifications/operationalAlerts";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common";

describe("operational failure alerts", () => {
  it("upserts a private Activity Inbox pointer for a scoped failure", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    await new OperationalAlertService(db).emit({
      kind: "job_exhausted",
      title: "Job failed permanently",
      message: "attempts exhausted",
      dedupeKey: "job_exhausted:job-1",
      spaceId: "space-1",
      userId: "user-1",
      projectId: "project-1",
      sourceRunId: "run-1",
      payload: { job_id: "job-1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO activity_records");
    expect(calls[0].sql).toContain("ON CONFLICT (space_id, aggregate_key)");
    expect(calls[0].sql).toContain("owner_user_id = EXCLUDED.owner_user_id");
    expect(calls[0].sql).toContain("project_id = EXCLUDED.project_id");
    expect(calls[0].params).toContain("project-1");
    expect(calls[0].params).toContain("run-1");
    expect(calls[0].sql).toContain("visibility = EXCLUDED.visibility");
    expect(calls[0].params).toContain("private");
    expect(calls[0].params).toContain("operational_alert:job_exhausted:job-1");
  });

  it("fans instance scheduler failures out to owners across all space types", async () => {
    let call = 0;
    const mutableInserts: unknown[][] = [];
    const db: Queryable = {
      async query<Row = Record<string, unknown>>(
        _sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> {
        call += 1;
        if (call === 1) {
          return {
            rows: [
              { space_id: "space-1", user_id: "user-1" },
              { space_id: "space-2", user_id: "user-2" },
            ] as Row[],
            rowCount: 2,
          };
        }
        mutableInserts.push([...params]);
        return { rows: [], rowCount: 1 };
      },
    };
    await new OperationalAlertService(db).emitInstance({
      kind: "scheduler_task_failed",
      title: "Scheduler task failed",
      message: "backup failed",
      dedupeKey: "scheduler_task_failed:backup_scheduler",
    });
    expect(mutableInserts).toHaveLength(2);
    expect(mutableInserts.map((params) => params[1])).toEqual(["space-1", "space-2"]);
  });
});
