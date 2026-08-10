import { describe, expect, it } from "vitest";
import {
  ProposalAcceptDispatchRequestSchema,
  ProposalAcceptOutSchema,
  ProposalEgressApprovalDispatchRequestSchema,
  ProposalOutSchema,
  ProposalPageSchema,
  ProposalRejectDispatchRequestSchema,
} from "../src/index";

function proposal() {
  return {
    id: "proposal-1",
    space_id: "space-1",
    user_id: "user-1",
    workspace_id: null,
    source_session_id: null,
    source_task_id: null,
    source_run_id: null,
    created_by_run_id: null,
    proposal_type: "memory_create",
    target_scope: "",
    target_namespace: "",
    memory_type: "",
    proposed_title: "Remember this",
    proposed_content: "content",
    rationale: "",
    status: "pending",
    risk_level: "low",
    urgency: "normal",
    visibility: "space_shared",
    preview: false,
    review_deadline: null,
    expires_at: null,
    expired: false,
    created_at: "2026-06-14T10:00:00.000Z",
    decided_at: null,
    resulting_memory_id: null,
    owner_user_id: null,
    subject_user_id: null,
    sensitivity_level: null,
    access_level: "full",
    provenance_entries: null,
    source_activity_id: null,
    grant_id: null,
    required_approver_user_id: null,
    requires_approval_type: null,
    egress_approval_status: null,
    egress_approval_id: null,
    project_id: null,
  };
}

describe("proposal review contracts", () => {
  it("parses proposal read DTOs and pages", () => {
    const parsed = ProposalOutSchema.parse(proposal());
    expect(parsed.id).toBe("proposal-1");
    expect(
      ProposalPageSchema.parse({
        items: [parsed],
        total: 1,
        limit: 50,
        offset: 0,
      }).items,
    ).toHaveLength(1);
  });

  it("parses accept response variants", () => {
    const parsed = ProposalAcceptOutSchema.parse({
      proposal: { ...proposal(), status: "accepted" },
      result_type: "code_patch_apply",
      result: { updated_paths: ["README.md"] },
    });
    expect(parsed.result_type).toBe("code_patch_apply");

    expect(
      ProposalAcceptOutSchema.parse({
        proposal: { ...proposal(), status: "accepted", proposal_type: "claim_create" },
        result_type: "claim",
        result: { claim: { id: "claim-1" } },
      }).result_type,
    ).toBe("claim");

    expect(
      ProposalAcceptOutSchema.parse({
        proposal: { ...proposal(), status: "accepted", proposal_type: "object_relation_create" },
        result_type: "object_relation",
        result: { object_relation: { id: "relation-1" } },
      }).result_type,
    ).toBe("object_relation");

    expect(
      ProposalAcceptOutSchema.parse({
        proposal: { ...proposal(), status: "accepted", proposal_type: "object_profile_create" },
        result_type: "object_profile",
        result: { object_profile: { id: "kind-1" } },
      }).result_type,
    ).toBe("object_profile");

    expect(
      ProposalAcceptOutSchema.parse({
        proposal: { ...proposal(), status: "accepted", proposal_type: "memory_maintenance_packet" },
        result_type: "memory_maintenance_packet",
        result: {
          report_artifact_id: "artifact-1",
          generated_child_proposal_ids: [],
          canonical_write_performed: false,
        },
      }).result_type,
    ).toBe("memory_maintenance_packet");

    expect(
      ProposalAcceptOutSchema.parse({
        proposal: { ...proposal(), status: "accepted", proposal_type: "claim_candidate_packet" },
        result_type: "claim_candidate_packet",
        result: {
          packet_artifact_id: "artifact-claim-candidates",
          generated_child_proposal_ids: ["proposal-child-1"],
          generated_child_proposal_count: 1,
          canonical_write_performed: false,
        },
      }).result_type,
    ).toBe("claim_candidate_packet");
  });

  it("parses proposal dispatch requests", () => {
    expect(
      ProposalAcceptDispatchRequestSchema.parse({
        proposal_id: "proposal-1",
        space_id: "space-1",
        user_id: "user-1",
      }).confirm_incomplete_patch,
    ).toBe(false);
    expect(
      ProposalRejectDispatchRequestSchema.parse({
        proposal_id: "proposal-1",
        space_id: "space-1",
        user_id: "user-1",
      }).proposal_id,
    ).toBe("proposal-1");
    expect(
      ProposalEgressApprovalDispatchRequestSchema.parse({
        proposal_id: "proposal-1",
        space_id: "space-1",
        user_id: "user-1",
        grant_id: "grant-1",
      }).grant_id,
    ).toBe("grant-1");
  });
});
