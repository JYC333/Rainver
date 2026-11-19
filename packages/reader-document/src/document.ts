/**
 * The Reader document tree: the Tiptap/ProseMirror JSON that the server's
 * canonical reading writer stores and the web Reader (`ReadOnlyTiptapReader`)
 * renders. One whitelist for both, so a stored document never contains a node
 * or mark the Reader cannot show.
 */
export interface ReaderMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ReaderNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ReaderNode[];
  text?: string;
  marks?: ReaderMark[];
}

export interface ReaderDocument {
  type: "doc";
  content: ReaderNode[];
}

const BLOCK_TYPES = ["paragraph", "heading", "codeBlock", "blockquote", "bulletList", "orderedList", "horizontalRule", "image", "table"] as const;
const INLINE_TYPES = ["text", "hardBreak"] as const;
export const READER_NODE_TYPES: ReadonlySet<string> = new Set([
  "doc", ...BLOCK_TYPES, ...INLINE_TYPES, "listItem", "tableRow", "tableCell", "tableHeader",
]);
export const READER_MARK_TYPES: ReadonlySet<string> = new Set(["bold", "italic", "strike", "code", "link"]);

const BLOCKS: ReadonlySet<string> = new Set(BLOCK_TYPES);
const INLINES: ReadonlySet<string> = new Set(INLINE_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Nesting deeper than any real document is degraded to its text, read without
 * recursion, so a hostile or corrupt tree cannot exhaust the call stack.
 */
export const READER_MAX_NESTING_DEPTH = 64;

/**
 * Input nodes one normalization (or one text read) visits, degraded subtrees
 * included. Far above any real document; past it the rest of the input is
 * not read and the bounded result says so (`truncated`).
 */
export const READER_MAX_NODES = 500_000;

// One synchronous traversal at a time, so a module-level budget is exact.
let remainingNodes = 0;
let budgetActive = false;
let budgetExhausted = false;

function budgetLeft(): boolean {
  if (remainingNodes <= 0) { budgetExhausted = true; return false; }
  return true;
}

function takeNode(): boolean {
  if (remainingNodes <= 0) { budgetExhausted = true; return false; }
  remainingNodes--;
  return true;
}

/** Charges up to `count` nodes at once; returns how many were granted. */
function takeNodes(count: number): number {
  const granted = Math.max(0, Math.min(count, remainingNodes));
  remainingNodes -= granted;
  if (granted < count) budgetExhausted = true;
  return granted;
}

function withNodeBudget<T>(run: () => T): { value: T; truncated: boolean } {
  if (budgetActive) return { value: run(), truncated: false };
  budgetActive = true;
  remainingNodes = READER_MAX_NODES;
  budgetExhausted = false;
  try {
    const value = run();
    return { value, truncated: budgetExhausted };
  } finally {
    budgetActive = false;
  }
}

/**
 * Text of a subtree in document order, iteratively (no separators between
 * blocks). The stack holds one cursor per open level, never a copy of a
 * child array, so a wide degraded node costs only the nodes actually read.
 */
function flatText(content: unknown): string {
  const parts: string[] = [];
  const stack: { nodes: readonly unknown[]; next: number }[] = [{ nodes: Array.isArray(content) ? content : [content], next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.nodes.length) { stack.pop(); continue; }
    const node = frame.nodes[frame.next++];
    if (!takeNode()) break;
    if (!isRecord(node)) continue;
    if (typeof node.text === "string") parts.push(node.text);
    else if (node.type === "hardBreak") parts.push("\n");
    else if (Array.isArray(node.content) && node.content.length) stack.push({ nodes: node.content, next: 0 });
  }
  return parts.join("");
}

/** `map` over an input array that stops at the first item once the node budget is spent. */
function mapWithinBudget<T>(items: unknown, map: (item: unknown) => T): T[] {
  const out: T[] = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!budgetLeft()) break;
    out.push(map(item));
  }
  return out;
}

function nodeText(node: unknown, depth: number): string {
  if (!takeNode() || !isRecord(node)) return "";
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  if (depth >= READER_MAX_NESTING_DEPTH) return flatText(node.content);
  return mapWithinBudget(node.content, child => nodeText(child, depth + 1)).join(node.type === "doc" ? "\n\n" : "");
}

/** Visible text of any node, used when an unsupported node is degraded to text. */
export function readerNodeText(node: unknown): string {
  return withNodeBudget(() => nodeText(node, 0)).value;
}

function cleanMarks(value: unknown, code: boolean): ReaderMark[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // Inline code excludes every other mark in the Reader schema, links included.
  if (code) return [{ type: "code" }];
  const marks: ReaderMark[] = [];
  for (const mark of value) {
    if (!isRecord(mark) || typeof mark.type !== "string" || !READER_MARK_TYPES.has(mark.type)) continue;
    if (marks.some(existing => existing.type === mark.type)) continue;
    if (mark.type === "link") {
      const href = isRecord(mark.attrs) && typeof mark.attrs.href === "string" ? mark.attrs.href.trim() : "";
      if (href) marks.push({ type: "link", attrs: { href } });
      continue;
    }
    marks.push({ type: mark.type });
  }
  return marks.length ? marks : undefined;
}

function inline(value: unknown): ReaderNode[] {
  if (!isRecord(value)) return [];
  if (value.type !== "text" && value.type !== "hardBreak") {
    // Anything else inside text keeps its words, not its structure.
    const text = nodeText(value, 0);
    return text ? [{ type: "text", text }] : [];
  }
  if (!takeNode()) return [];
  if (value.type === "text") {
    if (typeof value.text !== "string" || value.text === "") return [];
    const code = Array.isArray(value.marks) && value.marks.some(mark => isRecord(mark) && mark.type === "code");
    const marks = cleanMarks(value.marks, code);
    return [{ type: "text", text: value.text, ...(marks ? { marks } : {}) }];
  }
  return [{ type: "hardBreak" }];
}

function inlines(content: unknown): ReaderNode[] {
  return mapWithinBudget(content, inline).flat();
}

function textBlock(type: "paragraph" | "heading", content: ReaderNode[], attrs?: Record<string, unknown>): ReaderNode {
  return { type, ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) };
}

function intAttr(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function stringAttr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Block children; stray inline content is wrapped into paragraphs, nothing is dropped silently. */
function blocks(content: unknown, depth = 0): ReaderNode[] {
  if (depth >= READER_MAX_NESTING_DEPTH) {
    const text = flatText(content);
    return text.trim() ? [textBlock("paragraph", [{ type: "text", text }])] : [];
  }
  const out: ReaderNode[] = [];
  let pending: ReaderNode[] = [];
  const flush = () => { if (pending.length) out.push(textBlock("paragraph", pending)); pending = [] };
  for (const child of Array.isArray(content) ? content : []) {
    if (!budgetLeft()) break;
    if (isRecord(child) && typeof child.type === "string" && BLOCKS.has(child.type)) {
      flush();
      if (!takeNode()) break;
      const node = block(child, depth);
      if (node) out.push(node);
    } else if (isRecord(child) && (INLINES.has(String(child.type)))) {
      pending.push(...inline(child));
    } else {
      // Unsupported or misplaced structure becomes a paragraph of its text.
      flush();
      const text = nodeText(child, 0);
      if (text.trim()) out.push(textBlock("paragraph", [{ type: "text", text }]));
    }
  }
  flush();
  return out;
}

/**
 * A list item must open with a paragraph. A heading there becomes a paragraph
 * of the same text; any other first block (a list, code, an image…) gets an
 * empty paragraph in front so nothing is dropped.
 */
function paragraphFirst(content: ReaderNode[]): ReaderNode[] {
  const first = content[0];
  if (!first) return [{ type: "paragraph" }];
  if (first.type === "paragraph") return content;
  if (first.type === "heading") return [{ type: "paragraph", ...(first.content ? { content: first.content } : {}) }, ...content.slice(1)];
  return [{ type: "paragraph" }, ...content];
}

function tableCell(cell: unknown, depth: number): ReaderNode {
  const type = isRecord(cell) && cell.type === "tableHeader" ? "tableHeader" : "tableCell";
  const isCell = isRecord(cell) && (cell.type === "tableCell" || cell.type === "tableHeader");
  const content = isCell ? blocks(cell.content, depth + 3) : blocks([cell], depth + 2);
  const cellAttrs = isCell && isRecord(cell.attrs) ? cell.attrs : {};
  const colspan = intAttr(cellAttrs.colspan, 1, 20, 1);
  const rowspan = intAttr(cellAttrs.rowspan, 1, 20, 1);
  const spans = { ...(colspan > 1 ? { colspan } : {}), ...(rowspan > 1 ? { rowspan } : {}) };
  return { type, ...(Object.keys(spans).length ? { attrs: spans } : {}), content: content.length ? content : [{ type: "paragraph" }] };
}

function block(node: Record<string, unknown>, depth: number): ReaderNode | null {
  const attrs = isRecord(node.attrs) ? node.attrs : {};
  switch (node.type) {
    case "paragraph":
      return textBlock("paragraph", inlines(node.content));
    case "heading":
      return textBlock("heading", inlines(node.content), { level: intAttr(attrs.level, 1, 6, 1) });
    case "codeBlock": {
      // Code is kept character for character: one plain text node, no marks.
      const text = mapWithinBudget(node.content, child => nodeText(child, depth + 1)).join("");
      const language = stringAttr(attrs.language);
      return { type: "codeBlock", ...(language ? { attrs: { language } } : {}), ...(text ? { content: [{ type: "text", text }] } : {}) };
    }
    case "blockquote": {
      const content = blocks(node.content, depth + 1);
      return { type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] };
    }
    case "bulletList":
    case "orderedList": {
      const items: ReaderNode[] = [];
      for (const child of Array.isArray(node.content) ? node.content : []) {
        if (!takeNode()) break;
        const content = isRecord(child) && child.type === "listItem" ? blocks(child.content, depth + 2) : blocks([child], depth + 1);
        items.push({ type: "listItem", content: paragraphFirst(content) });
      }
      if (!items.length) return null;
      const start = node.type === "orderedList" ? intAttr(attrs.start, 0, 1_000_000, 1) : 1;
      return { type: node.type, ...(node.type === "orderedList" && start !== 1 ? { attrs: { start } } : {}), content: items };
    }
    case "horizontalRule":
      return { type: "horizontalRule" };
    case "image": {
      const src = stringAttr(attrs.src);
      if (!src) return null;
      const dimensions = Object.fromEntries(["width", "height"].flatMap(key => {
        const value = attrs[key];
        return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000 ? [[key, value]] : [];
      }));
      return { type: "image", attrs: { src, alt: stringAttr(attrs.alt) ?? "", title: stringAttr(attrs.title), ...dimensions } };
    }
    case "table": {
      const rows: ReaderNode[] = [];
      for (const row of Array.isArray(node.content) ? node.content : []) {
        if (!takeNode()) break;
        const cells: unknown[] = isRecord(row) && row.type === "tableRow" && Array.isArray(row.content) ? row.content : [row];
        // A row's cells are all charged before any is read, as before: a row
        // that runs out keeps the cells it was charged for.
        const charged = takeNodes(cells.length);
        const content = cells.slice(0, charged).map(cell => tableCell(cell, depth));
        if (content.length) rows.push({ type: "tableRow", content });
      }
      return rows.length ? { type: "table", content: rows } : null;
    }
    default:
      return null;
  }
}

/**
 * A Reader document that the Reader schema accepts, from any input. Supported
 * structure is kept; an unsupported or misplaced node is degraded to its text
 * (a paragraph where a block belongs, plain text inside a paragraph); unknown
 * marks are dropped. A single bad node therefore never blanks a document.
 */
export function normalizeReaderDocument(value: unknown): ReaderDocument {
  return normalizeReaderDocumentBounded(value).document;
}

/**
 * `normalizeReaderDocument` with its bound made visible: `truncated` is true
 * when the input had more than `READER_MAX_NODES` nodes and the rest was not
 * read.
 */
export function normalizeReaderDocumentBounded(value: unknown): { document: ReaderDocument; truncated: boolean } {
  const { value: content, truncated } = withNodeBudget(() =>
    isRecord(value) && value.type === "doc" ? blocks(value.content) : blocks([value]));
  return { document: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }, truncated };
}
