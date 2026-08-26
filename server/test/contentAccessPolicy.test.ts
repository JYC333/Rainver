import { describe, expect, it } from "vitest";
import { decideContentAccess } from "../src/modules/access/contentAccessPolicy.js";
import type {
  ContentAccessContext,
  ContentAccessDecision,
  ContentAccessGrant,
  ContentAccessResource,
  OversightMode,
} from "../src/modules/access/contentAccessTypes.js";

const OWNER = "owner-1";
const MEMBER = "member-1";
const GRANTEE = "grantee-1";
const GRANTEE_SUMMARY = "grantee-summary-1";
const ADMIN = "admin-1";
const INACTIVE = "inactive-1";
const CROSS_SPACE = "cross-space-1";

function resource(overrides: Partial<ContentAccessResource> = {}): ContentAccessResource {
  return {
    id: "resource-1",
    space_id: "space-1",
    owner_user_id: OWNER,
    visibility: "private",
    access_level: "full",
    ...overrides,
  };
}

function context(userId: string, overrides: Partial<ContentAccessContext> = {}): ContentAccessContext {
  return {
    spaceId: "space-1",
    userId,
    activeSpaceMember: true,
    scopeAllowed: true,
    ...overrides,
  };
}

function grant(accessLevel: "full" | "summary" = "full"): ContentAccessGrant {
  return { grantee_user_id: GRANTEE, access_level: accessLevel, revoked_at: null };
}

describe("content access policy matrix (member/grant, no oversight)", () => {
  it.each([
    ["private", "full", OWNER, [], "full"],
    ["private", "full", MEMBER, [], "deny"],
    ["space_shared", "full", MEMBER, [], "full"],
    ["space_shared", "summary", MEMBER, [], "summary"],
    // space_shared grants are per-user disclosure upgrades (Decision Matrix row C).
    ["space_shared", "summary", GRANTEE, [grant("full")], "full"],
    ["space_shared", "summary", GRANTEE, [grant("summary")], "summary"],
    ["space_shared", "full", GRANTEE, [grant("summary")], "full"],
    ["selected_users", "full", MEMBER, [], "deny"],
    ["selected_users", "full", GRANTEE, [grant("full")], "full"],
    // selected_users grants are authoritative — no longer narrowed by the
    // resource's own access_level (semantic change vs. the pre-upgrade model).
    ["selected_users", "summary", GRANTEE, [grant("full")], "full"],
    ["selected_users", "full", GRANTEE, [grant("summary")], "summary"],
  ] as const)(
    "%s/%s for %s resolves to %s",
    (visibility, accessLevel, userId, grants, expected) => {
      expect(decideContentAccess(
        resource({ visibility, access_level: accessLevel }),
        context(userId),
        grants,
      )).toBe(expected);
    },
  );

  it.each([
    [context(MEMBER, { activeSpaceMember: false }), "inactive member"],
    [context(MEMBER, { scopeAllowed: false }), "out-of-scope member"],
    [context(MEMBER, { spaceId: "space-2" }), "cross-space member"],
  ])("denies a %s", (viewer) => {
    expect(decideContentAccess(
      resource({ visibility: "space_shared" }),
      viewer,
    )).toBe("deny");
  });

  it("ignores revoked grants", () => {
    expect(decideContentAccess(
      resource({ visibility: "selected_users" }),
      context(GRANTEE),
      [{ ...grant(), revoked_at: "2026-01-01T00:00:00.000Z" }],
    )).toBe("deny");
  });

  it("fails closed for unknown visibility/access_level", () => {
    expect(decideContentAccess(resource({ visibility: "unknown" }), context(MEMBER))).toBe("deny");
    expect(decideContentAccess(resource({ access_level: "unknown" }), context(MEMBER))).toBe("deny");
  });
});

describe("admin/owner role is not an implicit read bypass", () => {
  it("denies without an oversightLevel in context — today's (pre-oversight) behavior, byte-identical", () => {
    expect(decideContentAccess(resource(), context(ADMIN))).toBe("deny");
  });

  it("denies when oversightLevel is explicitly 'none'", () => {
    expect(decideContentAccess(resource(), context(ADMIN, { oversightLevel: "none" }))).toBe("deny");
  });

  it.each(["summary", "content", "full"] as const)(
    "oversightLevel=%s (only ever set by the caller for an eligible owner/admin) is not denied — this is the one documented exception, not a blanket admin bypass",
    (mode) => {
      expect(decideContentAccess(resource(), context(ADMIN, { oversightLevel: mode }))).not.toBe("deny");
    },
  );
});

describe("space oversight widening (Decision Matrix row D/E)", () => {
  it.each([
    ["none", "deny"],
    ["summary", "summary"],
    ["content", "full"],
    ["full", "full"],
  ] as const)("oversight_mode=%s over another member's private content resolves to %s", (mode, expected) => {
    expect(decideContentAccess(
      resource({ visibility: "private" }),
      context(MEMBER, { oversightLevel: mode }),
    )).toBe(expected);
  });

  it.each([
    ["none", "deny"],
    ["summary", "summary"],
    ["content", "full"],
    ["full", "full"],
  ] as const)("oversight_mode=%s over an ungranted selected_users resource resolves to %s", (mode, expected) => {
    expect(decideContentAccess(
      resource({ visibility: "selected_users" }),
      context(MEMBER, { oversightLevel: mode }),
    )).toBe(expected);
  });

  it("omitted oversightLevel defaults to 'none' — fail closed", () => {
    expect(decideContentAccess(resource({ visibility: "private" }), context(MEMBER))).toBe("deny");
  });

  it("widest-wins: an active full grant beats a lower/no oversight level", () => {
    expect(decideContentAccess(
      resource({ visibility: "selected_users" }),
      context(GRANTEE, { oversightLevel: "summary" }),
      [grant("full")],
    )).toBe("full");
  });

  it("widest-wins: oversight beats a lower or absent grant", () => {
    expect(decideContentAccess(
      resource({ visibility: "selected_users" }),
      context(GRANTEE, { oversightLevel: "full" }),
      [grant("summary")],
    )).toBe("full");
    expect(decideContentAccess(
      resource({ visibility: "selected_users" }),
      context(MEMBER, { oversightLevel: "content" }),
      [],
    )).toBe("full");
  });

  it("owner access is unaffected by oversight (owner is always 'full' regardless)", () => {
    expect(decideContentAccess(
      resource({ visibility: "private" }),
      context(OWNER, { oversightLevel: "none" }),
    )).toBe("full");
  });

  it.each<[ContentAccessResource["visibility"], "full" | "summary", OversightMode, ContentAccessDecision]>([
    ["space_shared", "summary", "none", "summary"],
    ["space_shared", "summary", "summary", "summary"],
    ["space_shared", "summary", "content", "full"],
    ["space_shared", "full", "none", "full"],
  ])("oversight_mode=%3$s over space_shared/%2$s resolves to %4$s", (visibility, accessLevel, oversightLevel, expected) => {
    expect(decideContentAccess(
      resource({ visibility, access_level: accessLevel }),
      context(MEMBER, { oversightLevel }),
    )).toBe(expected);
  });
});

describe("complete oversight and grant matrix", () => {
  const visibilities = ["private", "space_shared", "selected_users"] as const;
  const levels = ["full", "summary"] as const;
  const modes = ["none", "summary", "content", "full"] as const;
  const viewers = [OWNER, MEMBER, GRANTEE, GRANTEE_SUMMARY, ADMIN, INACTIVE, CROSS_SPACE] as const;
  const grants = [
    grant("full"),
    { grantee_user_id: GRANTEE_SUMMARY, access_level: "summary", revoked_at: null },
  ];

  function expected(
    mode: OversightMode,
    visibility: ContentAccessResource["visibility"],
    accessLevel: "full" | "summary",
    viewer: (typeof viewers)[number],
  ): ContentAccessDecision {
    if (viewer === INACTIVE || viewer === CROSS_SPACE) return "deny";
    if (viewer === OWNER) return "full";

    let ordinary: ContentAccessDecision = "deny";
    if (visibility === "space_shared") ordinary = accessLevel;
    if (viewer === GRANTEE) {
      if (visibility === "space_shared") ordinary = "full";
      if (visibility === "selected_users") ordinary = "full";
    }
    if (viewer === GRANTEE_SUMMARY) {
      if (visibility === "space_shared") ordinary = accessLevel;
      if (visibility === "selected_users") ordinary = "summary";
    }

    const oversight = viewer === ADMIN
      ? mode === "summary"
        ? "summary"
        : mode === "content" || mode === "full"
          ? "full"
          : "deny"
      : "deny";
    return ordinary === "full" || oversight === "full"
      ? "full"
      : ordinary === "summary" || oversight === "summary"
        ? "summary"
        : "deny";
  }

  it.each(modes.flatMap((mode) =>
    visibilities.flatMap((visibility) =>
      levels.flatMap((accessLevel) => viewers.map((viewer) => ({ mode, visibility, accessLevel, viewer }))),
    ),
  ))(
    "$mode: $viewer reading $visibility/$accessLevel follows the locked decision matrix",
    ({ mode, visibility, accessLevel, viewer }) => {
      const isCrossSpace = viewer === CROSS_SPACE;
      const decision = decideContentAccess(
        resource({ visibility, access_level: accessLevel }),
        context(viewer, {
          spaceId: isCrossSpace ? "space-2" : "space-1",
          activeSpaceMember: viewer !== INACTIVE && !isCrossSpace,
          oversightLevel: viewer === ADMIN ? mode : "none",
        }),
        grants,
      );
      expect(decision).toBe(expected(mode, visibility, accessLevel, viewer));
    },
  );

  it("uses widest-wins when a full-oversight admin also has a summary selected-user grant", () => {
    expect(decideContentAccess(
      resource({ visibility: "selected_users", access_level: "summary" }),
      context(ADMIN, { oversightLevel: "full" }),
      [{ grantee_user_id: ADMIN, access_level: "summary", revoked_at: null }],
    )).toBe("full");
  });
});
