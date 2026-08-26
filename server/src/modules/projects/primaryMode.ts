import { HttpError } from "../routeUtils/common.js";

/**
 * How a Project advances. The system's one classification axis, and it
 * classifies by the shape of the work rather than by its subject matter.
 *
 * This lived in a `projectTemplates` module only because a creation-time
 * Project Template used to carry an initial Mode. That concept is gone —
 * nothing about a Project is preset at creation except this axis — so it
 * belongs to the kernel that owns `projects.primary_mode`.
 */
export type ProjectPrimaryMode = "research" | "delivery" | "operations" | "learning";

export const PRIMARY_MODES: readonly ProjectPrimaryMode[] = [
  "research",
  "delivery",
  "operations",
  "learning",
];

export function isPrimaryMode(value: unknown): value is ProjectPrimaryMode {
  return typeof value === "string" && PRIMARY_MODES.includes(value as ProjectPrimaryMode);
}

/** The Mode a caller asked for, or `research` when it said nothing. */
export function requiredPrimaryMode(value: unknown): ProjectPrimaryMode {
  if (value === undefined || value === null || value === "") return "research";
  if (!isPrimaryMode(value)) {
    throw new HttpError(422, `primary_mode must be one of: ${PRIMARY_MODES.join(", ")}`);
  }
  return value;
}
