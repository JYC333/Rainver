import type {
  ResearchProviderKey,
  ResearchQueryAttemptDirection,
  ResearchSemanticConcept,
  ResearchSemanticQuery,
} from "@agent-space/protocol";
import { ARXIV_LADDER_STRATEGY } from "./providers/arxiv.js";
import { OPENALEX_LADDER_STRATEGY } from "./providers/openAlex.js";
import { SEMANTIC_SCHOLAR_LADDER_STRATEGY } from "./providers/semanticScholar.js";
import { type QueryAdaptationStrategy } from "./providers/shared.js";
import { WEB_SEARCH_LADDER_STRATEGY } from "./providers/webSearch.js";
import { MAX_RESEARCH_QUERY_ATTEMPTS } from "./queryPolicy.js";

// Each provider file owns the facts about its own compiler's boolean
// structure (see QueryAdaptationStrategy in providers/shared.ts); this is
// just the lookup from provider key to that provider's strategy.
const LADDER_STRATEGIES: Record<ResearchProviderKey, QueryAdaptationStrategy> = {
  arxiv: ARXIV_LADDER_STRATEGY,
  openalex: OPENALEX_LADDER_STRATEGY,
  semantic_scholar: SEMANTIC_SCHOLAR_LADDER_STRATEGY,
  web_search: WEB_SEARCH_LADDER_STRATEGY,
};

export interface ResearchQueryLadderStep {
  sequence: number;
  direction: ResearchQueryAttemptDirection;
  semanticQuery: ResearchSemanticQuery;
}

export class ResearchQueryLadderBuilder {
  initial(intent: ResearchSemanticQuery): ResearchQueryLadderStep {
    return {
      sequence: 1,
      direction: "initial",
      semanticQuery: {
        ...intent,
        core: ranked(intent.core).slice(0, 3),
        expansions: ranked(intent.expansions).slice(0, 2),
        qualifiers: ranked(intent.qualifiers).slice(0, 1),
        exclusions: ranked(intent.exclusions).slice(0, 3),
      },
    };
  }

  next(
    previous: ResearchQueryLadderStep,
    intent: ResearchSemanticQuery,
    direction: Exclude<ResearchQueryAttemptDirection, "initial">,
    providerKey: ResearchProviderKey,
  ): ResearchQueryLadderStep {
    if (previous.sequence >= MAX_RESEARCH_QUERY_ATTEMPTS) throw new Error(`Research query ladder is limited to ${MAX_RESEARCH_QUERY_ATTEMPTS} attempts`);
    const strategy = LADDER_STRATEGIES[providerKey];
    const semanticQuery = direction === "broaden"
      ? broaden(previous.semanticQuery, intent, strategy)
      : narrow(previous.semanticQuery, intent, strategy);
    return {
      sequence: previous.sequence + 1,
      direction,
      semanticQuery,
    };
  }
}

// One relaxation per call: dropping the AND'd qualifier and adding an OR'd
// expansion in the same step used to take a 59-hit query straight to 17,831
// in one jump. Try the gentler lever (expansion, when it genuinely broadens
// for this provider) first; only reach for the qualifier, then core, once
// that's exhausted.
function broaden(current: ResearchSemanticQuery, intent: ResearchSemanticQuery, strategy: QueryAdaptationStrategy): ResearchSemanticQuery {
  if (strategy.expansionsBroaden) {
    const expansion = firstMissing(ranked(intent.expansions), current.expansions);
    if (expansion) return { ...current, expansions: [...current.expansions, expansion].slice(0, 4) };
  }
  if (current.qualifiers.length > 0) {
    return { ...current, qualifiers: ranked(current.qualifiers).slice(0, current.qualifiers.length - 1) };
  }
  if (strategy.coreIsUnion) {
    const core = firstMissing(ranked(intent.core), current.core);
    if (core) return { ...current, core: [...current.core, core].slice(0, 4) };
  } else if (current.core.length > 1) {
    return { ...current, core: ranked(current.core).slice(0, current.core.length - 1) };
  }
  return { ...current };
}

function narrow(current: ResearchSemanticQuery, intent: ResearchSemanticQuery, strategy: QueryAdaptationStrategy): ResearchSemanticQuery {
  const qualifier = firstMissing(ranked(intent.qualifiers), current.qualifiers);
  if (qualifier) return { ...current, qualifiers: [...current.qualifiers, qualifier].slice(0, 4) };
  // A provider with no boolean operators (plainQuery) treats an "expansion"
  // exactly like any other required keyword — adding one narrows just like
  // adding a qualifier, so it belongs here instead of in broaden().
  if (!strategy.expansionsBroaden) {
    const expansion = firstMissing(ranked(intent.expansions), current.expansions);
    if (expansion) return { ...current, expansions: [...current.expansions, expansion].slice(0, 4) };
  }
  if (strategy.coreIsUnion) {
    if (current.core.length > 1) return { ...current, core: ranked(current.core).slice(0, current.core.length - 1) };
  } else {
    const core = firstMissing(ranked(intent.core), current.core);
    if (core) return { ...current, core: [...current.core, core].slice(0, 4) };
  }
  // Trimming an expansion only narrows when it was a genuine OR alternative;
  // for a flat provider it would remove a required keyword and broaden
  // instead, so there is nothing left to do.
  if (strategy.expansionsBroaden) {
    return { ...current, expansions: current.expansions.slice(0, Math.max(0, current.expansions.length - 1)) };
  }
  return { ...current };
}

function ranked(values: ResearchSemanticConcept[]): ResearchSemanticConcept[] {
  return [...values].sort((left, right) => right.weight - left.weight || left.value.localeCompare(right.value));
}

function firstMissing(
  candidates: ResearchSemanticConcept[],
  selected: ResearchSemanticConcept[],
): ResearchSemanticConcept | undefined {
  const keys = new Set(selected.map((concept) => concept.value.toLocaleLowerCase()));
  return candidates.find((concept) => !keys.has(concept.value.toLocaleLowerCase()));
}
