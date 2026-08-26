import type { ServerConfig } from "../../config.js";
import * as protocol from "@agent-space/protocol";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, objectValue, optionalString, requiredString, withQueryableTransaction } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { sourceItemReadableClause } from "../sources/sourceItemAccess.js";
import { resolvePrompt } from "../prompts/resolver.js";
import { resolveProviderCommandStore } from "../providers/commands/store.js";
import { completeProviderMessages } from "../providers/invocation/invocation.js";
import { ProjectResearchExecutionProfileService, type ResearchExecutionSelection } from "./executionProfileService.js";
import {
  RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT,
  RESEARCH_QUESTION_SUBQUESTION_REPAIR_OUTPUT_CONTRACT,
  type StructuredOutputContract,
} from "./outputSchemas.js";
import {
  PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY,
  PROJECT_RESEARCH_QUESTION_SUBQUESTION_REPAIR_PROMPT_KEY,
} from "./promptRegistry.js";
import type { ResearchContextVersion } from "./question/contracts.js";
import { ResearchContextRepository } from "./question/researchContextRepository.js";
import {
  ProjectResearchQuestionAssessmentRepository,
  type BegunQuestionAssessmentTurn,
  type QuestionAssessmentConversation,
} from "./questionAssessmentRepository.js";

export interface QuestionRefinementClarifyingQuestion {
  question: string;
  options: string[];
  allow_multiple: boolean;
}

export interface QuestionRefinementResult {
  research_context_version_id: string;
  reply: string;
  recommended_question: string;
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

export interface QuestionAssessmentConfirmation {
  id: string;
  version: number;
  question: string;
  assessment: Record<string, unknown>;
  scope: { in: string[]; out: string[] };
  sub_questions: string[];
  manually_adjusted: boolean;
  created_at: string;
}

type InvokeRefinement = (input: {
  spaceId: string;
  userId: string;
  projectId: string;
  providerId: string;
  model: string | null;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  task?: string;
  outputFormat?: StructuredOutputContract;
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
        system: input.system,
        messages: input.messages,
        task: input.task ?? "project_research_question_refine",
        output_format: input.outputFormat ?? RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT,
        cache_strategy: "conversation",
        metering: {
          subject_user_id: input.userId,
          source_type: "local_run",
          execution_channel: "managed_api",
          project_id: input.projectId,
          task: input.task ?? "project_research_question_refine",
        },
      });
      if (!response.structured_output) throw new HttpError(502, "Question refinement provider returned no structured output");
      return response.structured_output;
    });
  }

  async getConversation(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
  ): Promise<QuestionAssessmentConversation | null> {
    return new ProjectResearchQuestionAssessmentRepository(this.db).getConversation(identity, projectId, threadId);
  }

  async listConfirmations(
    identity: SpaceUserIdentity,
    projectId: string,
    threadId: string,
  ): Promise<QuestionAssessmentConfirmation[]> {
    const conversations = new ProjectResearchQuestionAssessmentRepository(this.db);
    await conversations.getConversation(identity, projectId, threadId);
    const versions = await new ResearchContextRepository(this.db)
      .listAssessmentConfirmations(identity.spaceId, projectId, threadId);
    return versions.map(confirmationFromContextVersion);
  }

  async confirm(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<QuestionRefinementResult & { confirmation: QuestionAssessmentConfirmation }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const threadId = requiredString(body.thread_id, "thread_id");
    const refinementInput = objectValue(body.refinement);
    const normalized = await normalizeResult(refinementInput);
    const manuallyAdjusted = body.manually_adjusted === true;
    const conversations = new ProjectResearchQuestionAssessmentRepository(this.db);
    const session = await conversations.getConversation(identity, projectId, threadId);
    if (!session) throw new HttpError(409, "Assess the question before confirming its framework");

    return withQueryableTransaction(this.db, async (db) => {
      const transactionConversations = new ProjectResearchQuestionAssessmentRepository(db);
      const currentContextVersionId = await transactionConversations.lockForConfirmation(identity, session.id);
      const contexts = new ResearchContextRepository(db);
      const latestConfirmation = (await contexts.listAssessmentConfirmations(
        identity.spaceId,
        projectId,
        threadId,
      ))[0];
      if (
        latestConfirmation
        && currentContextVersionId === latestConfirmation.id
        && sameConfirmationSnapshot(normalized, latestConfirmation)
      ) {
        return {
          ...normalized,
          research_context_version_id: latestConfirmation.id,
          confirmation: confirmationFromContextVersion(latestConfirmation),
        };
      }

      const contextVersion = await contexts.create(identity, projectId, {
        schema_version: "research_context.v1",
        objective: normalized.recommended_question,
        sub_questions: normalized.sub_questions,
        in_scope: normalized.scope.in,
        out_of_scope: normalized.scope.out,
        must_have: [],
        nice_to_have: [],
        time_window: null,
        source_scope: {
          providers: ["arxiv", "openalex", "semantic_scholar", "web_search"],
          include_web: true,
        },
      }, {
        assessment: normalized.assessment,
        provenance: {
          source: "question_assessment_confirmation",
          thread_id: threadId,
          assessment_session_id: session.id,
          manually_adjusted: manuallyAdjusted,
        },
      });
      const completed = { ...normalized, research_context_version_id: contextVersion.id };
      await transactionConversations.confirmFramework(identity, session.id, completed);
      return {
        ...completed,
        confirmation: confirmationFromContextVersion(contextVersion),
      };
    });
  }

  async refine(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<QuestionRefinementResult & { assessment_session: QuestionAssessmentConversation }> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const threadId = requiredString(body.thread_id, "thread_id");
    const message = requiredString(body.message, "message");
    const establishAssessmentBaseline = body.establish_assessment_baseline === true;
    if (message.length > 20_000) throw new HttpError(422, "message is too long");
    const question = optionalString(body.research_question);
    if (!question) throw new HttpError(422, "research_question is required");
    const executionBody = objectValue(body.execution);
    const selection: ResearchExecutionSelection = {
      modelProviderId: optionalString(executionBody.model_provider_id),
      modelName: optionalString(executionBody.model_name),
    };
    const execution = await new ProjectResearchExecutionProfileService(this.db, this.config).resolve(identity, selection);
    const project = await this.db.query<{ name: string; description: string | null; goal: string | null }>(
      `SELECT p.name, p.description, bv.goal
         FROM projects p
         LEFT JOIN project_brief_versions bv ON bv.id = p.active_brief_version_id AND bv.space_id = p.space_id
        WHERE p.id=$1 AND p.space_id=$2 AND p.status='active' LIMIT 1`,
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
    const conversations = new ProjectResearchQuestionAssessmentRepository(this.db);
    let turn: BegunQuestionAssessmentTurn | null = null;
    try {
      turn = await conversations.beginTurn(identity, projectId, threadId, message);
      const resolved = await resolvePrompt(this.db, {
        spaceId: identity.spaceId,
        userId: identity.userId,
        projectId,
        agentId: execution.agentId,
        assetKey: PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY,
        variables: {},
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
        system: resolved.rendered_text,
        messages: [
          ...turn.history,
          {
            role: "user",
            content: JSON.stringify({
              project_context: {
                name: project.rows[0].name,
                description: project.rows[0].description ?? null,
                goal: project.rows[0].goal ?? null,
                corpus_summary: corpusSummary,
              },
              candidate_research_question: question,
              message,
            }),
          },
        ],
      });
      const normalized = await normalizeResult(output, async ({ reply, subQuestions }) => {
        const overlongItems = subQuestions.flatMap((text, sourceIndex) =>
          text.length > 200 ? [{ source_index: sourceIndex, text }] : []
        );
        const overlongCount = overlongItems.length;
        const unchangedItemCount = subQuestions.length - overlongCount;
        const maxReplacementItems = 10 - unchangedItemCount;
        await conversations.appendTurnProgress(identity, turn!, {
          stage: "subquestion_repair",
          status: "detected",
          message: `${overlongCount} sub-question${overlongCount === 1 ? " exceeds" : "s exceed"} the 200-character limit, so the framework cannot be saved unchanged.`,
        });
        await conversations.appendTurnProgress(identity, turn!, {
          stage: "subquestion_repair",
          status: "running",
          message: "Sending a separate structured request to split the long items. Wording, FINER scores, scope, and clarifications will remain unchanged.",
        });
        try {
          const repairPrompt = await resolvePrompt(this.db, {
            spaceId: identity.spaceId,
            userId: identity.userId,
            projectId,
            agentId: execution.agentId,
            assetKey: PROJECT_RESEARCH_QUESTION_SUBQUESTION_REPAIR_PROMPT_KEY,
            variables: {},
          });
          if (repairPrompt.validation_errors.length > 0 || !repairPrompt.rendered_text) {
            throw new Error("Question sub-question repair prompt is not resolvable");
          }
          const repaired = await this.invoke({
            spaceId: identity.spaceId,
            userId: identity.userId,
            projectId,
            providerId: execution.modelProviderId,
            model: execution.modelName,
            system: repairPrompt.rendered_text,
            messages: [{
              role: "user",
              content: JSON.stringify({
                latest_user_message: message,
                original_reply: reply,
                overlong_items: overlongItems,
                unchanged_item_count: unchangedItemCount,
                max_replacement_items: maxReplacementItems,
              }),
            }],
            task: "project_research_question_subquestion_repair",
            outputFormat: RESEARCH_QUESTION_SUBQUESTION_REPAIR_OUTPUT_CONTRACT,
          });
          const repairedReply = requiredOutputString(repaired.reply, "Question sub-question repair reply is invalid");
          if (!Array.isArray(repaired.repairs)) {
            throw new Error("Question sub-question repair returned no repair mappings");
          }
          const expectedIndexes = new Set(overlongItems.map(item => item.source_index));
          const replacementsByIndex = new Map<number, string[]>();
          for (const value of repaired.repairs) {
            const repair = objectValue(value);
            const sourceIndex = repair.source_index;
            if (!Number.isInteger(sourceIndex) || !expectedIndexes.has(sourceIndex as number)) {
              throw new Error("Question sub-question repair returned an unexpected source index");
            }
            if (replacementsByIndex.has(sourceIndex as number)) {
              throw new Error("Question sub-question repair returned a duplicate source index");
            }
            const replacements = strings(repair.replacements);
            if (replacements.length === 0) {
              throw new Error("Question sub-question repair returned an empty replacement list");
            }
            if (replacements.some(question => question.length > 200)) {
              throw new Error("Question sub-question repair still contains an overlong item");
            }
            replacementsByIndex.set(sourceIndex as number, replacements);
          }
          if (replacementsByIndex.size !== overlongItems.length) {
            throw new Error("Question sub-question repair did not repair every overlong item");
          }
          const replacementCount = [...replacementsByIndex.values()].reduce((count, items) => count + items.length, 0);
          if (replacementCount > maxReplacementItems) {
            throw new Error("Question sub-question repair exceeds the available list capacity");
          }
          const repairedSubQuestions = subQuestions.flatMap((question, sourceIndex) =>
            replacementsByIndex.get(sourceIndex) ?? [question]
          );
          if (repairedSubQuestions.length > 10) {
            throw new Error("Question sub-question repair exceeds the supported list length");
          }
          await conversations.appendTurnProgress(identity, turn!, {
            stage: "subquestion_repair",
            status: "completed",
            message: `Repair complete: ${overlongCount} overlong item${overlongCount === 1 ? " was" : "s were"} replaced by ${replacementCount} concise sub-question${replacementCount === 1 ? "" : "s"}; the final list contains ${repairedSubQuestions.length}. Validating and saving the framework.`,
          });
          return { reply: repairedReply, subQuestions: repairedSubQuestions };
        } catch (error) {
          await conversations.appendTurnProgress(identity, turn!, {
            stage: "subquestion_repair",
            status: "failed",
            message: "The separate repair request did not produce a valid sub-question list. The framework was not saved.",
          }).catch(() => {});
          throw error;
        }
      });
      const result = await withQueryableTransaction(this.db, async (db) => {
        const contextVersion = await new ResearchContextRepository(db).create(identity, projectId, {
          schema_version: "research_context.v1",
          objective: normalized.recommended_question,
          sub_questions: normalized.sub_questions,
          in_scope: normalized.scope.in,
          out_of_scope: normalized.scope.out,
          must_have: [],
          nice_to_have: [],
          time_window: null,
          source_scope: {
            providers: ["arxiv", "openalex", "semantic_scholar", "web_search"],
            include_web: true,
          },
        }, {
          assessment: normalized.assessment,
          provenance: { source: "question_refinement", prompt_asset_key: PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY },
        });
        const completed = { ...normalized, research_context_version_id: contextVersion.id };
        await new ProjectResearchQuestionAssessmentRepository(db).completeTurn(
          identity,
          turn!,
          completed,
          establishAssessmentBaseline,
        );
        return completed;
      });
      return {
        ...result,
        assessment_session: await conversations.conversationById(identity.spaceId, turn.sessionId),
      };
    } catch (error) {
      if (turn) await conversations.failTurn(identity, turn).catch(() => {});
      throw error;
    }
  }
}

function confirmationFromContextVersion(
  version: ResearchContextVersion,
): QuestionAssessmentConfirmation {
  return {
    id: version.id,
    version: version.version,
    question: version.context.objective,
    assessment: version.assessment,
    scope: { in: version.context.in_scope, out: version.context.out_of_scope },
    sub_questions: version.context.sub_questions,
    manually_adjusted: version.provenance.manually_adjusted === true,
    created_at: version.created_at,
  };
}

function sameConfirmationSnapshot(
  refinement: Omit<QuestionRefinementResult, "research_context_version_id">,
  version: ResearchContextVersion,
): boolean {
  return refinement.recommended_question.trim() === version.context.objective.trim()
    && sameStringItems(refinement.scope.in, version.context.in_scope)
    && sameStringItems(refinement.scope.out, version.context.out_of_scope)
    && sameStringItems(refinement.sub_questions, version.context.sub_questions);
}

function sameStringItems(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

async function normalizeResult(
  value: Record<string, unknown>,
  repairSubQuestions?: (input: { reply: string; subQuestions: string[] }) => Promise<{ reply: string; subQuestions: string[] }>,
): Promise<Omit<QuestionRefinementResult, "research_context_version_id">> {
  const assessment = objectValue(value.assessment);
  const finer = objectValue(assessment.finer);
  const scores = ["feasible", "interesting", "novel", "ethical", "relevant"] as const;
  const normalizedScores = Object.fromEntries(scores.map((key) => [key, score(finer[key])])) as Omit<QuestionRefinementResult, "research_context_version_id">["assessment"]["finer"];
  const suggested = strings(value.suggested_questions).slice(0, 3);
  if (typeof assessment.answerable !== "boolean" || suggested.length === 0) throw new HttpError(502, "Question refinement output is invalid");
  const normalized = {
    reply: requiredOutputString(value.reply, "Question refinement reply is invalid"),
    recommended_question: requiredOutputString(value.recommended_question, "Question refinement recommended question is invalid"),
    assessment: { answerable: assessment.answerable, finer: normalizedScores, issues: strings(assessment.issues) },
    suggested_questions: suggested,
    sub_questions: strings(value.sub_questions).slice(0, 10),
    scope: { in: boundedCriteria(objectValue(value.scope).in), out: boundedCriteria(objectValue(value.scope).out) },
    clarifying_questions: clarifyingQuestions(value.clarifying_questions),
  };
  const parsed = protocol.ProjectResearchQuestionRefinementSchema.safeParse(normalized);
  if (!parsed.success && repairSubQuestions && normalized.sub_questions.some((question) => question.length > 200)) {
    try {
      const repaired = await repairSubQuestions({
        reply: normalized.reply,
        subQuestions: normalized.sub_questions,
      });
      return await normalizeResult({
        ...normalized,
        reply: repaired.reply,
        sub_questions: repaired.subQuestions,
      });
    } catch (error) {
      throw new HttpError(502, "Question refinement sub-question repair failed", {
        code: "question_refinement_repair_failed",
        message: "The model could not split the overlong sub-questions into supported lengths.",
        diagnostics: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  if (!parsed.success) {
    throw new HttpError(502, "Question refinement output exceeds supported limits", {
      code: "question_refinement_output_invalid",
      message: "The model returned a question-assessment field outside the supported limits.",
      diagnostics: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

function requiredOutputString(value: unknown, message: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new HttpError(502, message);
  return normalized;
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
