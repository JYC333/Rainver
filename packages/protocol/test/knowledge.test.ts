import { describe, expect, it } from "vitest";
import {
  ClaimCandidatePacketCreateRequestSchema,
  ClaimCandidatePacketCreateResponseSchema,
  ClaimObjectProposalPayloadSchema,
  ClaimOutSchema,
  ClaimRelationOutSchema,
  ClaimSourceOutSchema,
  ClaimSummaryOutSchema,
  ObjectRelationOutSchema,
} from "../src/index";

describe("knowledge claim/object relation contracts", () => {
  it("parses Claim Candidate Packet creation contracts", () => {
    const request = ClaimCandidatePacketCreateRequestSchema.parse({
      source_artifact_ids: ["artifact-1"],
    });
    expect(request.max_candidates).toBe(40);
    expect(request.review_scope).toBe("private");
    expect(request.promote_private_sources_to_space_ops).toBe(false);

    const response = ClaimCandidatePacketCreateResponseSchema.parse({
      artifact_id: "artifact-2",
      proposal_id: "proposal-1",
      candidate_count: 3,
      source_artifact_count: 1,
      generated_child_proposal_count: 0,
    });
    expect(response.candidate_count).toBe(3);
  });

  it("parses claim read DTOs", () => {
    const source = ClaimSourceOutSchema.parse({
      id: "source-1",
      space_id: "space-1",
      claim_id: "claim-1",
      source_object_id: null,
      source_ref_type: "external_pointer",
      source_ref_id: "pointer-1",
      source_connection_id: "connection-1",
      source_policy_snapshot: {},
      locator: null,
      quote_excerpt: null,
      evidence_role: "supports",
      source_trust: "normal",
      confidence: 0.9,
      metadata: {},
      created_by_user_id: "user-1",
      created_at: "2026-06-24T10:00:00.000Z",
    });
    expect(source.source_connection_id).toBe("connection-1");

    const summary = ClaimSummaryOutSchema.parse({
      id: "claim-1",
      space_id: "space-1",
      subject_object_id: null,
      subject_text: "Retrieval",
      claim_kind: "fact",
      claim_text: "The retrieval embedding dimension is 2560.",
      normalized_claim_hash: "hash-1",
      confidence: 0.9,
      confidence_method: "human_confirmed",
      resolution_state: "confirmed",
      status: "active",
      visibility: "space_shared",
      title: "Embedding dimension",
      excerpt: null,
      primary_project_id: null,
      workspace_id: null,
      updated_at: "2026-06-24T10:00:00.000Z",
    });
    expect(summary.claim_kind).toBe("fact");

    expect(
      ClaimOutSchema.parse({
        ...summary,
        holder_object_id: null,
        holder_type: null,
        holder_id: null,
        valid_from: null,
        valid_until: null,
        observed_at: null,
        metadata: {},
        sources: [source],
        owner_user_id: "user-1",
        created_by_user_id: "user-1",
        created_by_agent_id: null,
        created_by_run_id: null,
        created_from_proposal_id: "proposal-1",
        approved_by_user_id: "user-1",
        created_at: "2026-06-24T10:00:00.000Z",
        archived_at: null,
      }).sources,
    ).toHaveLength(1);
  });

  it("parses relation DTOs", () => {
    expect(
      ClaimRelationOutSchema.parse({
        id: "claim-relation-1",
        space_id: "space-1",
        from_claim_id: "claim-1",
        to_claim_id: "claim-2",
        link_type: "supports",
        status: "active",
        confidence: 0.8,
        evidence_summary: null,
        source_proposal_id: null,
        created_by_user_id: "user-1",
        created_by_agent_id: null,
        created_at: "2026-06-24T10:00:00.000Z",
        updated_at: "2026-06-24T10:00:00.000Z",
      }).link_type,
    ).toBe("supports");

    expect(
      ObjectRelationOutSchema.parse({
        id: "object-relation-1",
        space_id: "space-1",
        from_object_id: "claim-1",
        to_object_id: "source-1",
        link_type: "source_for",
        status: "active",
        confidence: 0.8,
        evidence_summary: null,
        source_claim_id: "claim-1",
        source_object_id: "source-1",
        source_proposal_id: null,
        retrieval_projected: true,
        metadata: {},
        created_by_user_id: "user-1",
        created_by_agent_id: null,
        created_at: "2026-06-24T10:00:00.000Z",
        updated_at: "2026-06-24T10:00:00.000Z",
      }).link_type,
    ).toBe("source_for");
  });

  it("accepts only structured claim/object proposal packets", () => {
    expect(
      ClaimObjectProposalPayloadSchema.parse({
        operation: "claim_create",
        proposal_type: "claim_create",
        source_run_id: "run-1",
        created_by_run_id: "run-1",
        claim_kind: "fact",
        subject_text: "Retrieval",
        claim_text: "The retrieval embedding dimension is 2560.",
        sources: [
          {
            source_ref_type: "external_pointer",
            source_ref_id: "pointer-1",
            source_connection_id: "connection-1",
          },
        ],
      }).operation,
    ).toBe("claim_create");

    expect(() =>
      ClaimObjectProposalPayloadSchema.parse({
        operation: "claim_create",
        claim_kind: "fact",
        subject_text: "Retrieval",
        claim_text: "The retrieval embedding dimension is 2560.",
        sources: [
          {
            source_ref_type: "external_pointer",
            source_ref_id: "pointer-1",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      ClaimObjectProposalPayloadSchema.parse({
        operation: "claim_create",
        claim_kind: "fact",
        subject_text: "Retrieval",
        claim_text: "The retrieval embedding dimension is 2560.",
        status: "archived",
      }),
    ).toThrow();

    expect(() =>
      ClaimObjectProposalPayloadSchema.parse({
        operation: "claim_create",
        claim_kind: "fact",
        subject_text: "Retrieval",
        claim_text: "The retrieval embedding dimension is disputed.",
        status: "disputed",
        resolution_state: "confirmed",
      }),
    ).toThrow();

    expect(
      ClaimObjectProposalPayloadSchema.parse({
        operation: "claim_update",
        target_claim_id: "claim-1",
        status: "superseded",
        superseded_by_claim_id: "claim-2",
      }).operation,
    ).toBe("claim_update");

    expect(() =>
      ClaimObjectProposalPayloadSchema.parse({
        operation: "object_relation_create",
        from_object_id: "claim-1",
        to_object_id: "source-1",
        link_type: "source_for",
        status: "archived",
      }),
    ).toThrow();

    expect(() =>
      ClaimObjectProposalPayloadSchema.parse({
        operation: "claim_create",
        claim_kind: "fact",
        subject_text: "Retrieval",
        claim_text: "The retrieval embedding dimension is 2560.",
        accidental_freeform_field: "not allowed",
      }),
    ).toThrow();
  });
});
