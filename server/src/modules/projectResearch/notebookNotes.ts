import type { Queryable } from "../routeUtils/common";

/**
 * A project's "notebook" is a set of ordinary Notes (free-form, not a fixed
 * schema) filed under that project's auto-created Knowledge Notes folder and
 * tagged with `primary_project_id`. These four keys/titles only identify the
 * starter notes seeded for onboarding — nothing prevents a project from
 * having more notes than these four, or none of them (if the user
 * renamed/deleted a starter note).
 */
export const NOTEBOOK_SECTION_KEYS = ["understanding", "questions", "ideas", "experiments"] as const;
export type SectionKey = typeof NOTEBOOK_SECTION_KEYS[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  understanding: "Current understanding",
  questions: "Open questions",
  ideas: "Idea pool",
  experiments: "Experiment log",
};

export interface NotebookNoteRow {
  id: string;
  version: number;
  content_json: Record<string, unknown>;
  plain_text: string | null;
}

/**
 * Resolves a project-scoped note by title (first match, oldest first).
 * Returns null when the project's notes area isn't initialized yet, or
 * the named note doesn't exist (e.g. a starter note was renamed/deleted).
 */
export async function resolveProjectNoteByTitle(
  db: Queryable,
  spaceId: string,
  projectId: string,
  title: string,
): Promise<NotebookNoteRow | null> {
  const result = await db.query<NotebookNoteRow>(
    `SELECT n.object_id AS id, n.version, n.content_json, n.plain_text
       FROM notes n JOIN space_objects so ON so.id=n.object_id AND so.space_id=n.space_id
      WHERE so.space_id=$1 AND so.primary_project_id=$2 AND so.status='active' AND so.title=$3
      ORDER BY so.created_at ASC LIMIT 1`,
    [spaceId, projectId, title],
  );
  return result.rows[0] ?? null;
}

export function resolveNotebookNote(db: Queryable, spaceId: string, projectId: string, key: SectionKey): Promise<NotebookNoteRow | null> {
  return resolveProjectNoteByTitle(db, spaceId, projectId, SECTION_LABELS[key]);
}
