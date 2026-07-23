import type { PromptResolveResult } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { Queryable } from "../routeUtils/common";
import { resolvePrompt } from "../prompts/resolver";
import type { ResearchScopeContext } from "./researchContext";

export const PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY = "project_research.synthesis";
export const PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY = "project_research.question_refine";
export const PROJECT_RESEARCH_SYNTHESIS_CRITIQUE_PROMPT_KEY = "project_research.synthesis_critique";
export const PROJECT_RESEARCH_PAPER_CARD_PROMPT_KEY = "project_research.paper_card";
export const PROJECT_RESEARCH_MONITOR_COMPARE_PROMPT_KEY = "project_research.monitor_compare";

export interface ResolvedProjectResearchSynthesisPrompt {
  instruction: string;
  resolveResult: PromptResolveResult;
}

export async function resolveProjectResearchSynthesisPrompt(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    projectId: string;
    agentId: string;
    researchQuestion: string;
    researchScope: ResearchScopeContext;
    reportDepth?: "quick" | "full";
    critiqueContext?: string;
  },
): Promise<ResolvedProjectResearchSynthesisPrompt | null> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    assetKey: PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY,
    variables: {
      project_id: input.projectId,
      research_question: input.researchQuestion,
      research_scope: JSON.stringify(input.researchScope),
      report_depth: input.reportDepth ?? "full",
      critique_context: input.critiqueContext ?? "none",
    },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_text) return null;
  return { instruction: resolved.rendered_text, resolveResult: resolved };
}

export async function resolveProjectResearchCritiquePrompt(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    projectId: string;
    agentId: string;
    researchQuestion: string;
    researchScope: ResearchScopeContext;
    reportDepth: "quick" | "full";
    report: Record<string, unknown>;
    corpusSummary: string;
  },
): Promise<ResolvedProjectResearchSynthesisPrompt | null> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    assetKey: PROJECT_RESEARCH_SYNTHESIS_CRITIQUE_PROMPT_KEY,
    variables: {
      project_id: input.projectId,
      research_question: input.researchQuestion,
      research_scope: JSON.stringify(input.researchScope),
      report_depth: input.reportDepth,
      report_json: JSON.stringify(input.report),
      corpus_summary: input.corpusSummary,
    },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_text) return null;
  return { instruction: resolved.rendered_text, resolveResult: resolved };
}

export async function resolveProjectResearchPaperCardPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; projectId: string; agentId: string },
): Promise<ResolvedProjectResearchSynthesisPrompt> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    assetKey: PROJECT_RESEARCH_PAPER_CARD_PROMPT_KEY,
    variables: { project_id: input.projectId },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_text) {
    throw new Error(`Paper-card prompt is invalid: ${resolved.validation_errors.join("; ")}`);
  }
  return { instruction: resolved.rendered_text, resolveResult: resolved };
}

export async function resolveProjectResearchMonitorComparePrompt(
  db: Queryable,
  input: {
    spaceId: string;
    userId: string;
    projectId: string;
    agentId: string;
    researchQuestion: string;
    currentUnderstanding: string;
    newPapers: unknown[];
  },
): Promise<ResolvedProjectResearchSynthesisPrompt> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    assetKey: PROJECT_RESEARCH_MONITOR_COMPARE_PROMPT_KEY,
    variables: {
      project_id: input.projectId,
      research_question: input.researchQuestion,
      current_understanding: input.currentUnderstanding || "No current understanding has been recorded yet.",
      new_papers_json: JSON.stringify(input.newPapers),
    },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_text) {
    throw new Error(`Monitoring comparison prompt is invalid: ${resolved.validation_errors.join("; ")}`);
  }
  return { instruction: resolved.rendered_text, resolveResult: resolved };
}
