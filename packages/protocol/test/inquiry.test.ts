import { describe, expect, it } from "vitest";
import {
  InquiryCandidateDecisionRequestSchema,
  InquiryCandidateSchema,
  InquiryCreateSignalRequestSchema,
  InquiryLifecycleTransitionRequestSchema,
  InquiryThreadSchema,
} from "../src/inquiry.js";

describe("Inquiry protocol", () => {
  it("accepts the stable Thread and Candidate wire shapes", () => {
    expect(InquiryThreadSchema.parse({
      id: "thread-1",
      space_id: "space-1",
      project_id: "project-1",
      kind: "question",
      statement: "What changed?",
      lifecycle_status: "active",
      attention_state: "backlog",
      priority: 0,
      primary_parent_id: null,
      owner_user_id: null,
      next_focus_kind: null,
      next_focus_note: null,
      blocked_reason: null,
      version: 1,
      created_from: "user",
      created_by_user_id: "user-1",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
    }).id).toBe("thread-1");

    expect(InquiryCandidateSchema.parse({
      id: "candidate-1",
      space_id: "space-1",
      project_id: "project-1",
      thread_id: "thread-1",
      candidate_kind: "contradiction",
      semantic_key: "claim-1",
      title: "Contradiction",
      summary: null,
      proposed_change: { evaluation_state: "challenged" },
      status: "pending",
      review_packet_id: null,
      resulting_iteration_id: null,
      resulting_thread_id: null,
      merged_into_candidate_id: null,
      decision_reason: null,
      defer_until: null,
      decided_by_user_id: null,
      decided_at: null,
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
    }).status).toBe("pending");
  });

  it("rejects invalid Signal confidence, decisions, and lifecycle transitions", () => {
    expect(InquiryCreateSignalRequestSchema.safeParse({
      corpus_item_id: "corpus-1",
      classification: "supports",
      confidence: 1.01,
    }).success).toBe(false);
    expect(InquiryCandidateDecisionRequestSchema.safeParse({ decision: "overwrite" }).success).toBe(false);
    expect(InquiryLifecycleTransitionRequestSchema.safeParse({ lifecycle_status: "superseded" }).success).toBe(false);
  });
});
