import { objectValue } from "../routeUtils/common.js";

export const RESEARCH_CRITERION_MAX_LENGTH = 200;
const RESEARCH_CONTEXT_MAX_ITEMS = 10;

export interface ResearchScopeContext {
  sub_questions: string[];
  in: string[];
  out: string[];
  must_have: string[];
  nice_to_have: string[];
}

export interface ResearchRelevanceCriteria {
  include: string[];
  exclude: string[];
}

export interface ResearchRelevanceProfile {
  enabled: true;
  objective: string;
  include_criteria: string[];
  exclude_criteria: string[];
  must_have: string[];
  nice_to_have: string[];
}

/**
 * Convert persisted/provider-produced refinement output into the small,
 * durable context shared by query planning, screening, and synthesis.
 * Missing optional draft fields intentionally normalize to empty lists.
 */
export function researchScopeFromRefinement(value: unknown): ResearchScopeContext {
  const refinement = objectValue(value);
  const scope = objectValue(refinement.scope);
  return {
    sub_questions: boundedUniqueQuestions(refinement.sub_questions),
    in: boundedUniqueStrings(scope.in),
    out: boundedUniqueStrings(scope.out),
    must_have: boundedUniqueStrings(refinement.must_have),
    nice_to_have: boundedUniqueStrings(refinement.nice_to_have),
  };
}

export function normalizeResearchScope(value: unknown): ResearchScopeContext {
  const scope = objectValue(value);
  return {
    sub_questions: boundedUniqueQuestions(scope.sub_questions),
    in: boundedUniqueStrings(scope.in),
    out: boundedUniqueStrings(scope.out),
    must_have: boundedUniqueStrings(scope.must_have),
    nice_to_have: boundedUniqueStrings(scope.nice_to_have),
  };
}

/** Inclusion scope and sub-questions are positive screening signals; explicit
 * out-of-scope statements are negative signals. The full research question is
 * deliberately not copied here: it belongs in relevance_profile.objective.
 */
export function relevanceCriteriaFromScope(scope: ResearchScopeContext): ResearchRelevanceCriteria {
  return {
    include: unique([...scope.in, ...scope.sub_questions]).slice(0, 20),
    exclude: unique(scope.out).slice(0, 20),
  };
}

export function relevanceProfileFromResearchContext(
  researchQuestion: string,
  scope: ResearchScopeContext,
): ResearchRelevanceProfile {
  const criteria = relevanceCriteriaFromScope(scope);
  return {
    enabled: true,
    objective: researchQuestion,
    include_criteria: criteria.include,
    exclude_criteria: criteria.exclude,
    must_have: scope.must_have,
    nice_to_have: scope.nice_to_have,
  };
}

export function researchScopeIsEmpty(scope: ResearchScopeContext): boolean {
  return scope.sub_questions.length === 0 && scope.in.length === 0 && scope.out.length === 0
    && scope.must_have.length === 0 && scope.nice_to_have.length === 0;
}

function boundedUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const normalized = item.replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    return [normalized.length <= RESEARCH_CRITERION_MAX_LENGTH
      ? normalized
      : `${normalized.slice(0, RESEARCH_CRITERION_MAX_LENGTH - 1).trimEnd()}…`];
  })).slice(0, RESEARCH_CONTEXT_MAX_ITEMS);
}

// Sub-questions are full questions, not short screening tags (unlike
// scope.in/out and must_have/nice_to_have) — mid-sentence truncation would
// leave a broken, unusable question, so only bound item count, not length.
function boundedUniqueQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const normalized = item.replace(/\s+/g, " ").trim();
    return normalized ? [normalized] : [];
  })).slice(0, RESEARCH_CONTEXT_MAX_ITEMS);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
