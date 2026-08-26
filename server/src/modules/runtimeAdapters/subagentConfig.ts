import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LocalCliRuntimeAdapterSpec } from "./specs.js";

export class RuntimeSubagentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSubagentConfigError";
  }
}

export async function ensureRuntimeSubagentsDisabled(
  spec: LocalCliRuntimeAdapterSpec,
  sandboxCwd: string,
): Promise<void> {
  const config = spec.subagent_disable_config;
  if (!config) {
    if (spec.subagent_disable_mechanism === "runtime_config") {
      throw new RuntimeSubagentConfigError(
        `Runtime adapter '${spec.adapter_type}' declares runtime-configurable subagent disablement without a materialization contract.`,
      );
    }
    return;
  }
  const path = configPath(spec, sandboxCwd);
  const document = await readJsonObject(path);
  setRequiredValue(document, config.deny_path, config.denied_value);
  for (const required of config.required_values ?? []) {
    setRequiredValue(document, required.path, required.value, required.value_mode);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function assertRuntimeSubagentsDisabled(
  spec: LocalCliRuntimeAdapterSpec,
  sandboxCwd: string | null,
): Promise<void> {
  const config = spec.subagent_disable_config;
  if (!config) {
    if (spec.subagent_disable_mechanism === "runtime_config") {
      throw new RuntimeSubagentConfigError(
        `Runtime adapter '${spec.adapter_type}' declares runtime-configurable subagent disablement without a materialization contract.`,
      );
    }
    return;
  }
  if (!sandboxCwd) {
    throw new RuntimeSubagentConfigError(
      `Runtime adapter '${spec.adapter_type}' requires a sandbox to enforce runtime subagent disablement.`,
    );
  }
  const path = configPath(spec, sandboxCwd);
  const document = await readJsonObject(path);
  if (!matchesRequiredValue(valueAtPath(document, config.deny_path), config.denied_value)) {
    throw new RuntimeSubagentConfigError(
      `Runtime adapter '${spec.adapter_type}' is missing its declared subagent disable configuration.`,
    );
  }
  for (const required of config.required_values ?? []) {
    if (!matchesRequiredValue(valueAtPath(document, required.path), required.value, required.value_mode)) {
      throw new RuntimeSubagentConfigError(
        `Runtime adapter '${spec.adapter_type}' is missing a required tool permission configuration.`,
      );
    }
  }
}

function configPath(spec: LocalCliRuntimeAdapterSpec, sandboxCwd: string): string {
  const path = resolve(sandboxCwd, spec.subagent_disable_config?.relative_path ?? "");
  const root = resolve(sandboxCwd);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new RuntimeSubagentConfigError("Runtime subagent configuration escapes the sandbox.");
  }
  return path;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RuntimeSubagentConfigError(`Runtime subagent configuration must be a JSON object: ${path}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    if (error instanceof RuntimeSubagentConfigError) throw error;
    throw new RuntimeSubagentConfigError(`Runtime subagent configuration is invalid: ${path}`);
  }
}

function valueAtPath(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setValueAtPath(value: Record<string, unknown>, path: string[], next: unknown): void {
  if (path.length === 0) throw new RuntimeSubagentConfigError("Runtime subagent deny path cannot be empty.");
  let current = value;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (!child || typeof child !== "object" || Array.isArray(child)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = next;
}

function setRequiredValue(
  document: Record<string, unknown>,
  path: string[],
  expected: string | number | boolean | Record<string, string>,
  mode: "array_contains" | "exact" | undefined = undefined,
): void {
  if (typeof expected !== "object") {
    if (mode === "exact") {
      setValueAtPath(document, path, expected);
      return;
    }
    if (typeof expected !== "string") {
      throw new RuntimeSubagentConfigError(
        "Non-string runtime configuration values require exact matching.",
      );
    }
    const existing = valueAtPath(document, path);
    const values = Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : [];
    if (!values.includes(expected)) values.push(expected);
    setValueAtPath(document, path, values);
    return;
  }
  const existing = valueAtPath(document, path);
  const merged = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>), ...expected }
    : expected;
  setValueAtPath(document, path, merged);
}

function matchesRequiredValue(
  actual: unknown,
  expected: string | number | boolean | Record<string, string>,
  mode: "array_contains" | "exact" | undefined = undefined,
): boolean {
  if (typeof expected !== "object") {
    return mode === "exact"
      ? actual === expected
      : typeof expected === "string" && Array.isArray(actual) && actual.includes(expected);
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => (actual as Record<string, unknown>)[key] === value);
}
