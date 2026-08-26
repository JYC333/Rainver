import type { ResearchSemanticConcept, ResearchSemanticQuery } from "@rainver/protocol";
import { boundedPageSize, conceptTerms, type QueryAdaptationStrategy } from "./shared.js";

export const ARXIV_LADDER_STRATEGY: QueryAdaptationStrategy = {
  coreIsUnion: true,
  expansionsBroaden: true,
};

// core concepts are alternative framings of the same topic (e.g. "retrieval-
// augmented agent memory" vs. "summarization-only agent memory" for a
// question comparing agent memory approaches), not independently required
// facets — requiring every one of them to co-occur in the same paper is far
// stricter than the model intends and was collapsing recall to near zero.
// Core and expansion terms are OR'd into one topic clause; qualifiers stay
// required (AND) on top of that topic, and exclusions stay excluded (ANDNOT).
export function compileArxivSemanticQuery(query: ResearchSemanticQuery, pageSize?: number): Record<string, unknown> {
  const topicTerms = [
    ...query.core.map((concept) => arxivGroup(concept)),
    ...query.expansions.flatMap(conceptTerms).map(arxivTerm),
  ];
  const topic = topicTerms.length === 1 ? topicTerms[0]! : topicTerms.length ? `(${topicTerms.join(" OR ")})` : null;
  const required = [...(topic ? [topic] : []), ...query.qualifiers.map((concept) => arxivGroup(concept))];
  const exclusions = query.exclusions.map((concept) => `ANDNOT ${arxivGroup(concept)}`);
  return {
    mode: "search",
    search_query: [...required, ...exclusions].join(" AND ").replace(/ AND ANDNOT /g, " ANDNOT "),
    categories: [],
    max_results: boundedPageSize(pageSize, 100),
    sort_by: "relevance",
    sort_order: "descending",
    monitoring_field: "submittedDate",
  };
}

function arxivGroup(concept: ResearchSemanticConcept): string {
  const terms = conceptTerms(concept).map(arxivTerm);
  return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
}

// arXiv's `all:` field only matches a quoted multi-word value as an exact,
// adjacent phrase. Concept values are model-generated composite phrasing
// ("coding agent memory mechanism") that almost never appears verbatim in a
// real title/abstract — verified against the live API: several 3-4 word
// invented phrases returned 0 hits, while ANDing the same words returned
// hundreds. Require each word present instead of an exact phrase.
function arxivTerm(value: string): string {
  const words = value.replace(/"/g, "'").split(/\s+/).filter(Boolean);
  return words.length <= 1 ? arxivWord(words[0] ?? "") : `(${words.map(arxivWord).join(" AND ")})`;
}

function arxivWord(word: string): string {
  return /^[\p{L}\p{N}_-]+$/u.test(word) ? `all:${word}` : `all:"${word}"`;
}
