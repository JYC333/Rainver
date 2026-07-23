import type { ServerConfig } from "../../config";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import { HttpError, objectValue, optionalString } from "../routeUtils/common";
import { assertProjectWriter } from "../projects/access";
import { sourceItemReadableClause } from "../sources/sourceItemAccess";
import { resolvePrompt } from "../prompts/resolver";
import { resolveProviderCommandStore } from "../providers/commands/store";
import { completeProviderMessages } from "../providers/invocation/invocation";
import { ProjectResearchExecutionProfileService, type ResearchExecutionSelection } from "./executionProfileService";
import { RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT } from "./outputSchemas";
import { PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY } from "./promptRegistry";
import { ResearchContextRepository } from "./question/researchContextRepository";

export interface QuestionRefinementClarifyingQuestion {
  question: string;
  options: string[];
  allow_multiple: boolean;
}

export interface QuestionRefinementResult {
  research_context_version_id: string;
  assessment: {
    answerable: boolean;
    finer: { feasible: number; interesting: number; novel: number; ethical: number; relevant: number };
    issues: string[];
  };
  suggested_questions: string[];
  sub_questions: string[];
  scope: { in: string[]; out: string[] };
  clarifying_questions: QuestionRefinementClarifyingQuestion[];
}

type InvokeRefinement = (input: {
  spaceId: string;
  userId: string;
  projectId: string;
  providerId: string;
  model: string | null;
  instruction: string;
}) => Promise<Record<string, unknown>>;

let invokeRefinementOverride: InvokeRefinement | null = null;

export function __setQuestionRefineInvokerForTests(invoke: InvokeRefinement | null): void {
  invokeRefinementOverride = invoke;
}

export class ProjectResearchQuestionRefineService {
  private readonly invoke: InvokeRefinement;

  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
    invoke?: InvokeRefinement,
  ) {
    this.invoke = invoke ?? invokeRefinementOverride ?? (async (input) => {
      const response = await completeProviderMessages(resolveProviderCommandStore(config), input.spaceId, {
        provider_id: input.providerId,
        model: input.model,
        system: input.instruction,
        messages: [{ role: "user", content: "Refine the candidate research question using the supplied project context." }],
        max_tokens: 1800,
        task: "project_research_question_refine",
        output_format: RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT,
        metering: {
          subject_user_id: input.userId,
          source_type: "local_run",
          execution_channel: "managed_api",
          project_id: input.projectId,
          task: "project_research_question_refine",
        },
      });
      if (!response.structured_output) throw new HttpError(502, "Question refinement provider returned no structured output");
      return response.structured_output;
    });
  }

  async refine(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<QuestionRefinementResult> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const question = optionalString(body.research_question);
    if (!question) throw new HttpError(422, "research_question is required");
    const history = normalizeHistory(body.history);
    if (history.length > 4) throw new HttpError(422, "question refinement history supports at most three rounds");
    const executionBody = objectValue(body.execution);
    const selection: ResearchExecutionSelection = {
      modelProviderId: optionalString(executionBody.model_provider_id),
      modelName: optionalString(executionBody.model_name),
    };
    const execution = await new ProjectResearchExecutionProfileService(this.db, this.config).resolve(identity, selection);
    const project = await this.db.query<{ name: string; description: string | null }>(
      `SELECT name, description FROM projects WHERE id=$1 AND space_id=$2 AND status='active' LIMIT 1`,
      [projectId, identity.spaceId],
    );
    if (!project.rows[0]) throw new HttpError(404, "Project not found");
    const corpus = await this.db.query<{ count: string; titles: string[] | null }>(
      `SELECT count(DISTINCT pci.id)::text AS count,
              array_agg(si.title ORDER BY COALESCE(si.occurred_at, pci.created_at) DESC) FILTER (WHERE si.title IS NOT NULL) AS titles
         FROM project_corpus_items pci
         LEFT JOIN project_corpus_item_sources pcis
           ON pcis.corpus_item_id=pci.id AND pcis.space_id=pci.space_id
         LEFT JOIN source_items si ON si.id=pcis.source_item_id AND si.space_id=pcis.space_id AND si.deleted_at IS NULL
        WHERE pci.space_id=$1 AND pci.project_id=$2 AND pci.status='active'
          AND (si.id IS NULL OR ${sourceItemReadableClause("si", "$3", false)})`,
      [identity.spaceId, projectId, identity.userId],
    );
    const corpusSummary = `${Number(corpus.rows[0]?.count ?? 0)} active items; examples: ${(corpus.rows[0]?.titles ?? []).slice(0, 8).join(" | ") || "none"}`;
    const resolved = await resolvePrompt(this.db, {
      spaceId: identity.spaceId,
      userId: identity.userId,
      projectId,
      agentId: execution.agentId,
      assetKey: PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY,
      variables: {
        project_name: project.rows[0].name,
        project_description: project.rows[0].description ?? "none",
        corpus_summary: corpusSummary,
        research_question: question,
        conversation_history: history.length ? JSON.stringify(history) : "none",
      },
    });
    if (resolved.validation_errors.length > 0 || !resolved.rendered_text) {
      throw new HttpError(500, "Project Research question refinement prompt is not resolvable");
    }
    const output = await this.invoke({
      spaceId: identity.spaceId,
      userId: identity.userId,
      projectId,
      providerId: execution.modelProviderId,
      model: execution.modelName,
      instruction: resolved.rendered_text,
    });
    const result = normalizeResult(output);
    const contextVersion = await new ResearchContextRepository(this.db).create(identity, projectId, {
      schema_version: "research_context.v1",
      objective: question,
      sub_questions: result.sub_questions,
      in_scope: result.scope.in,
      out_of_scope: result.scope.out,
      must_have: [],
      nice_to_have: [],
      time_window: null,
      source_scope: {
        providers: ["arxiv", "openalex", "semantic_scholar", "web_search"],
        include_web: true,
      },
    }, {
      assessment: result.assessment,
      provenance: { source: "question_refinement", prompt_asset_key: PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY },
    });
    return { ...result, research_context_version_id: contextVersion.id };
  }
}

function normalizeHistory(value: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = objectValue(item);
    const role = optionalString(row.role);
    const content = optionalString(row.content);
    if ((role !== "user" && role !== "assistant") || !content) throw new HttpError(422, "history entries require role user|assistant and content");
    return { role, content };
  });
}

function normalizeResult(value: Record<string, unknown>): Omit<QuestionRefinementResult, "research_context_version_id"> {
  const assessment = objectValue(value.assessment);
  const finer = objectValue(assessment.finer);
  const scores = ["feasible", "interesting", "novel", "ethical", "relevant"] as const;
  const normalizedScores = Object.fromEntries(scores.map((key) => [key, score(finer[key])])) as Omit<QuestionRefinementResult, "research_context_version_id">["assessment"]["finer"];
  const suggested = strings(value.suggested_questions).slice(0, 3);
  if (typeof assessment.answerable !== "boolean" || suggested.length === 0) throw new HttpError(502, "Question refinement output is invalid");
  return {
    assessment: { answerable: assessment.answerable, finer: normalizedScores, issues: strings(assessment.issues) },
    suggested_questions: suggested,
    sub_questions: strings(value.sub_questions).slice(0, 10),
    scope: { in: boundedCriteria(objectValue(value.scope).in), out: boundedCriteria(objectValue(value.scope).out) },
    clarifying_questions: clarifyingQuestions(value.clarifying_questions),
  };
}

function clarifyingQuestions(value: unknown): QuestionRefinementClarifyingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((item) => {
    const record = objectValue(item);
    const question = optionalString(record.question);
    if (!question) throw new HttpError(502, "Question refinement clarifying question is invalid");
    return { question, options: strings(record.options).slice(0, 6), allow_multiple: record.allow_multiple === true };
  });
}

function score(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) throw new HttpError(502, "Question refinement FINER score is invalid");
  return value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function boundedCriteria(value: unknown): string[] {
  return strings(value).map((item) => item.length <= 200 ? item : `${item.slice(0, 199).trimEnd()}…`).slice(0, 10);
}
