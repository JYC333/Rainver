import {
  isContentAccessLevel,
  isContentVisibility,
  type ContentAccessContext,
  type ContentAccessDecision,
  type ContentAccessGrant,
  type ContentAccessLevel,
  type ContentAccessResource,
  type OversightMode,
} from "./contentAccessTypes";

/**
 * Canonical effective-level rule (see the oversight/grant-upgrade plan):
 *
 *   scope gates (membership, space, project_folder/project, active row) → deny if failed
 *   effective = widest( base-by-visibility, active-grant level, oversight level )
 *
 * The `highly_restricted` memory sensitivity gate is layered on top by the
 * memory-specific adapter (`memoryReadAuth.ts`), not here.
 */
export function decideContentAccess(
  resource: ContentAccessResource,
  context: ContentAccessContext,
  grants: readonly ContentAccessGrant[] = [],
): ContentAccessDecision {
  if (
    resource.space_id !== context.spaceId
    || !context.activeSpaceMember
    || !context.scopeAllowed
    || !isContentVisibility(resource.visibility)
    || !isContentAccessLevel(resource.access_level)
  ) {
    return "deny";
  }

  if (resource.owner_user_id === context.userId) return "full";

  const memberLevel = memberAccessDecision(resource, context.userId, grants);
  const oversightLevel = oversightContribution(context.oversightLevel);
  return widestAccessDecision(memberLevel, oversightLevel);
}

function memberAccessDecision(
  resource: ContentAccessResource,
  userId: string,
  grants: readonly ContentAccessGrant[],
): ContentAccessDecision {
  if (resource.visibility === "private") return "deny";

  const grant = grants.find(
    (candidate) =>
      candidate.grantee_user_id === userId
      && !candidate.revoked_at
      && isContentAccessLevel(candidate.access_level),
  );

  if (resource.visibility === "space_shared") {
    // Precondition already validated isContentAccessLevel(resource.access_level).
    const baseLevel = resource.access_level as ContentAccessLevel;
    // Grants on space_shared content are per-user disclosure upgrades; they
    // never narrow below the member base and can raise summary to full.
    return grant ? widestAccessDecision(baseLevel, grant.access_level as ContentAccessLevel) : baseLevel;
  }

  // selected_users: an active grant's access_level is authoritative for the
  // grantee — it is not narrowed by the resource's own access_level.
  return grant ? (grant.access_level as ContentAccessLevel) : "deny";
}

function oversightContribution(mode: OversightMode | undefined): ContentAccessDecision {
  if (mode === "summary") return "summary";
  if (mode === "content" || mode === "full") return "full";
  return "deny";
}

/** Widest-wins merge across `deny < summary < full`. */
export function widestAccessDecision(
  ...decisions: readonly ContentAccessDecision[]
): ContentAccessDecision {
  let widest: ContentAccessDecision = "deny";
  for (const decision of decisions) {
    if (decision === "full") return "full";
    if (decision === "summary" && widest === "deny") widest = "summary";
  }
  return widest;
}

export function isContentOwner(
  resource: Pick<ContentAccessResource, "owner_user_id">,
  userId: string | null | undefined,
): boolean {
  return Boolean(userId) && resource.owner_user_id === userId;
}
