import { createHash } from "node:crypto";
import type {
  ResearchCompiledQuery,
  ResearchProviderKey,
  ResearchSemanticQuery,
} from "@agent-space/protocol";
import { compileArxivSemanticQuery } from "./providers/arxiv.js";
import { compileOpenAlexSemanticQuery } from "./providers/openAlex.js";
import { compileSemanticScholarSemanticQuery } from "./providers/semanticScholar.js";
import { compileWebSearchSemanticQuery } from "./providers/webSearch.js";
import { HttpError } from "../../routeUtils/common.js";

export interface ResearchProviderCompileOptions {
  pageSize?: number;
}

export class ResearchProviderCompiler {
  compile(
    providerKey: ResearchProviderKey,
    semanticQuery: ResearchSemanticQuery,
    options: ResearchProviderCompileOptions = {},
  ): ResearchCompiledQuery {
    const query = compileProvider(providerKey, semanticQuery, options.pageSize);
    return {
      schema_version: "research_compiled_query.v1",
      provider_key: providerKey,
      query,
      fingerprint: queryFingerprint(providerKey, query),
    };
  }

  /** Validates provider-native input for manually created monitors. This is the
   * sole non-LLM path into a compiled provider query; connector adapters only
   * execute the returned contract. */
  compileNative(providerKey: ResearchProviderKey, input: Record<string, unknown>): ResearchCompiledQuery {
    const query = normalizeNativeProviderQuery(providerKey, input);
    return {
      schema_version: "research_compiled_query.v1",
      provider_key: providerKey,
      query,
      fingerprint: queryFingerprint(providerKey, query),
    };
  }
}

function compileProvider(
  providerKey: ResearchProviderKey,
  semanticQuery: ResearchSemanticQuery,
  pageSize?: number,
): Record<string, unknown> {
  if (providerKey === "arxiv") return compileArxivSemanticQuery(semanticQuery, pageSize);
  if (providerKey === "openalex") return compileOpenAlexSemanticQuery(semanticQuery, pageSize);
  if (providerKey === "semantic_scholar") return compileSemanticScholarSemanticQuery(semanticQuery, pageSize);
  return compileWebSearchSemanticQuery(semanticQuery, pageSize);
}

function queryFingerprint(providerKey: ResearchProviderKey, query: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ provider_key: providerKey, query })).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeNativeProviderQuery(providerKey: ResearchProviderKey, input: Record<string, unknown>): Record<string, unknown> {
  const query = objectValue(input.query ?? input);
  if (providerKey === "arxiv") {
    const allPapers = query.mode === "all";
    const categories = Array.isArray(query.categories) ? [...new Set(query.categories.map(String).filter(Boolean))] : [];
    const raw = stringValue(query.search_query);
    if (!allPapers && !raw && categories.length === 0) throw new HttpError(422, "arXiv query requires search_query, categories, or mode=all");
    const searchQuery = allPapers
      ? "all:*"
      : raw
        ? normalizeArxivSearchQuery(raw)
        : categories.map((category) => `cat:${category}`).join(" OR ");
    const sortBy = ["relevance", "lastUpdatedDate", "submittedDate"].includes(String(query.sort_by)) ? String(query.sort_by) : "submittedDate";
    return {
      mode: allPapers ? "all" : query.mode === "recent_by_category" ? "recent_by_category" : "search",
      search_query: searchQuery,
      categories,
      max_results: boundedInt(query.max_results, 100, 1, 100),
      sort_by: sortBy,
      sort_order: query.sort_order === "ascending" ? "ascending" : "descending",
      monitoring_field: query.monitoring_field === "lastUpdatedDate" ? "lastUpdatedDate" : "submittedDate",
    };
  }
  if (providerKey === "openalex") {
    const search = stringValue(query.search);
    if (!search) throw new HttpError(422, "OpenAlex query requires search");
    return {
      search,
      per_page: boundedInt(query.per_page, 100, 1, 100),
      sort: query.sort === "cited_by_count:desc" ? query.sort : "publication_date:desc",
      from_publication_date: isoDate(query.from_publication_date),
      to_publication_date: isoDate(query.to_publication_date),
    };
  }
  if (providerKey === "semantic_scholar") {
    const search = stringValue(query.query);
    if (!search) throw new HttpError(422, "Semantic Scholar query requires query");
    return {
      query: search,
      limit: boundedInt(query.limit, 100, 1, 100),
      publication_date_or_year: dateRange(query.from_publication_date, query.to_publication_date),
    };
  }
  const q = stringValue(query.q);
  if (!q) throw new HttpError(422, "Web search query requires q");
  return { q, count: boundedInt(query.count, 20, 1, 20), freshness: stringValue(query.freshness) };
}

const ARXIV_FIELD_PREFIX_RE = /\b(ti|au|abs|co|jr|cat|rn|id|all|submittedDate|lastUpdatedDate)\s*:/i;

function normalizeArxivSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (ARXIV_FIELD_PREFIX_RE.test(trimmed)) return trimmed;
  return `all:"${trimmed.replace(/^["']|["']$/g, "").replace(/"/g, "'")}"`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function isoDate(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new HttpError(422, "Provider date filter must be a valid date");
  return date.toISOString().slice(0, 10);
}

function dateRange(fromValue: unknown, toValue: unknown): string | null {
  const from = isoDate(fromValue);
  const to = isoDate(toValue);
  if (!from && !to) return null;
  return `${from ?? "1900-01-01"}:${to ?? new Date().toISOString().slice(0, 10)}`;
}
