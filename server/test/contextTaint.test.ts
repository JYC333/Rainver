import { describe, expect, it } from "vitest";
import {
  buildRunContextTaintSummary,
  outputVisibilityForTaint,
  hasProjectBoundRead,
  parseRunContextTaint,
  protectiveRunContextTaint,
} from "../src/modules/runs/contextTaint.js";
import { retrievalContextSourceAttribution } from "../src/modules/runtimeContext/productionAcquisition.js";

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

  it("reads an unparsable stored taint conservatively for the Run's protections, and only SQL NULL as untainted", () => {
    for (const [value, type] of [[null, "null"], [[], "array"], ["x", "string"], [{ schema_version: 2, narrowest_visibility: "private" }, "object"]] as const) {
      const taint = protectiveRunContextTaint(value, type);
      expect(taint?.narrowest_visibility, type).toBe("private");
      expect(hasProjectBoundRead(taint, ["core:gmail"]), type).toBe(true);
    }
    expect(protectiveRunContextTaint(null, null)).toBeNull();
    expect(protectiveRunContextTaint(undefined, undefined)).toBeNull();
    const valid = { schema_version: 1, narrowest_visibility: "space_shared" };
    expect(protectiveRunContextTaint(valid, "object")).toEqual(parseRunContextTaint(valid));
  });

  it("never reads malformed plugin read metadata as no reads", () => {
    const base = { schema_version: 1, narrowest_visibility: "private" };
    const unknown = [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: null }];
    for (const pluginReads of [{ plugin_id: "core:gmail" }, ["core:gmail"], [{ plugin_id: "core:gmail", data_class: "secret" }], [{ plugin_id: 7, data_class: "sensitive" }], null]) {
      const parsed = parseRunContextTaint({ ...base, plugin_reads: pluginReads });
      expect(parsed?.plugin_reads, JSON.stringify(pluginReads)).toEqual(unknown);
      expect(hasProjectBoundRead(parsed, ["core:gmail"])).toBe(true);
    }
    // Valid entries are kept as they are, alongside the unknown one an invalid sibling becomes.
    expect(parseRunContextTaint({ ...base, plugin_reads: [{ plugin_id: "plugin_x", data_class: "personal", owner_user_id: "u1" }, "junk"] })?.plugin_reads)
      .toEqual([...unknown, { plugin_id: "plugin_x", data_class: "personal", owner_user_id: "u1" }]);
    expect(parseRunContextTaint({ ...base, plugin_reads: [] })?.plugin_reads).toBeUndefined();
  });

  it("attributes retrieval taint from the canonical source, not the instructing user", () => {
    expect(retrievalContextSourceAttribution({
      ownerUserId: "user-b",
      visibility: "private",
    })).toEqual({ ownerUserId: "user-b", visibility: "private" });
    expect(retrievalContextSourceAttribution({
      ownerUserId: "user-b",
      visibility: "not-a-visibility",
    })).toEqual({ ownerUserId: "user-b", visibility: "private" });
  });
});
