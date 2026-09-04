export const RUN_CONTRACT_VERSION = "run_contract.v1" as const;

export type RunContractSourceKind =
  | "direct"
  | "space"
  | "task"
  | "automation"
  | "workflow"
  | "delegation"
  | "plan";

export interface RunContractSource {
  kind: RunContractSourceKind;
  id: string | null;
}

export interface RunBudgetSource {
  source: RunContractSource;
  /** Higher values win when a source explicitly declares precedence. */
  precedence?: number | null;
  max_runs?: number | null;
  max_attempts?: number | null;
  max_cost?: number | null;
  max_duration_seconds?: number | null;
}

export interface EffectiveRunBudget {
  max_runs: number | null;
  max_attempts: number | null;
  max_cost: number | null;
  max_duration_seconds: number | null;
}

export interface RunBudgetResolution {
  mode: "explicit_precedence" | "strictest_of_all" | "none";
  selected_source_by_dimension: Record<keyof EffectiveRunBudget, RunContractSource | null>;
  declared_precedence_by_source: Array<{
    source: RunContractSource;
    precedence: number;
  }>;
}

export interface RunContractSnapshotInput {
  source: RunContractSource;
  project_id?: string | null;
  project_folder_id?: string | null;
  acceptance_criteria_json?: unknown;
  definition_of_done?: string | null;
  required_outputs_json?: unknown;
  structured_output_json?: unknown;
  risk_level?: string | null;
  max_runs?: number | null;
  max_attempts?: number | null;
  max_cost?: number | null;
  max_duration_seconds?: number | null;
  budget_precedence?: number | null;
  budget_sources?: RunBudgetSource[];
  workflow_input_json?: unknown;
  upstream_inputs_json?: unknown;
  attachment_manifest_json?: unknown;
  route_hints_json?: unknown;
  /** Server-owned policy facts captured by trusted internal run creators. */
  policy_context_json?: unknown;
}

export interface RunContractSnapshot {
  contract_version: typeof RUN_CONTRACT_VERSION;
  source: RunContractSource;
  project_id: string | null;
  project_folder_id: string | null;
  acceptance_criteria_json: unknown;
  definition_of_done: string | null;
  required_outputs_json: unknown;
  structured_output_json: unknown;
  risk_level: string | null;
  max_runs: number | null;
  max_attempts: number | null;
  max_cost: number | null;
  max_duration_seconds: number | null;
  budget_sources: RunBudgetSource[];
  effective_budget: EffectiveRunBudget;
  budget_resolution: RunBudgetResolution;
  workflow_input_json: unknown;
  upstream_inputs_json: unknown;
  attachment_manifest_json: unknown;
  route_hints_json: unknown;
  policy_context_json: unknown;
  created_at: string;
}

export function createRunContractSnapshot(
  input: RunContractSnapshotInput | undefined,
  createdAt: string,
): RunContractSnapshot {
  const source = input?.source ?? { kind: "direct" as const, id: null };
  const budgetSources = normalizeBudgetSources(input, source);
  const budget = resolveBudget(budgetSources);
  return {
    contract_version: RUN_CONTRACT_VERSION,
    source: {
      kind: source.kind,
      id: source.id ?? null,
    },
    project_id: input?.project_id ?? null,
    project_folder_id: input?.project_folder_id ?? null,
    acceptance_criteria_json: cloneJson(input?.acceptance_criteria_json),
    definition_of_done: input?.definition_of_done ?? null,
    required_outputs_json: cloneJson(input?.required_outputs_json),
    structured_output_json: cloneJson(input?.structured_output_json),
    risk_level: input?.risk_level ?? null,
    max_runs: budget.effective.max_runs,
    max_attempts: budget.effective.max_attempts,
    max_cost: budget.effective.max_cost,
    max_duration_seconds: budget.effective.max_duration_seconds,
    budget_sources: budget.sources,
    effective_budget: budget.effective,
    budget_resolution: budget.resolution,
    workflow_input_json: cloneJson(input?.workflow_input_json),
    upstream_inputs_json: cloneJson(input?.upstream_inputs_json),
    attachment_manifest_json: cloneJson(input?.attachment_manifest_json),
    route_hints_json: cloneJson(input?.route_hints_json),
    policy_context_json: cloneJson(input?.policy_context_json),
    created_at: createdAt,
  };
}

export function contractRecord(value: unknown): Partial<RunContractSnapshot> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Partial<RunContractSnapshot>;
}

export function contractRouteHints(value: unknown): unknown {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record) return null;
  return record.route_hints_json ?? record.route_hints ?? null;
}

/** Shared by every admission path (`PgTaskRepository.createTaskRun`, both branches) that reads a Task's `policy_json.budget_sources`. */
export function budgetSourcesFromPolicy(value: unknown): RunBudgetSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RunBudgetSource => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const source = (item as { source?: unknown }).source;
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;
    const kind = (source as { kind?: unknown }).kind;
    return kind === "direct"
      || kind === "task"
      || kind === "automation"
      || kind === "workflow"
      || kind === "delegation"
      || kind === "plan";
  });
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const BUDGET_DIMENSIONS: Array<keyof EffectiveRunBudget> = [
  "max_runs",
  "max_attempts",
  "max_cost",
  "max_duration_seconds",
];

function normalizeBudgetSources(
  input: RunContractSnapshotInput | undefined,
  source: RunContractSource,
): RunBudgetSource[] {
  const explicit = Array.isArray(input?.budget_sources)
    ? input!.budget_sources.map((item) => normalizeBudgetSource(item)).filter(Boolean) as RunBudgetSource[]
    : [];
  // Legacy callers provide the source and flat budget fields. Treat those
  // fields as one source so old task/automation/workflow creation paths get
  // the same deterministic resolution and audit metadata.
  const legacy: RunBudgetSource = {
    source: { kind: source.kind, id: source.id ?? null },
    precedence: finiteNumberOrNull(input?.budget_precedence),
    max_runs: positiveIntegerOrNull(input?.max_runs),
    max_attempts: positiveIntegerOrNull(input?.max_attempts),
    max_cost: nonNegativeNumberOrNull(input?.max_cost),
    max_duration_seconds: positiveNumberOrNull(input?.max_duration_seconds),
  };
  const hasLegacyValue = BUDGET_DIMENSIONS.some((dimension) => legacy[dimension] !== null && legacy[dimension] !== undefined);
  if (explicit.length === 0) return hasLegacyValue ? [legacy] : [];
  if (!hasLegacyValue) return explicit;
  return [legacy, ...explicit];
}

function normalizeBudgetSource(input: RunBudgetSource): RunBudgetSource | null {
  if (!input || !input.source || !isSourceKind(input.source.kind)) return null;
  const precedence = finiteNumberOrNull(input.precedence);
  return {
    source: { kind: input.source.kind, id: input.source.id ?? null },
    precedence: precedence !== null ? Math.max(0, Math.floor(precedence)) : null,
    max_runs: positiveIntegerOrNull(input.max_runs),
    max_attempts: positiveIntegerOrNull(input.max_attempts),
    max_cost: nonNegativeNumberOrNull(input.max_cost),
    max_duration_seconds: positiveNumberOrNull(input.max_duration_seconds),
  };
}

export function resolveBudgetSources(sources: RunBudgetSource[]): {
  sources: RunBudgetSource[];
  effective: EffectiveRunBudget;
  resolution: RunBudgetResolution;
} {
  return resolveBudget(
    sources.map((source) => normalizeBudgetSource(source)).filter(Boolean) as RunBudgetSource[],
  );
}

function resolveBudget(sources: RunBudgetSource[]): {
  sources: RunBudgetSource[];
  effective: EffectiveRunBudget;
  resolution: RunBudgetResolution;
} {
  const declaredPrecedence = sources
    .filter((source) => source.precedence !== null && source.precedence !== undefined)
    .map((source) => ({ source: source.source, precedence: source.precedence as number }));
  const hasExplicitPrecedence = declaredPrecedence.length > 0;
  const effective = {} as EffectiveRunBudget;
  const selected = {} as Record<keyof EffectiveRunBudget, RunContractSource | null>;
  for (const dimension of BUDGET_DIMENSIONS) {
    const candidates = sources.filter((source) => source[dimension] !== null && source[dimension] !== undefined);
    if (candidates.length === 0) {
      effective[dimension] = null;
      selected[dimension] = null;
      continue;
    }
    const explicit = candidates.filter((source) => source.precedence !== null && source.precedence !== undefined);
    const eligible = explicit.length > 0
      ? explicit.filter((source) => source.precedence === Math.max(...explicit.map((item) => item.precedence as number)))
      : candidates;
    // Caps are always strictest within the selected precedence tier. This
    // makes ties deterministic and prevents a second carrier from widening a
    // budget that the owner explicitly set.
    const winner = eligible.reduce((current, candidate) =>
      (candidate[dimension] as number) < (current[dimension] as number) ? candidate : current,
    );
    effective[dimension] = winner[dimension] as number;
    selected[dimension] = winner.source;
  }
  return {
    sources,
    effective,
    resolution: {
      mode: sources.length === 0 ? "none" : hasExplicitPrecedence ? "explicit_precedence" : "strictest_of_all",
      selected_source_by_dimension: selected,
      declared_precedence_by_source: declaredPrecedence,
    },
  };
}

function isSourceKind(value: unknown): value is RunContractSourceKind {
  return value === "direct" || value === "space" || value === "task" || value === "automation" || value === "workflow" || value === "delegation" || value === "plan";
}

function nonNegativeNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
