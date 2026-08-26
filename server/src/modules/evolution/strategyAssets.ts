import {
  dateIso,
  objectValue,
  stringArray,
} from "../routeUtils/common.js";
import type { EvolutionStrategyAssetRow } from "./types.js";

export function strategyAssetToOut(row: EvolutionStrategyAssetRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    strategy_key: row.strategy_key,
    name: row.name,
    description: row.description,
    category: row.category,
    target_type: row.target_type,
    status: row.status,
    risk_level: row.risk_level,
    signals_match: stringArray(row.signals_match_json),
    preconditions_json: objectValue(row.preconditions_json),
    strategy_steps: stringArray(row.strategy_steps_json),
    constraints: stringArray(row.constraints_json),
    validation_policy_json: objectValue(row.validation_policy_json),
    tool_policy_json: objectValue(row.tool_policy_json),
    routing_hint_json: objectValue(row.routing_hint_json),
    provenance_type: row.provenance_type,
    source_ref_json: objectValue(row.source_ref_json),
    success_count: Number(row.success_count ?? 0),
    failure_count: Number(row.failure_count ?? 0),
    confidence_score: Number(row.confidence_score ?? 0),
    last_selected_at: dateIso(row.last_selected_at),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function strategySignals(row: EvolutionStrategyAssetRow): string[] {
  return stringArray(row.signals_match_json);
}

export function strategyRiskRank(risk: string | null | undefined): number {
  if (risk === "critical") return 4;
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

export function confidenceScore(row: EvolutionStrategyAssetRow): number {
  const parsed = Number(row.confidence_score ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
