import MarkdownIt from "markdown-it";
import { normalizeReaderDocument, type ReaderDocument, type ReaderMark, type ReaderNode } from "./document.js";

/**
 * Converts Markdown into the Reader document tree with markdown-it — the one
 * Markdown → Reader converter, used by the server's canonical reading writer
 * for content declared as Markdown and by the web Reader for Markdown it
 * renders itself.
 *
 * A direct token → JSON walk rather than `prosemirror-markdown`: that resolves
 * tokens against a live ProseMirror schema, while the Reader stores plain JSON
 * and has its own small table shape. Raw HTML in Markdown is not interpreted
 * (`html: false`): it stays visible text, never markup. Images are block nodes
 * in the Reader, so an image inside a paragraph splits it. Code keeps every
 * character, indentation included. The result passes through
 * `normalizeReaderDocument`, so anything unexpected degrades to text.
 */
const parser = new MarkdownIt("default", { html: false, linkify: false, breaks: false });

type Token = ReturnType<typeof parser.parse>[number];
interface Cursor { index: number }

export function markdownToReaderDocument(markdown: string): ReaderDocument {
  const tokens = parser.parse(markdown ?? "", {});
  return normalizeReaderDocument({ type: "doc", content: blocksFromTokens(tokens, { index: 0 }, null) });
}

function blocksFromTokens(tokens: Token[], cursor: Cursor, stopType: string | null): ReaderNode[] {
  const nodes: ReaderNode[] = [];
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!;
    if (stopType && token.type === stopType) {
      cursor.index += 1;
      return nodes;
    }
    const produced = blockNodesFromToken(tokens, cursor);
    if (produced) nodes.push(...produced);
    else cursor.index += 1;
  }
  return nodes;
}

function blockNodesFromToken(tokens: Token[], cursor: Cursor): ReaderNode[] | null {
  const token = tokens[cursor.index]!;
  switch (token.type) {
    case "heading_open": {
      const level = Number(token.tag.replace("h", "")) || 1;
      const inline = tokens[cursor.index + 1];
      cursor.index += 3; // heading_open, inline, heading_close
      return splitAroundImages("heading", inlineFromToken(inline), { level: Math.min(6, Math.max(1, level)) });
    }
    case "paragraph_open": {
      const inline = tokens[cursor.index + 1];
      cursor.index += 3; // paragraph_open, inline, paragraph_close
      return splitAroundImages("paragraph", inlineFromToken(inline));
    }
    case "bullet_list_open": {
      cursor.index += 1;
      return [{ type: "bulletList", content: listItemsFromTokens(tokens, cursor, "bullet_list_close") }];
    }
    case "ordered_list_open": {
      const start = Number(token.attrGet("start") ?? "1");
      cursor.index += 1;
      const content = listItemsFromTokens(tokens, cursor, "ordered_list_close");
      return [{ type: "orderedList", ...(Number.isInteger(start) && start !== 1 ? { attrs: { start } } : {}), content }];
    }
    case "blockquote_open": {
      cursor.index += 1;
      return [{ type: "blockquote", content: blocksFromTokens(tokens, cursor, "blockquote_close") }];
    }
    case "code_block":
    case "fence": {
      cursor.index += 1;
      // markdown-it keeps the block's text verbatim; only the closing newline is its own.
      const text = token.content.replace(/\n$/, "");
      const language = token.info?.trim().split(/\s+/)[0] || null;
      return [{ type: "codeBlock", ...(language ? { attrs: { language } } : {}), ...(text ? { content: [{ type: "text", text }] } : {}) }];
    }
    case "hr":
      cursor.index += 1;
      return [{ type: "horizontalRule" }];
    case "table_open":
      cursor.index += 1;
      return [{ type: "table", content: tableRowsFromTokens(tokens, cursor) }];
    default:
      return null;
  }
}

/** A text block holding images becomes the text before, the image blocks, and the text after. */
function splitAroundImages(type: "paragraph" | "heading", inline: ReaderNode[], attrs?: Record<string, unknown>): ReaderNode[] {
  const out: ReaderNode[] = [];
  let run: ReaderNode[] = [];
  const flush = (force = false) => {
    if (run.length || force) out.push({ type, ...(attrs ? { attrs } : {}), ...(run.length ? { content: run } : {}) });
    run = [];
  };
  for (const node of inline) {
    if (node.type === "image") { flush(); out.push(node); } else run.push(node);
  }
  flush(out.length === 0);
  return out;
}

function listItemsFromTokens(tokens: Token[], cursor: Cursor, stopType: string): ReaderNode[] {
  const items: ReaderNode[] = [];
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!;
    if (token.type === stopType) {
      cursor.index += 1;
      return items;
    }
    if (token.type === "list_item_open") {
      cursor.index += 1;
      items.push({ type: "listItem", content: blocksFromTokens(tokens, cursor, "list_item_close") });
      continue;
    }
    cursor.index += 1;
  }
  return items;
}

/** markdown-it's thead/tbody wrappers are flattened; `th` cells become `tableHeader`. */
function tableRowsFromTokens(tokens: Token[], cursor: Cursor): ReaderNode[] {
  const rows: ReaderNode[] = [];
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!;
    if (token.type === "table_close") {
      cursor.index += 1;
      return rows;
    }
    if (token.type === "tr_open") {
      cursor.index += 1;
      rows.push({ type: "tableRow", content: tableCellsFromTokens(tokens, cursor) });
      continue;
    }
    cursor.index += 1;
  }
  return rows;
}

function tableCellsFromTokens(tokens: Token[], cursor: Cursor): ReaderNode[] {
  const cells: ReaderNode[] = [];
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index]!;
    if (token.type === "tr_close") {
      cursor.index += 1;
      return cells;
    }
    if (token.type === "th_open" || token.type === "td_open") {
      const inline = tokens[cursor.index + 1];
      cursor.index += 3; // open, inline, close
      cells.push({ type: token.type === "th_open" ? "tableHeader" : "tableCell", content: splitAroundImages("paragraph", inlineFromToken(inline)) });
      continue;
    }
    cursor.index += 1;
  }
  return cells;
}

function inlineFromToken(token: Token | undefined): ReaderNode[] {
  if (!token?.children) return [];
  const nodes: ReaderNode[] = [];
  const marks: ReaderMark[] = [];
  const pushText = (text: string, extra?: ReaderMark) => {
    if (!text) return;
    const applied = extra ? [...marks, extra] : marks;
    nodes.push({ type: "text", text, ...(applied.length ? { marks: applied.map(mark => ({ ...mark })) } : {}) });
  };
  const pop = (type: string) => {
    const index = marks.map(mark => mark.type).lastIndexOf(type);
    if (index >= 0) marks.splice(index, 1);
  };
  for (const child of token.children) {
    switch (child.type) {
      case "text": pushText(child.content); break;
      case "softbreak": pushText(" "); break;
      case "hardbreak": nodes.push({ type: "hardBreak" }); break;
      case "strong_open": marks.push({ type: "bold" }); break;
      case "strong_close": pop("bold"); break;
      case "em_open": marks.push({ type: "italic" }); break;
      case "em_close": pop("italic"); break;
      case "s_open": marks.push({ type: "strike" }); break;
      case "s_close": pop("strike"); break;
      case "code_inline": pushText(child.content, { type: "code" }); break;
      case "link_open": marks.push({ type: "link", attrs: { href: child.attrGet("href") ?? "" } }); break;
      case "link_close": pop("link"); break;
      case "image":
        nodes.push({ type: "image", attrs: { src: child.attrGet("src") ?? "", alt: child.content || "", title: child.attrGet("title") ?? null } });
        break;
      default:
        // html_inline cannot occur with html:false; anything else keeps its text.
        if (child.content) pushText(child.content);
        break;
    }
  }
  return nodes;
}
