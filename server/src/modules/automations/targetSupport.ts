import type { PoolClient } from "../../db/pool.js";
import { lockActiveProjectForMutation } from "../projects/access.js";
import { assertBudgetSourcesAvailable } from "../runs/budgetEnforcement.js";
import {
  contractRouteHints,
  type RunBudgetSource,
} from "../runs/contractSnapshot.js";
import type { AutomationRow } from "./repository.js";

const AUTOMATION_SCHEDULE_HANDLED = Symbol("automation_schedule_handled");
const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

type ScheduleHandledError = Error & { [AUTOMATION_SCHEDULE_HANDLED]?: true };

export function markAutomationScheduleHandled(
  error: unknown,
  fallbackMessage = "Automation target execution failed",
): Error {
  const marked: ScheduleHandledError = error instanceof Error
    ? (error as ScheduleHandledError)
    : (new Error(fallbackMessage) as ScheduleHandledError);
  marked[AUTOMATION_SCHEDULE_HANDLED] = true;
  return marked;
}

export function automationScheduleWasHandled(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && (error as Partial<ScheduleHandledError>)[AUTOMATION_SCHEDULE_HANDLED],
  );
}

export function automationContract(auto: AutomationRow) {
  const config = recordValue(auto.config_json);
  const declared = recordValue(config.contract_json ?? config.contract);
  const value = (key: string): unknown => declared[key] ?? config[key] ?? null;
  const definitionOfDone = value("definition_of_done");
  return {
    source: { kind: "automation" as const, id: auto.id },
    project_id: auto.project_id,
    project_folder_id: auto.project_folder_id,
    acceptance_criteria_json: value("acceptance_criteria_json"),
    definition_of_done: typeof definitionOfDone === "string" ? definitionOfDone : null,
    required_outputs_json: value("required_outputs_json"),
    risk_level: normalizeRiskLevel(value("risk_level")),
    max_runs: positiveIntegerOrNull(value("max_runs")),
    max_attempts: positiveIntegerOrNull(value("max_attempts")),
    max_cost: nonNegativeNumberOrNull(value("max_cost")),
    max_duration_seconds: positiveIntegerOrNull(value("max_duration_seconds")),
    budget_precedence: nonNegativeNumberOrNull(value("budget_precedence")),
    route_hints_json: contractRouteHints(declared) ?? contractRouteHints(config),
  };
}

export function automationBudgetSource(auto: AutomationRow): RunBudgetSource {
  const contract = automationContract(auto);
  return {
    source: { kind: "automation", id: auto.id },
    precedence: contract.budget_precedence,
    max_runs: contract.max_runs,
    max_attempts: contract.max_attempts,
    max_cost: contract.max_cost,
    max_duration_seconds: contract.max_duration_seconds,
  };
}

export async function lockAndCheckAutomationBudget(
  client: PoolClient,
  auto: AutomationRow,
): Promise<void> {
  if (auto.project_id) {
    await lockActiveProjectForMutation(client, auto.space_id, auto.project_id);
  }
  await client.query(
    `SELECT id FROM automations WHERE space_id = $1 AND id = $2 FOR UPDATE`,
    [auto.space_id, auto.id],
  );
  const source = automationBudgetSource(auto);
  if (source.max_runs === null || source.max_runs === undefined) return;
  await assertBudgetSourcesAvailable(client, auto.space_id, [source]);
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRiskLevel(value: unknown): string {
  return typeof value === "string" && VALID_RISK_LEVELS.has(value) ? value : "medium";
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
