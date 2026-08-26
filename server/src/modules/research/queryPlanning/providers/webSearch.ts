import type { ResearchSemanticQuery } from "@agent-space/protocol";
import { boundedPageSize, conceptTerms, type QueryAdaptationStrategy } from "./shared.js";

// core concepts are space-joined (AND-like), but expansions get their own
// `(a OR b OR c)` group — a genuine OR, unlike openalex/semantic_scholar's
// flat plainQuery.
export const WEB_SEARCH_LADDER_STRATEGY: QueryAdaptationStrategy = {
  coreIsUnion: false,
  expansionsBroaden: true,
};

export function compileWebSearchSemanticQuery(query: ResearchSemanticQuery, pageSize?: number): Record<string, unknown> {
  const core = query.core.map(webGroup);
  const qualifiers = query.qualifiers.map((concept) => quote(concept.value));
  const expansions = query.expansions.flatMap(conceptTerms).map(quote);
  const exclusions = query.exclusions.map((concept) => `-${quote(concept.value)}`);
  const expansionGroup = expansions.length ? `(${expansions.join(" OR ")})` : null;
  return {
    q: [...core, ...qualifiers, expansionGroup, ...exclusions].filter(Boolean).join(" "),
    count: boundedPageSize(pageSize, 20),
    safesearch: "strict",
  };
}

function webGroup(concept: ResearchSemanticQuery["core"][number]): string {
  const terms = conceptTerms(concept).map(quote);
  return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
}

function quote(value: string): string {
  const normalized = value.replace(/"/g, "'");
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}
