import type { ResearchSemanticQuery } from "@rainver/protocol";
import { boundedPageSize, plainQuery, type QueryAdaptationStrategy } from "./shared.js";

// plainQuery has no boolean operators at all — core, qualifiers, and
// expansions all get flattened into one space-joined keyword string. Do not
// treat an added word as a broaden. It only narrows the match.
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
