import { describe, expect, it } from "vitest";
import {
  memoryAccessDecision,
  shouldRedactMemoryContent,
  type MemoryAuthFields,
} from "../src/modules/memory/memoryReadAuth";

function memory(overrides: Partial<MemoryAuthFields> = {}): MemoryAuthFields {
  return {
    id: "memory-1",
    space_id: "space-1",
    deleted_at: null,
    sensitivity_level: "normal",
    visibility: "private",
    access_level: "full",
    owner_user_id: "owner-1",
    scope_type: "user",
    ...overrides,
  };
}

describe("memory content access adapter", () => {
  it("delegates visibility and grant decisions to canonical content access", () => {
    const ctx = { userId: "viewer-1", spaceId: "space-1" };
    expect(memoryAccessDecision(memory(), ctx)).toBe("deny");
    expect(memoryAccessDecision(memory({ owner_user_id: "viewer-1" }), ctx)).toBe("full");
    expect(memoryAccessDecision(memory({ visibility: "space_shared", access_level: "summary" }), ctx)).toBe("summary");
    expect(memoryAccessDecision(memory({
      visibility: "selected_users",
      content_access_grants: [{ grantee_user_id: "viewer-1", access_level: "full", revoked_at: null }],
    }), ctx)).toBe("full");
  });

  it("rejects invalid scopes and applies sensitivity restrictions", () => {
    const ctx = { userId: "viewer-1", spaceId: "space-1" };
    expect(memoryAccessDecision(memory({ visibility: "space_shared", scope_type: "agent" }), ctx)).toBe("deny");
    expect(memoryAccessDecision(memory({ visibility: "space_shared", scope_type: "project_folder" }), ctx)).toBe("deny");
    expect(memoryAccessDecision(memory({ visibility: "space_shared", sensitivity_level: "highly_restricted" }), ctx)).toBe("deny");
    expect(memoryAccessDecision(memory({ owner_user_id: "viewer-1", sensitivity_level: "highly_restricted" }), ctx)).toBe("full");
    expect(memoryAccessDecision(memory({ visibility: "space_shared", deleted_at: "2026-01-01T00:00:00Z" }), ctx)).toBe("deny");
  });

  it("redacts content from non-owners when the effective level is summary", () => {
    expect(shouldRedactMemoryContent(memory({ effective_access_level: "summary" }), "viewer-1")).toBe(true);
    expect(shouldRedactMemoryContent(memory({ effective_access_level: "full" }), "viewer-1")).toBe(false);
    expect(shouldRedactMemoryContent(memory({ owner_user_id: "viewer-1", access_level: "summary" }), "viewer-1")).toBe(false);
  });

  describe("highly_restricted sensitivity gate under Space oversight", () => {
    const restricted = memory({ visibility: "private", sensitivity_level: "highly_restricted" });

    it.each(["none", "summary", "content"] as const)(
      "oversightLevel=%s still denies a non-owner viewer — only 'full' pierces the sensitivity gate",
      (oversightLevel) => {
        const ctx = { userId: "viewer-1", spaceId: "space-1", oversightLevel };
        expect(memoryAccessDecision(restricted, ctx)).toBe("deny");
      },
    );

    it("oversightLevel='full' pierces the sensitivity gate for a non-owner viewer", () => {
      const ctx = { userId: "viewer-1", spaceId: "space-1", oversightLevel: "full" as const };
      expect(memoryAccessDecision(restricted, ctx)).toBe("full");
    });

    it("omitted oversightLevel denies — fail closed, same as 'none'", () => {
      expect(memoryAccessDecision(restricted, { userId: "viewer-1", spaceId: "space-1" })).toBe("deny");
    });

    it("an explicit selected_users grant never pierces the sensitivity gate, even at access_level='full'", () => {
      const granted = memory({
        visibility: "selected_users",
        sensitivity_level: "highly_restricted",
        content_access_grants: [{ grantee_user_id: "viewer-1", access_level: "full", revoked_at: null }],
      });
      expect(memoryAccessDecision(granted, { userId: "viewer-1", spaceId: "space-1" })).toBe("deny");
      // Even under full oversight, the row is still selected_users/ungranted-for-oversight-purposes
      // vs. an active grant — the sensitivity gate keys off oversightLevel, not the grant, so a grant
      // alone (no oversight) must still deny.
      expect(memoryAccessDecision(granted, { userId: "viewer-1", spaceId: "space-1", oversightLevel: "content" })).toBe("deny");
    });

    it("the owner is always exempt from the sensitivity gate, regardless of oversightLevel", () => {
      const own = memory({ owner_user_id: "viewer-1", sensitivity_level: "highly_restricted" });
      expect(memoryAccessDecision(own, { userId: "viewer-1", spaceId: "space-1" })).toBe("full");
    });
  });
});
