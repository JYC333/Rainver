import { SYSTEM_ACTION_REGISTRY, systemActionInputJsonSchema } from "@rainver/protocol";
import { describe, expect, it, vi } from "vitest";
import { loadProjectChatActionPreviews } from "../src/modules/agents/projectChatActionPreviews.js";
import { CONVERSATION_TOOL_ALLOWANCE, ROOM_CONVERSATION_TOOL_ALLOWANCE, conversationToolGrantInput } from "../src/modules/systemActions/scenarioToolAllowance.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

describe("projectChatActionPreviews", () => {
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
          { status: "failed", metadata_json: { action_id: "research.start_acquisition", tool_call_id: "call-3", ok: false, error_code: "system_action_failed", error_message: "No active Question Thread has id 'memory-classification'. Use one of these ids exactly: t-1 — Why?" } },
          { status: "failed", metadata_json: null },
        ] };
      });

      await expect(loadProjectChatActionPreviews({ query } as unknown as Queryable, "space-1", "run-1")).resolves.toEqual([
        expect.objectContaining({ proposal_id: "proposal-1", status: "proposed", scope: { project_id: "project-1" } }),
        expect.objectContaining({ action_id: "project.source.propose_bind", status: "failed", summary: "system_action_policy_denied" }),
        // The reason, when one was recorded, not just the code.
        expect.objectContaining({ action_id: "research.start_acquisition", status: "failed", summary: expect.stringContaining("Use one of these ids exactly: t-1") }),
      ]);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it("projects a rejected proposal as status 'rejected', not 'failed'", async () => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("FROM proposals")) {
          return { rows: [{
            id: "proposal-2",
            proposal_type: "knowledge_create",
            title: "Record conclusion",
            status: "rejected",
            risk_level: "medium",
            payload_json: { action_id: "inquiry.promote_knowledge" },
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
});

describe("projectChatToolPermissions", () => {
  describe("Project Chat tool permissions",()=>{
    // One allowance for every way a person talks to an Agent in a Project — a
    // Room message, a delegation, a direct chat. Direct chat used to keep its
    // own three-action list, so it could propose a Source and nothing else.
    it("gives a direct chat in a Project the same allowance a Room message gets",()=>{
      expect(conversationToolGrantInput({ project_id: "project-1" })).toEqual({
        capabilities_json: [...ROOM_CONVERSATION_TOOL_ALLOWANCE],
        scenario_tool_allowance: ROOM_CONVERSATION_TOOL_ALLOWANCE,
      });
      expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain("project.source.propose_bind");
      expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain("source.backfill.propose_start");
    });
    it("gives a chat outside any Project only what talking to someone allows",()=>{
      expect(conversationToolGrantInput({ project_id: null }).scenario_tool_allowance).toBe(CONVERSATION_TOOL_ALLOWANCE);
      expect(conversationToolGrantInput({ room_id: "room-1" }).scenario_tool_allowance).toBe(ROOM_CONVERSATION_TOOL_ALLOWANCE);
    });
    it("publishes required model fields for proposal tools, derived from the Zod that validates them",async ()=>{
      const definitionFor=(id:string)=>{
        const found=SYSTEM_ACTION_REGISTRY.find((definition)=>definition.id===id);
        if(!found) throw new Error(`Missing system action definition: ${id}`);
        return found;
      };
      expect(systemActionInputJsonSchema(definitionFor("project.source.propose_bind"))).toMatchObject({required:["source_channel_id"]});
      expect(systemActionInputJsonSchema(definitionFor("source.backfill.propose_start"))).toMatchObject({required:["source_channel_id","source_backfill_plan_id"]});
    });
  });
});
