import { HttpError, objectValue } from "../../routeUtils/common";
import type {
  NormalizedSourceItem,
  RequestSpec,
  SourceConnectorCapabilities,
  SourceConnectorHandler,
} from "../catalog/sourceConnectorRegistry";
import { scanPublicationWindowStart } from "./monitoringWindow";

const OPENALEX_FIELDS = "id,doi,title,display_name,publication_date,authorships,primary_location,type,cited_by_count,referenced_works_count,ids,abstract_inverted_index";
const S2_FIELDS = "paperId,externalIds,url,title,abstract,authors,publicationDate,year,venue,publicationTypes,citationCount,referenceCount,openAccessPdf";

export class OpenAlexConnectorHandler implements SourceConnectorHandler {
  readonly connectorKey = "openalex_api";

  buildScanRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, cursor: Record<string, unknown>): RequestSpec {
    const query = { ...objectValue(channel.compiled_query) };
    const windowStart = scanPublicationWindowStart(cursor);
    if (windowStart) {
      const existing = isoDate(query.from_publication_date);
      const cutoff = isoDate(windowStart);
      query.from_publication_date = laterDate(existing, cutoff);
    }
    return { url: openAlexUrl(query, stringValue(cursor.cursor) ?? "*") };
  }

  buildBackfillRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, window: Record<string, unknown>, cursor: Record<string, unknown>): RequestSpec {
    const query = { ...objectValue(channel.compiled_query) };
    query.from_publication_date = isoDate(window.from) ?? query.from_publication_date;
    query.to_publication_date = isoDate(window.to) ?? query.to_publication_date;
    query.per_page = boundedInt(window.page_size ?? window.max_items ?? query.per_page, 100, 1, 100);
    const page = boundedInt(window.cursor, 0, 0, 9999) + 1;
    return { url: openAlexUrl(query, stringValue(cursor.cursor) ?? "*", page) };
  }

  parseResponse(response: string): NormalizedSourceItem[] {
    const payload = parseJson(response, "OpenAlex");
    const rows = Array.isArray(payload.results) ? payload.results : [];
    return rows.map(openAlexItem).filter((item): item is NormalizedSourceItem => item !== null);
  }

  parseCursor(response: string): Record<string, unknown> {
    return { cursor: stringValue(objectValue(parseJson(response, "OpenAlex").meta).next_cursor) };
  }

  getCapabilities(): SourceConnectorCapabilities {
    // Paged by `page`, so a narrower `per_page` would land on a different set.
    return academicCapabilities("openalex_json_api", ["doi", "arxiv_id", "openalex_id"], { pageSizeNarrowing: false });
  }
}

export class SemanticScholarConnectorHandler implements SourceConnectorHandler {
  readonly connectorKey = "semantic_scholar_api";

  buildScanRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, cursor: Record<string, unknown>): RequestSpec {
    const query = { ...objectValue(channel.compiled_query) };
    const windowStart = scanPublicationWindowStart(cursor);
    if (windowStart) {
      query.publication_date_or_year = dateRange(windowStart, new Date().toISOString());
    }
    return { url: semanticScholarUrl(query, boundedInt(cursor.offset, 0, 0, 900)) };
  }

  buildBackfillRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, window: Record<string, unknown>, cursor: Record<string, unknown>): RequestSpec {
    const query = { ...objectValue(channel.compiled_query) };
    query.publication_date_or_year = dateRange(window.from, window.to) ?? query.publication_date_or_year;
    query.limit = boundedInt(window.page_size ?? window.max_items ?? query.limit, 100, 1, 100);
    return { url: semanticScholarUrl(query, boundedInt(window.offset ?? window.cursor ?? cursor.offset, 0, 0, 900)) };
  }

  parseResponse(response: string): NormalizedSourceItem[] {
    const payload = parseJson(response, "Semantic Scholar");
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return rows.map(semanticScholarItem).filter((item): item is NormalizedSourceItem => item !== null);
  }

  parseCursor(response: string): Record<string, unknown> {
    const payload = parseJson(response, "Semantic Scholar");
    return { offset: integerOrNull(payload.next) };
  }

  getCapabilities(): SourceConnectorCapabilities {
    return academicCapabilities("semantic_scholar_graph_api", ["doi", "arxiv_id", "semantic_scholar_id"], { pageSizeNarrowing: true });
  }
}

export class BraveWebSearchConnectorHandler implements SourceConnectorHandler {
  readonly connectorKey = "brave_web_search_api";
  buildScanRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, cursor: Record<string, unknown>): RequestSpec {
    return { url: braveUrl(objectValue(channel.compiled_query), boundedInt(cursor.offset, 0, 0, 9)), headers: { Accept: "application/json" } };
  }
  buildBackfillRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, _window: Record<string, unknown>, cursor: Record<string, unknown>): RequestSpec {
    return this.buildScanRequest(channel, cursor);
  }
  parseResponse(response: string): NormalizedSourceItem[] {
    const payload = parseJson(response, "Brave Search");
    const rows = Array.isArray(objectValue(payload.web).results) ? objectValue(payload.web).results as unknown[] : [];
    return rows.flatMap((value): NormalizedSourceItem[] => {
      const row = objectValue(value); const url = stringValue(row.url); const title = stringValue(row.title);
      if (!url || !title) return [];
      return [{ itemType: "external_url", externalId: url, title, sourceUri: url, canonicalUri: url, sourceExternalId: url,
        author: null, occurredAt: null, excerpt: stringValue(row.description),
        metadata: { web_provider: "brave", trust_tier: "web_untrusted", source_url: url, language: stringValue(row.language) } }];
    });
  }
  parseCursor(response: string): Record<string, unknown> {
    const more = objectValue(parseJson(response, "Brave Search").query).more_results_available === true;
    return { more_results_available: more };
  }
  getCapabilities(): SourceConnectorCapabilities {
    return { protocol: "brave_web_search_api", supports_search: true, supports_categories: false, supports_date_range: false, supports_all_history: false, supports_incremental: true, supports_conditional_requests: false, supports_page_size_narrowing: false, id_fields: ["canonical_uri"] };
  }
}

function openAlexUrl(query: Record<string, unknown>, cursor: string, page?: number): string {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", String(query.search));
  url.searchParams.set("per-page", String(boundedInt(query.per_page, 100, 1, 100)));
  if (page === undefined) url.searchParams.set("cursor", cursor);
  else url.searchParams.set("page", String(page));
  url.searchParams.set("select", OPENALEX_FIELDS);
  url.searchParams.set("sort", String(query.sort ?? "publication_date:desc"));
  const filters = [
    isoDate(query.from_publication_date) ? `from_publication_date:${isoDate(query.from_publication_date)}` : null,
    isoDate(query.to_publication_date) ? `to_publication_date:${isoDate(query.to_publication_date)}` : null,
  ].filter(Boolean);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  return url.toString();
}

function semanticScholarUrl(query: Record<string, unknown>, offset: number): string {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", String(query.query));
  url.searchParams.set("limit", String(boundedInt(query.limit, 100, 1, 100)));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("fields", S2_FIELDS);
  if (stringValue(query.publication_date_or_year)) url.searchParams.set("publicationDateOrYear", String(query.publication_date_or_year));
  return url.toString();
}

function braveUrl(query: Record<string, unknown>, offset: number): string {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", String(query.q)); url.searchParams.set("count", String(boundedInt(query.count, 20, 1, 20)));
  url.searchParams.set("offset", String(offset)); url.searchParams.set("safesearch", "strict");
  if (stringValue(query.freshness)) url.searchParams.set("freshness", String(query.freshness));
  return url.toString();
}

function openAlexItem(value: unknown): NormalizedSourceItem | null {
  const row = objectValue(value);
  const openalexId = tailId(stringValue(row.id));
  const title = stringValue(row.title) ?? stringValue(row.display_name);
  if (!openalexId || !title) return null;
  const ids = objectValue(row.ids);
  const doi = normalizeDoi(stringValue(row.doi) ?? stringValue(ids.doi));
  const arxivId = arxivIdFrom(stringValue(ids.arxiv));
  const authors = (Array.isArray(row.authorships) ? row.authorships : [])
    .map((entry) => stringValue(objectValue(objectValue(entry).author).display_name)).filter((name): name is string => Boolean(name));
  const primaryLocation = objectValue(row.primary_location);
  const source = objectValue(primaryLocation.source);
  const sourceUri = stringValue(primaryLocation.landing_page_url) ?? stringValue(row.id);
  return {
    externalId: openalexId, title, sourceUri, canonicalUri: sourceUri, sourceExternalId: openalexId,
    author: authors.join(", ") || null, occurredAt: stringValue(row.publication_date),
    excerpt: reconstructAbstract(row.abstract_inverted_index),
    metadata: {
      academic_provider: "openalex", openalex_id: openalexId, doi, arxiv_id: arxivId, authors,
      published_at: stringValue(row.publication_date), venue: stringValue(source.display_name),
      paper_type: paperType(stringValue(row.type)), cited_by_count: integerOrNull(row.cited_by_count),
      reference_count: integerOrNull(row.referenced_works_count), source_url: sourceUri,
    },
  };
}

function semanticScholarItem(value: unknown): NormalizedSourceItem | null {
  const row = objectValue(value);
  const paperId = stringValue(row.paperId);
  const title = stringValue(row.title);
  if (!paperId || !title) return null;
  const externalIds = objectValue(row.externalIds);
  const doi = normalizeDoi(stringValue(externalIds.DOI));
  const arxivId = stringValue(externalIds.ArXiv);
  const authors = (Array.isArray(row.authors) ? row.authors : [])
    .map((entry) => stringValue(objectValue(entry).name)).filter((name): name is string => Boolean(name));
  const sourceUri = stringValue(row.url) ?? `https://www.semanticscholar.org/paper/${paperId}`;
  return {
    externalId: paperId, title, sourceUri, canonicalUri: sourceUri, sourceExternalId: paperId,
    author: authors.join(", ") || null,
    occurredAt: stringValue(row.publicationDate) ?? (Number.isInteger(row.year) ? `${row.year}-01-01` : null),
    excerpt: stringValue(row.abstract),
    metadata: {
      academic_provider: "semantic_scholar", semantic_scholar_id: paperId, doi, arxiv_id: arxivId, authors,
      published_at: stringValue(row.publicationDate), venue: stringValue(row.venue),
      paper_type: paperType(Array.isArray(row.publicationTypes) ? stringValue(row.publicationTypes[0]) : null),
      cited_by_count: integerOrNull(row.citationCount), reference_count: integerOrNull(row.referenceCount),
      pdf_url: stringValue(objectValue(row.openAccessPdf).url), source_url: sourceUri,
    },
  };
}

function parseJson(raw: string, provider: string): Record<string, unknown> {
  try { return objectValue(JSON.parse(raw)); } catch { throw new HttpError(502, `${provider} returned invalid JSON`); }
}
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function integerOrNull(value: unknown): number | null { return Number.isInteger(value) ? Number(value) : null; }
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
}
function isoDate(value: unknown): string | null {
  const raw = stringValue(value); if (!raw) return null;
  const time = Date.parse(raw); return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}
function dateRange(from: unknown, to: unknown): string | null {
  const start = isoDate(from); const end = isoDate(to); return start || end ? `${start ?? ""}:${end ?? ""}` : null;
}
function laterDate(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}
function normalizeDoi(value: string | null): string | null { return value?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase() ?? null; }
function tailId(value: string | null): string | null { return value?.split("/").filter(Boolean).at(-1) ?? null; }
function arxivIdFrom(value: string | null): string | null { return value?.replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "").replace(/\.pdf$/i, "") ?? null; }
function paperType(value: string | null): string { return value?.toLowerCase().includes("conference") ? "conference_paper" : value?.toLowerCase().includes("preprint") ? "preprint" : "article"; }
function reconstructAbstract(value: unknown): string | null {
  const inverted = objectValue(value); const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inverted)) if (Array.isArray(positions)) for (const position of positions) if (Number.isInteger(position)) words.push([Number(position), word]);
  return words.length ? words.sort((a, b) => a[0] - b[0]).map(([, word]) => word).join(" ") : null;
}
function academicCapabilities(
  protocol: string,
  ids: string[],
  options: { pageSizeNarrowing: boolean },
): SourceConnectorCapabilities {
  return {
    protocol,
    supports_search: true,
    supports_categories: false,
    supports_date_range: true,
    supports_all_history: true,
    supports_incremental: true,
    supports_conditional_requests: false,
    supports_page_size_narrowing: options.pageSizeNarrowing,
    id_fields: ids,
  };
}
