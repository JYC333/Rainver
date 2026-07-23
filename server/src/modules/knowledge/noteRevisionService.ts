import { createHash, randomUUID } from "node:crypto";
import { HttpError, type Queryable } from "../routeUtils/common";
import { applyNoteOps, normalizePmText, parseNoteOps, pmBlocksText, type NoteOp } from "./noteDocument";

export type NoteRevisionSource = "user_edit" | "ai_monitoring" | "ai_adhoc" | "seed" | "rollback";

export interface NoteContentRow {
  object_id: string;
  content_json: Record<string, unknown>;
  content_format: string;
  plain_text: string | null;
  content_hash: string | null;
  refs_json: unknown;
  version: number;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export type NoteWriteResult =
  | { outcome: "written"; note: NoteContentRow }
  | { outcome: "version_conflict"; currentVersion: number };

/**
 * Single writer for note content. Every path — user save, AI ops, seeding,
 * rollback — goes through here so each new version always gets a revision
 * row, which is what makes rollback trustworthy.
 */
export async function writeNote(db: Queryable, input: {
  spaceId: string;
  noteId: string;
  expectVersion?: number | null;
  content: { kind: "doc"; doc: Record<string, unknown>; plainText?: string | null } | { kind: "ops"; ops: NoteOp[] };
  source: NoteRevisionSource;
  userId?: string | null;
  runId?: string | null;
  refs?: string[];
  diff?: unknown;
}): Promise<NoteWriteResult> {
  const locked = await db.query<NoteContentRow>(
    `SELECT object_id, content_json, content_format, plain_text, content_hash, refs_json, version, updated_by_user_id, updated_by_run_id
       FROM notes WHERE object_id=$1 AND space_id=$2 FOR UPDATE`,
    [input.noteId, input.spaceId],
  );
  const current = locked.rows[0];
  if (!current) throw new HttpError(404, "Note not found");
  if (input.expectVersion !== null && input.expectVersion !== undefined && input.expectVersion !== current.version) {
    return { outcome: "version_conflict", currentVersion: current.version };
  }
  const doc = input.content.kind === "doc" ? input.content.doc : applyNoteOps(current.content_json ?? {}, input.content.ops);
  // Ordinary editor saves pass their own plain-text extraction (matches the
  // rich-text editor's rendering exactly); AI ops writes have no client-side
  // extraction, so they derive it from the resulting Tiptap blocks.
  const normalized = input.content.kind === "doc" && input.content.plainText !== undefined
    ? (input.content.plainText ?? "")
    : normalizePmText(doc);
  const mergedRefs = [...new Set([
    ...(Array.isArray(current.refs_json) ? current.refs_json.filter((v): v is string => typeof v === "string") : []),
    ...(input.refs ?? []),
  ])];
  const now = new Date().toISOString();
  const hash = sha256(normalized);
  const updated = await db.query<NoteContentRow>(
    `WITH obj AS (
       UPDATE space_objects SET updated_at=$8 WHERE id=$1 AND space_id=$9
     )
     UPDATE notes
        SET content_json=$2::jsonb, plain_text=$3, content_hash=$4, refs_json=$5::jsonb, version=version+1,
            updated_by_user_id=$6, updated_by_run_id=$7
      WHERE object_id=$1 AND space_id=$9
      RETURNING object_id, content_json, content_format, plain_text, content_hash, refs_json, version, updated_by_user_id, updated_by_run_id`,
    [input.noteId, JSON.stringify(doc), normalized, hash, JSON.stringify(mergedRefs), input.userId ?? null, input.runId ?? null, now, input.spaceId],
  );
  const note = updated.rows[0]!;
  await insertRevision(db, {
    spaceId: input.spaceId, noteId: note.object_id, version: note.version, doc, normalized, hash, refs: mergedRefs,
    source: input.source, userId: input.userId ?? null, runId: input.runId ?? null, diff: input.diff ?? null, at: now,
  });
  return { outcome: "written", note };
}

/**
 * Applies AI-proposed block ops to a note, single writer for both async
 * agent-run paths and synchronous chat paths. When the note moved past
 * `baseVersion` since the ops were computed, the change degrades to a
 * clearly labeled append instead of silently dropping the request or
 * overwriting newer content.
 */
export async function applyNoteOpsWithConflictFallback(db: Queryable, input: {
  spaceId: string;
  noteId: string;
  baseVersion: number;
  rawOps: unknown[];
  source: NoteRevisionSource;
  runId: string;
  refs: string[];
}): Promise<{ note: NoteContentRow; conflict: boolean } | null> {
  const note = await db.query<{ version: number; content_json: Record<string, unknown> }>(
    `SELECT version, content_json FROM notes WHERE object_id=$1 AND space_id=$2 FOR UPDATE`,
    [input.noteId, input.spaceId],
  );
  if (!note.rows[0]) return null;
  if (note.rows[0].version === input.baseVersion) {
    const ops = parseNoteOps(input.rawOps, pmBlocksText(note.rows[0].content_json).length);
    const result = await writeNote(db, {
      spaceId: input.spaceId, noteId: input.noteId,
      expectVersion: input.baseVersion,
      content: { kind: "ops", ops },
      source: input.source, runId: input.runId, refs: input.refs,
      diff: { ops, base_version: input.baseVersion },
    });
    return result.outcome === "written" ? { note: result.note, conflict: false } : null;
  }
  const markdown = input.rawOps
    .map((value) => (typeof (value as { markdown?: unknown })?.markdown === "string" ? (value as { markdown: string }).markdown : ""))
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  if (!markdown) return null;
  const fallback: NoteOp[] = [{ op: "append", markdown: `## AI update (note changed since v${input.baseVersion})\n\n${markdown}` }];
  const result = await writeNote(db, {
    spaceId: input.spaceId, noteId: input.noteId,
    content: { kind: "ops", ops: fallback },
    source: input.source, runId: input.runId, refs: input.refs,
    diff: { ops: fallback, base_version: input.baseVersion, conflict: true },
  });
  return result.outcome === "written" ? { note: result.note, conflict: true } : null;
}

export async function rollbackNote(db: Queryable, input: {
  spaceId: string;
  noteId: string;
  toVersion: number;
  userId: string;
}): Promise<NoteContentRow> {
  const revision = await db.query<{ content_json: Record<string, unknown>; refs_json: unknown }>(
    `SELECT content_json, refs_json FROM note_revisions WHERE note_id=$1 AND space_id=$2 AND version=$3`,
    [input.noteId, input.spaceId, input.toVersion],
  );
  if (!revision.rows[0]) throw new HttpError(404, "Note revision not found");
  const result = await writeNote(db, {
    spaceId: input.spaceId,
    noteId: input.noteId,
    content: { kind: "doc", doc: revision.rows[0].content_json },
    source: "rollback",
    userId: input.userId,
    refs: Array.isArray(revision.rows[0].refs_json) ? revision.rows[0].refs_json.filter((v): v is string => typeof v === "string") : [],
    diff: { rolled_back_to_version: input.toVersion },
  });
  if (result.outcome !== "written") throw new HttpError(409, "Note changed while rolling back; retry");
  return result.note;
}

export async function listNoteRevisions(db: Queryable, input: {
  spaceId: string;
  noteId: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const rows = await db.query(
    `SELECT id, version, content_json, normalized_text, refs_json, source, diff_json, created_by_user_id, created_by_run_id, created_at
       FROM note_revisions
      WHERE note_id=$1 AND space_id=$2
      ORDER BY version DESC
      LIMIT $3`,
    [input.noteId, input.spaceId, limit],
  );
  return rows.rows;
}

export async function insertInitialNoteRevision(db: Queryable, input: {
  spaceId: string;
  noteId: string;
  doc: Record<string, unknown>;
  at: string;
  userId?: string | null;
}): Promise<void> {
  await insertRevision(db, {
    spaceId: input.spaceId, noteId: input.noteId, version: 1, doc: input.doc, normalized: normalizePmText(input.doc),
    hash: sha256(normalizePmText(input.doc)), refs: [], source: "seed", userId: input.userId ?? null, runId: null, diff: null, at: input.at,
  });
}

async function insertRevision(db: Queryable, input: {
  spaceId: string; noteId: string; version: number; doc: Record<string, unknown>; normalized: string; hash: string;
  refs: string[]; source: NoteRevisionSource; userId: string | null; runId: string | null; diff: unknown; at: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO note_revisions
       (id, space_id, note_id, version, content_json, normalized_text, content_hash, refs_json, source, diff_json, created_by_user_id, created_by_run_id, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13)
     ON CONFLICT (note_id, version) DO NOTHING`,
    [randomUUID(), input.spaceId, input.noteId, input.version, JSON.stringify(input.doc), input.normalized, input.hash,
      JSON.stringify(input.refs), input.source, input.diff === null || input.diff === undefined ? null : JSON.stringify(input.diff), input.userId, input.runId, input.at],
  );
}

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
