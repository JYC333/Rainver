export const CONTENT_VISIBILITIES = ["private", "space_shared", "selected_users"] as const;
export type ContentVisibility = (typeof CONTENT_VISIBILITIES)[number];

export const CONTENT_ACCESS_LEVELS = ["full", "summary"] as const;
export type ContentAccessLevel = (typeof CONTENT_ACCESS_LEVELS)[number];
export type ContentAccessDecision = "deny" | ContentAccessLevel;

/**
 * Space oversight modes, strictly increasing capability: `none` (default) <
 * `summary` < `content` < `full`. Chosen at Space creation and immutable
 * afterwards; applies to reads only. See
 * `.agent/architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`.
 */
export const OVERSIGHT_MODES = ["none", "summary", "content", "full"] as const;
export type OversightMode = (typeof OVERSIGHT_MODES)[number];
export function isOversightMode(value: unknown): value is OversightMode {
  return typeof value === "string" && OVERSIGHT_MODES.includes(value as OversightMode);
}

export interface ContentAccessResource {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  project_folder_id?: string | null;
  project_id?: string | null;
}

export interface ContentAccessGrant {
  grantee_user_id: string;
  access_level: string;
  revoked_at?: string | null;
}

export interface ContentAccessContext {
  spaceId: string;
  userId: string;
  activeSpaceMember: boolean;
  scopeAllowed: boolean;
  /**
   * The viewer's effective oversight capability for this resource's Space,
   * already gated by role (only meaningful for an active owner/admin member).
   * Omitted/undefined is treated as `'none'` — fail closed.
   */
  oversightLevel?: OversightMode;
}

export function isContentVisibility(value: unknown): value is ContentVisibility {
  return typeof value === "string" && CONTENT_VISIBILITIES.includes(value as ContentVisibility);
}

/**
 * A row read through the content gate: it carries the viewer's computed level.
 * Body-carrying serializers take only this shape, so a read path that did not
 * compute the level does not compile.
 */
export type WithAccessLevel<T> = T & { effective_access_level: ContentAccessLevel };

/**
 * Whether a viewer at this level is withheld a resource's body. Fails closed:
 * anything but an explicit `full` withholds, so a level column holding an
 * unexpected value hides the body rather than serving it.
 */
export function bodyWithheld(level: ContentAccessLevel): boolean {
  return level !== "full";
}

export function isContentAccessLevel(value: unknown): value is ContentAccessLevel {
  return typeof value === "string" && CONTENT_ACCESS_LEVELS.includes(value as ContentAccessLevel);
}
