import { describe, expect, it } from "vitest";
import { projectBriefConversationProjection } from "../src/modules/runtimeContext/productionAcquisition";

describe("Project Brief model-visible projection", () => {
  it("keeps semantic definition fields and strips persistence/audit metadata", () => {
    const projected = projectBriefConversationProjection({
      id: "brief-1",
      version: "v3",
      status: "published",
      goal: "Build a reliable personal memory MVP",
      success_definition: "Beat the vector-only baseline",
      primary_mode: "research",
      created_at: "2026-08-17T19:00:00Z",
      reviewed_at: "2026-08-17T19:01:00Z",
      reviewed_by_user_id: "user-1",
      published_at: "2026-08-17T19:02:00Z",
      published_by_user_id: "user-1",
      confirmed_decisions: [],
      workspace_identity: {},
      source_refs: [],
    });

    expect(projected).toEqual({
      goal: "Build a reliable personal memory MVP",
      success_definition: "Beat the vector-only baseline",
      primary_mode: "research",
    });
    expect(JSON.stringify(projected)).not.toMatch(/created_at|reviewed|published|brief-1|v3/);
  });
});
