import { describe, expect, it } from "vitest";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants";

describe("buildRunToolGrants", () => {
  it("keeps a tool-free Run tool-free for network-isolated Docker CLI execution", async () => {
    await expect(buildRunToolGrants([], {})).resolves.toEqual([]);
  });

  it("returns the registry-backed intersection with action metadata", async () => {
    await expect(
      buildRunToolGrants(
        ["retrieval.search", "agent.delegate", "source.recipe.plan"],
        {
          allowed_tools: [
            "retrieval.search",
            "agent.delegate",
            "source.recipe.plan",
          ],
        },
      ),
    ).resolves.toEqual([
      {
        action_id: "authorization.request",
        capability_id: null,
        approval_behavior: "none",
        side_effecting: true,
      },
      {
        action_id: "retrieval.search",
        capability_id: null,
        approval_behavior: "none",
        side_effecting: false,
      },
      {
        action_id: "agent.delegate",
        capability_id: null,
        approval_behavior: "none",
        side_effecting: true,
      },
    ]);
  });

  it("fails closed for unknown, undeclared, and unpermitted actions", async () => {
    await expect(
      buildRunToolGrants(
        ["retrieval.search", "unknown.action"],
        { allowed_tools: ["agent.delegate", "unknown.action"] },
      ),
    ).resolves.toEqual([]);
  });

  it("fails closed for malformed or missing permission declarations", async () => {
    await expect(
      buildRunToolGrants(["agent.delegate"], null),
    ).resolves.toEqual([]);
    await expect(
      buildRunToolGrants(["agent.delegate"], { allowed_tools: "agent.delegate" }),
    ).resolves.toEqual([]);
  });
});
