import { describe, expect, it } from "vitest";
import { ProblemProjectionSchema, ProblemCloseRoundRequestSchema, ProblemWorkRequestSchema } from "../src/problemEngine.js";
const token = {
  method_version: "problem_solving.v1",
  expected_version: 1,
  expected_revision: 0,
  idempotency_key: "request"
};
describe("versioned problem work contract", () => {
  it("keeps pagination cursors as round-trip JSON integers", () => {
    const schema=ProblemProjectionSchema.pick({next_step_cursor:true,next_closeout_cursor:true});
    expect(schema.parse({next_step_cursor:3,next_closeout_cursor:null})).toEqual({next_step_cursor:3,next_closeout_cursor:null});
    expect(schema.safeParse({next_step_cursor:"3",next_closeout_cursor:null}).success).toBe(false);
  });
  it("accepts non-linear work with explicit skip provenance", () => {
    expect(ProblemWorkRequestSchema.safeParse({
      ...token,
      stage: "act",
      work_kind: "select_method",
      reason: "Known fix",
      selection_kind: "skip",
      skipped_stages: ["plan"]
    }).success).toBe(true);
    expect(ProblemWorkRequestSchema.safeParse({
      ...token,
      stage: "act",
      work_kind: "select_method",
      reason: "Known fix",
      selection_kind: "skip"
    }).success).toBe(false);
  });
  it("keeps cognition, Task status and execution identities out of a work write", () => {
    for (const field of ["answer_state", "status", "operation_id"]) {
      expect(ProblemWorkRequestSchema.safeParse({
        ...token,
        stage: "verify",
        work_kind: "record_work",
        reason: "Inspected",
        [field]: "value"
      }).success).toBe(false);
    }
  });
  it("requires expected versions and a reason for unchanged close-out", () => {
    expect(ProblemCloseRoundRequestSchema.safeParse({
      ...token,
      summary: "No new evidence"
    }).success).toBe(true);
    expect(ProblemCloseRoundRequestSchema.safeParse({
      ...token,
      summary: ""
    }).success).toBe(false);
    expect(ProblemCloseRoundRequestSchema.safeParse({
      ...token,
      expected_revision: undefined,
      summary: "No change"
    }).success).toBe(false);
  });
});
