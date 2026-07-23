import type { ResearchSemanticQuery } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { boundedPageSize, plainQuery, type QueryAdaptationStrategy } from "./shared";

// plainQuery has no boolean operators at all — core, qualifiers, and
// expansions all get flattened into one space-joined keyword string, so
// adding any of them (including an "expansion") only ever narrows the
// match, never broadens it. Verified in production: three consecutive
// "broaden" steps for openalex kept adding words and hits kept dropping
// (1094 -> 360 -> 24 -> 24).
export const OPENALEX_LADDER_STRATEGY: QueryAdaptationStrategy = {
  coreIsUnion: false,
  expansionsBroaden: false,
};

export function compileOpenAlexSemanticQuery(query: ResearchSemanticQuery, pageSize?: number): Record<string, unknown> {
  return {
    search: plainQuery(query),
    per_page: boundedPageSize(pageSize, 100),
    sort: "publication_date:desc",
    from_publication_date: query.time_window?.from ?? null,
    to_publication_date: query.time_window?.to ?? null,
  };
}
