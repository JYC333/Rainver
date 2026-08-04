import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { ExecutionGraphRecoveryService } from "../src/modules/execution/executionGraphRecoveryService";

const CONFIG = loadConfig({});

describe("ExecutionGraphRecoveryService", () => {
  it("isolates graph failures and continues reconciling other graphs", async () => {
    let query = 0;
    const db = {
      async query<Row>() {
        query += 1;
        return query === 1
          ? { rows: [{ id: "plan-1", space_id: "space-1", user_id: "user-1" }] as Row[], rowCount: 1 }
          : { rows: [{ id: "workflow-1", space_id: "space-1", user_id: "user-1" }] as Row[], rowCount: 1 };
      },
    };
    const alerts = { emit: vi.fn(async () => undefined) };
    const plan = vi.fn(async () => { throw new Error("transient plan failure"); });
    const workflow = vi.fn(async () => undefined);
    const result = await new ExecutionGraphRecoveryService(db, CONFIG, alerts, undefined, plan, workflow).reconcileActive();
    expect(result).toEqual({ plans: 0, workflows: 1, failures: 1 });
    expect(workflow).toHaveBeenCalledWith("space-1", "user-1", "workflow-1");
    expect(alerts.emit).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "execution_graph_recovery:plan:plan-1" }));
  });

  it("retries a graph on a later scan after a transient reconcile failure", async () => {
    const db = {
      async query<Row>(sql: string) {
        return sql.includes("FROM plans")
          ? { rows: [{ id: "plan-1", space_id: "space-1", user_id: "user-1" }] as Row[], rowCount: 1 }
          : { rows: [] as Row[], rowCount: 0 };
      },
    };
    let attempts = 0;
    const plan = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("post-finalization reconcile failed");
    });
    const alerts = { emit: vi.fn(async () => undefined) };
    const recovery = new ExecutionGraphRecoveryService(db, CONFIG, alerts, undefined, plan, vi.fn(async () => undefined));
    await expect(recovery.reconcileActive()).resolves.toEqual({ plans: 0, workflows: 0, failures: 1 });
    await expect(recovery.reconcileActive()).resolves.toEqual({ plans: 1, workflows: 0, failures: 0 });
    expect(plan).toHaveBeenCalledTimes(2);
  });
});
