import { describe, expect, it } from "vitest";
import { classifyRequestableDecision } from "../src/modules/policy/authorizationRequestService.js";

function denied(action: string, metadata: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    space_id: "space-1",
    run_id: "run-1",
    actor_type: "agent",
    actor_id: "agent-1",
    action,
    resource_type: "resource",
    resource_id: "resource-1",
    decision: "deny",
    policy_rule_id: "managed_system_action_grant_required",
    policy_source: "builtin",
    metadata_json: {
      surface: "managed_run_system_action_gateway",
      ...metadata,
    },
  };
}

describe("authorization request denial classification", () => {
  it("keeps memory retrieval denials as hard boundaries", async () => {
    await expect(classifyRequestableDecision({
      ...denied("memory.retrieval.search"),
      policy_rule_id: "retrieval_tool_domain_enabled",
    })).resolves.toBeNull();
    await expect(classifyRequestableDecision({
      ...denied("memory.retrieval.brief"),
      policy_rule_id: "retrieval_tool_domain_enabled",
    })).resolves.toBeNull();
  });

  it("allows registry grantable actions and binds the audited action id", async () => {
    await expect(classifyRequestableDecision(denied(
      "project.source.bind",
      { action_id: "project.source.propose_bind" },
    ))).resolves.toEqual({ actionId: "project.source.propose_bind" });
  });

  it.each([
    "runtime.use_credential",
    "policy.action_grant.create",
    "proposal.apply",
    "deployment.execute",
    "unknown.action",
  ])("keeps %s as a hard boundary", async (action) => {
    await expect(classifyRequestableDecision(denied(action))).resolves.toBeNull();
  });

  it("rejects an action-id mismatch instead of selecting another grantable action", async () => {
    await expect(classifyRequestableDecision(denied(
      "project.source.bind",
      { action_id: "source.channel.propose_activation" },
    ))).resolves.toBeNull();
  });

  it("never turns hard-invariant or space-boundary denials into requests", async () => {
    await expect(classifyRequestableDecision({
      ...denied("memory.retrieval.search"),
      policy_source: "hard_invariant",
      policy_rule_id: "hard_invariant_cross_space_memory",
    })).resolves.toBeNull();
    await expect(classifyRequestableDecision({
      ...denied("project.source.bind", { action_id: "project.source.propose_bind" }),
      policy_rule_id: "space_boundary",
    })).resolves.toBeNull();
  });

  it.each([
    "retrieval_tool_viewer_required",
    "retrieval_tool_source_policy",
    "retrieval_tool_egress_policy",
    "configured_policy",
  ])("does not misclassify personal-memory policy rule %s as a share request", async (rule) => {
    await expect(classifyRequestableDecision({
      ...denied("memory.retrieval.search"),
      policy_rule_id: rule,
    })).resolves.toBeNull();
  });
});
