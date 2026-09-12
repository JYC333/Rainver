import { CANONICAL_ROLES } from "../policy/decisionCore.js";
import { HttpError } from "../routeUtils/common.js";

export type SpaceRole = "owner" | "admin" | "reviewer" | "member" | "guest";

/** Space roles, lowest first. */
export const SPACE_ROLE_LADDER: readonly string[] = CANONICAL_ROLES;

export function isKnownSpaceRole(value: string | null | undefined): value is SpaceRole {
  return value === "owner" || value === "admin" || value === "reviewer" || value === "member" || value === "guest";
}

export function isSpaceOwnerOrAdmin(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The one rule for handing someone a role: it must be a role the ladder
 * knows, no higher than the granter's own, and only an owner hands out owner.
 * Returns the refusal, or null when the grant is allowed.
 */
export function roleGrantRefusal(
  ladder: readonly string[],
  actorRole: string | null,
  requestedRole: string,
): { statusCode: 403 | 422; detail: string } | null {
  const requested = ladder.indexOf(requestedRole);
  if (requested < 0) return { statusCode: 422, detail: `Unknown role '${requestedRole}'` };
  const actor = actorRole === null ? -1 : ladder.indexOf(actorRole);
  if (actor < requested) {
    return { statusCode: 403, detail: `A ${actorRole ?? "non-member"} cannot grant the ${requestedRole} role` };
  }
  if (requestedRole === "owner" && actorRole !== "owner") {
    return { statusCode: 403, detail: "Only an owner can grant the owner role" };
  }
  return null;
}

export function assertCanGrantRole(ladder: readonly string[], actorRole: string | null, requestedRole: string): void {
  const refusal = roleGrantRefusal(ladder, actorRole, requestedRole);
  if (refusal) throw new HttpError(refusal.statusCode, refusal.detail);
}
