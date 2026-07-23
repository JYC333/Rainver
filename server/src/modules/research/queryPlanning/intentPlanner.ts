import type {
  ResearchContext,
  ResearchSemanticConcept,
  ResearchSemanticQuery,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../../config";
import { resolvePrompt } from "../../prompts/resolver";
import { resolveProviderCommandStore } from "../../providers/commands/store";
import { completeProviderMessages } from "../../providers/invocation/invocation";
import { loadProtocol } from "../../providers/protocolRuntime";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common";

export const RESEARCH_QUERY_INTENT_PROMPT_KEY = "research_query.intent_plan";

export interface ResearchIntentExecution {
  modelProviderId?: string;
  modelName?: string;
}

export class ResearchIntentPlanner {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  async plan(
    identity: SpaceUserIdentity,
    context: ResearchContext,
    execution: ResearchIntentExecution = {},
  ): Promise<ResearchSemanticQuery> {
    const protocol = await loadProtocol();
    const validatedContext = protocol.ResearchContextSchema.parse(context);
    if (!execution.modelProviderId) return heuristicResearchIntent(validatedContext);

    const resolved = await resolvePrompt(this.db, {
      spaceId: identity.spaceId,
      userId: identity.userId,
      assetKey: RESEARCH_QUERY_INTENT_PROMPT_KEY,
      variables: { research_context: JSON.stringify(validatedContext) },
    });
    if (resolved.validation_errors.length || !resolved.rendered_text) {
      throw new HttpError(500, "Research query intent prompt is not resolvable");
    }
    const response = await completeProviderMessages(resolveProviderCommandStore(this.config), identity.spaceId, {
      provider_id: execution.modelProviderId,
      model: execution.modelName,
      system: resolved.rendered_text,
      messages: [{ role: "user", content: "Extract the semantic search intent." }],
      max_tokens: 1_400,
      task: "research_query_intent_plan",
      output_format: RESEARCH_INTENT_OUTPUT_CONTRACT,
      metering: {
        subject_user_id: identity.userId,
        source_type: "local_run",
        execution_channel: "managed_api",
        task: "research_query_intent_plan",
      },
      egressPolicy: { externalEgressEnabled: true },
    });
    if (!response.structured_output) throw new HttpError(502, "Research query intent planner returned no structured output");
    return protocol.ResearchSemanticQuerySchema.parse({
      ...response.structured_output,
      schema_version: "research_semantic_query.v1",
      time_window: validatedContext.time_window,
    });
  }
}

export function heuristicResearchIntent(context: ResearchContext): ResearchSemanticQuery {
  const preferredCore = uniquePhrases(context.in_scope.map((value) => compactConceptPhrase(value))).slice(0, 3);
  const fallbackCore = keywordConcepts(context.objective, 3);
  const coreValues = preferredCore.length ? preferredCore : fallbackCore;
  const qualifiers = uniquePhrases([
    ...context.sub_questions.flatMap((value) => keywordConcepts(value, 2)),
    ...context.must_have.map((value) => compactConceptPhrase(value)),
    ...context.nice_to_have.map((value) => compactConceptPhrase(value)),
  ]).filter((value) => !includesPhrase(coreValues, value)).slice(0, 4);
  const exclusions = uniquePhrases(context.out_of_scope.map((value) => compactConceptPhrase(value))).slice(0, 4);
  const core = coreValues.map((value, index) => concept(value, 1 - index * 0.1));
  if (core.length === 0) core.push(concept("research", 1));
  return {
    schema_version: "research_semantic_query.v1",
    core,
    expansions: [],
    qualifiers: qualifiers.map((value, index) => concept(value, Math.max(0.5, 0.85 - index * 0.1))),
    exclusions: exclusions.map((value) => concept(value, 0.8)),
    time_window: context.time_window,
  };
}

function concept(value: string, weight: number): ResearchSemanticConcept {
  return { value: boundedPhrase(value), synonyms: [], weight };
}

function uniquePhrases(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const normalized = boundedPhrase(value);
    if (!normalized || output.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) continue;
    output.push(normalized);
  }
  return output;
}

function keywordConcepts(value: string, limit: number): string[] {
  const tokens = wordTokens(value)
    .map((token) => token.toLocaleLowerCase())
    .filter((token) => (token.length > 2 || /\p{Script=Han}/u.test(token)) && !STOP_WORDS.has(token));
  const unique = [...new Set(tokens)];
  if (unique.length <= limit) return unique;
  return unique.slice(0, limit);
}

function compactConceptPhrase(value: string): string {
  const words = wordTokens(value);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word.toLocaleLowerCase()));
  return boundedPhrase((meaningful.length ? meaningful : words).slice(0, 4).join(" "));
}

function wordTokens(value: string): string[] {
  const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(value.normalize("NFKC"));
  return [...segments]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

function boundedPhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function includesPhrase(values: string[], candidate: string): boolean {
  const normalized = candidate.toLocaleLowerCase();
  return values.some((value) => value.toLocaleLowerCase() === normalized);
}

const STOP_WORDS = new Set([
  "about", "after", "also", "among", "and", "are", "can", "does", "for", "from", "have", "how",
  "into", "its", "should", "that", "the", "their", "these", "this", "through", "using", "what", "when",
  "where", "which", "with", "within", "would",
]);

export const RESEARCH_INTENT_OUTPUT_CONTRACT = {
  type: "json_schema",
  schema_id: "research_query.intent_plan.v1",
  strict: true,
  stage: "query_planning",
  schema: {
    type: "object",
    properties: {
      core: { type: "array", minItems: 1, maxItems: 4, items: conceptSchema() },
      expansions: { type: "array", maxItems: 8, items: conceptSchema() },
      qualifiers: { type: "array", maxItems: 8, items: conceptSchema() },
      exclusions: { type: "array", maxItems: 8, items: conceptSchema() },
    },
    required: ["core", "expansions", "qualifiers", "exclusions"],
    additionalProperties: false,
  },
} as const;

function conceptSchema() {
  return {
    type: "object",
    properties: {
      value: { type: "string", minLength: 1, maxLength: 80 },
      synonyms: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 80 } },
      weight: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["value", "synonyms", "weight"],
    additionalProperties: false,
  } as const;
}
