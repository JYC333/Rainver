import { describe, expect, it } from "vitest";
import {
  buildRunContextTaintSummary,
  outputVisibilityForTaint,
  parseRunContextTaint,
} from "../src/modules/runs/contextTaint.js";

describe("run context taint", () => {
  it("records the narrowest visibility and distinct non-instructing owners", () => {
    expect(buildRunContextTaintSummary({
      instructingUserId: "user-a",
      runVisibility: "space_shared",
      items: [
        { ownerUserId: "user-a", visibility: "selected_users" },
        { ownerUserId: "user-b", visibility: "private" },
        { ownerUserId: "user-b", visibility: "private" },
        { ownerUserId: "user-c", visibility: "space_shared" },
      ],
    })).toMatchObject({
      narrowest_visibility: "private",
      input_owner_user_ids: ["user-a", "user-b", "user-c"],
      non_instructing_owner_user_ids: ["user-b"],
    });
  });

  it("defaults cross-owner output to selected users and clamps same-owner output", () => {
    const crossOwner = buildRunContextTaintSummary({
      instructingUserId: "user-a",
      runVisibility: "space_shared",
      items: [{ ownerUserId: "user-b", visibility: "private" }],
    });
    expect(outputVisibilityForTaint({
      requestedVisibility: "space_shared", runVisibility: "space_shared", taint: crossOwner,
    })).toBe("selected_users");
    expect(outputVisibilityForTaint({
      requestedVisibility: "space_shared",
      runVisibility: "space_shared",
      taint: { ...crossOwner, non_instructing_owner_user_ids: [] },
    })).toBe("private");
  });

  it("rejects malformed persisted summaries", () => {
    expect(parseRunContextTaint({ schema_version: 2, narrowest_visibility: "private" })).toBeNull();
  });
});
