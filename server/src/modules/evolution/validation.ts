import { EvolutionAssetRefusal } from "./assetRefusal.js";
import {
  optionalString,
} from "../routeUtils/common.js";
import type { EvolutionTargetRow } from "./types.js";

export function requiredBodyString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new EvolutionAssetRefusal(422, `${field} is required`);
  return text;
}

const TARGET_TYPES = new Set(["agent_version", "memory", "knowledge", "workflow", "project_folder", "system"]);

export function evolutionTargetType(value: unknown): string {
  const type = requiredBodyString(value, "target_type");
  if (!TARGET_TYPES.has(type)) throw new EvolutionAssetRefusal(422, "target_type is invalid");
  return type;
}

export function assertTargetRunnable(target: EvolutionTargetRow): void {
  if (!target.enabled) throw new EvolutionAssetRefusal(409, "Evolution target is disabled");
  if (target.status !== "active") throw new EvolutionAssetRefusal(409, "Evolution target is not active");
}

export function boundedRunMode(value: unknown): "dry_run" {
  const mode = optionalString(value) ?? "dry_run";
  if (mode === "dry_run") return mode;
  if (mode === "live") {
    throw new EvolutionAssetRefusal(422, "live evolution execution is not supported in v1; use dry_run");
  }
  throw new EvolutionAssetRefusal(422, "mode must be dry_run");
}
