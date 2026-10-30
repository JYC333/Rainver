import { markdownToReaderDocument, normalizeReaderDocument } from "@rainver/reader-document";

export interface ReaderPmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ReaderPmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ReaderPmNode[];
  text?: string;
  marks?: ReaderPmMark[];
}

export interface ReaderPmDoc {
  type: "doc";
  content: ReaderPmNode[];
}

export interface StructuredReaderContent {
  schema_version: 1;
  kind: "reader_document";
  extraction_method: "structured_html_v1" | "markdown_v1" | "plain_text_v1" | "pdf_text_v1" | "agent_provided_v1";
  image_policy: "remote_reference" | "none";
  title: string | null;
  source_uri: string | null;
  plain_text: string;
  content_json: ReaderPmDoc;
  image_count: number;
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "header", "hr", "main", "nav", "p",
  "pre", "section", "table",
]);

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DROP_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "head"];
const CHROME_TAGS = new Set(["aside", "button", "dialog", "footer", "form", "nav"]);
const NOISE_PRUNE_TAGS = new Set(["div", "section", "header", "footer", "nav", "aside", "ul", "ol"]);
const CANDIDATE_CONTAINER_TAGS = new Set(["article", "main", "section", "div"]);
const POSITIVE_ATTR_RE = /(^|\s)(article|body|content|entry|main|markdown|post|prose|reader|story|text)(\s|$)/i;
const STRONG_CONTENT_ATTR_RE = /(^|\s)(article content|article body|content body|entry content|entry body|post content|post body|rich text|story content|story body|text content|markdown|prose|正文)(\s|$)/i;
const NEGATIVE_ATTR_RE = /(^|\s)(ad|ads|advert|advertisement|aside|banner|breadcrumb|comments?|cookie|drawer|footer|login|menu|modal|nav|navbar|navigation|newsletter|pagination|paywall|popup|promo|promotion|recommend|related|search|share|sidebar|social|sponsor|subscribe|toolbar|widget)(\s|$)/i;
const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlTitle(input: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(input);
  const title = match ? stripHtml(match[1] ?? "").trim() : "";
  return title || null;
}

export function excerpt(input: string, maxLength = 2048): string | null {
  const value = stripHtml(input).trim();
  if (!value) return null;
  return value.slice(0, maxLength);
}

export function extractStructuredReaderContent(
  html: string,
  sourceUri: string | null,
): StructuredReaderContent {
  const cleaned = removeDroppedContent(html);
  const readableHtml = pruneReaderChrome(pickReadableHtml(pruneReaderChrome(cleaned)));
  const contentJson = htmlToReaderPmDoc(readableHtml, sourceUri);
  const plainText = pmDocToPlainText(contentJson);
  const fallbackText = stripHtml(readableHtml);
  const finalPlainText = plainText.trim() || fallbackText;
  // Stored through the shared normalizer, so the tree is valid for the Reader schema.
  const finalContentJson = normalizeReaderDocument(contentJson.content.length > 0
    ? contentJson
    : plainTextToPmDoc(finalPlainText)) as ReaderPmDoc;
  return {
    schema_version: 1,
    kind: "reader_document",
    extraction_method: "structured_html_v1",
    image_policy: "remote_reference",
    title: htmlTitle(html),
    source_uri: sourceUri,
    plain_text: finalPlainText,
    content_json: finalContentJson,
    image_count: countImageNodes(finalContentJson),
  };
}

const EXTRACTION_METHODS = new Set(["structured_html_v1", "markdown_v1", "plain_text_v1", "pdf_text_v1", "agent_provided_v1"]);

/** The syntax a fetched text response declares by its media type (or, without one, by a Markdown file extension). */
export function fetchedTextSyntax(contentType: string | null, url: string): "html" | "markdown" | "plain" {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/plain" || type === "application/json" || type.endsWith("+json")) return "plain";
  if (!type || type === "application/octet-stream") {
    try { if (/\.(md|markdown)$/i.test(new URL(url).pathname)) return "markdown"; } catch { /* not a URL */ }
  }
  return "html";
}

/**
 * Reader content for a fetched text response, by its declared syntax: HTML
 * through the structural extractor, Markdown through the shared markdown-it
 * converter, plain text as paragraphs. Nothing is converted to another syntax
 * first, and nothing is guessed from the text itself.
 */
export function readerContentFromFetchedText(text: string, contentType: string | null, sourceUri: string): StructuredReaderContent {
  const syntax = fetchedTextSyntax(contentType, sourceUri);
  if (syntax === "html") return extractStructuredReaderContent(text, sourceUri);
  const contentJson = (syntax === "markdown" ? markdownToReaderDocument(text) : normalizeReaderDocument(plainTextToPmDoc(text))) as ReaderPmDoc;
  const plainText = pmDocToPlainText(contentJson) || text.trim();
  return {
    schema_version: 1,
    kind: "reader_document",
    extraction_method: syntax === "markdown" ? "markdown_v1" : "plain_text_v1",
    // Same rule as a captured page: images the source itself references.
    image_policy: "remote_reference",
    title: null,
    source_uri: sourceUri,
    plain_text: plainText,
    content_json: contentJson,
    image_count: countImageNodes(contentJson),
  };
}

/** Converts Agent-provided reading text by the syntax the Agent declared; undeclared text stays literal. */
export function agentReaderContentJson(text: string, syntax: "plain" | "markdown" | undefined): ReaderPmDoc {
  return (syntax === "markdown" ? markdownToReaderDocument(text) : plainTextToPmDoc(text)) as ReaderPmDoc;
}

export { pmDocToPlainText };

export function parseStructuredReaderContent(value: string): StructuredReaderContent | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schema_version !== 1 || parsed.kind !== "reader_document") return null;
    if (!EXTRACTION_METHODS.has(parsed.extraction_method as string)) return null;
    if (parsed.image_policy !== "remote_reference" && parsed.image_policy !== "none") return null;
    if (typeof parsed.plain_text !== "string") return null;
    if (!isRecord(parsed.content_json) || parsed.content_json.type !== "doc") return null;
    // Stored documents are read through the shared Reader normalizer: an
    // unsupported node degrades to its text instead of hiding the document.
    const contentJson = normalizeReaderDocument(parsed.content_json) as ReaderPmDoc;
    return {
      schema_version: 1,
      kind: "reader_document",
      extraction_method: parsed.extraction_method as StructuredReaderContent["extraction_method"],
      image_policy: parsed.image_policy,
      title: typeof parsed.title === "string" ? parsed.title : null,
      source_uri: typeof parsed.source_uri === "string" ? parsed.source_uri : null,
      plain_text: parsed.plain_text,
      content_json: contentJson,
      image_count: typeof parsed.image_count === "number" ? parsed.image_count : countImageNodes(contentJson),
    };
  } catch {
    return null;
  }
}

function removeDroppedContent(html: string): string {
  let output = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DROP_TAGS) {
    output = removeElementBlocks(output, (candidateTag) => candidateTag === tag);
  }
  return output;
}

type ReadableCandidateKind = "article" | "main" | "role-main" | "content-hint" | "body" | "document";

interface ReadableCandidate {
  html: string;
  kind: ReadableCandidateKind;
}

function pickReadableHtml(html: string): string {
  const candidates: ReadableCandidate[] = [];
  for (const tag of ["article", "main"] as const) {
    candidates.push(...matchingElementHtml(html, tag).map((candidate) => ({ html: candidate, kind: tag })));
  }
  candidates.push(...matchingRoleMainHtml(html).map((candidate) => ({ html: candidate, kind: "role-main" as const })));
  candidates.push(...matchingContentHintHtml(html).map((candidate) => ({ html: candidate, kind: "content-hint" as const })));
  candidates.push(...matchingElementHtml(html, "body").map((candidate) => ({ html: candidate, kind: "body" as const })));
  if (candidates.length === 0) candidates.push({ html, kind: "document" });
  return candidates
    .filter((candidate, index, all) => all.findIndex((other) => other.html === candidate.html) === index)
    .map((candidate) => ({
      html: candidate.html,
      score: readableScore(candidate.html, candidate.kind),
    }))
    .sort((a, b) => b.score - a.score)[0]?.html ?? html;
}

function matchingElementHtml(html: string, tag: string): string[] {
  return matchingElements(html, (candidateTag) => candidateTag === tag);
}

function matchingRoleMainHtml(html: string): string[] {
  return matchingElements(html, (_tag, openTag) => attrValue(openTag, "role")?.toLowerCase() === "main");
}

function matchingContentHintHtml(html: string): string[] {
  return matchingElements(html, (tag, openTag) =>
    CANDIDATE_CONTAINER_TAGS.has(tag) && hasPositiveReaderAttrs(openTag),
  );
}

function pruneReaderChrome(html: string): string {
  return removeElementBlocks(html, (tag, openTag, elementHtml) => {
    if (CHROME_TAGS.has(tag)) return true;
    if (hasNegativeReaderAttrs(openTag) && !hasStrongContentAttrs(openTag)) return true;
    if (!NOISE_PRUNE_TAGS.has(tag) || hasStrongContentAttrs(openTag)) return false;
    // A layout wrapper around a link-heavy nav and the marked article body is
    // not chrome: judging it by link density alone dropped the article with it.
    // Its nav is still judged, and pruned, as an element of its own.
    if (containsStrongContentElement(elementHtml)) return false;

    const textLength = visibleTextLength(elementHtml);
    const linkDensity = linkedTextDensity(elementHtml);
    const linkCount = anchorCount(elementHtml);
    if (tag === "header" && linkCount > 0 && textLength <= 1000 && linkDensity >= 0.35) return true;
    return linkCount >= 2 && textLength <= 1600 && linkDensity >= 0.5 && !hasPositiveReaderAttrs(openTag);
  });
}

function containsStrongContentElement(elementHtml: string): boolean {
  const inner = /<[a-z][a-z0-9:-]*\b[^>]*>/gi;
  inner.exec(elementHtml); // the element's own open tag
  for (let match = inner.exec(elementHtml); match; match = inner.exec(elementHtml)) {
    if (hasStrongContentAttrs(match[0])) return true;
  }
  return false;
}

function readableScore(html: string, kind: ReadableCandidateKind): number {
  const textLength = visibleTextLength(html);
  const paragraphBonus = (html.match(/<p\b/gi)?.length ?? 0) * 90;
  const headingBonus = (html.match(/<h[1-6]\b/gi)?.length ?? 0) * 70;
  const imageBonus = (html.match(/<img\b/gi)?.length ?? 0) * 80;
  const chromePenalty = (html.match(/<(?:nav|footer|aside|form)\b/gi)?.length ?? 0) * 500;
  const linkPenalty = Math.round(textLength * linkedTextDensity(html) * 1.6);
  const negativeAttrPenalty = (html.match(/\b(?:nav|navbar|footer|sidebar|related|comments?|promo|advert|share|subscribe|breadcrumb|pagination)\b/gi)?.length ?? 0) * 120;
  const sourceBonus: Record<ReadableCandidateKind, number> = {
    article: 1600,
    main: 1300,
    "role-main": 1200,
    "content-hint": 900,
    body: 0,
    document: -1200,
  };
  return textLength + paragraphBonus + headingBonus + imageBonus + sourceBonus[kind] - chromePenalty - linkPenalty - negativeAttrPenalty;
}

function matchingElements(
  html: string,
  predicate: (tag: string, openTag: string) => boolean,
  limit = 80,
): string[] {
  const matches: string[] = [];
  const openRe = /<([a-z][a-z0-9:-]*)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html)) !== null) {
    const openTag = match[0];
    const tag = match[1]?.toLowerCase();
    if (!tag || VOID_TAGS.has(tag) || !predicate(tag, openTag)) continue;
    const end = findElementEnd(html, match.index, tag);
    if (end === null) continue;
    matches.push(html.slice(match.index, end));
    if (matches.length >= limit) break;
  }
  return matches;
}

function removeElementBlocks(
  html: string,
  predicate: (tag: string, openTag: string, elementHtml: string) => boolean,
): string {
  const openRe = /<([a-z][a-z0-9:-]*)\b[^>]*>/gi;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html)) !== null) {
    const openTag = match[0];
    const tag = match[1]?.toLowerCase();
    if (!tag || VOID_TAGS.has(tag)) continue;
    const end = findElementEnd(html, match.index, tag);
    if (end === null) continue;
    const elementHtml = html.slice(match.index, end);
    if (!predicate(tag, openTag, elementHtml)) continue;
    output += html.slice(cursor, match.index) + " ";
    cursor = end;
    openRe.lastIndex = end;
  }
  return cursor === 0 ? html : output + html.slice(cursor);
}

function findElementEnd(html: string, startIndex: number, tag: string): number | null {
  const tagRe = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, "gi");
  tagRe.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const token = match[0];
    if (/^<\s*\//.test(token)) {
      depth -= 1;
      if (depth === 0) return tagRe.lastIndex;
      continue;
    }
    if (!/\/\s*>$/.test(token)) depth += 1;
  }
  return null;
}

function hasPositiveReaderAttrs(openTag: string): boolean {
  return POSITIVE_ATTR_RE.test(normalizedReaderAttrs(openTag));
}

function hasStrongContentAttrs(openTag: string): boolean {
  return STRONG_CONTENT_ATTR_RE.test(normalizedReaderAttrs(openTag));
}

function hasNegativeReaderAttrs(openTag: string): boolean {
  return NEGATIVE_ATTR_RE.test(normalizedReaderAttrs(openTag));
}

function normalizedReaderAttrs(openTag: string): string {
  return [
    attrValue(openTag, "id"),
    attrValue(openTag, "class"),
    attrValue(openTag, "role"),
    attrValue(openTag, "aria-label"),
    attrValue(openTag, "data-testid"),
    attrValue(openTag, "data-test"),
    attrValue(openTag, "itemprop"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function visibleTextLength(html: string): number {
  return decodeEntities(stripHtml(html)).length;
}

function linkedTextDensity(html: string): number {
  const total = visibleTextLength(html);
  if (total === 0) return 0;
  let linked = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    linked += visibleTextLength(match[1] ?? "");
  }
  return Math.min(1, linked / total);
}

function anchorCount(html: string): number {
  return html.match(/<a\b/gi)?.length ?? 0;
}

function tableHtmlToReaderPmNode(tableHtml: string, sourceUri: string | null): ReaderPmNode | null {
  const rows = matchingElements(tableHtml, (tag) => tag === "tr", 200)
    .map((rowHtml) => tableRowHtmlToReaderPmNode(rowHtml, sourceUri))
    .filter((row): row is ReaderPmNode => row !== null);
  return rows.length > 0 ? { type: "table", content: rows } : null;
}

function tableRowHtmlToReaderPmNode(rowHtml: string, sourceUri: string | null): ReaderPmNode | null {
  const cells = matchingElements(rowHtml, (tag) => tag === "td" || tag === "th", 80)
    .map((cellHtml) => tableCellHtmlToReaderPmNode(cellHtml, sourceUri))
    .filter((cell): cell is ReaderPmNode => cell !== null);
  return cells.length > 0 ? { type: "tableRow", content: cells } : null;
}

function tableCellHtmlToReaderPmNode(cellHtml: string, sourceUri: string | null): ReaderPmNode | null {
  const openTag = /^<([a-z][a-z0-9:-]*)\b[^>]*>/i.exec(cellHtml)?.[0] ?? "";
  const tag = tagName(openTag);
  if (tag !== "td" && tag !== "th") return null;
  const cellDoc = htmlToReaderPmDoc(innerElementHtml(cellHtml), sourceUri);
  const node: ReaderPmNode = {
    type: tag === "th" ? "tableHeader" : "tableCell",
    content: cellDoc.content.length > 0 ? cellDoc.content : [{ type: "paragraph" }],
  };
  const colspan = boundedSpan(attrValue(openTag, "colspan"));
  const rowspan = boundedSpan(attrValue(openTag, "rowspan"));
  if (colspan > 1 || rowspan > 1) {
    node.attrs = {
      ...(colspan > 1 ? { colspan } : {}),
      ...(rowspan > 1 ? { rowspan } : {}),
    };
  }
  return node;
}

function innerElementHtml(elementHtml: string): string {
  return elementHtml
    .replace(/^<([a-z][a-z0-9:-]*)\b[^>]*>/i, "")
    .replace(/<\/([a-z][a-z0-9:-]*)>\s*$/i, "");
}

function boundedSpan(value: string | null): number {
  if (!value) return 1;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 1;
}

/**
 * HTML → Reader tree. Keeps the inline semantics the Reader can show (bold,
 * italic, strike, inline code, links), headings h1–h6, nested lists as
 * nested lists, blockquotes and tables; `<pre>` text is kept character for
 * character. Anything else becomes plain text of the nearest block.
 */
function htmlToReaderPmDoc(html: string, sourceUri: string | null): ReaderPmDoc {
  interface Frame { kind: "root" | "blockquote" | "listItem"; blocks: ReaderPmNode[]; list?: ListFrame }
  interface ListFrame { type: "bulletList" | "orderedList"; items: ReaderPmNode[]; depth: number; start: number }
  const frames: Frame[] = [{ kind: "root", blocks: [] }];
  const lists: ListFrame[] = [];
  const marks: ReaderPmMark[] = [];
  let currentBlock: { type: "paragraph" | "heading" | "codeBlock"; attrs?: Record<string, unknown>; content: ReaderPmNode[] } | null = null;
  let preDepth = 0;

  const top = (): Frame => frames[frames.length - 1]!;
  const appendBlock = (node: ReaderPmNode): void => { top().blocks.push(node); };

  function closeCurrentBlock(): void {
    if (!currentBlock) return;
    if (currentBlock.type !== "codeBlock") trimInlineContent(currentBlock.content);
    else trimCodeBlock(currentBlock.content);
    if (currentBlock.content.length > 0) {
      const node: ReaderPmNode = { type: currentBlock.type, content: currentBlock.content };
      if (currentBlock.attrs) node.attrs = currentBlock.attrs;
      appendBlock(node);
    }
    currentBlock = null;
  }

  function ensureBlock(): ReaderPmNode[] {
    if (!currentBlock) currentBlock = { type: "paragraph", content: [] };
    return currentBlock.content;
  }

  function appendText(raw: string): void {
    const decoded = decodeEntities(raw);
    const verbatim = preDepth > 0;
    const text = verbatim ? decoded : decoded.replace(/\s+/g, " ");
    if (!text) return;
    const target = ensureBlock();
    const previous = target[target.length - 1];
    const value = verbatim
      ? text
      : previous?.type === "text" && typeof previous.text === "string"
        ? coalesceText(previous.text, text)
        : trimLeadingText(target, text);
    if (!value) return;
    // Code blocks hold plain text only.
    const applied = verbatim ? undefined : currentMarks(marks);
    if (previous?.type === "text" && typeof previous.text === "string" && sameMarks(previous.marks, applied)) {
      previous.text += value;
      return;
    }
    const node: ReaderPmNode = { type: "text", text: value };
    if (applied) node.marks = applied;
    target.push(node);
  }

  function startBlock(type: "paragraph" | "heading" | "codeBlock", attrs?: Record<string, unknown>): void {
    closeCurrentBlock();
    currentBlock = { type, attrs, content: [] };
  }

  function closeFrame(): void {
    const frame = frames.pop();
    if (!frame || frame.kind === "root") return;
    if (frame.kind === "listItem") {
      frame.list?.items.push({ type: "listItem", content: frame.blocks.length > 0 ? frame.blocks : [{ type: "paragraph" }] });
    } else if (frame.blocks.length > 0) {
      appendBlock({ type: "blockquote", content: frame.blocks });
    }
  }

  function closeListItem(): void {
    closeCurrentBlock();
    const list = lists[lists.length - 1];
    if (list && top().kind === "listItem" && top().list === list) closeFrame();
  }

  function closeList(): void {
    closeCurrentBlock();
    const list = lists.pop();
    if (!list) return;
    while (frames.length > list.depth) closeFrame();
    if (list.items.length === 0) return;
    appendBlock({ type: list.type, ...(list.type === "orderedList" && list.start !== 1 ? { attrs: { start: list.start } } : {}), content: list.items });
  }

  const tokenRe = /<\/?[^>]+>|[^<]+/g;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(html)) !== null) {
    const value = token[0];
    if (!value.startsWith("<")) {
      appendText(value);
      continue;
    }

    const tag = tagName(value);
    if (!tag) continue;
    const closing = /^<\s*\//.test(value);
    const selfClosing = /\/\s*>$/.test(value) || VOID_TAGS.has(tag);
    const markType = INLINE_MARK_TAGS[tag];

    if (closing) {
      if (markType && !(markType === "code" && preDepth > 0)) popMark(marks, markType);
      else if (["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre"].includes(tag)) {
        if (tag === "pre") preDepth = Math.max(0, preDepth - 1);
        closeCurrentBlock();
      } else if (tag === "li") {
        closeListItem();
      } else if (tag === "ul" || tag === "ol") {
        closeList();
      } else if (tag === "blockquote") {
        closeCurrentBlock();
        while (frames.length > 1 && top().kind !== "blockquote") closeFrame();
        if (top().kind === "blockquote") closeFrame();
      } else if (BLOCK_TAGS.has(tag)) {
        closeCurrentBlock();
      }
      continue;
    }

    if (markType) {
      // `<code>` inside `<pre>` is the code block itself, not an inline mark.
      if (markType === "code" && preDepth > 0) continue;
      if (markType === "link") {
        const href = resolveRemoteUrl(attrValue(value, "href"), sourceUri);
        marks.push(href ? { type: "link", attrs: { href } } : { type: "link" });
      } else {
        marks.push({ type: markType });
      }
      continue;
    }

    if (tag === "br") {
      if (preDepth > 0) appendText("\n");
      else ensureBlock().push({ type: "hardBreak" });
      continue;
    }

    if (tag === "hr") {
      closeCurrentBlock();
      appendBlock({ type: "horizontalRule" });
      continue;
    }

    if (tag === "img") {
      const src = resolveRemoteUrl(attrValue(value, "src") ?? firstSrcsetUrl(attrValue(value, "srcset")), sourceUri);
      if (src) {
        closeCurrentBlock();
        appendBlock({
          type: "image",
          attrs: {
            src,
            alt: attrValue(value, "alt") ?? "",
            title: attrValue(value, "title") ?? null,
          },
        });
      }
      continue;
    }

    if (tag === "table") {
      closeCurrentBlock();
      const end = findElementEnd(html, token.index, "table");
      if (end !== null) {
        const table = tableHtmlToReaderPmNode(html.slice(token.index, end), sourceUri);
        if (table) appendBlock(table);
        tokenRe.lastIndex = end;
      }
      continue;
    }

    if (tag === "blockquote") {
      closeCurrentBlock();
      frames.push({ kind: "blockquote", blocks: [] });
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      closeCurrentBlock();
      const start = tag === "ol" ? Number(attrValue(value, "start") ?? "1") : 1;
      lists.push({ type: tag === "ul" ? "bulletList" : "orderedList", items: [], depth: frames.length, start: Number.isInteger(start) ? start : 1 });
      continue;
    }

    if (tag === "li") {
      closeListItem();
      const list = lists[lists.length - 1];
      if (list) frames.push({ kind: "listItem", blocks: [], list });
      continue;
    }

    if (tag === "pre") {
      preDepth += 1;
      startBlock("codeBlock");
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      startBlock("heading", { level: Number(tag.slice(1)) });
      continue;
    }

    if (tag === "p") {
      startBlock("paragraph");
      continue;
    }

    if (BLOCK_TAGS.has(tag) && !selfClosing) {
      closeCurrentBlock();
    }
  }

  closeCurrentBlock();
  while (lists.length > 0) closeList();
  while (frames.length > 1) closeFrame();
  return { type: "doc", content: frames[0]!.blocks.filter(hasRenderableContent) };
}

/** Inline HTML elements whose meaning the Reader keeps, by mark. */
const INLINE_MARK_TAGS: Record<string, string> = {
  a: "link", b: "bold", strong: "bold", i: "italic", em: "italic",
  s: "strike", del: "strike", strike: "strike", code: "code", kbd: "code", samp: "code",
};

function currentMarks(stack: ReaderPmMark[]): ReaderPmMark[] | undefined {
  const marks: ReaderPmMark[] = [];
  for (const mark of stack) {
    // A link without a usable target still scopes its text, but adds no mark.
    if (mark.type === "link" && !mark.attrs) continue;
    const existing = marks.findIndex(item => item.type === mark.type);
    if (existing >= 0) marks.splice(existing, 1);
    marks.push(mark);
  }
  // Inline code excludes every other mark in the Reader schema, links included.
  if (marks.some(mark => mark.type === "code")) return [{ type: "code" }];
  return marks.length > 0 ? marks : undefined;
}

function popMark(stack: ReaderPmMark[], type: string): void {
  const index = stack.map(mark => mark.type).lastIndexOf(type);
  if (index >= 0) stack.splice(index, 1);
}

/** A `<pre>` block keeps its text verbatim; only a single newline right after `<pre>` and the last line break are markup. */
function trimCodeBlock(nodes: ReaderPmNode[]): void {
  const first = nodes[0];
  if (first?.type === "text" && typeof first.text === "string") first.text = first.text.replace(/^\r?\n/, "");
  const last = nodes[nodes.length - 1];
  if (last?.type === "text" && typeof last.text === "string") last.text = last.text.replace(/\r?\n$/, "");
  for (let index = nodes.length - 1; index >= 0; index -= 1) if (nodes[index]!.type === "text" && !nodes[index]!.text) nodes.splice(index, 1);
}

function plainTextToPmDoc(text: string): ReaderPmDoc {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.length > 0
      ? paragraphs.map((paragraph) => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] }))
      : [{ type: "paragraph" }],
  };
}

function pmDocToPlainText(doc: ReaderPmDoc): string {
  return (doc.content ?? [])
    .map(blockText)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function blockText(node: ReaderPmNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image" || node.type === "horizontalRule") return "";
  if (!node.content) return "";
  if (node.type === "table") {
    return node.content.map(blockText).filter(Boolean).join("\n");
  }
  if (node.type === "tableRow") {
    return node.content.map(blockText).map((part) => part.trim()).filter(Boolean).join(" | ");
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    return node.content.map(blockText).map((part) => part.trim()).filter(Boolean).join(" ");
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    return node.content.map(blockText).filter(Boolean).join("\n");
  }
  if (node.type === "listItem") {
    return node.content.map(blockText).filter(Boolean).join(" ");
  }
  return node.content.map(blockText).join("");
}

function hasRenderableContent(node: ReaderPmNode): boolean {
  if (node.type === "image" || node.type === "horizontalRule") return true;
  return blockText(node).trim().length > 0 || Boolean(node.content?.some(hasRenderableContent));
}

function trimInlineContent(nodes: ReaderPmNode[]): void {
  while (nodes[0]?.type === "text" && typeof nodes[0].text === "string") {
    nodes[0].text = nodes[0].text.trimStart();
    if (nodes[0].text) break;
    nodes.shift();
  }
  while (nodes[nodes.length - 1]?.type === "text" && typeof nodes[nodes.length - 1]!.text === "string") {
    const last = nodes[nodes.length - 1]!;
    last.text = last.text!.trimEnd();
    if (last.text) break;
    nodes.pop();
  }
}

function trimLeadingText(existing: ReaderPmNode[], text: string): string {
  if (existing.length > 0) return text;
  return text.trimStart();
}

function coalesceText(previous: string, next: string): string {
  if (!previous) return next.trimStart();
  if (/\s$/.test(previous) && /^\s/.test(next)) return next.trimStart();
  return next;
}


function sameMarks(a: ReaderPmMark[] | undefined, b: ReaderPmMark[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((mark, index) => {
    const other = right[index];
    return Boolean(other) &&
      mark.type === other.type &&
      JSON.stringify(mark.attrs ?? null) === JSON.stringify(other.attrs ?? null);
  });
}

function tagName(tag: string): string | null {
  const match = /^<\s*\/?\s*([a-zA-Z0-9:-]+)/.exec(tag);
  return match?.[1]?.toLowerCase() ?? null;
}

function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(
    "\\b" + escapeRegExp(name) + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))",
    "i",
  );
  const match = re.exec(tag);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return raw ? decodeEntities(raw.trim()) : null;
}


function firstSrcsetUrl(srcset: string | null): string | null {
  const first = srcset?.split(",")[0]?.trim();
  return first ? first.split(/\s+/)[0] ?? null : null;
}

function resolveRemoteUrl(value: string | null, sourceUri: string | null): string | null {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return null;
  try {
    const resolved = sourceUri ? new URL(value, sourceUri) : new URL(value);
    return ["http:", "https:"].includes(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (_whole, entity: string) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith("#x")) return codePointText(Number.parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return codePointText(Number.parseInt(key.slice(1), 10));
    return ENTITY_MAP[key] ?? `&${entity};`;
  });
}

/**
 * A numeric entity outside Unicode (`&#x110000;`, a page's typo or a crawler
 * artefact) is the browser's replacement character, not a thrown
 * `RangeError` that would fail the whole page's extraction.
 */
function codePointText(codePoint: number): string {
  if (!Number.isFinite(codePoint)) return "";
  return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\uFFFD";
}

function countImageNodes(doc: ReaderPmDoc): number {
  let count = 0;
  const visit = (node: ReaderPmNode): void => {
    if (node.type === "image") count += 1;
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return count;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}



function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
