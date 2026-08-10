import { describe, expect, it } from "vitest";
import type { RuntimeContextPolicyVersion } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  assertPolicyDoesNotWiden,
  assertPolicyPreferencesWithinConstraints,
  resolveRuntimeContextPolicies,
} from "../src/modules/policy/runtimeContextPolicyResolver";

function version(
  id: string,
  scope_type: RuntimeContextPolicyVersion["scope_type"],
  scope_id: string,
  policy: RuntimeContextPolicyVersion["policy"],
  number: number,
): RuntimeContextPolicyVersion {
  return {
    id,
    space_id: "space-1",
    scope_type,
    scope_id,
    version: number,
    policy,
    base_version_id: null,
    typed_diff: {},
    reason: "test",
    created_by_user_id: "user-1",
    created_at: "2026-08-08T00:00:00.000Z",
  };
}

describe("Runtime Context Policy resolution", () => {
  it("intersects constraints and preserves explicit false preferences", () => {
    const resolved = resolveRuntimeContextPolicies([
      version("space-policy", "space", "space-1", {
        constraints: {
          retrieval_domains: ["knowledge", "memory"],
          retrieval_max_candidates: 20,
          allow_project_brief: true,
          continuity_modes: ["recent", "checkpoint"],
        },
        preferences: { retrieval_enabled: true, include_project_brief: true },
      }, 1),
      version("project-policy", "project", "project-1", {
        constraints: {
          retrieval_domains: ["knowledge"],
          retrieval_max_candidates: 5,
          allow_project_brief: false,
          continuity_modes: [],
        },
        preferences: { retrieval_enabled: false, include_project_brief: false },
      }, 1),
    ]);
    expect(resolved.policy.constraints).toMatchObject({
      retrieval_domains: ["knowledge"],
      retrieval_max_candidates: 5,
      allow_project_brief: false,
      continuity_modes: [],
    });
    expect(resolved.policy.preferences).toMatchObject({
      retrieval_enabled: false,
      include_project_brief: false,
    });
    expect(resolved.contributing_versions.map((ref) => ref.id)).toEqual(["space-policy", "project-policy"]);
    expect(resolved.resolution_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects lower-scope attempts to widen allowlists, maxima, booleans, or sensitivity", () => {
    const governing = {
      constraints: {
        retrieval_domains: ["knowledge"],
        retrieval_max_candidates: 5,
        allow_project_instructions: false,
        explicit_reference_sensitivity_ceiling: "sensitive" as const,
      },
      preferences: {},
    };
    expect(() => assertPolicyDoesNotWiden(governing, {
      constraints: { retrieval_domains: ["knowledge", "web"] }, preferences: {},
    })).toThrow(/cannot widen/);
    expect(() => assertPolicyDoesNotWiden(governing, {
      constraints: { retrieval_max_candidates: 6 }, preferences: {},
    })).toThrow(/cannot widen/);
    expect(() => assertPolicyDoesNotWiden(governing, {
      constraints: { allow_project_instructions: true }, preferences: {},
    })).toThrow(/cannot widen/);
    expect(() => assertPolicyDoesNotWiden(governing, {
      constraints: { explicit_reference_sensitivity_ceiling: "restricted" }, preferences: {},
    })).toThrow(/cannot widen/);
  });

  it("rejects preferences that attempt to bypass resolved hard constraints", () => {
    expect(() => assertPolicyPreferencesWithinConstraints({
      constraints: { allow_project_brief: false },
      preferences: { include_project_brief: true },
    })).toThrow(/cannot widen/);
    expect(() => assertPolicyPreferencesWithinConstraints({
      constraints: { continuity_modes: ["checkpoint"] },
      preferences: { continuity_strategy: "stateful_cli" },
    })).toThrow(/cannot widen/);
    expect(() => assertPolicyPreferencesWithinConstraints({
      constraints: { retrieval_domains: [] },
      preferences: { retrieval_enabled: true },
    })).toThrow(/cannot widen/);
  });

  it("clamps stale lower-scope preferences after a higher scope is tightened", () => {
    const resolved = resolveRuntimeContextPolicies([
      version("space-policy", "space", "space-1", {
        constraints: {
          allow_project_brief: false,
          retrieval_domains: [],
          continuity_modes: ["checkpoint"],
        },
        preferences: {},
      }, 2),
      version("project-policy", "project", "project-1", {
        constraints: {},
        preferences: {
          include_project_brief: true,
          retrieval_enabled: true,
          continuity_strategy: "stateful_cli",
        },
      }, 1),
    ]);

    expect(resolved.policy.preferences).toEqual({
      include_project_brief: false,
      retrieval_enabled: false,
    });
  });
});
