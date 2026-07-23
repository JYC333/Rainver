import type { ResearchSemanticConcept, ResearchSemanticQuery } from "@agent-space/protocol" with { "resolution-mode": "import" };

/**
 * Facts about how a provider's compiler expresses boolean structure, used by
 * queryLadderBuilder.ts to pick a broaden/narrow step that actually broadens
 * or narrows for that provider instead of assuming every provider supports
 * the same OR/AND grammar arxiv does. Each provider file owns its own
 * strategy, the same way it owns its own compile function.
 */
export interface QueryAdaptationStrategy {
  /** Core concepts are OR'd into one topic clause (adding an alternative
   * widens matches, removing one narrows) rather than all being required. */
  coreIsUnion: boolean;
  /** Expansions are genuinely OR'd in as alternatives and broaden recall.
   * False when the compiler has no boolean operators at all (plainQuery)
   * and an "expansion" is just one more required keyword — exactly as
   * narrowing as a qualifier, never a broadening move. */
  expansionsBroaden: boolean;
}

export function conceptTerms(concept: ResearchSemanticConcept): string[] {
  return unique([concept.value, ...concept.synonyms].map(normalizeTerm).filter(Boolean));
}

export function plainQuery(query: ResearchSemanticQuery): string {
  const required = [...query.core, ...query.qualifiers].flatMap((concept) => conceptTerms(concept).slice(0, 1));
  const expansions = query.expansions.flatMap((concept) => conceptTerms(concept).slice(0, 1));
  return unique([...required, ...expansions]).join(" ");
}

export function boundedPageSize(value: number | undefined, maximum: number): number {
  return Math.min(maximum, Math.max(1, Number.isInteger(value) ? Number(value) : Math.min(20, maximum)));
}

export function normalizeTerm(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLocaleLowerCase()))];
}
