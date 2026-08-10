import { describe, expect, it } from "vitest";
import {
  CrossSpaceEgressDisclosureRequestSchema,
  CrossSpaceRetrievalRequestSchema,
  PERSONAL_AGGREGATED_RESOURCE_TYPES,
  RETRIEVAL_OBJECT_TYPE_VALUES,
} from "../src/index";

describe("cross-Space retrieval contract", () => {
  it("keeps the intentional exception list explicit and complete", () => {
    expect(PERSONAL_AGGREGATED_RESOURCE_TYPES).toEqual(RETRIEVAL_OBJECT_TYPE_VALUES);
  });

  it("rejects repeated pointers in an egress disclosure", () => {
    expect(CrossSpaceEgressDisclosureRequestSchema.safeParse({ pointer_ids: ["p-1", "p-1"] }).success).toBe(false);
  });

  it("rejects repeated resource types in an aggregated search", () => {
    expect(CrossSpaceRetrievalRequestSchema.safeParse({
      query: "boundary",
      resource_types: ["knowledge_item", "knowledge_item"],
    }).success).toBe(false);
  });
});
