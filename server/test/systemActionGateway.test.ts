import { describe, expect, it, vi } from "vitest";
import type { SystemActionId } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { SystemActionGateway } from "../src/modules/systemActions/gateway";

const context = {
  actor: { type: "agent" as const, space_id: "space-1", agent_id: "agent-1", run_id: "run-1" },
  visibility: "agent_tool" as const,
};

describe("SystemActionGateway", () => {
  it("fails closed for unknown and non-visible actions", async () => {
    const gateway = new SystemActionGateway(new Map(), async () => ({ allowed: true }));
    await expect(gateway.dispatch("missing.action.read", {}, context)).rejects.toMatchObject({ code: "unknown_system_action" });
    await expect(gateway.dispatch("source.recipe.activate", {}, context)).rejects.toMatchObject({ code: "system_action_actor_denied" });
  });

  it("enforces policy on every dispatch and validates output", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const enforce = vi.fn(async () => ({ allowed: true, policy_decision_record_id: "decision-1" }));
    const gateway = new SystemActionGateway(
      new Map([["retrieval.search" as SystemActionId, execute]]),
      enforce,
    );
    const result = await gateway.dispatch("retrieval.search", { query: "test" }, context);
    expect(result.policy_decision_record_id).toBe("decision-1");
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns a failed dispatch when policy denies", async () => {
    const execute = vi.fn();
    const onFailed = vi.fn();
    const gateway = new SystemActionGateway(
      new Map([["retrieval.search" as SystemActionId, execute]]),
      async () => ({ allowed: false, reason: "denied",policy_decision_record_id:"decision-denied" }),
      { onFailed },
    );
    await expect(gateway.dispatch("retrieval.search", {}, context)).rejects.toMatchObject({ code: "system_action_policy_denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({id:"retrieval.search"}),expect.objectContaining({code:"system_action_policy_denied"}),context);
    expect(onFailed.mock.calls[0]?.[1]).toMatchObject({policy_decision_record_id:"decision-denied"});
  });

  it("distinguishes an approval pause from a policy denial", async () => {
    const execute = vi.fn();
    const gateway = new SystemActionGateway(
      new Map([["retrieval.search" as SystemActionId, execute]]),
      async () => ({
        allowed: false,
        reason: "Review required",
        policy_decision_record_id: "decision-review",
        details: { status: "require_approval", error_code: "policy_requires_approval" },
      }),
    );

    await expect(gateway.dispatch("retrieval.search", {}, context)).rejects.toMatchObject({
      code: "system_action_approval_required",
      policy_decision_record_id: "decision-review",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires the canonical tool-call id for side-effecting actions", async () => {
    const gateway = new SystemActionGateway(new Map(), async () => ({ allowed: true }));
    await expect(gateway.dispatch(
      "source.channel.propose_activation",
      { provider_key: "rss", name: "Feed", query: {}, endpoint_url: "https://example.test/feed" },
      context,
    )).rejects.toMatchObject({ code: "system_action_idempotency_required" });
  });
});
