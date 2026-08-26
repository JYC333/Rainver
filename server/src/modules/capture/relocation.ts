import { HttpError, type Queryable } from "../routeUtils/common.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";

export type RelocationMode = "move" | "copy";

export interface RelocationBlock {
  block_id: string;
  text: string;
  /** The capture's own block, preselected in the preview. */
  anchored: boolean;
}

export interface CaptureRow {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  project_id: string | null;
  content: string | null;
  note_id: string | null;
  block_id: string | null;
}

/**
 * Which blocks a relocation may carry, and which are merely offered.
 *
 * Block adhesion has no technical solution. If the user wrote further lines
 * next to a captured paragraph and considers them one thought, no automatic
 * rule — absorb the next N, absorb until the next capture — is right in every
 * case, and being wrong in either direction damages data: too few and the
 * thought is torn in half, too many and someone else's paragraph is dragged
 * along. Once content has been edited into the note, "what this capture now
 * is" has no objective answer; only the author knows.
 *
 * So this offers rather than decides. The anchored block is preselected, the
 * blocks after it up to the next boundary are listed unselected, and the user
 * checks what belongs.
 */
export function relocationCandidates(
  blocks: readonly { id: string | null; type: string; text: string }[],
  anchorId: string,
  otherAnchorIds: ReadonlySet<string>,
): RelocationBlock[] {
  const start = blocks.findIndex((block) => block.id === anchorId);
  if (start < 0) return [];
  const offered: RelocationBlock[] = [
    { block_id: anchorId, text: blocks[start]!.text, anchored: true },
  ];
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    // A heading starts a new section and another capture's block is another
    // thought; either way the run of orphans has ended.
    if (block.type === "heading") break;
    if (!block.id || otherAnchorIds.has(block.id)) break;
    offered.push({ block_id: block.id, text: block.text, anchored: false });
  }
  return offered;
}

/**
 * Whether this caller may take the content out of the Space, as opposed to
 * copying it (ADR 0013 amendments 6a/6b).
 *
 * Move is decision 6's transformation run backwards: the original leaves the
 * Project. One member must not be able to remove another member's contribution
 * from the team's Space, so move needs authority over the content — its owner,
 * or someone administering the Project it sits in.
 */
export async function canMoveCapture(
  db: Queryable,
  capture: CaptureRow,
  userId: string,
): Promise<boolean> {
  if (capture.owner_user_id === userId) return true;
  if (!capture.project_id) return false;
  // Deliberately narrower than `canWriteProject`, which admits any project
  // member: being able to contribute to a Project is not authority to remove
  // what a colleague contributed. Only the Project's own owner and the Space's
  // owners and admins administer other people's content.
  const project = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM projects WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
    [capture.project_id, capture.space_id],
  );
  if (project.rows[0]?.owner_user_id === userId) return true;
  const spaceRole = await db.query<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [capture.space_id, userId],
  );
  if (isSpaceOwnerOrAdmin(spaceRole.rows[0]?.role)) return true;
  const projectRole = await db.query<{ role: string }>(
    `SELECT role FROM project_members
      WHERE space_id = $1 AND project_id = $2 AND user_id = $3 AND status = 'active' LIMIT 1`,
    [capture.space_id, capture.project_id, userId],
  );
  return projectRole.rows[0]?.role === "owner";
}

/**
 * Whether the Space permits copying content out of it into a personal Space.
 *
 * Copy leaves the original in place, so it is not a loss to the team — it is
 * egress, a second holder. Default off; an owner or admin opens it.
 */
export async function spaceAllowsCopyOut(db: Queryable, spaceId: string): Promise<boolean> {
  // Only this column: whether an egress is *permitted* and whether it is
  // *announced* are two independent questions, and reading them together here
  // would suggest otherwise.
  const result = await db.query<{ member_copy_out_enabled: boolean }>(
    `SELECT member_copy_out_enabled FROM spaces WHERE id = $1`,
    [spaceId],
  );
  return Boolean(result.rows[0]?.member_copy_out_enabled);
}

/**
 * Announce an egress to the Space's members, when the Space asks for it.
 *
 * ADR 0013 decision 11's two non-negotiables are honoured here: **pointer
 * metadata only, never the content**, and the notification is a record of an
 * action the actor was already told about. A notification carrying the copied
 * text would make the disclosure channel a leak of its own.
 */
export async function recordEgress(
  db: Queryable,
  input: {
    sourceSpaceId: string;
    actorUserId: string;
    activityId: string;
    noteId: string | null;
    blockCount: number;
    at: string;
  },
): Promise<void> {
  const space = await db.query<{ egress_notifications_enabled: boolean }>(
    `SELECT egress_notifications_enabled FROM spaces WHERE id = $1`,
    [input.sourceSpaceId],
  );
  if (!space.rows[0]?.egress_notifications_enabled) return;
  // One statement rather than a round trip per member, matching the existing
  // broadcast in `crossSpaceRetrieval`.
  await db.query(
    `INSERT INTO space_member_notifications
       (id, space_id, recipient_user_id, event_type, pointer_metadata_json, created_at)
     SELECT gen_random_uuid()::varchar, $1::varchar, membership.user_id,
            'content_egress', $3::jsonb, $4::timestamptz
       FROM space_memberships membership
      WHERE membership.space_id = $1::varchar
        AND membership.status = 'active'
        AND membership.user_id <> $2::varchar`,
    [input.sourceSpaceId, input.actorUserId, JSON.stringify({
      actor_user_id: input.actorUserId,
      activity_id: input.activityId,
      note_id: input.noteId,
      block_count: input.blockCount,
    }), input.at],
  );
}

export function assertRelocationMode(value: unknown): asserts value is RelocationMode {
  if (value !== "move" && value !== "copy") throw new HttpError(422, "mode must be move or copy");
}
