import { XMLParser } from "fast-xml-parser";
import { HttpError } from "../../routeUtils/common.js";

/**
 * arXiv-specific helpers: API query URL building, Atom response parsing, and
 * arXiv id/URL normalization. arXiv parsing stays out of the generic RSS/Atom
 * feed parser on purpose.
 */

export const ARXIV_API_BASE_URL = "https://export.arxiv.org/api/query";

export const ARXIV_SORT_BY_VALUES = ["relevance", "lastUpdatedDate", "submittedDate"] as const;
export const ARXIV_SORT_ORDER_VALUES = ["ascending", "descending"] as const;

export type ArxivSortBy = (typeof ARXIV_SORT_BY_VALUES)[number];
export type ArxivSortOrder = (typeof ARXIV_SORT_ORDER_VALUES)[number];

export interface ArxivQueryConfig {
  search_query: string;
  max_results: number;
  sort_by: ArxivSortBy;
  sort_order: ArxivSortOrder;
}

export interface ArxivReference {
  baseId: string;
  version: string | null;
}

export interface ArxivPaper {
  arxiv_id: string;
  arxiv_version: string | null;
  title: string;
  authors: string[];
  summary: string | null;
  published_at: string | null;
  updated_at: string | null;
  categories: string[];
  primary_category: string | null;
  doi: string | null;
  journal_ref: string | null;
  comment: string | null;
  abs_url: string;
  html_url: string;
  pdf_url: string;
}

export function buildArxivQueryUrl(config: ArxivQueryConfig): string {
  const params = new URLSearchParams({
    search_query: config.search_query,
    start: "0",
    max_results: String(config.max_results),
    sortBy: config.sort_by,
    sortOrder: config.sort_order,
  });
  return `${ARXIV_API_BASE_URL}?${params.toString()}`;
}

export function arxivAbsUrl(baseId: string): string {
  return `https://arxiv.org/abs/${baseId}`;
}

export function arxivHtmlUrl(baseId: string): string {
  return `https://arxiv.org/html/${baseId}`;
}

export function arxivPdfUrl(baseId: string): string {
  return `https://arxiv.org/pdf/${baseId}`;
}

// New-style ids (2402.08954) and legacy slash ids (hep-th/9901001), with an
// optional version suffix such as v2.
const NEW_STYLE_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const LEGACY_ID = /^([A-Za-z][A-Za-z0-9.-]*\/\d{7})(v\d+)?$/;

const ARXIV_HOSTNAMES = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);
const ARXIV_URL_PATH_PREFIXES = ["/abs/", "/pdf/", "/html/"];

/**
 * Parses arXiv ids out of abs/pdf/html URLs, `arXiv:<id>` references, and bare
 * ids (versioned, unversioned, and legacy slash ids). Returns null for
 * anything that is not an arXiv reference.
 */
export function parseArxivReference(value: string | null | undefined): ArxivReference | null {
  const raw = value?.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith("arxiv:")) {
    return parseArxivId(raw.slice("arxiv:".length).trim());
  }
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!ARXIV_HOSTNAMES.has(url.hostname.toLowerCase())) return null;
    const prefix = ARXIV_URL_PATH_PREFIXES.find((candidate) => url.pathname.startsWith(candidate));
    if (!prefix) return null;
    let idPart = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/+$/, "");
    if (idPart.toLowerCase().endsWith(".pdf")) idPart = idPart.slice(0, -".pdf".length);
    return parseArxivId(idPart);
  }
  return parseArxivId(raw);
}

function parseArxivId(value: string): ArxivReference | null {
  const match = NEW_STYLE_ID.exec(value) ?? LEGACY_ID.exec(value);
  if (!match) return null;
  return { baseId: match[1]!, version: match[2] ?? null };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Parses an arXiv API Atom response into normalized paper records. */
export function parseArxivFeed(xml: string): ArxivPaper[] {
  const root = record(parser.parse(xml));
  const feed = record(root.feed);
  if (!root.feed) {
    throw new HttpError(422, "arXiv response is not an Atom feed");
  }
  const papers: ArxivPaper[] = [];
  for (const entryValue of asArray(feed.entry)) {
    const entry = record(entryValue);
    const entryId = text(entry.id);
    // The arXiv API reports malformed queries as HTTP 200 feeds containing a
    // single error entry; fail closed instead of returning "no papers".
    if (entryId?.includes("arxiv.org/api/errors")) {
      throw new HttpError(
        422,
        `arXiv API error: ${collapseWhitespace(text(entry.summary)) ?? "invalid query"}`,
      );
    }
    const reference = parseArxivReference(entryId);
    if (!reference) continue;
    const categories = asArray(entry.category)
      .map((category) => text(record(category)["@term"]))
      .filter((term): term is string => Boolean(term));
    papers.push({
      arxiv_id: reference.baseId,
      arxiv_version: reference.version,
      title: collapseWhitespace(text(entry.title)) ?? reference.baseId,
      authors: asArray(entry.author)
        .map((author) => text(record(author).name))
        .filter((name): name is string => Boolean(name)),
      summary: collapseWhitespace(text(entry.summary)),
      published_at: dateIso(text(entry.published)),
      updated_at: dateIso(text(entry.updated)),
      categories,
      primary_category: text(record(entry["arxiv:primary_category"])["@term"]) ?? categories[0] ?? null,
      doi: text(entry["arxiv:doi"]),
      journal_ref: text(entry["arxiv:journal_ref"]),
      comment: text(entry["arxiv:comment"]),
      abs_url: arxivAbsUrl(reference.baseId),
      html_url: arxivHtmlUrl(reference.baseId),
      pdf_url: arxivPdfUrl(reference.baseId),
    });
  }
  return papers;
}

function collapseWhitespace(value: string | null): string | null {
  const collapsed = value?.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const out = String(value).trim();
    return out || null;
  }
  const row = record(value);
  return text(row["#text"]) ?? text(row["#cdata"]);
}

function dateIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
