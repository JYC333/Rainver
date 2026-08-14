import { HttpError } from "../../routeUtils/common";
import { parseFeed } from "../feedParser";
import {
  buildArxivQueryUrl,
  parseArxivFeed,
  type ArxivPaper,
  type ArxivQueryConfig,
} from "../connectors/arxiv";
import { acquireArxivRequestSlot } from "../connectors/arxivThrottle";
import { BraveWebSearchConnectorHandler, OpenAlexConnectorHandler, SemanticScholarConnectorHandler } from "../connectors/academicJson";
import { scanPublicationWindowStart } from "../connectors/monitoringWindow";

export interface SourceConnectorCapabilities {
  protocol: string;
  supports_search: boolean;
  supports_categories: boolean;
  supports_date_range: boolean;
  supports_all_history: boolean;
  supports_incremental: boolean;
  supports_conditional_requests: boolean;
  /**
   * Whether a history page may be re-requested at a smaller size without
   * disturbing paging. True only for connectors whose backfill offset is
   * counted in items; a page-numbered or opaque-cursor API cannot express
   * "the same position, fewer rows", so narrowing it would skip results.
   */
  supports_page_size_narrowing: boolean;
  id_fields: string[];
}

export interface SourceConnectorHandler {
  readonly connectorKey: string;
  buildScanRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, cursor: Record<string, unknown>): RequestSpec;
  buildBackfillRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, window: Record<string, unknown>, cursor: Record<string, unknown>): RequestSpec;
  parseResponse(response: string): NormalizedSourceItem[];
  parseCursor?(response: string): Record<string, unknown>;
  getCapabilities(): SourceConnectorCapabilities;
  prepareRequest?(): Promise<void>;
}

export interface RequestSpec {
  url: string;
  headers?: Record<string, string>;
}

export interface NormalizedSourceItem {
  itemType?: "feed_entry" | "external_url";
  externalId: string;
  title: string;
  sourceUri: string | null;
  canonicalUri: string | null;
  sourceExternalId: string | null;
  author: string | null;
  occurredAt: string | null;
  excerpt: string | null;
  metadata: Record<string, unknown>;
}

export class SourceConnectorRegistry {
  private readonly handlers = new Map<string, SourceConnectorHandler>();

  register(handler: SourceConnectorHandler): void {
    if (this.handlers.has(handler.connectorKey)) {
      throw new Error(`Source connector handler already registered: ${handler.connectorKey}`);
    }
    this.handlers.set(handler.connectorKey, handler);
  }

  get(connectorKey: string): SourceConnectorHandler {
    const handler = this.handlers.get(connectorKey);
    if (!handler) throw new HttpError(422, `No source connector handler is registered for ${connectorKey}`);
    return handler;
  }
}

class ArxivConnectorHandler implements SourceConnectorHandler {
  readonly connectorKey = "arxiv_api";

  buildScanRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, cursor: Record<string, unknown>): RequestSpec {
    const query = objectValue(channel.compiled_query);
    const windowStart = scanPublicationWindowStart(cursor);
    if (windowStart) {
      const monitoringField = query.monitoring_field === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate";
      const formatDate = (value: Date) => value.toISOString().replace(/\D/g, "").slice(0, 12);
      const current = String(query.search_query ?? "");
      const range = `${monitoringField}:[${formatDate(new Date(windowStart))} TO ${formatDate(new Date())}]`;
      const url = buildArxivQueryUrl({
        search_query: current ? `(${current}) AND ${range}` : range,
        max_results: 100,
        sort_by: monitoringField as ArxivQueryConfig["sort_by"],
        sort_order: "descending",
      });
      return { url: this.withCursor(url, { ...cursor, start: 0 }) };
    }
    return { url: this.withCursor(buildArxivQueryUrl(query as unknown as ArxivQueryConfig), cursor) };
  }

  buildBackfillRequest(channel: { endpoint_url: string | null; compiled_query: unknown }, window: Record<string, unknown>, cursor: Record<string, unknown>): RequestSpec {
    const query = objectValue(channel.compiled_query);
    const monitoringField = query.monitoring_field === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate";
    const from = typeof window.from === "string" ? window.from : null;
    const to = typeof window.to === "string" ? window.to : null;
    if (!from || !to) throw new HttpError(422, "arXiv backfill window requires from and to");
    const formatDate = (value: string) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new HttpError(422, "arXiv backfill window dates must be valid ISO timestamps");
      return date.toISOString().replace(/\D/g, "").slice(0, 12);
    };
    const baseQuery = String(query.search_query ?? "").trim();
    const dateQuery = baseQuery
      ? `(${baseQuery}) AND ${monitoringField}:[${formatDate(from)} TO ${formatDate(to)}]`
      : `${monitoringField}:[${formatDate(from)} TO ${formatDate(to)}]`;
    const compiled = buildArxivQueryUrl({
      search_query: dateQuery,
      max_results: Number(query.max_results) || 100,
      sort_by: monitoringField as ArxivQueryConfig["sort_by"],
      sort_order: "ascending",
    });
    const pageSize = Math.min(100, Math.max(1, Number(window.max_items ?? window.page_size ?? query.max_results ?? 100)));
    // Offset is counted in items, not pages. Deriving it as `cursor * 100`
    // silently skipped or repeated results whenever the page was smaller than
    // 100 — which is the normal case on the last page of a budget, and the
    // permanent case once a page size is narrowed after a provider failure.
    const startOffset = Number.isInteger(window.offset)
      ? Number(window.offset)
      : Number.isInteger(window.consumed_items)
        ? Number(window.consumed_items)
        : Number.isInteger(window.cursor)
          ? Number(window.cursor) * pageSize
          : Number.isInteger(cursor.start)
            ? Number(cursor.start)
            : 0;
    return { url: this.withCursor(compiled, { start: Math.max(0, startOffset), max_results: pageSize }) };
  }

  parseResponse(response: string): NormalizedSourceItem[] {
    return parseArxivFeed(response).map((paper: ArxivPaper) => ({
      externalId: paper.arxiv_id,
      title: paper.title,
      sourceUri: paper.abs_url,
      canonicalUri: paper.abs_url,
      sourceExternalId: paper.arxiv_id,
      author: paper.authors.join(", ") || null,
      occurredAt: paper.published_at,
      excerpt: paper.summary,
      metadata: {
        arxiv_id: paper.arxiv_id,
        arxiv_version: paper.arxiv_version,
        doi: paper.doi,
        updated_at: paper.updated_at,
        categories: paper.categories,
        primary_category: paper.primary_category,
        pdf_url: paper.pdf_url,
        html_url: paper.html_url,
      },
    }));
  }

  getCapabilities(): SourceConnectorCapabilities {
    return {
      protocol: "arxiv_atom_api",
      supports_search: true,
      supports_categories: true,
      supports_date_range: true,
      supports_all_history: true,
      supports_incremental: true,
      supports_conditional_requests: false,
      // `start` is an item offset, so a narrower page resumes at the same item.
      supports_page_size_narrowing: true,
      id_fields: ["arxiv_id", "doi"],
    };
  }

  async prepareRequest(): Promise<void> {
    await acquireArxivRequestSlot();
  }

  private withCursor(url: string | null, cursor: Record<string, unknown>): string {
    if (!url) throw new HttpError(422, "Source channel has no endpoint URL");
    const parsed = new URL(url);
    const start = Number.isInteger(cursor.start) && Number(cursor.start) >= 0 ? Number(cursor.start) : 0;
    parsed.searchParams.set("start", String(start));
    if (Number.isInteger(cursor.max_results) && Number(cursor.max_results) > 0) {
      parsed.searchParams.set("max_results", String(Math.min(100, Number(cursor.max_results))));
    }
    return parsed.toString();
  }
}

class GenericFeedConnectorHandler implements SourceConnectorHandler {
  constructor(public readonly connectorKey: string, private readonly feedFormat: "rss" | "atom") {}
  buildScanRequest(channel: { endpoint_url: string | null }): RequestSpec {
    if (!channel.endpoint_url) throw new HttpError(422, "Feed channel has no endpoint URL");
    return { url: channel.endpoint_url };
  }
  buildBackfillRequest(channel: { endpoint_url: string | null }): RequestSpec { return this.buildScanRequest(channel); }
  parseResponse(response: string): NormalizedSourceItem[] {
    return parseFeed(response, this.feedFormat).map((item) => ({
      itemType: "feed_entry",
      externalId: item.externalId ?? item.url ?? item.title,
      title: item.title,
      sourceUri: item.url,
      canonicalUri: item.url,
      sourceExternalId: item.externalId,
      author: item.author,
      occurredAt: item.occurredAt,
      excerpt: item.excerpt,
      metadata: item.metadata,
    }));
  }
  getCapabilities(): SourceConnectorCapabilities {
    return { protocol: this.connectorKey, supports_search: false, supports_categories: false, supports_date_range: false, supports_all_history: false, supports_incremental: true, supports_conditional_requests: true, supports_page_size_narrowing: false, id_fields: ["guid", "link"] };
  }
}

class WebPageConnectorHandler implements SourceConnectorHandler {
  readonly connectorKey = "web_page";
  buildScanRequest(channel: { endpoint_url: string | null }): RequestSpec {
    if (!channel.endpoint_url) throw new HttpError(422, "Web page channel has no endpoint URL");
    return { url: channel.endpoint_url };
  }
  buildBackfillRequest(channel: { endpoint_url: string | null }): RequestSpec { return this.buildScanRequest(channel); }
  parseResponse(response: string): NormalizedSourceItem[] {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(response)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Web page";
    const text = response.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return [{
      itemType: "external_url",
      externalId: title,
      title,
      sourceUri: null,
      canonicalUri: null,
      sourceExternalId: null,
      author: null,
      occurredAt: null,
      excerpt: text.slice(0, 2048),
      metadata: { page_title: title, content_length: response.length },
    }];
  }
  getCapabilities(): SourceConnectorCapabilities {
    return { protocol: "web_page", supports_search: false, supports_categories: false, supports_date_range: false, supports_all_history: false, supports_incremental: true, supports_conditional_requests: true, supports_page_size_narrowing: false, id_fields: ["canonical_uri"] };
  }
}

export const sourceConnectorRegistry = new SourceConnectorRegistry();
// Deliberately self-register at import: these handlers and their registry share
// this file, so importing the registry cannot omit them and registration occurs
// exactly once per process rather than once per Fastify app build.
sourceConnectorRegistry.register(new ArxivConnectorHandler());
sourceConnectorRegistry.register(new OpenAlexConnectorHandler());
sourceConnectorRegistry.register(new SemanticScholarConnectorHandler());
sourceConnectorRegistry.register(new BraveWebSearchConnectorHandler());
sourceConnectorRegistry.register(new GenericFeedConnectorHandler("rss", "rss"));
sourceConnectorRegistry.register(new GenericFeedConnectorHandler("atom", "atom"));
sourceConnectorRegistry.register(new WebPageConnectorHandler());
sourceConnectorRegistry.register(new GenericFeedConnectorHandler("custom_source", "rss"));

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
