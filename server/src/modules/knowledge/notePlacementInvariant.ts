import {
  NOTE_OWNING_ENTRY_REQUIRED_CODE,
  type NoteOwningEntryAction,
  type NoteOwningEntryRequiredError,
} from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";

/**
 * The entry invariant for notes, and the lock discipline that keeps it true
 * under concurrency.
 *
 * **Invariant.** A note that is not deleted and whose `primary_project_id` is
 * Project A has at least one placement whose folder lies in A's own notes
 * subtree (the nearest Project ancestor of the folder is A), from the moment
 * it is created. A note outside every Project may be created unfiled (a jot
 * with no context object, a link target) but, once filed, never loses its
 * last placement to a removal, move, or folder delete. A placement inside
 * another Project's subtree — a cross-Project share's entry — does not
 * count: it is B's way in, and B revoking it must not take A's note away
 * from A.
 *
 * **Why it is checked after the change.** The question is whether the *final*
 * state is well-formed, so every writer that removes, moves, or rewrites
 * placements, deletes a folder, or rebinds a note's Project does its work and
 * then calls {@link assertNoteEntryInvariant} on each note it touched, inside
 * the same transaction. Checking before the change would need every writer to
 * predict the outcome of its own SQL.
 *
 * **Lock order.** Folder rows, then note rows, then share rows, then
 * placement rows. Every such writer pins the folders it touches first (the
 * tree reorder `FOR SHARE`, folder delete `FOR UPDATE`, a placement writer
 * `FOR KEY SHARE` through `requireNoteCollectionRow`), then takes the note's
 * `space_objects` row `FOR UPDATE` ({@link lockNotesForPlacementChange}) —
 * notes in ascending id order when there are several — and only then reads or
 * writes share and placement rows. Two requests that each remove a different
 * placement of the same note would otherwise both see "there is still another
 * one" and together remove both; serialized on the note row, the second sees
 * the first's result and is refused. Do not lock placements first and the
 * note afterwards, and do not take a folder row after a note row.
 */

export interface LockedNoteForPlacement {
  note_id: string;
  title: string;
  primary_project_id: string | null;
  status: string;
}

/**
 * Locks the given notes' root rows, in ascending id order, and returns what
 * the invariant needs to know about them. Notes that do not exist in this
 * Space are simply absent from the result.
 */
export async function lockNotesForPlacementChange(
  db: Queryable,
  spaceId: string,
  noteIds: readonly string[],
): Promise<LockedNoteForPlacement[]> {
  const ids = [...new Set(noteIds)].sort();
  if (ids.length === 0) return [];
  const result = await db.query<LockedNoteForPlacement>(
    `SELECT so.id AS note_id, so.title, so.primary_project_id, n.status
       FROM space_objects so
       JOIN notes n ON n.object_id = so.id AND n.space_id = so.space_id
      WHERE so.space_id = $1 AND so.object_type = 'note' AND so.id = ANY($2::varchar[])
      ORDER BY so.id ASC
      FOR UPDATE OF so`,
    [spaceId, ids],
  );
  return result.rows;
}

/**
 * Refuses, with the two actions a person can actually take, when any of the
 * notes is left without its required entry. Callers pass the notes they
 * locked at the start of the transaction, after making their change.
 */
export async function assertNoteEntryInvariant(
  db: Queryable,
  spaceId: string,
  notes: readonly LockedNoteForPlacement[],
): Promise<void> {
  const live = notes.filter((note) => note.status !== "deleted");
  if (live.length === 0) return;
  const owning = await placementOwningProjects(db, spaceId, live.map((note) => note.note_id));
  const violations = live.filter((note) => {
    const entries = owning.get(note.note_id) ?? [];
    return note.primary_project_id
      ? !entries.some((projectId) => projectId === note.primary_project_id)
      : entries.length === 0;
  });
  const first = violations[0];
  if (!first) return;
  throw noteOwningEntryRequired(first, violations.length);
}

/**
 * For each note, the owning Project of every folder it is placed in (`null`
 * for a folder outside every Project), one entry per placement.
 *
 * The recursion stops at the first ancestor carrying a `project_id`, which is
 * the same answer `projectOwningCollection` gives for one folder, computed for
 * every placement of every note in one statement.
 */
async function placementOwningProjects(
  db: Queryable,
  spaceId: string,
  noteIds: readonly string[],
): Promise<Map<string, Array<string | null>>> {
  const result = await db.query<{ note_id: string; placement_id: string; project_id: string | null }>(
    `WITH RECURSIVE placed AS (
       SELECT item.id AS placement_id, item.note_id, c.id, c.parent_id, c.project_id,
              ARRAY[c.id::text] AS visited
         FROM note_collection_items item
         JOIN note_collections c ON c.id = item.collection_id AND c.space_id = item.space_id
        WHERE item.space_id = $1 AND item.note_id = ANY($2::varchar[])
       UNION ALL
       SELECT placed.placement_id, placed.note_id, parent.id, parent.parent_id, parent.project_id,
              placed.visited || parent.id::text
         FROM note_collections parent
         JOIN placed ON placed.parent_id = parent.id
        WHERE parent.space_id = $1
          AND placed.project_id IS NULL
          AND NOT parent.id::text = ANY(placed.visited)
     )
     SELECT DISTINCT ON (placement_id) note_id, placement_id, project_id
       FROM placed
      ORDER BY placement_id, (project_id IS NULL) ASC`,
    [spaceId, [...noteIds]],
  );
  const owning = new Map<string, Array<string | null>>();
  for (const row of result.rows) {
    const entries = owning.get(row.note_id) ?? [];
    entries.push(row.project_id);
    owning.set(row.note_id, entries);
  }
  return owning;
}

function noteOwningEntryRequired(note: LockedNoteForPlacement, affectedCount: number): HttpError {
  const actions: NoteOwningEntryAction[] = note.primary_project_id
    ? ["move_within_owning_project", "delete_note"]
    : ["move_to_folder", "delete_note"];
  const detail = note.primary_project_id
    ? `"${note.title}" must keep an entry in the project that owns it; move it to another folder of that project, or delete the note`
    : `"${note.title}" must stay in at least one folder; move it to another folder, or delete the note`;
  const body: NoteOwningEntryRequiredError = {
    code: NOTE_OWNING_ENTRY_REQUIRED_CODE,
    detail,
    note_id: note.note_id,
    note_title: note.title,
    owning_project_id: note.primary_project_id,
    actions,
    affected_note_count: affectedCount,
  };
  return new HttpError(422, detail, body);
}
