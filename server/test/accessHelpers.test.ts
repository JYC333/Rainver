import { describe, expect, it } from "vitest";
import { isKnownSpaceRole, isSpaceOwnerOrAdmin } from "../src/modules/access/roles.js";
import { decideContentAccess } from "../src/modules/access/contentAccessPolicy.js";
import { contentResourceDefinition } from "../src/modules/access/contentAccessRegistry.js";
import { contentAccessLevelSql, contentAccessSql } from "../src/modules/access/contentAccessSql.js";

const resource = {
  id: "resource-1",
  space_id: "space-1",
  owner_user_id: "owner-1",
  visibility: "private",
  access_level: "full",
  project_folder_id: null,
  project_id: null,
};

const context = {
  spaceId: "space-1",
  userId: "viewer-1",
  activeSpaceMember: true,
  scopeAllowed: true,
};

describe("content access", () => {
  it("applies the canonical visibility and disclosure matrix", () => {
    expect(decideContentAccess({ ...resource, owner_user_id: "viewer-1" }, context)).toBe("full");
    expect(decideContentAccess(resource, context)).toBe("deny");
    expect(decideContentAccess({ ...resource, visibility: "space_shared" }, context)).toBe("full");
    expect(decideContentAccess({ ...resource, visibility: "space_shared", access_level: "summary" }, context)).toBe("summary");
    expect(decideContentAccess(
      { ...resource, visibility: "selected_users" },
      context,
      [{ grantee_user_id: "viewer-1", access_level: "full", revoked_at: null }],
    )).toBe("full");
    expect(decideContentAccess(
      { ...resource, visibility: "selected_users" },
      context,
      [{ grantee_user_id: "viewer-1", access_level: "summary", revoked_at: null }],
    )).toBe("summary");
  });

  it("fails closed before visibility for membership, scope, space, and unknown values", () => {
    expect(decideContentAccess({ ...resource, visibility: "space_shared" }, { ...context, activeSpaceMember: false })).toBe("deny");
    expect(decideContentAccess({ ...resource, visibility: "space_shared" }, { ...context, scopeAllowed: false })).toBe("deny");
    expect(decideContentAccess({ ...resource, visibility: "space_shared" }, { ...context, spaceId: "space-2" })).toBe("deny");
    expect(decideContentAccess({ ...resource, visibility: "unknown" }, context)).toBe("deny");
    expect(decideContentAccess({ ...resource, access_level: "unknown" }, context)).toBe("deny");
  });

  it("does not treat an administrator role as a read bypass when no oversight context is supplied", () => {
    // A context with no oversightLevel is the byte-identical "today" behavior:
    // decideContentAccess defaults oversight to 'none', so a bare admin role
    // (with nothing granting oversight) still denies private content it does
    // not own. The oversight-mode bypass is opt-in via context.oversightLevel,
    // exercised separately in contentAccessPolicy.test.ts and
    // contentAccessEquivalence.test.ts.
    expect(isKnownSpaceRole("admin")).toBe(true);
    expect(isSpaceOwnerOrAdmin("admin")).toBe(true);
    expect(decideContentAccess(resource, context)).toBe("deny");
    expect(decideContentAccess(resource, { ...context, oversightLevel: "none" })).toBe("deny");
  });

  it("builds one SQL predicate for membership, scope, owner, sharing, grants, and oversight", () => {
    const definition = contentResourceDefinition("artifact")!;
    const predicate = contentAccessSql({ definition, alias: "a", userExpr: "$2" });
    expect(predicate).toContain("space_memberships content_member");
    expect(predicate).toContain("content_member.status = 'active'");
    // The SQL builder also rejects malformed persisted values, keeping its
    // result fail-closed like decideContentAccess.
    expect(predicate).toContain("a.visibility IN ('private', 'space_shared', 'selected_users')");
    expect(predicate).toContain("a.access_level IN ('full', 'summary')");
    expect(predicate).toContain("a.visibility = 'space_shared'");
    expect(predicate).toContain("a.visibility = 'selected_users'");
    expect(predicate).toContain("a.owner_user_id = $2");
    expect(predicate).toContain("content_access_grants content_grant");
    expect(predicate).toContain("project_members content_project_member");
    expect(predicate).toContain("project_folders folder_access_folder");
    // The oversight branch is a documented exception (Space owner/admin, only
    // when the Space's oversight_mode <> 'none'), not an unconditional admin
    // bypass — see contentOversightEligibleSql. Assert its exact shape instead
    // of asserting "admin" is absent from the predicate.
    expect(predicate).toContain("spaces content_oversight_space");
    expect(predicate).toContain("content_oversight_space.oversight_mode <> 'none'");
    expect(predicate).toContain("content_oversight_member.role IN ('owner', 'admin')");
    expect(contentAccessLevelSql({ definition, alias: "a", userExpr: "$2" })).toContain("access_level = 'summary'");
  });

  it("omits the oversight branch entirely when a caller opts out (includeOversight: false)", () => {
    // publicSummaryGenerator.ts uses this: its candidate queries must never
    // let an oversight admin's own extra visibility leak into a space-wide
    // published artifact.
    const definition = contentResourceDefinition("artifact")!;
    const predicate = contentAccessSql({ definition, alias: "a", userExpr: "$2", includeOversight: false });
    expect(predicate).not.toContain("content_oversight_space");
    expect(predicate).not.toContain("content_oversight_member");
    const levelSql = contentAccessLevelSql({ definition, alias: "a", userExpr: "$2", includeOversight: false });
    expect(levelSql).not.toContain("content_oversight_level_space");
    expect(levelSql).not.toContain("content_oversight_level_member");
  });
});
