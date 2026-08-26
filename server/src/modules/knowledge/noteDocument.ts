import { objectValue, optionalString } from "../routeUtils/common.js";

type PmNode = Record<string, unknown>;

export function markdownToPm(markdown: string): PmNode {
  const content: PmNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const textNode = (value: string): PmNode[] => value ? [{ type: "text", text: value }] : [];
  const flushParagraph = () => {
    const value = paragraph.join(" ").trim();
    if (value) content.push({ type: "paragraph", content: textNode(value) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    content.push({
      type: list.ordered ? "orderedList" : "bulletList",
      content: list.items.map((item) => ({ type: "listItem", content: [{ type: "paragraph", content: textNode(item) }] })),
    });
    list = null;
  };

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: textNode(heading[2]!.trim()) });
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const next = { ordered: Boolean(ordered), value: (bullet?.[1] ?? ordered?.[1] ?? "").trim() };
      if (list && list.ordered !== next.ordered) flushList();
      if (!list) list = { ordered: next.ordered, items: [] };
      list.items.push(next.value);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** Plain text of one top-level block, list items on their own `- ` lines. */
export function pmBlockText(block: unknown): string {
  const node = objectValue(block);
  const type = String(node.type ?? "");
  if (type === "bulletList" || type === "orderedList") {
    const items = Array.isArray(node.content) ? node.content : [];
    return items
      .map((item, index) => {
        const text = inlineText(item).trim();
        return text ? `${type === "orderedList" ? `${index + 1}.` : "-"} ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return inlineText(node).trim();
}

/** Plain text of every top-level block, in document order. */
export function pmBlocksText(doc: unknown): string[] {
  const content = objectValue(doc).content;
  return (Array.isArray(content) ? content : []).map(pmBlockText);
}

export function normalizePmText(value: unknown): string {
  return pmBlocksText(value).filter(Boolean).join("\n\n");
}

export type NoteOp =
  | { op: "append"; markdown: string }
  | { op: "insert"; index: number; markdown: string }
  | { op: "replace"; index: number; count: number; markdown: string }
  | { op: "delete"; index: number; count: number };

/**
 * Validate untrusted op input (structured AI output or API body) against a
 * document with `blockCount` top-level blocks. Throws on any malformed op so a
 * partially valid batch never mutates the note.
 */
export function parseNoteOps(value: unknown, blockCount: number): NoteOp[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error("note ops must be a non-empty array of at most 50 operations");
  }
  const ops: NoteOp[] = [];
  for (const raw of value) {
    const record = objectValue(raw);
    const op = optionalString(record.op);
    const markdown = typeof record.markdown === "string" ? record.markdown.trim() : "";
    const index = record.index === null || record.index === undefined ? null : Number(record.index);
    const count = record.count === null || record.count === undefined ? 1 : Number(record.count);
    if (op === "append") {
      if (!markdown) throw new Error("append requires markdown");
      ops.push({ op, markdown });
      continue;
    }
    if (index === null || !Number.isInteger(index) || index < 0) throw new Error(`${op ?? "unknown"} requires a non-negative block index`);
    if (op === "insert") {
      if (!markdown || index > blockCount) throw new Error("insert requires markdown and an index within the document");
      ops.push({ op, index, markdown });
      continue;
    }
    if (op !== "replace" && op !== "delete") throw new Error(`unsupported note op ${JSON.stringify(op)}`);
    if (!Number.isInteger(count) || count < 1 || index + count > blockCount) throw new Error(`${op} range is outside the document`);
    if (op === "replace" && !markdown) throw new Error("replace requires markdown");
    ops.push(op === "replace" ? { op, index, count, markdown } : { op, index, count });
  }
  assertNonOverlapping(ops, blockCount);
  return ops;
}

/**
 * Apply block-level ops to a Tiptap doc. Untouched blocks are carried over
 * byte-identical, so user formatting outside the edited ranges is never lost.
 */
export function applyNoteOps(doc: unknown, ops: NoteOp[]): PmNode {
  const source = objectValue(doc);
  const blocks = Array.isArray(source.content) ? [...source.content] : [];
  const ordered = [...ops].sort((left, right) => anchorIndex(right, blocks.length) - anchorIndex(left, blocks.length));
  for (const op of ordered) {
    if (op.op === "append") {
      blocks.push(...markdownBlocks(op.markdown));
    } else if (op.op === "insert") {
      blocks.splice(op.index, 0, ...markdownBlocks(op.markdown));
    } else if (op.op === "replace") {
      blocks.splice(op.index, op.count, ...markdownBlocks(op.markdown));
    } else {
      blocks.splice(op.index, op.count);
    }
  }
  return { ...source, type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] };
}

function markdownBlocks(markdown: string): PmNode[] {
  const content = markdownToPm(markdown).content;
  return Array.isArray(content) ? content as PmNode[] : [];
}

function anchorIndex(op: NoteOp, blockCount: number): number {
  return op.op === "append" ? blockCount + 1 : op.index;
}

function assertNonOverlapping(ops: NoteOp[], blockCount: number): void {
  const ranges = ops
    .filter((op): op is Extract<NoteOp, { index: number }> => op.op !== "append")
    .map((op) => ({ start: op.index, end: op.op === "insert" ? op.index : op.index + op.count }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1]!;
    const next = ranges[i]!;
    if (next.start < prev.end || next.start === prev.start) {
      throw new Error("note ops must not overlap");
    }
  }
  if (ops.filter((op) => op.op === "append").length > 1) throw new Error("at most one append op is allowed");
  void blockCount;
}

function inlineText(node: unknown): string {
  const record = objectValue(node);
  if (typeof record.text === "string") return record.text;
  if (!Array.isArray(record.content)) return "";
  return record.content.map((child) => inlineText(child)).join("");
}
