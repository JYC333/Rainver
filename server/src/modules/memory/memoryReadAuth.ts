import { decideContentAccess, isContentOwner } from "../access/contentAccessPolicy";
import type {
  ContentAccessDecision,
  ContentAccessGrant,
  OversightMode,
} from "../access/contentAccessTypes";
import { isContentAccessLevel, isContentVisibility } from "../access/contentAccessTypes";

/** Memory-specific adapter around the canonical content-access decision. */
export interface MemoryAuthFields {
  id?: string;
  space_id: string;
  deleted_at: unknown;
  sensitivity_level: string | null;
  visibility: string | null;
  access_level: string | null;
  effective_access_level?: string | null;
  owner_user_id: string | null;
  scope_type: string | null;
  content_access_grants?: readonly ContentAccessGrant[] | null;
}

export interface MemoryReadContext {
  userId: string;
  spaceId: string;
  activeSpaceMember?: boolean;
  scopeAllowed?: boolean;
  /**
   * The viewer's effective Space oversight mode, already gated by role.
   * Omitted is treated as `'none'` — fail closed. Only `'full'` pierces the
   * `highly_restricted` sensitivity gate below; `'summary'`/`'content'` still
   * deny it (Decision Matrix row E).
   */
  oversightLevel?: OversightMode;
}

export function memoryAccessDecision(
  memory: MemoryAuthFields,
  context: MemoryReadContext,
): ContentAccessDecision {
  if (memory.deleted_at !== null) return "deny";
  if (
    memory.space_id !== context.spaceId
    || context.activeSpaceMember === false
    || context.scopeAllowed === false
    || !isContentVisibility(memory.visibility)
    || !isContentAccessLevel(memory.access_level)
  ) return "deny";
  if (memory.scope_type !== "user" && memory.scope_type !== "project") return "deny";
  const resource = {
    id: memory.id ?? "memory",
    space_id: memory.space_id,
    owner_user_id: memory.owner_user_id,
    visibility: memory.visibility,
    access_level: memory.access_level,
  };
  const decision = isContentAccessLevel(memory.effective_access_level)
    ? memory.effective_access_level
    : decideContentAccess(
        resource,
        {
          userId: context.userId,
          spaceId: context.spaceId,
          activeSpaceMember: context.activeSpaceMember ?? true,
          scopeAllowed: context.scopeAllowed ?? true,
          oversightLevel: context.oversightLevel,
        },
        memory.content_access_grants ?? [],
      );
  if (decision === "deny") return decision;
  if (
    memory.sensitivity_level === "highly_restricted"
    && !isContentOwner(resource, context.userId)
    && context.oversightLevel !== "full"
  ) {
    return "deny";
  }
  return decision;
}

export function canReadMemory(memory: MemoryAuthFields, context: MemoryReadContext): boolean {
  return memoryAccessDecision(memory, context) !== "deny";
}

export function shouldRedactMemoryContent(
  memory: Pick<MemoryAuthFields, "owner_user_id"> & {
    effective_access_level?: string | null;
    access_level?: string | null;
  },
  viewerUserId: string,
): boolean {
  if (isContentOwner(memory, viewerUserId)) return false;
  if (memory.effective_access_level) return memory.effective_access_level === "summary";
  return memory.access_level === "summary";
}
