import { createHash } from "node:crypto";
import type {
  RuntimeContextPolicyDocument,
  RuntimeContextPolicyVersion,
  RuntimeContextResolvedPolicy,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { HttpError } from "../routeUtils/common";

type Constraints = RuntimeContextPolicyDocument["constraints"];
type Preferences = RuntimeContextPolicyDocument["preferences"];
type ConstraintKey = keyof Constraints;

const LIST_KEYS = [
  "retrieval_domains",
  "memory_layers",
  "explicit_reference_types",
  "pinned_reference_types",
  "continuity_modes",
] as const satisfies readonly ConstraintKey[];
const MAX_KEYS = [
  "retrieval_max_candidates",
  "explicit_reference_max",
  "pinned_reference_max",
  "sealed_payload_retention_seconds",
] as const satisfies readonly ConstraintKey[];
const BOOLEAN_KEYS = [
  "allow_project_brief",
  "allow_project_instructions",
  "allow_sealed_payload",
] as const satisfies readonly ConstraintKey[];
const SENSITIVITY_RANK = {
  normal: 0,
  sensitive: 1,
  restricted: 2,
  highly_restricted: 3,
} as const;

export function resolveRuntimeContextPolicies(
  versions: readonly RuntimeContextPolicyVersion[],
  options: { preferenceConflicts?: "clamp" | "reject" } = {},
): RuntimeContextResolvedPolicy {
  let constraints: Constraints = {};
  let preferences: Preferences = {};
  for (const version of versions) {
    const policy = version.policy;
    constraints = intersectConstraints(constraints, policy.constraints);
    preferences = { ...preferences, ...policy.preferences };
  }
  let policy: RuntimeContextPolicyDocument = { constraints, preferences };
  if (options.preferenceConflicts === "reject") {
    assertPolicyPreferencesWithinConstraints(policy);
  } else {
    policy = { constraints, preferences: clampPreferencesToConstraints(constraints, preferences) };
  }
  const contributingVersions = versions.map((version) => ({
    type: "runtime_context_policy",
    id: version.id,
    version: String(version.version),
  }));
  return {
    policy,
    contributing_versions: contributingVersions,
    resolution_hash: createHash("sha256")
      .update(stableJson({ policy, contributing_versions: contributingVersions }))
      .digest("hex"),
  };
}

function clampPreferencesToConstraints(
  constraints: Constraints,
  preferences: Preferences,
): Preferences {
  const clamped = { ...preferences };
  if (constraints.allow_project_brief === false && clamped.include_project_brief === true) {
    clamped.include_project_brief = false;
  }
  if (constraints.allow_project_instructions === false && clamped.include_project_instructions === true) {
    clamped.include_project_instructions = false;
  }
  if (constraints.retrieval_domains?.length === 0 && clamped.retrieval_enabled === true) {
    clamped.retrieval_enabled = false;
  }
  if (clamped.continuity_strategy !== undefined
    && constraints.continuity_modes !== undefined
    && !constraints.continuity_modes.includes(clamped.continuity_strategy)) {
    delete clamped.continuity_strategy;
  }
  return clamped;
}

export function assertPolicyDoesNotWiden(
  governing: RuntimeContextPolicyDocument,
  candidate: RuntimeContextPolicyDocument,
): void {
  const parent = governing.constraints;
  const child = candidate.constraints;
  for (const key of LIST_KEYS) {
    const parentValue = parent[key] as readonly string[] | undefined;
    const childValue = child[key] as readonly string[] | undefined;
    if (parentValue !== undefined && childValue !== undefined) {
      const allowed = new Set(parentValue);
      if (childValue.some((value) => !allowed.has(value))) widening(key);
    }
  }
  for (const key of MAX_KEYS) {
    const parentValue = parent[key] as number | undefined;
    const childValue = child[key] as number | undefined;
    if (parentValue !== undefined && childValue !== undefined && childValue > parentValue) widening(key);
  }
  for (const key of BOOLEAN_KEYS) {
    if (parent[key] === false && child[key] === true) widening(key);
  }
  const parentSensitivity = parent.explicit_reference_sensitivity_ceiling;
  const childSensitivity = child.explicit_reference_sensitivity_ceiling;
  if (parentSensitivity !== undefined && childSensitivity !== undefined
    && SENSITIVITY_RANK[childSensitivity] > SENSITIVITY_RANK[parentSensitivity]) {
    widening("explicit_reference_sensitivity_ceiling");
  }
}

export function assertPolicyPreferencesWithinConstraints(
  policy: RuntimeContextPolicyDocument,
): void {
  const { constraints, preferences } = policy;
  if (constraints.allow_project_brief === false && preferences.include_project_brief === true) {
    widening("allow_project_brief");
  }
  if (constraints.allow_project_instructions === false && preferences.include_project_instructions === true) {
    widening("allow_project_instructions");
  }
  if (constraints.retrieval_domains?.length === 0 && preferences.retrieval_enabled === true) {
    widening("retrieval_domains");
  }
  if (preferences.continuity_strategy !== undefined
    && constraints.continuity_modes !== undefined
    && !constraints.continuity_modes.includes(preferences.continuity_strategy)) {
    widening("continuity_modes");
  }
}

export function policyTypedDiff(
  previous: RuntimeContextPolicyDocument | null,
  next: RuntimeContextPolicyDocument,
): Record<string, unknown> {
  const before = previous ?? { constraints: {}, preferences: {} };
  const diff: Record<string, unknown> = {};
  for (const section of ["constraints", "preferences"] as const) {
    const sectionDiff: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(before[section]), ...Object.keys(next[section])]);
    for (const key of [...keys].sort()) {
      const oldValue = before[section][key as never];
      const newValue = next[section][key as never];
      if (stableJson(oldValue) !== stableJson(newValue)) {
        sectionDiff[key] = {
          before: oldValue === undefined ? null : oldValue,
          after: newValue === undefined ? null : newValue,
        };
      }
    }
    if (Object.keys(sectionDiff).length > 0) diff[section] = sectionDiff;
  }
  return diff;
}

function intersectConstraints(current: Constraints, next: Constraints): Constraints {
  const result: Record<string, unknown> = { ...current };
  for (const key of LIST_KEYS) {
    const left = current[key] as readonly string[] | undefined;
    const right = next[key] as readonly string[] | undefined;
    if (right === undefined) continue;
    result[key] = left === undefined ? [...right] : left.filter((value) => right.includes(value));
  }
  for (const key of MAX_KEYS) {
    const left = current[key] as number | undefined;
    const right = next[key] as number | undefined;
    if (right !== undefined) result[key] = left === undefined ? right : Math.min(left, right);
  }
  for (const key of BOOLEAN_KEYS) {
    const left = current[key] as boolean | undefined;
    const right = next[key] as boolean | undefined;
    if (right !== undefined) result[key] = left === undefined ? right : left && right;
  }
  const leftSensitivity = current.explicit_reference_sensitivity_ceiling;
  const rightSensitivity = next.explicit_reference_sensitivity_ceiling;
  if (rightSensitivity !== undefined) {
    result.explicit_reference_sensitivity_ceiling = leftSensitivity === undefined
      ? rightSensitivity
      : SENSITIVITY_RANK[leftSensitivity] <= SENSITIVITY_RANK[rightSensitivity]
        ? leftSensitivity
        : rightSensitivity;
  }
  return result as Constraints;
}

function widening(key: ConstraintKey): never {
  throw new HttpError(409, `Lower-scope Runtime Context Policy cannot widen '${key}'`);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
