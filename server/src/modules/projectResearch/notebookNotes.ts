import type { Queryable } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { SOURCE_LINEAGE_PROVENANCE_TYPES } from "../retrieval/sourcePolicy.js";
import {
  NOTE_PROJECT_ROLE_DEFAULT_TITLES,
  type NoteProjectRole,
} from "../knowledge/noteProjectRoles.js";

/**
 * A project's "notebook" is a set of ordinary Notes (free-form, not a fixed
 * schema) filed under that project's auto-created Knowledge Notes folder and
 * tagged with `primary_project_id`. Nothing prevents a project from having
 * more notes than the four role-carrying ones, or from having none of them.
 *
 * What identifies the four is `notes.project_role`, not their title. Do not
 * match `space_objects.title` against literal English strings: a rename then
 * removes a note from the research baseline and the comparison degrades
 * without reporting anything.
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
 * no note in that role" as an empty string is silent degradation. The
 * absence is a value the caller has to destructure rather than a `null`
 * that reads like "nothing to add".
 */
type NotebookNoteResolution =
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
  /**
   * Whose view resolves the note, or `null` for a system read.
   *
   * Required, because this returns the note's *body* and the ask-AI path puts
   * it straight into a model prompt: a Project member is not automatically a
   * reader of every note filed under that Project.
   *
   * `null` is the standing and monitor comparison jobs, which read the
   * Project's baseline to build the Project's own report. That report's Run
   * is created for a Project writer, so a member who gave their own `private`
   * note the `understanding` role has its body reach that person's Run. Do
   * not narrow this read: the baseline role is a Project fixture, and an
   * empty comparison would be the result.
   */
  viewerUserId: string | null,
): Promise<NotebookNoteResolution> {
  const result = await db.query<NotebookNoteRow>(
    `SELECT n.object_id AS id, n.version, n.content_json, n.plain_text
       FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
      WHERE n.space_id=$1 AND n.role_project_id=$2 AND n.project_role=$3
        AND n.status='active' AND so.deleted_at IS NULL
        ${viewerUserId ? `AND ${contentReadSql("space_object", "so", "$4")}` : ""}
      LIMIT 1`,
    viewerUserId ? [spaceId, projectId, role, viewerUserId] : [spaceId, projectId, role],
  );
  const note = result.rows[0];
  return note ? { present: true, note } : { present: false, role, reason: "no_note_in_role" };
}

/**
 * Whether a Note may be a monitoring comparison baseline.
 *
 * The baseline is a system read (see `resolveNotebookNote`) whose body goes into the
 * comparison prompt, and what the model writes from it lands in Project-shared outputs
 * (scan summaries, evidence cards, Evidence Signals) that answer only to Project read.
 * Those outputs cannot carry a Note's Source policy, so a Note with any Source lineage
 * entry (`source_item`, `source_snapshot`, `extracted_evidence` provenance, however its
 * connections resolve now) is never a baseline: whoever queues the comparison, nothing
 * derived from a Source reaches a Project reader that Source does not admit. Lineage is
 * append-only, so a Note admitted here was lineage-free when its body was frozen; a
 * deleted Note is not admitted either.
 */
export async function notebookBaselineAdmissible(db: Queryable, spaceId: string, noteId: string): Promise<boolean> {
  const result = await db.query<{ derived: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM provenance_links pl
                     WHERE pl.space_id=so.space_id AND pl.target_type='note' AND pl.target_id=so.id
                       AND pl.source_type=ANY($3::varchar[])) AS derived
       FROM space_objects so WHERE so.space_id=$1 AND so.id=$2 AND so.deleted_at IS NULL`,
    [spaceId, noteId, [...SOURCE_LINEAGE_PROVENANCE_TYPES]],
  );
  return result.rows[0]?.derived === false;
}

/**
 * Whether a monitoring comparison Run's frozen baseline (`baseline_note_id` in its
 * `project_research` or `project_research_standing` input) is admissible now, by
 * `notebookBaselineAdmissible`. Applied before every provider attempt and again before
 * a terminal result is merged into Project-shared outputs (the standing batch's evidence
 * cards, the focused operation's comparison results): a Run queued before the id was
 * frozen cannot prove which Note it copied and is refused at either point.
 */
export async function comparisonBaselineAdmission(
  db: Queryable, spaceId: string, workflowInput: unknown,
): Promise<"admitted" | "not_frozen" | "withheld"> {
  const input = (workflowInput && typeof workflowInput === "object" ? workflowInput : {}) as Record<string, unknown>;
  const frozen = (input.project_research_standing ?? input.project_research) as Record<string, unknown> | undefined;
  const baseline = frozen && typeof frozen.baseline_note_id === "string" && frozen.baseline_note_id ? frozen.baseline_note_id : null;
  if (!baseline) return "not_frozen";
  return (await notebookBaselineAdmissible(db, spaceId, baseline)) ? "admitted" : "withheld";
}

/** Every role-carrying note of a project, keyed by role. */
/**
 * Every role-bound note of a Project, as the system sees them.
 *
 * Unscoped on purpose: its callers seed starter notes, adopt them by title and
 * materialize a report into them, all of which must see a role that is filled
 * whoever filled it. Nothing here reaches a person's prompt —
 * `resolveNotebookNote` is the read that does, and it takes a viewer.
 */
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
