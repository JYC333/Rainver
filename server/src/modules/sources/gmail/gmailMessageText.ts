/**
 * Pure normalization of Gmail API JSON (`threads.list`, `threads.get
 * format=metadata`, `messages.get format=full`) into owner-facing plain text.
 * No network, DB or credentials. Gmail already parses MIME and decodes the
 * transfer encoding: each part carries `body.data` (base64url of the part's
 * bytes in its declared charset) or, for attachments and very large parts,
 * only `body.attachmentId`, which this MVP never fetches.
 *
 * Output is text only: text/plain is preferred inside each alternative, HTML is
 * reduced to text through the Sources `stripHtml` path (scripts, styles, markup,
 * images and links dropped; block boundaries kept as line breaks). Attachments
 * are counted, never decoded.
 */
import { stripHtml } from "../contentParsing.js";
import { GMAIL_READ_LIMITS } from "./gmailReadContract.js";

export interface GmailHeader { name?: unknown; value?: unknown }
export interface GmailPart {
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: { data?: unknown; attachmentId?: unknown; size?: unknown } | null;
  parts?: unknown;
}
export interface GmailApiMessage { id?: unknown; threadId?: unknown; internalDate?: unknown; labelIds?: unknown; snippet?: unknown; payload?: GmailPart | null }

const HEX_ID = /^[0-9a-f]{1,64}$/;
const MAX_HEADER_CHARS = 1000;
const MAX_PARTS = 500;
const MAX_DEPTH = 20;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Control characters other than tab/newline are removed; CRLF becomes LF. */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** A header value (Gmail returns encoded-words already decoded), single-line and bounded; null when absent. */
export function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const lower = name.toLowerCase();
  for (const header of headers as GmailHeader[]) {
    if (isRecord(header) && typeof header.name === "string" && header.name.toLowerCase() === lower && typeof header.value === "string") {
      return clip(cleanText(header.value).replace(/\s+/g, " ").trim(), MAX_HEADER_CHARS);
    }
  }
  return null;
}

/** Gmail `internalDate` (ms since epoch, as a string) → ISO, or null when malformed. */
export function internalDateIso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const gmailId = (value: unknown): string | null => typeof value === "string" && HEX_ID.test(value) ? value : null;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
/** Decodes the few named entities Gmail snippets and mail HTML use, plus numeric references. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[lower] ?? match;
  });
}

/** Snippets from Gmail are HTML-escaped text. */
export function snippetText(value: unknown): string {
  return typeof value === "string" ? clip(cleanText(decodeEntities(value)).replace(/\s+/g, " ").trim(), MAX_HEADER_CHARS) : "";
}

// Marks a block boundary that survives `stripHtml`'s whitespace collapse (a private-use code point is not `\s`).
const BREAK = "";
const BLOCK_END = /<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article|header|footer)\s*>|<(br|hr)\b[^>]*>/gi;

/** HTML mail → plain text: no markup, images, links or active content survive. */
export function htmlToMailText(html: string): string {
  const withoutHead = html.replace(/<head[\s\S]*?<\/head>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const marked = withoutHead.replace(BLOCK_END, (tag) => `${tag}${BREAK}`);
  const text = decodeEntities(stripHtml(marked));
  return text.split(BREAK).map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function charsetOf(part: GmailPart): string {
  const contentType = headerValue(part.headers, "Content-Type") ?? "";
  const match = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType);
  return match ? match[1]!.toLowerCase() : "utf-8";
}

/** Decodes base64url bytes with the declared charset; an unknown label falls back to UTF-8, invalid bytes become U+FFFD. */
export function decodePartData(data: string, charset: string): string {
  const bytes = Buffer.from(data, "base64url");
  let decoder: InstanceType<typeof TextDecoder>;
  try { decoder = new TextDecoder(charset, { fatal: false }); } catch { decoder = new TextDecoder("utf-8", { fatal: false }); }
  return decoder.decode(bytes);
}

function isAttachment(part: GmailPart): boolean {
  const filename = typeof part.filename === "string" ? part.filename : "";
  const disposition = (headerValue(part.headers, "Content-Disposition") ?? "").toLowerCase();
  return filename.length > 0 || disposition.startsWith("attachment");
}

interface Collected { plain: string[]; html: string[]; attachments: number; unavailableText: boolean }

/**
 * Walks the part tree. Inside `multipart/alternative` only the best text
 * alternative (plain, else HTML) is taken, so a message is not shown twice.
 */
function collect(part: GmailPart, out: Collected, depth: number, budget: { parts: number }): void {
  if (depth > MAX_DEPTH || budget.parts <= 0) { out.unavailableText = true; return; }
  budget.parts -= 1;
  const mime = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
  // An attachment (filename or `Content-Disposition: attachment`) is counted once and never walked,
  // even when it is itself multipart: none of its text parts is read.
  if (isAttachment(part)) { out.attachments += 1; return; }
  const children = Array.isArray(part.parts) ? (part.parts as unknown[]).filter(isRecord) as GmailPart[] : [];
  if (mime.startsWith("multipart/")) {
    if (mime === "multipart/alternative") {
      const plain = children.find((child) => String(child.mimeType).toLowerCase() === "text/plain" && !isAttachment(child));
      const html = children.find((child) => String(child.mimeType).toLowerCase() === "text/html" && !isAttachment(child));
      const nested = children.find((child) => String(child.mimeType).toLowerCase().startsWith("multipart/") && !isAttachment(child));
      const chosen = plain ?? nested ?? html;
      if (chosen) collect(chosen, out, depth + 1, budget);
      // Other alternatives are renderings of the same text; attachments inside still count.
      for (const child of children) if (child !== chosen && isAttachment(child)) out.attachments += 1;
      return;
    }
    for (const child of children) collect(child, out, depth + 1, budget);
    return;
  }
  if (mime !== "text/plain" && mime !== "text/html") {
    if (part.body && typeof part.body.attachmentId === "string") out.attachments += 1;
    return;
  }
  const data = part.body && typeof part.body.data === "string" ? part.body.data : null;
  if (data === null) {
    // A text part Gmail moved behind an attachment id is not fetched by this MVP.
    if (part.body && typeof part.body.attachmentId === "string") out.unavailableText = true;
    return;
  }
  const text = decodePartData(data, charsetOf(part));
  (mime === "text/plain" ? out.plain : out.html).push(text);
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes on a code point boundary. */
export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let cut = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

export interface NormalizedMessageBody {
  text: string;
  text_format: "plain" | "html_converted" | "none";
  text_truncated: boolean;
  attachment_count: number;
}

/** The text of one `messages.get format=full` payload, bounded to the per-message text limit. */
export function normalizeMessageBody(payload: GmailPart | null | undefined, maxBytes: number = GMAIL_READ_LIMITS.normalizedTextBytesPerMessage): NormalizedMessageBody {
  const out: Collected = { plain: [], html: [], attachments: 0, unavailableText: false };
  if (isRecord(payload)) collect(payload, out, 0, { parts: MAX_PARTS });
  let raw: string;
  let format: NormalizedMessageBody["text_format"];
  if (out.plain.length) { raw = out.plain.join("\n\n"); format = "plain"; }
  else if (out.html.length) { raw = out.html.map(htmlToMailText).join("\n\n"); format = "html_converted"; }
  else { raw = ""; format = "none"; }
  const bounded = truncateUtf8(cleanText(raw).trim(), maxBytes);
  return { text: bounded.text, text_format: format, text_truncated: bounded.truncated || out.unavailableText, attachment_count: out.attachments };
}

/** Thread page in Gmail's web UI; carries the mailbox address as `authuser`, never a token. */
export function gmailWebUrl(mailboxEmail: string, googleId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailboxEmail)}#all/${googleId}`;
}
