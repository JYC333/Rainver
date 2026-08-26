import { HttpError } from "../routeUtils/common.js";

/**
 * The system-reserved roles a Note can play in its Project's notebook (N2).
 *
 * Before this, the four notes that make up a Project's research baseline were
 * resolved by matching `space_objects.title` against literal English strings.
 * Renaming a note therefore removed it from the baseline silently — the
 * comparison kept running against a null "current understanding" and reported
 * nothing. The role is the binding instead: it survives a rename, a move
 * between collections, and a change of title language.
 *
 * The vocabulary lives here rather than in a database CHECK (B12F, matching
 * persisted source-reference kinds and `cards.source_type`). `notes` carries
 * only a format constraint; this module is what makes the demotion safe. Users
 * assign and clear roles; they cannot invent them.
 */

/**
 * `inbox` is not one of the research baseline's four. It is the Project's
 * capture target: a quick capture with no context object appends to it rather
 * than creating a fragment per thought. It is a role rather than a title lookup
 * for the same reason the other four are — the previous work removed
 * title-based note resolution and the inbox cannot reintroduce it.
 *
 * Mirrors `NOTE_PROJECT_ROLE_VALUES` in the protocol package, which is the
 * shared vocabulary the web client reads. The server keeps its own const
 * because the write-path rule lives here, with the SQL that enforces it, and
 * the protocol package must stay a contract without behaviour. The pair is
 * cross-checked by `test/noteProjectRoleGuard.test.ts`, the same arrangement
 * the link-type registry uses, so a divergence fails rather than drifts.
 */
export const NOTE_PROJECT_ROLES = ["understanding", "questions", "ideas", "experiments", "inbox"] as const;

export type NoteProjectRole = typeof NOTE_PROJECT_ROLES[number];

/**
 * The title a role's note is created with. A default at creation only — never
 * a lookup key, which is the whole point of the role existing. A user may
 * rename any of these freely.
 */
export const NOTE_PROJECT_ROLE_DEFAULT_TITLES: Record<NoteProjectRole, string> = {
  understanding: "Current understanding",
  questions: "Open questions",
  ideas: "Idea pool",
  experiments: "Experiment log",
  inbox: "Project inbox",
};

export function isNoteProjectRole(value: unknown): value is NoteProjectRole {
  return typeof value === "string" && (NOTE_PROJECT_ROLES as readonly string[]).includes(value);
}

/** Registry-backed check replacing the closed-set CHECK the column does not have. */
export function assertNoteProjectRole(value: unknown): asserts value is NoteProjectRole {
  if (!isNoteProjectRole(value)) {
    throw new HttpError(422, `Unknown note project role: ${String(value)}`);
  }
}
