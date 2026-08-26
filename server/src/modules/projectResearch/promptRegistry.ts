import type { PromptResolveResult } from "@agent-space/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { resolvePrompt } from "../prompts/resolver.js";
import type { ResearchScopeContext } from "./researchContext.js";

export const PROJECT_RESEARCH_SYNTHESIS_PROMPT_KEY = "project_research.synthesis";
export const PROJECT_RESEARCH_QUESTION_REFINE_PROMPT_KEY = "project_research.question_refine";
export const PROJECT_RESEARCH_QUESTION_SUBQUESTION_REPAIR_PROMPT_KEY = "project_research.question_subquestion_repair";
export const PROJECT_RESEARCH_SYNTHESIS_CRITIQUE_PROMPT_KEY = "project_research.synthesis_critique";
export const PROJECT_RESEARCH_EVIDENCE_CARD_PROMPT_KEY = "project_research.evidence_card";
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

export async function resolveProjectResearchEvidenceCardPrompt(
  db: Queryable,
  input: { spaceId: string; userId: string; projectId: string; agentId: string },
): Promise<ResolvedProjectResearchSynthesisPrompt> {
  const resolved = await resolvePrompt(db, {
    spaceId: input.spaceId,
    userId: input.userId,
    projectId: input.projectId,
    agentId: input.agentId,
    assetKey: PROJECT_RESEARCH_EVIDENCE_CARD_PROMPT_KEY,
    variables: { project_id: input.projectId },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_text) {
    throw new Error(`Evidence-card prompt is invalid: ${resolved.validation_errors.join("; ")}`);
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
    newMaterial: unknown[];
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
      new_material_json: JSON.stringify(input.newMaterial),
    },
  });
  if (resolved.validation_errors.length > 0 || !resolved.rendered_text) {
    throw new Error(`Monitoring comparison prompt is invalid: ${resolved.validation_errors.join("; ")}`);
  }
  return { instruction: resolved.rendered_text, resolveResult: resolved };
}
