import { randomUUID } from "node:crypto";
import { objectValue } from "../routeUtils/common.js";
import { pmBlockText } from "./noteDocument.js";

type PmNode = Record<string, unknown>;

/**
 * Stable identity for a top-level block of a note.
 *
 * Capture needs to be able to say "this paragraph is the one I wrote" after the
 * user has edited around it, which a block *index* cannot do — inserting a line
 * above shifts every index below it. The id travels in the ProseMirror node's
 * own `attrs`, so it survives in `content_json`, in every revision, and through
 * the editor round-trip.
 *
 * Only top-level blocks carry one. Relocation extracts whole blocks, so an id
 * on a list item or an inline span would be identity nothing asks for, and
 * every one of them would have to be kept unique through splits and merges.
 */
export const BLOCK_ID_ATTR = "blockId";

/**
 * Stamp an id on every top-level block that has none, leaving existing ids
 * untouched.
 *
 * Absence is legal and stays legal: notes written before this existed keep
 * loading, and their blocks acquire ids the next time the note is written
 * rather than through a migration that would rewrite history. `note_revisions`
 * rows are never rewritten — an old revision restored by rollback simply
 * arrives without ids and is stamped by the write that restores it.
 */
export function withBlockIds(doc: unknown): PmNode {
  const source = objectValue(doc);
  const blocks = Array.isArray(source.content) ? source.content : [];
  let changed = false;
  const next = blocks.map((block) => {
    const node = objectValue(block);
    const attrs = objectValue(node.attrs);
    if (typeof attrs[BLOCK_ID_ATTR] === "string" && attrs[BLOCK_ID_ATTR]) return block;
    changed = true;
    return { ...node, attrs: { ...attrs, [BLOCK_ID_ATTR]: randomUUID() } };
  });
  if (!changed) return source;
  return { ...source, content: next };
}

/** The ids of a document's top-level blocks, in order; `null` where absent. */
export function blockIds(doc: unknown): (string | null)[] {
  const source = objectValue(doc);
  const blocks = Array.isArray(source.content) ? source.content : [];
  return blocks.map((block) => {
    const value = objectValue(objectValue(block).attrs)[BLOCK_ID_ATTR];
    return typeof value === "string" && value ? value : null;
  });
}

/**
 * The ids a write introduced — the blocks in `next` that `previous` did not
 * have.
 *
 * This is how a capture learns which block it became. Computing it by diffing
 * ids rather than by trusting the op's position keeps it correct when several
 * ops run in one write, and when the append is not the last thing applied.
 */
export function addedBlockIds(previous: unknown, next: unknown): string[] {
  const before = new Set(blockIds(previous).filter((id): id is string => id !== null));
  return blockIds(next).filter((id): id is string => id !== null && !before.has(id));
}

export interface NoteBlock {
  id: string | null;
  type: string;
  text: string;
}

/** Top-level blocks with their identity and current text, in document order. */
export function noteBlocks(doc: unknown): NoteBlock[] {
  const source = objectValue(doc);
  const blocks = Array.isArray(source.content) ? source.content : [];
  return blocks.map((block) => {
    const node = objectValue(block);
    const value = objectValue(node.attrs)[BLOCK_ID_ATTR];
    return {
      id: typeof value === "string" && value ? value : null,
      type: String(node.type ?? ""),
      text: pmBlockText(block),
    };
  });
}

/**
 * Remove the named blocks, keeping everything else byte-identical.
 *
 * A document may not end up empty — ProseMirror rejects a doc with no content
 * — so removing the last block leaves an empty paragraph behind, which is what
 * the editor would show anyway.
 */
export function removeBlocks(doc: unknown, ids: readonly string[]): PmNode {
  const source = objectValue(doc);
  const drop = new Set(ids);
  const blocks = Array.isArray(source.content) ? source.content : [];
  const kept = blocks.filter((block) => {
    const value = objectValue(objectValue(block).attrs)[BLOCK_ID_ATTR];
    return !(typeof value === "string" && drop.has(value));
  });
  return { ...source, type: "doc", content: kept.length ? kept : [{ type: "paragraph" }] };
}
