import type { ResearchSemanticQuery } from "@agent-space/protocol";
import { boundedPageSize, plainQuery, type QueryAdaptationStrategy } from "./shared.js";

// Same plainQuery flattening as openalex — no boolean operators, so
// expansions are just more required keywords and never broaden. See
// openAlex.ts for the production evidence.
export const SEMANTIC_SCHOLAR_LADDER_STRATEGY: QueryAdaptationStrategy = {
  coreIsUnion: false,
  expansionsBroaden: false,
};

export function compileSemanticScholarSemanticQuery(query: ResearchSemanticQuery, pageSize?: number): Record<string, unknown> {
  return {
    query: plainQuery(query).replace(/-/g, " "),
    limit: boundedPageSize(pageSize, 100),
    publication_date_or_year: dateRange(query.time_window?.from ?? null, query.time_window?.to ?? null),
  };
}

function dateRange(from: string | null, to: string | null): string | null {
  const start = year(from);
  const end = year(to);
  if (!start && !end) return null;
  return `${start ?? "1900"}:${end ?? new Date().getUTCFullYear()}`;
}

function year(value: string | null): string | null {
  return value && /^\d{4}/.test(value) ? value.slice(0, 4) : null;
}
