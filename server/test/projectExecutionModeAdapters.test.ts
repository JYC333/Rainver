import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration.js";
import { registerAutomationsProjectIntegration } from "../src/modules/automations/projectIntegration.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

const identity = { spaceId: "space-1", userId: "user-1" };
const projectId = "project-1";

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
});

describe("Project execution Mode adapters", () => {
  it("interrupts a person about readable Project Tasks that need them", async () => {
    // `responsible_user_id` is computed by the shared responsibility SQL, so a
    // fixture row carries the answer the database would have produced.
    const mine = { claimed_by_user_id: null, claimed_by_agent_id: null, assigned_user_id: identity.userId, assigned_agent_id: null, created_by_user_id: identity.userId, responsible_user_id: identity.userId, loop_stage: null };
    // Claimed by an Agent *and still being worked on*: the chain stops there,
    // so no person is responsible and nobody is interrupted.
    const agents = { claimed_by_user_id: null, claimed_by_agent_id: "agent-1", assigned_user_id: identity.userId, assigned_agent_id: null, created_by_user_id: identity.userId, responsible_user_id: null, loop_stage: "act" };
    // Claimed by an Agent but now waiting on a decision: the chain steps past
    // the Agent, because a state that means "a person has to decide" with no
    // person responsible is a Task that waits forever.
    const handedBack = { ...agents, responsible_user_id: identity.userId, loop_stage: "verify" };
    // Created by an Agent and never assigned: no person anywhere in the chain
    // except the Project owner, who is therefore the one interrupted.
    const orphan = { claimed_by_user_id: null, claimed_by_agent_id: null, assigned_user_id: null, assigned_agent_id: null, created_by_user_id: null, responsible_user_id: identity.userId, loop_stage: "verify" };
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("content_access_grants");
      return {
        rows: [
          { id: "waiting", title: "Confirm the approach", status: "waiting_for_review", due_at: null, blocked_reason: null, ...mine },
          { id: "blocked", title: "Unblock release", status: "blocked", due_at: null, blocked_reason: "Waiting for approval", ...mine },
          { id: "overdue", title: "Publish release", status: "in_progress", due_at: "2020-01-01T00:00:00.000Z", blocked_reason: null, ...mine },
          // Claimed by an Agent and still running: belongs in "the Agent is
          // working" and interrupts nobody, even though it is overdue.
          { id: "agent-running", title: "Regenerate the index", status: "in_progress", due_at: "2020-01-01T00:00:00.000Z", blocked_reason: null, ...agents },
          // Same claim, but now waiting on a decision: it must reach a person.
          { id: "agent-held", title: "Confirm the regenerated index", status: "waiting_for_review", due_at: null, blocked_reason: null, ...handedBack },
          { id: "agent-made", title: "Check the flaky test", status: "waiting_for_review", due_at: null, blocked_reason: null, ...orphan },
          { id: "done", title: "Prepare release", status: "done", due_at: null, blocked_reason: null, ...mine },
        ],
        rowCount: 6,
      };
    });
    const db = { query } as unknown as Queryable;
    registerTasksProjectIntegration();

    const attention = projectAttentionRegistry.list().find(item => item.areaKind === "delivery");
    await expect(attention!.listAttentionItems(db, identity, projectId)).resolves.toEqual([
      expect.objectContaining({ source_id: "waiting", severity: "high", reason: "waiting_for_review" }),
      expect.objectContaining({ source_id: "blocked", severity: "high", reason: "blocked" }),
      expect.objectContaining({ source_id: "overdue", severity: "normal", reason: "overdue" }),
      expect.objectContaining({ source_id: "agent-held", severity: "high", reason: "waiting_for_review" }),
      expect.objectContaining({ source_id: "agent-made", severity: "high", reason: "waiting_for_review" }),
    ]);
  });

  it("surfaces readable operational alerts as attention, read in the Space Inbox", async () => {
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
