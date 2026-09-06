import { decideContentAccess, isContentOwner } from "../access/contentAccessPolicy.js";
import type {
  ContentAccessDecision,
  ContentAccessGrant,
  OversightMode,
} from "../access/contentAccessTypes.js";
import { isContentAccessLevel, isContentVisibility } from "../access/contentAccessTypes.js";

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
  // `agent` scope reads as the Agent's owner's own private content: the row is
  // private with `owner_user_id` naming that person, so the canonical decision
  // below already answers it. Listing the scope here is what admits it at all
  // ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §4).
  if (memory.scope_type !== "user" && memory.scope_type !== "project" && memory.scope_type !== "agent") {
    return "deny";
  }
  // An agent-scope row is private by CHECK; a wider one could only be a row
  // written around the applier, and granting on it would hand the Agent's own
  // memory to the Space.
  if (memory.scope_type === "agent" && memory.visibility !== "private") return "deny";
  // And it is the Agent's owner's alone, oversight included. A note carries
  // the Room it was learned in and is delivered only where that Room's
  // audience already reached (ADR 0003 §4, ADR 0018); a Space owner reading it
  // on the Memory page would cross the Room the delivery path refuses to
  // cross. Oversight keeps `user` and `project` scope, where the
  // accountability it exists for lives.
  if (memory.scope_type === "agent" && memory.owner_user_id !== context.userId) return "deny";
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
