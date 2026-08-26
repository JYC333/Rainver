import { objectValue } from "../routeUtils/common.js";
import {
  confidenceScore,
  strategyRiskRank,
  strategySignals,
} from "./strategyAssets.js";
import type {
  EvolutionSelection,
  EvolutionSignalRow,
  EvolutionStrategyAssetRow,
  EvolutionTargetRow,
} from "./types.js";

interface EvolutionSelectorInput {
  target: EvolutionTargetRow;
  signals: EvolutionSignalRow[];
  strategies: EvolutionStrategyAssetRow[];
}

interface ScoredStrategy {
  strategy: EvolutionStrategyAssetRow;
  score: number;
  matchedSignals: string[];
  targetCompatibility: number;
}

export class EvolutionSelector {
  select(input: EvolutionSelectorInput): EvolutionSelection {
    const inputSignalTypes = input.signals.map((signal) => signal.signal_type);
    const inputSignalIds = input.signals.map((signal) => signal.id);
    const rejectedReasons: Array<Record<string, unknown>> = [];
    const scored: ScoredStrategy[] = [];
    const scoreTrace: Record<string, unknown> = {};

    for (const strategy of input.strategies) {
      if (strategy.status !== "active") {
        rejectedReasons.push(reject(strategy, "strategy_disabled"));
        continue;
      }
      const categoryRejection = categoryPolicyRejection(input.target, strategy);
      if (categoryRejection) {
        rejectedReasons.push(reject(strategy, categoryRejection));
        continue;
      }
      const riskRejection = riskPolicyRejection(input.target, strategy);
      if (riskRejection) {
        rejectedReasons.push(reject(strategy, riskRejection));
        continue;
      }
      const targetCompatibility = targetCompatibilityScore(input.target.target_type, strategy.target_type);
      if (targetCompatibility <= 0) {
        rejectedReasons.push(reject(strategy, "target_type_not_compatible"));
        continue;
      }

      const matches = strategySignals(strategy).filter((signalType) => inputSignalTypes.includes(signalType));
      const signalScore = inputSignalTypes.length === 0
        ? 0.1
        : Math.min(1, matches.length / Math.max(1, inputSignalTypes.length));
      const score = (targetCompatibility * 0.35) + (signalScore * 0.45) + (confidenceScore(strategy) * 0.2);
      scored.push({ strategy, score, matchedSignals: matches, targetCompatibility });
      scoreTrace[strategy.id] = {
        strategy_key: strategy.strategy_key,
        score,
        matched_signal_types: matches,
        target_compatibility: targetCompatibility,
        confidence_score: confidenceScore(strategy),
      };
    }

    scored.sort((a, b) =>
      b.score - a.score
      || confidenceScore(b.strategy) - confidenceScore(a.strategy)
      || a.strategy.strategy_key.localeCompare(b.strategy.strategy_key),
    );
    const selected = scored[0]?.strategy ?? null;
    return {
      selectedStrategy: selected,
      candidateStrategyIds: scored.map((candidate) => candidate.strategy.id),
      inputSignalIds,
      decisionReason: selected
        ? `Selected ${selected.strategy_key} from ${scored.length} compatible active strategies.`
        : "No compatible active strategy passed selector policy.",
      scoreTrace,
      rejectedReasons,
    };
  }
}

function targetCompatibilityScore(targetType: string, strategyTargetType: string): number {
  if (strategyTargetType === targetType) return 1;
  if (strategyTargetType === "system") return 0.55;
  return 0;
}

function categoryPolicyRejection(
  target: EvolutionTargetRow,
  strategy: EvolutionStrategyAssetRow,
): string | null {
  const enginePolicy = objectValue(target.engine_policy_json);
  const allowedCategories = enginePolicy.allowed_strategy_categories;
  if (!Array.isArray(allowedCategories) || allowedCategories.length === 0) return null;
  if (!allowedCategories.includes(strategy.category)) {
    return "strategy_category_not_in_target_policy";
  }
  return null;
}

function riskPolicyRejection(
  target: EvolutionTargetRow,
  strategy: EvolutionStrategyAssetRow,
): string | null {
  if (strategy.risk_level === "critical") return "critical_strategy_requires_manual_policy";
  const enginePolicy = objectValue(target.engine_policy_json);
  const configuredCeiling = typeof enginePolicy.max_strategy_risk === "string"
    ? enginePolicy.max_strategy_risk
    : null;
  const ceiling = configuredCeiling ?? target.risk_level ?? "medium";
  if (strategyRiskRank(strategy.risk_level) > strategyRiskRank(ceiling)) {
    return "strategy_risk_exceeds_target_policy";
  }
  return null;
}

function reject(strategy: EvolutionStrategyAssetRow, reason: string): Record<string, unknown> {
  return {
    strategy_asset_id: strategy.id,
    strategy_key: strategy.strategy_key,
    reason,
  };
}
