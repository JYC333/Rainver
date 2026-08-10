import type { Queryable } from "../routeUtils/common";
import {
  NOTE_PROJECT_ROLE_DEFAULT_TITLES,
  type NoteProjectRole,
} from "../knowledge/noteProjectRoles";

/**
 * A project's "notebook" is a set of ordinary Notes (free-form, not a fixed
 * schema) filed under that project's auto-created Knowledge Notes folder and
 * tagged with `primary_project_id`. Nothing prevents a project from having
 * more notes than the four role-carrying ones, or from having none of them.
 *
 * What identifies the four is `notes.project_role`, not their title (N2). The
 * old binding matched `space_objects.title` against literal English strings,
 * so a rename silently removed a note from the research baseline and the
 * comparison degraded without reporting anything.
 */
/**
 * The four the research baseline is made of — deliberately *not* every note
 * project role. `inbox` is a role too, but it is a capture target for the
 * Project's notes surface, not a research section: seeding it here would give
 * every research area a fifth starter note and make the synthesis compare
 * against captured fragments.
 */
export const NOTEBOOK_SECTION_KEYS = ["understanding", "questions", "ideas", "experiments"] as const;
export type SectionKey = typeof NOTEBOOK_SECTION_KEYS[number];

/** Default titles used when a role's note is created. Never a lookup key. */
export const SECTION_LABELS = NOTE_PROJECT_ROLE_DEFAULT_TITLES;

export interface NotebookNoteRow {
  id: string;
  version: number;
  content_json: Record<string, unknown>;
  plain_text: string | null;
}

/**
 * The two outcomes a role lookup has. A caller that treats "this project has
 * no note in that role" as an empty string is exactly the silent degradation
 * the role marker exists to prevent, so the absence is a value the caller has
 * to destructure rather than a `null` that reads like "nothing to add".
 */
export type NotebookNoteResolution =
  | { readonly present: true; readonly note: NotebookNoteRow }
  | { readonly present: false; readonly role: NoteProjectRole; readonly reason: "no_note_in_role" };

/**
 * Resolves the note holding `role` in this project. `notes.project_role` is
 * unique per (space, project, role), so this is a lookup, not a search.
 */
export async function resolveNotebookNote(
  db: Queryable,
  spaceId: string,
  projectId: string,
  // Any registered role, not only a research section: resolution keys on
  // `notes.project_role`, and the Project's `inbox` note is found the same way.
  role: NoteProjectRole,
): Promise<NotebookNoteResolution> {
  const result = await db.query<NotebookNoteRow>(
    `SELECT n.object_id AS id, n.version, n.content_json, n.plain_text
       FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
      WHERE n.space_id=$1 AND n.role_project_id=$2 AND n.project_role=$3
        AND n.status='active' AND so.deleted_at IS NULL
      LIMIT 1`,
    [spaceId, projectId, role],
  );
  const note = result.rows[0];
  return note ? { present: true, note } : { present: false, role, reason: "no_note_in_role" };
}

/** Every role-carrying note of a project, keyed by role. */
export async function resolveNotebookNotes(
  db: Queryable,
  spaceId: string,
  projectId: string,
): Promise<Partial<Record<SectionKey, NotebookNoteRow & { project_role: SectionKey }>>> {
  const result = await db.query<NotebookNoteRow & { project_role: SectionKey }>(
    `SELECT n.object_id AS id, n.version, n.content_json, n.plain_text, n.project_role
       FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
      WHERE n.space_id=$1 AND n.role_project_id=$2 AND n.project_role IS NOT NULL
        AND n.status='active' AND so.deleted_at IS NULL`,
    [spaceId, projectId],
  );
  const byRole: Partial<Record<SectionKey, NotebookNoteRow & { project_role: SectionKey }>> = {};
  for (const row of result.rows) byRole[row.project_role] = row;
  return byRole;
}
