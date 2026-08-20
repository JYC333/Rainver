import { describe, expect, it } from "vitest";
import {
  assertIncompleteCodePatchConfirmation,
  canRejectProposalWithRole,
  ProposalApplyHttpError,
} from "../src/modules/proposals/applyService";

describe("proposal apply service guards", () => {
  it("requires explicit confirmation before applying incomplete code patches", () => {
    expect(() => assertIncompleteCodePatchConfirmation(
      "code_patch",
      {
        incomplete_patch: true,
        skipped_changes: [{ path: "binary.dat", reason: "binary" }],
      },
      false,
    )).toThrow(ProposalApplyHttpError);

    try {
      assertIncompleteCodePatchConfirmation(
        "code_patch",
        {
          incomplete_patch: true,
          skipped_changes: [{ path: "binary.dat", reason: "binary" }],
        },
        false,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalApplyHttpError);
      expect((error as ProposalApplyHttpError).statusCode).toBe(422);
      expect((error as ProposalApplyHttpError).detail).toMatchObject({
        code: "incomplete_patch_requires_confirmation",
        skipped_changes: [{ path: "binary.dat", reason: "binary" }],
      });
    }

    expect(() => assertIncompleteCodePatchConfirmation(
      "code_patch",
      { incomplete_patch: true },
      true,
    )).not.toThrow();
    expect(() => assertIncompleteCodePatchConfirmation(
      "memory_create",
      { incomplete_patch: true },
      false,
    )).not.toThrow();
  });

  it("allows required approvers to reject proposals created by another user", () => {
    const ownerRequired = {
      created_by_user_id: "member-1",
      owner_user_id: "member-1",
      created_by_agent_id: null,
      required_approver_role: "owner",
    };
    expect(canRejectProposalWithRole(ownerRequired, "owner-1", "owner")).toBe(true);
    expect(canRejectProposalWithRole(ownerRequired, "admin-1", "admin")).toBe(false);
    expect(canRejectProposalWithRole(ownerRequired, "member-1", "member")).toBe(true);

    const noRequiredRole = {
      created_by_user_id: "member-1",
      owner_user_id: "member-1",
      created_by_agent_id: null,
      required_approver_role: null,
    };
    expect(canRejectProposalWithRole(noRequiredRole, "owner-1", "owner")).toBe(false);
    expect(canRejectProposalWithRole(noRequiredRole, "member-1", "member")).toBe(true);

    const agentAuthored = {
      created_by_user_id: null,
      owner_user_id: "member-1",
      created_by_agent_id: "agent-1",
      required_approver_role: null,
    };
    expect(canRejectProposalWithRole(agentAuthored, "member-1", "member")).toBe(true);
    expect(canRejectProposalWithRole(agentAuthored, "other-1", "member")).toBe(false);

    const ownerWithoutAgentAttribution = {
      ...agentAuthored,
      created_by_agent_id: null,
    };
    expect(canRejectProposalWithRole(ownerWithoutAgentAttribution, "member-1", "member")).toBe(false);
  });
});
