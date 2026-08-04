import { SETTINGS_KEYS } from "../settings/keys";
import type { Queryable } from "./runRepositoryTypes";
import {
  contractRecord,
  resolveBudgetSources,
  type RunBudgetSource,
} from "./contractSnapshot";

export interface CanonicalBudgetAuthority {
  sources: RunBudgetSource[];
  effective: ReturnType<typeof resolveBudgetSources>["effective"];
  resolution: ReturnType<typeof resolveBudgetSources>["resolution"];
  ownership: Array<{
    source: RunBudgetSource["source"];
    authority: "space_setting" | "planning_run_snapshot" | "task_contract" | "workflow_version";
  }>;
}

/**
 * Loads only server-owned budget carriers. Agent tool input is intentionally
 * absent: a planning model may declare a Plan cap, but cannot manufacture an
 * inherited Space, Automation, Task, or Workflow authority.
 */
export async function loadCanonicalPlanBudgetAuthority(
  db: Queryable,
  input: {
    spaceId: string;
    sourceTaskId: string;
    planningRunId: string;
    referenceWorkflowVersionId?: string | null;
  },
): Promise<CanonicalBudgetAuthority> {
  const owned: CanonicalBudgetAuthority["ownership"] = [];
  const sources: RunBudgetSource[] = [];
  const space = await db.query<{ settings_json: unknown }>(
    `SELECT settings_json FROM settings
      WHERE scope_type = 'space' AND scope_id = $1 AND settings_key = $2
      LIMIT 1`,
    [input.spaceId, SETTINGS_KEYS.runBudgetSpace],
  );
  const spaceBudget = budgetFromRecord("space", input.spaceId, space.rows[0]?.settings_json);
  if (spaceBudget) {
    sources.push(spaceBudget);
    owned.push({ source: spaceBudget.source, authority: "space_setting" });
  }

  const planning = await db.query<{ contract_snapshot_json: unknown }>(
    `SELECT contract_snapshot_json FROM runs WHERE space_id = $1 AND id = $2 LIMIT 1`,
    [input.spaceId, input.planningRunId],
  );
  for (const source of snapshotSources(planning.rows[0]?.contract_snapshot_json)) {
    sources.push(source);
    owned.push({ source: source.source, authority: "planning_run_snapshot" });
  }

  const task = await db.query<{ contract_json: unknown }>(
    `SELECT jsonb_build_object(
              'max_runs', max_runs,
              'max_cost', max_cost,
              'max_duration_seconds', max_duration_seconds,
              'precedence', policy_json->'budget_precedence'
            ) AS contract_json
       FROM tasks
      WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
    [input.spaceId, input.sourceTaskId],
  );
  const taskBudget = budgetFromRecord("task", input.sourceTaskId, task.rows[0]?.contract_json);
  if (taskBudget) {
    sources.push(taskBudget);
    owned.push({ source: taskBudget.source, authority: "task_contract" });
  }

  if (input.referenceWorkflowVersionId) {
    const workflow = await db.query<{ content_json: unknown }>(
      `SELECT v.content_json
         FROM evolvable_asset_versions v
         JOIN evolvable_assets a ON a.id = v.asset_id
        WHERE v.id = $1 AND a.asset_type = 'workflow_template'
          AND v.status = 'approved'
          AND (v.space_id = $2 OR v.space_id IS NULL)
        LIMIT 1`,
      [input.referenceWorkflowVersionId, input.spaceId],
    );
    const workflowBudget = budgetFromRecord("workflow", input.referenceWorkflowVersionId, workflow.rows[0]?.content_json);
    if (workflowBudget) {
      sources.push(workflowBudget);
      owned.push({ source: workflowBudget.source, authority: "workflow_version" });
    }
  }

  const deduplicated = deduplicate(sources);
  const resolved = resolveBudgetSources(deduplicated);
  return { ...resolved, ownership: owned };
}

function snapshotSources(value: unknown): RunBudgetSource[] {
  const contract = contractRecord(value);
  const policy = objectValue(contract.policy_context_json);
  // Planning-specific inheritance is server-owned policy context, not the
  // planning Run's own budget pool. Reusing `budget_sources` here would count
  // the planning Run and the later Plan as two logical admissions.
  const inherited = policy.plan_budget_sources;
  const sources = Array.isArray(inherited) ? inherited : contract.budget_sources;
  return Array.isArray(sources) ? sources.filter(isBudgetSource) : [];
}

function budgetFromRecord(
  kind: RunBudgetSource["source"]["kind"],
  id: string,
  value: unknown,
): RunBudgetSource | null {
  const record = objectValue(value);
  const nested = objectValue(record.budget);
  const budget = Object.keys(nested).length > 0 ? nested : record;
  const source: RunBudgetSource = {
    source: { kind, id },
    precedence: nonNegativeInteger(budget.precedence),
    max_runs: positiveInteger(budget.max_runs),
    max_attempts: positiveInteger(budget.max_attempts),
    max_cost: nonNegativeNumber(budget.max_cost),
    max_duration_seconds: positiveNumber(budget.max_duration_seconds),
  };
  return ["max_runs", "max_attempts", "max_cost", "max_duration_seconds"]
    .some((key) => source[key as keyof RunBudgetSource] !== null)
    ? source
    : null;
}

function deduplicate(sources: RunBudgetSource[]): RunBudgetSource[] {
  const values = new Map<string, RunBudgetSource>();
  for (const source of sources) {
    values.set(`${source.source.kind}:${source.source.id ?? ""}`, source);
  }
  return [...values.values()];
}

function isBudgetSource(value: unknown): value is RunBudgetSource {
  const record = objectValue(value);
  const source = objectValue(record.source);
  return ["direct", "space", "task", "automation", "workflow", "delegation", "plan"].includes(String(source.kind))
    && (source.id === null || typeof source.id === "string");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
