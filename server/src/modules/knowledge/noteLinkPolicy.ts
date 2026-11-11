import type { ModuleContext } from "../../gateway/routeRegistry.js";
import { enforce } from "../policy/service.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { HttpError, type SpaceUserIdentity } from "../routeUtils/common.js";

/** Admission for the existing human link, unlink and atomic jot routes.
 * Canonical repository access checks still authorize both endpoints.
 */
export async function enforceNoteLinkPolicy(
  context: ModuleContext,
  identity: SpaceUserIdentity,
  noteId?: string,
): Promise<void> {
  const result = await enforce(context.config, await loadActionRegistry(), {
    action: "note.link.create",
    actor_type: "user",
    actor_id: identity.userId,
    space_id: identity.spaceId,
    resource_space_id: identity.spaceId,
    resource_type: "note",
    resource_id: noteId ?? null,
    force_record: false,
  });
  if (result.status !== "allow") {
    throw new HttpError(result.status === "error" ? 503 : 403, result.message ?? "Note link policy unavailable");
  }
}
