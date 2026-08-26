import {
  HttpError,
  optionalString,
  stringArray,
} from "../routeUtils/common.js";
import type { EvolutionTargetRow } from "./types.js";

export function requiredBodyString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new HttpError(422, `${field} is required`);
  return text;
}

export function optionalStringArray(value: unknown): string[] {
  return stringArray(value).filter((item) => item.length > 0);
}

export function assertTargetRunnable(target: EvolutionTargetRow): void {
  if (!target.enabled) throw new HttpError(409, "Evolution target is disabled");
  if (target.status !== "active") throw new HttpError(409, "Evolution target is not active");
}

export function boundedRunMode(value: unknown): "dry_run" {
  const mode = optionalString(value) ?? "dry_run";
  if (mode === "dry_run") return mode;
  if (mode === "live") {
    throw new HttpError(422, "live evolution execution is not supported in v1; use dry_run");
  }
  throw new HttpError(422, "mode must be dry_run");
}
