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

/**
 * Whose work a fire is, and under which origin it runs
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §5, D1).
 *
 * A manual fire that carries the person's own prompt is that person asking in
 * the moment: the Run is theirs, `manual`, exactly as if they had started it
 * from the Agent. A fire with nothing supplied runs the automation's own
 * configured prompt, which is the owner's work whoever pressed the button —
 * an admin or Project writer may fire another member's automation — so the Run
 * is stamped as the schedule would have stamped it. Who pressed it stays in
 * `automation_runs.triggered_by_user_id`.
 *
 * The distinction is load-bearing: the responsible person is what decides a
 * persona write, so an automation firing with nobody's prompt must not be
 * attributed to the person who merely set it running.
 *
 * Decided **once** per fire and carried to everything that judges that Run —
 * the preflight's policy checks as much as the Run row — so no second place
 * asserts an origin of its own and reaches a different answer about one fire.
 */
export interface FireResponsibility {
  triggerOrigin: "manual" | "automation";
  instructedByUserId: string;
}

export function fireResponsibility(
  auto: AutomationRow,
  input: { actorUserId: string; prompt?: string | null; instruction?: string | null },
  triggerType: string,
): FireResponsibility {
  const supplied = (value: string | null | undefined): boolean => typeof value === "string" && value.trim().length > 0;
  return triggerType === "manual" && (supplied(input.prompt) || supplied(input.instruction))
    ? { triggerOrigin: "manual", instructedByUserId: input.actorUserId }
    : { triggerOrigin: "automation", instructedByUserId: auto.owner_user_id };
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
