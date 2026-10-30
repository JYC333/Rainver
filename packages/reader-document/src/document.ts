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

/** Visible text of any node, used when an unsupported node is degraded to text. */
export function readerNodeText(node: unknown): string {
  if (!isRecord(node)) return "";
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  return Array.isArray(node.content) ? node.content.map(readerNodeText).join(node.type === "doc" ? "\n\n" : "") : "";
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
  if (value.type === "text") {
    if (typeof value.text !== "string" || value.text === "") return [];
    const code = Array.isArray(value.marks) && value.marks.some(mark => isRecord(mark) && mark.type === "code");
    const marks = cleanMarks(value.marks, code);
    return [{ type: "text", text: value.text, ...(marks ? { marks } : {}) }];
  }
  if (value.type === "hardBreak") return [{ type: "hardBreak" }];
  // Anything else inside text keeps its words, not its structure.
  const text = readerNodeText(value);
  return text ? [{ type: "text", text }] : [];
}

function inlines(content: unknown): ReaderNode[] {
  return Array.isArray(content) ? content.flatMap(inline) : [];
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
function blocks(content: unknown): ReaderNode[] {
  const out: ReaderNode[] = [];
  let pending: ReaderNode[] = [];
  const flush = () => { if (pending.length) out.push(textBlock("paragraph", pending)); pending = [] };
  for (const child of Array.isArray(content) ? content : []) {
    if (isRecord(child) && typeof child.type === "string" && BLOCKS.has(child.type)) {
      flush();
      const node = block(child);
      if (node) out.push(node);
    } else if (isRecord(child) && (INLINES.has(String(child.type)))) {
      pending.push(...inline(child));
    } else {
      // Unsupported or misplaced structure becomes a paragraph of its text.
      flush();
      const text = readerNodeText(child);
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

function block(node: Record<string, unknown>): ReaderNode | null {
  const attrs = isRecord(node.attrs) ? node.attrs : {};
  switch (node.type) {
    case "paragraph":
      return textBlock("paragraph", inlines(node.content));
    case "heading":
      return textBlock("heading", inlines(node.content), { level: intAttr(attrs.level, 1, 6, 1) });
    case "codeBlock": {
      // Code is kept character for character: one plain text node, no marks.
      const text = Array.isArray(node.content) ? node.content.map(readerNodeText).join("") : "";
      const language = stringAttr(attrs.language);
      return { type: "codeBlock", ...(language ? { attrs: { language } } : {}), ...(text ? { content: [{ type: "text", text }] } : {}) };
    }
    case "blockquote": {
      const content = blocks(node.content);
      return { type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] };
    }
    case "bulletList":
    case "orderedList": {
      const items = (Array.isArray(node.content) ? node.content : []).map(child => {
        const content = isRecord(child) && child.type === "listItem" ? blocks(child.content) : blocks([child]);
        return { type: "listItem", content: paragraphFirst(content) };
      });
      if (!items.length) return null;
      const start = node.type === "orderedList" ? intAttr(attrs.start, 0, 1_000_000, 1) : 1;
      return { type: node.type, ...(node.type === "orderedList" && start !== 1 ? { attrs: { start } } : {}), content: items };
    }
    case "horizontalRule":
      return { type: "horizontalRule" };
    case "image": {
      const src = stringAttr(attrs.src);
      if (!src) return null;
      return { type: "image", attrs: { src, alt: stringAttr(attrs.alt) ?? "", title: stringAttr(attrs.title) } };
    }
    case "table": {
      const rows = (Array.isArray(node.content) ? node.content : []).map(row => {
        const cells = isRecord(row) && row.type === "tableRow" && Array.isArray(row.content) ? row.content : [row];
        return {
          type: "tableRow",
          content: cells.map(cell => {
            const type = isRecord(cell) && cell.type === "tableHeader" ? "tableHeader" : "tableCell";
            const isCell = isRecord(cell) && (cell.type === "tableCell" || cell.type === "tableHeader");
            const content = isCell ? blocks(cell.content) : blocks([cell]);
            const cellAttrs = isCell && isRecord(cell.attrs) ? cell.attrs : {};
            const colspan = intAttr(cellAttrs.colspan, 1, 20, 1);
            const rowspan = intAttr(cellAttrs.rowspan, 1, 20, 1);
            const spans = { ...(colspan > 1 ? { colspan } : {}), ...(rowspan > 1 ? { rowspan } : {}) };
            return { type, ...(Object.keys(spans).length ? { attrs: spans } : {}), content: content.length ? content : [{ type: "paragraph" }] };
          }),
        };
      }).filter(row => row.content.length);
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
  const content = isRecord(value) && value.type === "doc" ? blocks(value.content) : blocks([value]);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
