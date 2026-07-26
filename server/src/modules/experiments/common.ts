import { posix as pathPosix } from "node:path";
import { HttpError } from "../routeUtils/common";

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

export function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function enumValue(value: unknown, allowed: Set<string>, field = "value"): string | null {
  const text = typeof value === "string" && value.trim() ? value.trim() : null;
  if (!text) return null;
  if (!allowed.has(text)) throw new HttpError(422, `${field} must be one of ${[...allowed].join(", ")}`);
  return text;
}

/** Rejects overlap between the editable and protected scope declarations — a path cannot be both or nested under both. */
export function scopePathArray(value: unknown, field: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of stringArray(value)) {
    if (raw.includes("\0") || raw.includes("\\") || /^[A-Za-z]:/.test(raw) || pathPosix.isAbsolute(raw)) {
      throw new HttpError(422, `${field} entries must be relative POSIX Project Folder paths`);
    }
    const normalized = pathPosix.normalize(raw);
    if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      throw new HttpError(422, `${field} entries must stay inside the Project Folder`);
    }
    if (normalized.includes("*")) {
      throw new HttpError(422, `${field} entries must be literal files or directories, not glob patterns`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return paths;
}

function scopeContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export function assertScopesDoNotOverlap(editable: string[], protectedPaths: string[]): void {
  for (const editablePath of editable) {
    for (const protectedPath of protectedPaths) {
      if (scopeContains(editablePath, protectedPath) || scopeContains(protectedPath, editablePath)) {
        throw new HttpError(422, `Path '${editablePath}' overlaps protected scope '${protectedPath}'`);
      }
    }
  }
}

export function managedScopeViolation(
  changedPaths: string[],
  editable: string[],
  protectedPaths: string[],
): string | null {
  for (const path of changedPaths) {
    const normalized = scopePathArray([path], "changed path")[0]!;
    if (protectedPaths.some(protectedPath => scopeContains(protectedPath, normalized))) {
      return `Changed protected path '${normalized}'`;
    }
    if (!editable.some(editablePath => scopeContains(editablePath, normalized))) {
      return `Changed path '${normalized}' outside editable scope`;
    }
  }
  return null;
}

export const EXECUTOR_TYPES = new Set(["manual", "managed_code_comparison"]);

function positiveIntegerOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(422, `${field} must be a positive integer`);
  }
  return value;
}

/** Validates and normalizes a managed_code_comparison Version's config_json; a no-op shape check for "manual". */
export function normalizeExecutorConfig(executorType: string, config: Record<string, unknown>): Record<string, unknown> {
  if (executorType !== "managed_code_comparison") return {};
  const projectFolderId = typeof config.project_folder_id === "string" && config.project_folder_id.trim() ? config.project_folder_id.trim() : null;
  if (!projectFolderId) throw new HttpError(422, "config.project_folder_id is required for managed_code_comparison");
  const editableScope = scopePathArray(config.editable_scope, "config.editable_scope");
  const protectedScope = scopePathArray(config.protected_scope, "config.protected_scope");
  assertScopesDoNotOverlap(editableScope, protectedScope);
  return {
    project_folder_id: projectFolderId,
    editable_scope: editableScope,
    protected_scope: protectedScope,
    setup_commands: stringArray(config.setup_commands),
    run_command: typeof config.run_command === "string" ? config.run_command : null,
    metric_parser: config.metric_parser && typeof config.metric_parser === "object" ? config.metric_parser : {},
    time_budget_seconds: positiveIntegerOrNull(config.time_budget_seconds, "config.time_budget_seconds"),
    timeout_seconds: positiveIntegerOrNull(config.timeout_seconds, "config.timeout_seconds"),
    resource_budget: config.resource_budget && typeof config.resource_budget === "object" ? config.resource_budget : {},
  };
}
