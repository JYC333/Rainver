import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration";
import { registerAutomationsProjectIntegration } from "../src/modules/automations/projectIntegration";
import { projectModeProjectionRegistry } from "../src/modules/projects/overviewRegistry";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry";
import type { Queryable } from "../src/modules/routeUtils/common";

const identity = { spaceId: "space-1", userId: "user-1" };
const projectId = "project-1";

afterEach(() => {
  projectModeProjectionRegistry.__resetForTests();
  projectAttentionRegistry.__resetForTests();
});

describe("Project execution Mode adapters", () => {
  it("projects readable Project Tasks into Delivery overview and attention", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("content_access_grants");
      return {
        rows: [
          { id: "blocked", title: "Unblock release", status: "blocked", due_at: null, blocked_reason: "Waiting for approval" },
          { id: "overdue", title: "Publish release", status: "in_progress", due_at: "2020-01-01T00:00:00.000Z", blocked_reason: null },
          { id: "done", title: "Prepare release", status: "done", due_at: null, blocked_reason: null },
        ],
        rowCount: 3,
      };
    });
    const db = { query } as unknown as Queryable;
    registerTasksProjectIntegration();

    const adapter = projectModeProjectionRegistry.get("delivery");
    expect(adapter).not.toBeNull();
    await expect(adapter!.getOverviewProjection(db, identity, projectId)).resolves.toMatchObject({
      mode: "delivery",
      current_state_summary: "2 open Tasks; 1 blocked; 1 done",
      progress_indicators: [
        { metric: "open_tasks", value: 2 },
        { metric: "blocked_tasks", value: 1 },
        { metric: "completed_tasks", value: 1 },
      ],
    });

    const attention = projectAttentionRegistry.list().find(item => item.areaKind === "delivery");
    await expect(attention!.listAttentionItems(db, identity, projectId)).resolves.toEqual([
      expect.objectContaining({ source_id: "blocked", severity: "high", reason: "blocked" }),
      expect.objectContaining({ source_id: "overdue", severity: "normal", reason: "overdue" }),
    ]);
  });

  it("composes readable Automations, Runs, and alerts into Operations projections", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM automations")) {
        return { rows: [{ active: 2, paused: 1 }], rowCount: 1 };
      }
      if (sql.includes("FROM runs")) {
        expect(sql).toContain("content_access_grants");
        return { rows: [{ active: 3, failed: 1 }], rowCount: 1 };
      }
      if (sql.includes("FROM activity_records")) {
        expect(sql).toContain("content_access_grants");
        return {
          rows: [{
            id: "alert-1",
            title: "Automation stalled",
            content: "No heartbeat",
            occurred_at: "2026-07-24T00:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const db = { query } as unknown as Queryable;
    registerAutomationsProjectIntegration();

    const adapter = projectModeProjectionRegistry.get("operations");
    expect(adapter).not.toBeNull();
    await expect(adapter!.getOverviewProjection(db, identity, projectId)).resolves.toMatchObject({
      mode: "operations",
      current_state_summary: "2 active Automations; 3 active Runs; 1 alert",
      progress_indicators: [
        { metric: "active_automations", value: 2 },
        { metric: "active_runs", value: 3 },
        { metric: "failed_runs", value: 1 },
        { metric: "alerts", value: 1 },
      ],
    });

    const attention = projectAttentionRegistry.list().find(item => item.areaKind === "operations");
    await expect(attention!.listAttentionItems(db, identity, projectId)).resolves.toEqual([
      expect.objectContaining({
        source_type: "operational_alert",
        source_id: "alert-1",
        severity: "high",
      }),
    ]);
  });
});
