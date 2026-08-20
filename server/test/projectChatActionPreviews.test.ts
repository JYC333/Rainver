import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/modules/routeUtils/common";
import { loadProjectChatActionPreviews } from "../src/modules/agents/projectChatActionPreviews";

describe("loadProjectChatActionPreviews", () => {
  it("deduplicates proposal events and projects failed action events", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(params).toEqual(["space-1", "run-1"]);
      if (sql.includes("FROM proposals")) {
        return { rows: [{
          id: "proposal-1",
          proposal_type: "source_backfill_start",
          title: "Start history import",
          status: "pending",
          risk_level: "high",
          payload_json: { action_id: "source.backfill.propose_start", project_id: "project-1" },
          action_idempotency_key: "call-1",
        }] };
      }
      return { rows: [
        { status: "succeeded", metadata_json: { action_id: "source.backfill.propose_start", tool_call_id: "call-1", ok: true } },
        { status: "failed", metadata_json: { action_id: "project.source.propose_bind", tool_call_id: "call-2", ok: false, error_code: "system_action_policy_denied" } },
        { status: "failed", metadata_json: null },
      ] };
    });

    await expect(loadProjectChatActionPreviews({ query } as unknown as Queryable, "space-1", "run-1")).resolves.toEqual([
      expect.objectContaining({ proposal_id: "proposal-1", status: "proposed", scope: { project_id: "project-1" } }),
      expect.objectContaining({ action_id: "project.source.propose_bind", status: "failed", summary: "system_action_policy_denied" }),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("projects a rejected proposal as status 'rejected', not 'failed'", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM proposals")) {
        return { rows: [{
          id: "proposal-2",
          proposal_type: "inquiry_conclusion",
          title: "Record conclusion",
          status: "rejected",
          risk_level: "medium",
          payload_json: { action_id: "inquiry.record_conclusion" },
          action_idempotency_key: "call-3",
        }] };
      }
      return { rows: [] };
    });

    await expect(loadProjectChatActionPreviews({ query } as unknown as Queryable, "space-1", "run-2")).resolves.toEqual([
      expect.objectContaining({ proposal_id: "proposal-2", status: "rejected" }),
    ]);
  });
});
