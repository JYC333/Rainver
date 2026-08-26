import type {
  EvolutionExperienceCreateInput,
  EvolutionExperienceRow,
  EvolutionRunExperienceContext,
} from "./types.js";

export interface EvolutionRunEvaluationForSolidifier {
  id?: string | null;
  run_id: string;
  space_id: string;
  evaluator_version?: string | null;
  outcome_status: string;
  failure_layer?: string | null;
  failure_reason_code?: string | null;
  trajectory_status?: string | null;
  evidence_json?: unknown;
  rule_trace_json?: unknown;
  notes?: string | null;
  evaluated_at?: string | null;
}

export interface EvolutionExperienceRepositoryPort {
  // Returns null when a concurrent insert raced to the same (space_id, experience_key).
  // Callers must handle null by fetching the existing row via getExperienceByKey.
  createExperience(input: EvolutionExperienceCreateInput): Promise<EvolutionExperienceRow | null>;
  updateStrategyExperienceStats(strategyAssetId: string, outcomeStatus: string): Promise<void>;
  getExperienceByKey?(spaceId: string, experienceKey: string): Promise<EvolutionExperienceRow | null>;
  getRunExperienceContext?(spaceId: string, runId: string): Promise<EvolutionRunExperienceContext | null>;
}

export class EvolutionSolidifier {
  constructor(private readonly repository: EvolutionExperienceRepositoryPort) {}

  async solidifyExperience(input: EvolutionExperienceCreateInput): Promise<EvolutionExperienceRow> {
    const existing = await this.repository.getExperienceByKey?.(input.spaceId, input.experienceKey);
    if (existing) return existing;
    const created = await this.repository.createExperience(input);
    if (created) {
      if (input.strategyAssetId) {
        await this.repository.updateStrategyExperienceStats(input.strategyAssetId, input.outcomeStatus);
      }
      return created;
    }
    // Concurrent insert won the race — fetch what the other writer inserted.
    const concurrent = await this.repository.getExperienceByKey?.(input.spaceId, input.experienceKey);
    if (concurrent) return concurrent;
    throw new Error(`Failed to create or fetch experience with key ${input.experienceKey}`);
  }

  async solidifyFromRunEvaluation(
    evaluation: EvolutionRunEvaluationForSolidifier,
  ): Promise<EvolutionExperienceRow | null> {
    const context = await this.repository.getRunExperienceContext?.(evaluation.space_id, evaluation.run_id);
    if (!context) return null;
    const outcomeStatus = experienceOutcomeStatus(evaluation.outcome_status);
    return this.solidifyExperience({
      spaceId: evaluation.space_id,
      strategyAssetId: context.strategyAssetId,
      targetId: context.targetId,
      sourceRunId: evaluation.run_id,
      experienceKey: runExperienceKey(context, evaluation),
      summary: runExperienceSummary(context, evaluation, outcomeStatus),
      triggerSignals: context.inputSignalIds,
      outcomeStatus,
      confidenceScore: confidenceForOutcome(outcomeStatus),
      validationTrace: {
        run_evaluation_id: evaluation.id ?? null,
        outcome_status: evaluation.outcome_status,
        trajectory_status: evaluation.trajectory_status ?? null,
        failure_layer: evaluation.failure_layer ?? null,
        failure_reason_code: evaluation.failure_reason_code ?? null,
        rule_trace_json: evaluation.rule_trace_json ?? [],
      },
      executionTrace: {
        run_id: evaluation.run_id,
        evidence_json: evaluation.evidence_json ?? {},
      },
      lessons: evaluation.notes ? [evaluation.notes] : [],
      antiPatterns: evaluation.failure_reason_code ? [evaluation.failure_reason_code] : [],
      environmentFingerprint: {
        target_id: context.targetId,
        strategy_key: context.strategyKey,
      },
      provenanceType: "run_observed",
    });
  }

  // Key contract: experienceKey MUST use the prefix "proposal_accepted:{proposalId}"
  // (e.g. "proposal_accepted:abc123"). The run_observed path uses the format
  // "{strategyKey}/run/{runId}/{evaluatorVersion}", so a different prefix is required
  // to prevent the dedup guard in solidifyExperience from suppressing one of the two
  // distinct learning events that a single run+proposal pair produces.
  async solidifyFromAcceptedProposal(
    input: Omit<EvolutionExperienceCreateInput, "provenanceType">,
  ): Promise<EvolutionExperienceRow> {
    return this.solidifyExperience({ ...input, provenanceType: "proposal_accepted" });
  }

  async solidifyFromManualObservation(
    input: Omit<EvolutionExperienceCreateInput, "provenanceType">,
  ): Promise<EvolutionExperienceRow> {
    return this.solidifyExperience({ ...input, provenanceType: "user_authored" });
  }
}

function experienceOutcomeStatus(outcomeStatus: string): EvolutionExperienceCreateInput["outcomeStatus"] {
  if (outcomeStatus === "passed") return "success";
  if (outcomeStatus === "failed") return "failed";
  if (outcomeStatus === "partial") return "partial";
  return "unknown";
}

function confidenceForOutcome(outcomeStatus: EvolutionExperienceCreateInput["outcomeStatus"]): number {
  if (outcomeStatus === "success") return 0.7;
  if (outcomeStatus === "partial") return 0.55;
  if (outcomeStatus === "failed") return 0.6;
  return 0.4;
}

function runExperienceKey(
  context: EvolutionRunExperienceContext,
  evaluation: EvolutionRunEvaluationForSolidifier,
): string {
  const strategy = context.strategyKey ?? context.strategyAssetId ?? "unknown_strategy";
  const evaluationKey = evaluation.evaluator_version ?? "run_evaluation";
  return `${strategy}/run/${evaluation.run_id}/${evaluationKey}`.slice(0, 160);
}

function runExperienceSummary(
  context: EvolutionRunExperienceContext,
  evaluation: EvolutionRunEvaluationForSolidifier,
  outcomeStatus: EvolutionExperienceCreateInput["outcomeStatus"],
): string {
  const target = context.targetName ?? context.targetId ?? "evolution target";
  const strategy = context.strategyKey ?? "unknown strategy";
  const reason = evaluation.failure_reason_code ? ` (${evaluation.failure_reason_code})` : "";
  return `Run ${evaluation.run_id} produced ${outcomeStatus} experience for ${target} using ${strategy}${reason}.`;
}
