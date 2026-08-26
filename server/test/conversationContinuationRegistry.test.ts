import { describe, expect, it } from "vitest";
import {
  ConversationContinuationRegistry,
  type ContinuationProposal,
} from "../src/modules/proposals/continuationRegistry.js";
import { registerInquiryThreadContinuation } from "../src/modules/inquiry/inquiryThreadProposalApplier.js";
import { registerProjectDefinitionContinuation } from "../src/modules/projects/projectDefinitionProposalApplier.js";
import type { Queryable } from "../src/modules/proposals/repository.js";

// Unit coverage for the registry's own dispatch logic (plan:
// .agent/plans/room-advancement-reliability-plan.md, Phase 2) — the parts
// that never touch the database. Domain handler behavior (sibling counting,
// created-Thread lookup) is covered against real Postgres in roomsDb.test.ts.

const unusedDb = {
  query: async () => {
    throw new Error("this path must not query the database");
  },
} as unknown as Queryable;

function proposal(overrides: Partial<ContinuationProposal>): ContinuationProposal {
  return {
    id: "proposal-1",
    space_id: "space-1",
    project_id: "project-1",
    proposal_type: "some_unregistered_type",
    status: "accepted",
    proposed_title: "Some Proposal",
    payload_json: {},
    created_by_run_id: "run-1",
    ...overrides,
  };
}

describe("ConversationContinuationRegistry", () => {
  it("returns the shared rejected instruction regardless of proposal type, without consulting a handler", async () => {
    const registry = new ConversationContinuationRegistry();
    registry.register("project_brief_publish", () => {
      throw new Error("must not be called for a rejected proposal");
    });
    const result = await registry.resolve(unusedDb, proposal({
      proposal_type: "project_brief_publish",
      status: "rejected",
    }));
    expect(result).toMatchObject({
      directive: null,
      instruction: expect.stringContaining("rejected the preceding proposal"),
    });
  });

  it("renders the rejected instruction in Chinese when the title is Chinese", async () => {
    const registry = new ConversationContinuationRegistry();
    const result = await registry.resolve(unusedDb, proposal({
      status: "rejected",
      proposed_title: "定义 Agent Memory 项目",
    }));
    expect(result.instruction).toContain("用户已拒绝上一项方案");
  });

  it("falls back to the generic accepted instruction for an unregistered proposal type", async () => {
    const registry = new ConversationContinuationRegistry();
    const result = await registry.resolve(unusedDb, proposal({ status: "accepted" }));
    expect(result).toMatchObject({
      directive: null,
      instruction: expect.stringContaining("Confirm what was completed"),
    });
  });

  it("rejects a duplicate registration for the same proposal type", () => {
    const registry = new ConversationContinuationRegistry();
    registry.register("project_brief_publish", () => ({ directive: null, instruction: "x" }));
    expect(() => registry.register("project_brief_publish", () => ({ directive: null, instruction: "y" })))
      .toThrow(/already registered/);
  });

  it("wires both domain registrations without a naming collision", () => {
    const registry = new ConversationContinuationRegistry();
    expect(() => {
      registerInquiryThreadContinuation(registry);
      registerProjectDefinitionContinuation(registry);
    }).not.toThrow();
  });
});
