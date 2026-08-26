import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { markdownToPm } from "./noteDocument.js";
import { ensureProjectNotesFolder } from "./noteProjectFolders.js";
import { withNoteWrites } from "./noteWriter.js";

/**
 * Projection of a capture into the caller's private marginalia note.
 *
 * A capture whose destination is marginalia is still an `activity_record`
 * first; this is the second half of that write, and the two commit together so
 * the felt behaviour of typing a thought inside a Project is unchanged.
 *
 * Why the note is private and per-user: ADR 0013 decision 3 would publish a
 * margin note to the whole team on the first keystroke, and decision 3a is the
 * carve-out for exactly that — marginalia takes the document's (here the
 * Project's) scope but not its visibility. `space_objects.visibility` is
 * row-level, so a note cannot mix private and shared paragraphs; one private
 * note per member is what row-level visibility leaves available.
 */
export interface MarginaliaProjection {
  note_id: string;
  note_title: string;
  /**
   * The top-level block this capture became — the anchor relocation extracts
   * by. Null only for a document whose blocks predate block ids, which cannot
   * happen on this path but is not worth a throw.
   */
  block_id: string | null;
}

export interface MarginaliaInput {
  projectId: string;
  /** A `space_objects` row the Area declared as its current object, or null. */
  targetId: string | null;
  text: string;
  /** The capture's `activity_record`, recorded on the note as provenance. */
  activityId: string;
}

/**
 * The knowledge repository's own gated reads and writes, each taking the
 * `Queryable` to run on: the lookup and the link write happen inside the note
 * write scope, and binding them to the repository's outer handle would put
 * them outside the transaction whenever that handle is a pool.
 */
export interface MarginaliaDeps {
  /** Read-gated object lookup, so an invisible target leaves no note behind. */
  requireVisibleSpaceObject(
    db: Queryable,
    identity: SpaceUserIdentity,
    objectId: string,
    notFoundMessage: string,
  ): Promise<{ id: string; object_type: string; title: string; primary_project_id: string | null }>;
  createNoteLink(
    db: Queryable,
    identity: SpaceUserIdentity,
    noteId: string,
    body: Record<string, unknown>,
  ): Promise<unknown>;
  /** The shared capture-note resolver, with its owner dimension supplied. */
  noteForJotTarget(
    db: Queryable,
    identity: SpaceUserIdentity,
    targetId: string,
    projectId: string | null,
    marginaliaOwnerUserId: string | null,
  ): Promise<string | null>;
}

export async function appendMarginalia(
  db: Queryable,
  identity: SpaceUserIdentity,
  input: MarginaliaInput,
  deps: MarginaliaDeps,
): Promise<MarginaliaProjection> {
  // Binding anything to a Project is a write to that Project, and the append
  // branch below never reaches the writer check inside note creation.
  await assertProjectWriter(db, identity.spaceId, input.projectId, identity.userId);
  const target = input.targetId
    ? await deps.requireVisibleSpaceObject(db, identity, input.targetId, "Capture target not found")
    : null;
  // Visible is not the same as in scope. Without this an object belonging to
  // one Project could be annotated under another the caller happens to write,
  // producing a note binding and a cross-Project link no surface can produce.
  if (target && !(await objectIsInProject(db, identity, target.id, target.primary_project_id, input.projectId))) {
    throw new HttpError(422, "Capture target does not belong to this Project");
  }

  return withNoteWrites(db, async (scope) => {
    // Serialised per member, per destination: two captures racing would
    // otherwise each find no note and create a second one, and for the
    // object-level note nothing in the schema would catch it.
    await scope.db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`note-marginalia:${identity.spaceId}:${identity.userId}:${input.projectId}:${target?.id ?? "-"}`],
    );

    const existingId = target
      ? await deps.noteForJotTarget(scope.db, identity, target.id, input.projectId, identity.userId)
      : await projectMarginaliaNote(scope.db, identity, input.projectId);
    const existing = existingId ? { note_id: existingId, title: await noteTitle(scope.db, identity, existingId) } : null;

    if (existing) {
      // Append with no `expectVersion`: a capture adds a paragraph at the end
      // and cannot conflict with an edit elsewhere in the document.
      const result = await scope.write({
        spaceId: identity.spaceId,
        noteId: existing.note_id,
        content: { kind: "ops", ops: [{ op: "append", markdown: input.text }] },
        source: "user_edit",
        userId: identity.userId,
      });
      if (result.outcome !== "written") {
        throw new HttpError(409, "Note changed while appending; reload and retry", {
          current_version: result.currentVersion,
        });
      }
      // The first block the append introduced. A capture whose text contains a
      // blank line becomes several blocks; the anchor is where it starts, and
      // P2b's preview offers the rest as the blocks that follow it.
      return {
        note_id: existing.note_id,
        note_title: existing.title,
        block_id: result.addedBlockIds[0] ?? null,
      };
    }

    const title = target ? `My notes on ${target.title}`.slice(0, 512) : "My project notes";
    const created = await scope.create({
      spaceId: identity.spaceId,
      actor: { userId: identity.userId },
      title,
      visibility: "private",
      ownerUserId: identity.userId,
      doc: markdownToPm(input.text),
      contentFormat: "prosemirror_json",
      plainText: input.text,
      primaryProjectId: input.projectId,
      createdFromActivityId: input.activityId,
      collectionId: await ensureProjectNotesFolder(scope.db, identity.spaceId, input.projectId),
      // The binding is the marker as well as the slot: it is what tells the
      // shared jot resolver that this note is one member's marginalia and not
      // a team note about the same object.
      marginaliaProjectId: input.projectId,
      marginaliaOwnerUserId: identity.userId,
      marginaliaTargetObjectId: target?.id ?? null,
    });
    if (target) {
      await deps.createNoteLink(scope.db, identity, created.id, {
        target_type: target.object_type,
        target_id: target.id,
        link_type: "references",
      });
    }
    return { note_id: created.id, note_title: title, block_id: created.blockIds[0] ?? null };
  });
}

/**
 * Whether the object is in the Project's scope, by ownership or by an active
 * cross-Project share — the same two ways any other reader reaches it.
 */
async function objectIsInProject(
  db: Queryable,
  identity: SpaceUserIdentity,
  objectId: string,
  primaryProjectId: string | null,
  projectId: string,
): Promise<boolean> {
  if (primaryProjectId === projectId) return true;
  const shared = await db.query<{ project_id: string }>(
    `SELECT project_id FROM space_object_project_shares
      WHERE space_id = $1 AND object_id = $2 AND project_id = $3 AND revoked_at IS NULL
      LIMIT 1`,
    [identity.spaceId, objectId, projectId],
  );
  return Boolean(shared.rows[0]);
}

async function noteTitle(db: Queryable, identity: SpaceUserIdentity, noteId: string): Promise<string> {
  const result = await db.query<{ title: string }>(
    `SELECT title FROM space_objects WHERE id = $1 AND space_id = $2`,
    [noteId, identity.spaceId],
  );
  return result.rows[0]?.title ?? "";
}

/** The caller's single private note for the Project itself (no context object). */
async function projectMarginaliaNote(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
): Promise<string | null> {
  const result = await db.query<{ note_id: string }>(
    `SELECT n.object_id AS note_id
       FROM notes n
       JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
      WHERE n.space_id = $1
        AND n.marginalia_project_id = $2
        AND n.marginalia_owner_user_id = $3
        AND n.marginalia_target_object_id IS NULL
        AND n.status = 'active'
        AND so.deleted_at IS NULL
      LIMIT 1`,
    [identity.spaceId, projectId, identity.userId],
  );
  return result.rows[0]?.note_id ?? null;
}
