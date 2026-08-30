import { describe, expect, it } from "vitest";
import {
  AttachThreadReferencesRequestSchema,
  ThreadReferenceDisclosureRequiredSchema,
  ThreadReferencePickSchema,
  ThreadReferenceProvenanceSchema,
  ThreadReferenceSummaryUnavailableSchema,
} from "../src/threadReferences.js";

const ID = "11111111-1111-4111-8111-111111111111";
const pick = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "messages" as const, id: ID, item_ids: [`${ID.slice(0, -1)}${i % 10}`] }));

describe("thread reference contracts", () => {
  it("bounds an attach to one to twenty picks", () => {
    expect(AttachThreadReferencesRequestSchema.safeParse({ references: [] }).success).toBe(false);
    expect(AttachThreadReferencesRequestSchema.safeParse({ references: pick(20) }).success).toBe(true);
    expect(AttachThreadReferencesRequestSchema.safeParse({ references: pick(21) }).success).toBe(false);
  });

  it("bounds a pick to two hundred items and refuses unknown fields", () => {
    const ids = Array.from({ length: 201 }, () => ID);
    expect(ThreadReferencePickSchema.safeParse({ kind: "messages", id: ID, item_ids: ids.slice(0, 200) }).success).toBe(true);
    expect(ThreadReferencePickSchema.safeParse({ kind: "messages", id: ID, item_ids: ids }).success).toBe(false);
    expect(ThreadReferencePickSchema.safeParse({ kind: "messages", id: ID, extra: 1 }).success).toBe(false);
    expect(ThreadReferencePickSchema.safeParse({ kind: "bogus", id: ID }).success).toBe(false);
  });

  it("accepts a confirmation as the named people or a bare yes, and nothing else", () => {
    const base = { references: pick(1) };
    expect(AttachThreadReferencesRequestSchema.safeParse({ ...base, confirm_disclosure: [ID] }).success).toBe(true);
    expect(AttachThreadReferencesRequestSchema.safeParse({ ...base, confirm_disclosure: true }).success).toBe(true);
    expect(AttachThreadReferencesRequestSchema.safeParse({ ...base, confirm_disclosure: "yes" }).success).toBe(false);
  });

  it("shapes the two refusals the composer acts on by code", () => {
    // A confirmation that cannot name who is being let in is not informed
    // consent, so the disclosure refusal requires the list.
    expect(ThreadReferenceDisclosureRequiredSchema.safeParse({
      code: "reference_disclosure_confirmation_required", detail: "x", gains_access_user_ids: [ID],
    }).success).toBe(true);
    expect(ThreadReferenceDisclosureRequiredSchema.safeParse({
      code: "reference_disclosure_confirmation_required", detail: "x",
    }).success).toBe(false);
    expect(ThreadReferenceSummaryUnavailableSchema.safeParse({ code: "reference_summary_unavailable", detail: "x" }).success).toBe(true);
    expect(ThreadReferenceSummaryUnavailableSchema.safeParse({ code: "reference_summary_unavailable", detail: "" }).success).toBe(false);
  });

  it("records provenance strictly, with a nullable source Room and a trust label", () => {
    const provenance = {
      kind: "imported_session", source_id: ID, source_room_id: null, source_title: null,
      item_ids: [], trust: "external_untrusted", clipped: false, attached_by_user_id: ID,
      attached_at: "2026-08-29T00:00:00.000Z",
    };
    expect(ThreadReferenceProvenanceSchema.safeParse(provenance).success).toBe(true);
    expect(ThreadReferenceProvenanceSchema.safeParse({ ...provenance, trust: "user_confirmed" }).success).toBe(false);
    expect(ThreadReferenceProvenanceSchema.safeParse({ ...provenance, note: "extra" }).success).toBe(false);
  });
});
