import { expect, it } from "vitest";
import { checkProposalApplyPolicy, type ProposalApplyInput } from "../src/modules/policy/gateway.js";

// The narrow owner-private approval (a plain member accepting their own Gmail monitor draft) is a gate
// branch that only an owner-only proposal type can reach. It must not raise any other proposal or role.
const supported = new Set(["gmail_monitor_create", "plan_review"]);
const input = (overrides: Partial<ProposalApplyInput> = {}): ProposalApplyInput => ({
  user_id: "u1", space_id: "s1", proposal_id: "p1", proposal_type: "gmail_monitor_create", declared_risk: "medium",
  proposal_payload: {}, ...overrides,
});

it("lets a member decide their own owner-only private draft, and nothing else", () => {
  expect(checkProposalApplyPolicy(input(), "member", supported)).toMatchObject({ decision: "require_approval", reason_code: "insufficient_role" });
  expect(checkProposalApplyPolicy(input({ private_owner_decision: true }), "member", supported)).toMatchObject({ decision: "allow", reason_code: "approved_private_owner" });
  // The flag on another type changes nothing.
  expect(checkProposalApplyPolicy(input({ proposal_type: "plan_review", private_owner_decision: true }), "member", supported))
    .toMatchObject({ decision: "require_approval", reason_code: "insufficient_role" });
  // Not a member, or an explicit approver role required: still refused.
  expect(checkProposalApplyPolicy(input({ private_owner_decision: true }), null, supported)).toMatchObject({ decision: "require_approval", reason_code: "no_membership" });
  expect(checkProposalApplyPolicy(input({ private_owner_decision: true, required_approver_role: "admin" }), "member", supported))
    .toMatchObject({ decision: "require_approval", reason_code: "insufficient_required_approver_role" });
});
