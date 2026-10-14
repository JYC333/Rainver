/**
 * A person changing who may read their own Memory entry, for the
 * content-access API.
 *
 * Not a column update: Memory is versioned, and who could read a version is
 * part of what it was. The canonical applier writes the new version, carries
 * its provenance, moves the grants with it and checks placement and audience
 * (`PgMemoryApplyRepository.applyOwnerAccessChange`). The owner deciding who
 * reads their own entry needs no second approver
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §3).
 */
import type { Queryable } from "./memoryApplyProvenance.js";
import { PgMemoryApplyRepository } from "./memoryApplyRepository.js";
import type { MemoryGrant } from "./memoryAudience.js";

export interface LockedMemoryForAccess {
  id: string;
  owner_user_id: string | null;
  scope_type: string;
  visibility: string;
  project_id: string | null;
}

/** The active entry, locked for the change; null when there is none. */
export async function lockActiveMemoryForAccess(
  db: Queryable,
  spaceId: string,
  memoryId: string,
): Promise<LockedMemoryForAccess | null> {
  const result = await db.query<LockedMemoryForAccess>(
    `SELECT id, owner_user_id, scope_type, visibility, project_id
       FROM memory_entries
      WHERE space_id = $1 AND id = $2 AND status = 'active' AND deleted_at IS NULL
      FOR UPDATE`,
    [spaceId, memoryId],
  );
  return result.rows[0] ?? null;
}

/** Writes the owner's change and returns the new head's id. */
export async function changeOwnMemoryAccess(db: Queryable, input: {
  spaceId: string;
  ownerUserId: string;
  memoryId: string;
  visibility: string;
  accessLevel: string;
  grants: readonly MemoryGrant[];
}): Promise<string> {
  const memory = await new PgMemoryApplyRepository(db).applyOwnerAccessChange(input);
  return memory.id;
}
