import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import {
  AgentGroupRunService,
  type AgentGroupIdentity,
  type SpawnChildRunInput,
} from "../agentGroups/service";
import { PgAgentGroupRepository } from "../agentGroups/repository";
import { PgRunRepository, type RunRecord } from "./repository";

const AGENT_DELEGATE_TOOL = "agent.delegate";
const AGENT_WAIT_FOR_RESULTS_TOOL = "agent.wait_for_results";

export interface AgentDelegationTarget {
  agent_id: string;
  name: string;
  role: string;
  capabilities_json?: Record<string, unknown> | null;
}

export interface AgentDelegationToolBinding {
  targets: AgentDelegationTarget[];
  toolDefinitions: CanonicalToolDefinition[];
  toolBindings: RuntimeHostExecuteRequest["tool_bindings"];
  service: Pick<AgentGroupRunService, "spawnChildRun"> & Partial<Pick<AgentGroupRunService, "preflightSpawnChildRunPolicy" | "spawnChildRunAuthorized">>;
  pool: Pool | null;
}

export interface AgentDelegationToolDeps {
  pool?: Pool;
  service?: Pick<AgentGroupRunService, "spawnChildRun"> & Partial<Pick<AgentGroupRunService, "preflightSpawnChildRunPolicy" | "spawnChildRunAuthorized">>;
  targets?: AgentDelegationTarget[] | null;
}

export async function resolveAgentDelegationToolBinding(
  config: ServerConfig,
  run: RunRecord,
  deps: AgentDelegationToolDeps = {},
): Promise<AgentDelegationToolBinding | null> {
  if (!run.run_group_id || !run.root_run_id || !run.instructed_by_user_id) return null;
  let sharedPool = deps.pool;
  const pool = (): Pool => {
    sharedPool ??= getDbPool(requiredDatabaseUrl(config));
    return sharedPool;
  };
  const targets = deps.targets ?? await loadDelegationTargets(config, run, pool());
  const service = deps.service ?? new AgentGroupRunService(config, pool());
  return {
    targets,
    service,
    pool: sharedPool ?? null,
    toolDefinitions: [
      ...(targets.length > 0 ? [agentDelegateToolDefinition(targets)] : []),
      agentWaitForResultsToolDefinition(targets),
    ],
    toolBindings: [
      ...(targets.length > 0 ? [{
        id: AGENT_DELEGATE_TOOL,
        external_type: "internal",
        external_ref: AGENT_DELEGATE_TOOL,
        display_name: "Delegate to agent",
        required_scopes: ["run.spawn_child"],
        credential_ref: null,
        data_exposure_level: "model_provider",
        observability_level: "structured_events",
        side_effect_level: "queued_child_run",
        approval_required: false,
      }] : []),
      {
        id: AGENT_WAIT_FOR_RESULTS_TOOL,
        external_type: "internal",
        external_ref: AGENT_WAIT_FOR_RESULTS_TOOL,
        display_name: "Wait for agent results",
        required_scopes: ["run.read"],
        credential_ref: null,
        data_exposure_level: "model_provider",
        observability_level: "structured_events",
        side_effect_level: "pause_current_run",
        approval_required: false,
      },
    ],
  };
}

function agentDelegateToolDefinition(targets: readonly AgentDelegationTarget[]): CanonicalToolDefinition {
  return {
      name: AGENT_DELEGATE_TOOL,
      description: [
        "Delegate work to another active member of this agent room.",
        "Use this when work is outside your role, would benefit from another specialist, should be split into parallel sub-tasks, or when the user asks you to ask, call, consult, assign, or get independent work from another agent.",
        "Do not simulate the target agent's result; the server will create an auditable child run.",
        `Available targets: ${targets.map(targetLabel).join("; ")}`,
      ].join(" "),
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["target_agent_id", "instruction"],
        properties: {
          target_agent_id: {
            type: "string",
            enum: targets.map((target) => target.agent_id),
            description: "The room member agent id to call.",
          },
          instruction: {
            type: "string",
            minLength: 1,
            description: "The concrete task for the target agent.",
          },
          reason: {
            type: "string",
            description: "Short reason for this delegation.",
          },
          budget: {
            type: "object",
            additionalProperties: true,
            description: "Optional trace-safe delegation budget hints.",
          },
          context: {
            type: "object",
            additionalProperties: true,
            description: "Optional trace-safe context policy hints.",
          },
        },
      },
    };
}

function agentWaitForResultsToolDefinition(targets: readonly AgentDelegationTarget[]): CanonicalToolDefinition {
  return {
    name: AGENT_WAIT_FOR_RESULTS_TOOL,
    description: [
      "Pause this room agent run until other room agent runs finish, or read their completed results if they are already done.",
      "Use scope=current_turn when the same user message addressed multiple agents and your instruction depends on the other addressed agents' outputs.",
      "Use scope=own_delegations after you create agent.delegate calls and need those child results before replying.",
      "Use scope=run_ids only when you already have explicit run ids from prior tool results or audit context.",
      "If any dependency is still queued or running, the server pauses this run and resumes the same run after every dependency is terminal.",
      `Available room members and capabilities: ${targets.length ? targets.map(targetLabel).join("; ") : "no other active room members"}`,
    ].join(" "),
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["current_turn", "own_delegations", "run_ids"],
          description: "Which room runs to wait for. Defaults to own_delegations.",
        },
        run_ids: {
          type: "array",
          items: { type: "string" },
          description: "Explicit run ids to wait for when scope is run_ids.",
        },
        target_agent_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional room agent ids used to filter current_turn dependencies.",
        },
        reason: {
          type: "string",
          description: "Short trace-safe reason for waiting.",
        },
        resume_instruction: {
          type: "string",
          description: "Instruction to follow when the dependency results are available.",
        },
      },
    },
  };
}

async function loadDelegationTargets(
  config: ServerConfig,
  run: RunRecord,
  pool?: Pool,
): Promise<AgentDelegationTarget[]> {
  const db = pool ?? getDbPool(requiredDatabaseUrl(config));
  const result = await db.query<AgentDelegationTarget>(
    `SELECT m.agent_id,
            COALESCE(NULLIF(a.name, ''), m.agent_id) AS name,
            m.role,
            m.capabilities_json
       FROM agent_run_groups g
       JOIN agent_run_group_members m
         ON m.space_id = g.space_id
        AND m.group_id = g.id
       JOIN agents a
         ON a.space_id = m.space_id
        AND a.id = m.agent_id
      WHERE g.space_id = $1
        AND g.id = $2
        AND g.status = 'active'
        AND m.status = 'active'
        AND a.status = 'active'
        AND m.agent_id <> $3
      ORDER BY m.created_at ASC, m.id ASC`,
    [run.space_id, run.run_group_id, run.agent_id],
  );
  return result.rows;
}

export async function runAgentRoomToolCall(
  call: CanonicalToolCall,
  binding: AgentDelegationToolBinding,
  run: RunRecord,
  request: RuntimeHostExecuteRequest,
  authorizedPolicy?: Awaited<ReturnType<AgentGroupRunService["preflightSpawnChildRunPolicy"]>>,
): Promise<{ modelResult: unknown; summary: Record<string, unknown>; suspend?: RuntimeHostExecuteResponse }> {
  if (call.name === AGENT_WAIT_FOR_RESULTS_TOOL) {
    return runAgentWaitForResultsToolCall(call, binding, run, request);
  }
  if (call.name !== AGENT_DELEGATE_TOOL) {
    return {
      modelResult: { ok: false, tool: call.name, error: "Unknown agent room tool." },
      summary: { tool_name: call.name, ok: false, error_code: "unknown_agent_room_tool" },
    };
  }
  try {
    const { params, identity, input } = agentDelegatePolicyInput(call, binding, run);
    const result = authorizedPolicy && binding.service.spawnChildRunAuthorized
      ? await binding.service.spawnChildRunAuthorized(identity, input, authorizedPolicy)
      : await binding.service.spawnChildRun(identity, input);
    const target = binding.targets.find((candidate) => candidate.agent_id === params.target_agent_id);
    if (result.delegation.status === "policy_denied" || !result.child_run_id) {
      return {
        modelResult: {
          ok: false,
          tool: call.name,
          target_agent_id: params.target_agent_id,
          target_name: target?.name ?? params.target_agent_id,
          delegation_id: result.delegation.id,
          child_run_id: result.child_run_id,
          status: result.delegation.status,
          error: "Delegation was blocked by policy.",
        },
        summary: {
          tool_name: call.name,
          ok: false,
          error_code: "delegation_policy_denied",
          target_agent_id: params.target_agent_id,
          delegation_id: result.delegation.id,
          child_run_id: result.child_run_id,
          delegation_status: result.delegation.status,
          policy_decision_record_id: result.policy_decision_record_id,
        },
      };
    }
    return {
      modelResult: {
        ok: true,
        tool: call.name,
        target_agent_id: params.target_agent_id,
        target_name: target?.name ?? params.target_agent_id,
        delegation_id: result.delegation.id,
        child_run_id: result.child_run_id,
        status: result.delegation.status,
        message: "Delegated child run queued. Do not fabricate the child result; wait for delegation result messages before summarizing outcomes.",
      },
      summary: {
        tool_name: call.name,
        ok: true,
        target_agent_id: params.target_agent_id,
        delegation_id: result.delegation.id,
        child_run_id: result.child_run_id,
        delegation_status: result.delegation.status,
        policy_decision_record_id: result.policy_decision_record_id,
      },
    };
  } catch (error) {
    return {
      modelResult: {
        ok: false,
        tool: call.name,
        error: error instanceof Error ? error.message : "Agent delegation failed.",
      },
      summary: {
        tool_name: call.name,
        ok: false,
        error_code: "agent_delegate_tool_call_failed",
        error_message: error instanceof Error ? error.message : "Agent delegation failed.",
      },
    };
  }
}

export function agentDelegatePolicyInput(call: CanonicalToolCall, binding: AgentDelegationToolBinding, run: RunRecord) {
  const params = parseAgentDelegateArguments(call.arguments_json, binding.targets);
  const identity: AgentGroupIdentity = { spaceId: run.space_id, userId: run.instructed_by_user_id as string };
  const input: SpawnChildRunInput = {
    space_id: run.space_id,
    group_id: run.run_group_id as string,
    parent_run_id: run.id,
    root_run_id: run.root_run_id as string,
    requesting_agent_id: run.agent_id,
    target_agent_id: params.target_agent_id,
    manager_user_id: run.instructed_by_user_id as string,
    instruction: params.instruction,
    reason: params.reason ?? "agent_delegate_tool",
    budget_json: params.budget,
    context_policy_json: params.context,
    tool_call_id: call.id,
  };
  return { params, identity, input };
}

async function runAgentWaitForResultsToolCall(
  call: CanonicalToolCall,
  binding: AgentDelegationToolBinding,
  run: RunRecord,
  request: RuntimeHostExecuteRequest,
): Promise<{ modelResult: unknown; summary: Record<string, unknown>; suspend?: RuntimeHostExecuteResponse }> {
  try {
    if (!binding.pool) throw new Error("agent.wait_for_results requires room database access.");
    const params = parseAgentWaitArguments(call.arguments_json);
    const groups = new PgAgentGroupRepository(binding.pool);
    const runs = new PgRunRepository(binding.pool);
    const dependencies = await dependencyRunsForWait({
      groups,
      runs,
      run,
      scope: params.scope,
      explicitRunIds: params.run_ids,
      targetAgentIds: params.target_agent_ids,
    });
    if (dependencies.length === 0) {
      return {
        modelResult: {
          ok: false,
          tool: call.name,
          status: "no_dependencies",
          error: "No matching room runs were found to wait for.",
        },
        summary: {
          tool_name: call.name,
          ok: false,
          status: "no_dependencies",
          scope: params.scope,
        },
      };
    }

    const pending = dependencies.filter((dependency) => !isHardTerminalRunStatus(dependency.status));
    const results = dependencies
      .filter((dependency) => isHardTerminalRunStatus(dependency.status))
      .map(waitResultForRun);
    if (pending.length === 0) {
      return {
        modelResult: {
          ok: true,
          tool: call.name,
          status: "ready",
          results,
        },
        summary: {
          tool_name: call.name,
          ok: true,
          status: "ready",
          scope: params.scope,
          depends_on_run_ids: dependencies.map((dependency) => dependency.id),
        },
      };
    }

    const waitingForResults = {
      status: "waiting",
      scope: params.scope,
      reason: params.reason,
      resume_instruction: params.resume_instruction,
      requested_by_tool_call_id: call.id,
      depends_on_run_ids: dependencies.map((dependency) => dependency.id),
      pending_run_ids: pending.map((dependency) => dependency.id),
      ready_results: results,
    };
    return {
      modelResult: {
        ok: true,
        tool: call.name,
        status: "waiting",
        pending_run_ids: pending.map((dependency) => dependency.id),
      },
      summary: {
        tool_name: call.name,
        ok: true,
        status: "waiting",
        scope: params.scope,
        depends_on_run_ids: dependencies.map((dependency) => dependency.id),
        pending_run_ids: pending.map((dependency) => dependency.id),
      },
      suspend: waitForResultsResponse(request, waitingForResults),
    };
  } catch (error) {
    return {
      modelResult: {
        ok: false,
        tool: call.name,
        error: error instanceof Error ? error.message : "Waiting for agent results failed.",
      },
      summary: {
        tool_name: call.name,
        ok: false,
        error_code: "agent_wait_for_results_tool_call_failed",
        error_message: error instanceof Error ? error.message : "Waiting for agent results failed.",
      },
    };
  }
}

function parseAgentDelegateArguments(
  argumentsJson: string,
  targets: readonly AgentDelegationTarget[],
): {
  target_agent_id: string;
  instruction: string;
  reason: string | null;
  budget: Record<string, unknown>;
  context: Record<string, unknown>;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson || "{}");
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
  const record = recordValue(raw);
  const targetAgentId = stringValue(record.target_agent_id);
  if (!targetAgentId) throw new Error("target_agent_id is required.");
  if (!targets.some((target) => target.agent_id === targetAgentId)) {
    throw new Error("target_agent_id must be an active room member and cannot be the current agent.");
  }
  const instruction = stringValue(record.instruction);
  if (!instruction) throw new Error("instruction is required.");
  return {
    target_agent_id: targetAgentId,
    instruction,
    reason: stringValue(record.reason),
    budget: recordValue(record.budget),
    context: recordValue(record.context),
  };
}

function parseAgentWaitArguments(argumentsJson: string): {
  scope: "current_turn" | "own_delegations" | "run_ids";
  run_ids: string[];
  target_agent_ids: string[];
  reason: string | null;
  resume_instruction: string | null;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson || "{}");
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
  const record = recordValue(raw);
  const rawScope = stringValue(record.scope);
  const scope = rawScope === "current_turn" || rawScope === "run_ids"
    ? rawScope
    : "own_delegations";
  const runIds = stringArrayValue(record.run_ids);
  if (scope === "run_ids" && runIds.length === 0) {
    throw new Error("run_ids is required when scope is run_ids.");
  }
  return {
    scope,
    run_ids: runIds,
    target_agent_ids: stringArrayValue(record.target_agent_ids),
    reason: stringValue(record.reason),
    resume_instruction: stringValue(record.resume_instruction),
  };
}

async function dependencyRunsForWait(input: {
  groups: PgAgentGroupRepository;
  runs: PgRunRepository;
  run: RunRecord;
  scope: "current_turn" | "own_delegations" | "run_ids";
  explicitRunIds: readonly string[];
  targetAgentIds: readonly string[];
}): Promise<RunRecord[]> {
  const ids = await dependencyRunIdsForWait(input);
  const targetFilter = new Set(input.targetAgentIds);
  const dependencies: RunRecord[] = [];
  for (const runId of ids) {
    if (runId === input.run.id) continue;
    const dependency = await input.runs.getRun(input.run.space_id, runId);
    if (!dependency) continue;
    if (dependency.run_group_id !== input.run.run_group_id) continue;
    if (input.run.root_run_id && dependency.root_run_id && dependency.root_run_id !== input.run.root_run_id) continue;
    if (targetFilter.size > 0 && !targetFilter.has(dependency.agent_id)) continue;
    dependencies.push(dependency);
  }
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    if (seen.has(dependency.id)) return false;
    seen.add(dependency.id);
    return true;
  });
}

async function dependencyRunIdsForWait(input: {
  groups: PgAgentGroupRepository;
  run: RunRecord;
  scope: "current_turn" | "own_delegations" | "run_ids";
  explicitRunIds: readonly string[];
}): Promise<string[]> {
  if (input.scope === "run_ids") return [...input.explicitRunIds];
  if (input.scope === "own_delegations") {
    const delegations = await input.groups.listDelegationsForParent({
      space_id: input.run.space_id,
      parent_run_id: input.run.id,
    });
    return delegations
      .map((delegation) => delegation.child_run_id)
      .filter((runId): runId is string => typeof runId === "string" && runId.length > 0);
  }
  if (!input.run.run_group_id) return [];
  const parentMessageId = await input.groups.findTurnParentMessageIdForRun({
    space_id: input.run.space_id,
    group_id: input.run.run_group_id,
    run_id: input.run.id,
  });
  if (!parentMessageId) return [];
  const message = await input.groups.getMessage(input.run.space_id, parentMessageId);
  return stringArrayValue(recordValue(message?.metadata_json).recipient_run_ids);
}

function waitResultForRun(run: RunRecord): Record<string, unknown> {
  return {
    run_id: run.id,
    agent_id: run.agent_id,
    agent_name: stringValue(run.agent_name),
    status: run.status,
    prompt: run.prompt,
    result: terminalRunResultSummary(run),
  };
}

function waitForResultsResponse(
  request: RuntimeHostExecuteRequest,
  waitingForResults: Record<string, unknown>,
): RuntimeHostExecuteResponse {
  const now = new Date().toISOString();
  return {
    success: true,
    stdout: "",
    stderr: "",
    output_text: "",
    output_json: {
      adapter_type: "ts_agent_host",
      run_id: request.run_id,
      waiting_for_results: waitingForResults,
    },
    exit_code: 0,
    error_text: null,
    error_code: null,
    started_at: now,
    completed_at: now,
    model: request.model ?? null,
    usage: null,
    events: [],
    adapter_metadata: {
      adapter_type: "ts_agent_host",
      run_id: request.run_id,
      tool_mode: "authorized_bindings",
      waiting_for_results: waitingForResults,
    },
    adapter_log_json: null,
  };
}

function targetLabel(target: AgentDelegationTarget): string {
  const capabilityText = capabilitySummary(target.capabilities_json);
  return `${target.name} (${target.role}, id: ${target.agent_id})${capabilityText ? ` — ${capabilityText}` : ""}`;
}

function capabilitySummary(value: unknown): string {
  const record = recordValue(value);
  const parts: string[] = [];
  const description = stringValue(record.description);
  const roleInstruction = stringValue(record.role_instruction);
  if (description) parts.push(`description: ${description}`);
  if (roleInstruction) parts.push(`role: ${roleInstruction}`);
  const capabilities = Array.isArray(record.capabilities) ? record.capabilities : [];
  const rendered = capabilities
    .map((item) => {
      if (typeof item === "string") return item;
      const itemRecord = recordValue(item);
      return stringValue(itemRecord.name)
        ?? stringValue(itemRecord.id)
        ?? stringValue(itemRecord.key)
        ?? stringValue(itemRecord.capability_key)
        ?? null;
    })
    .filter((item): item is string => Boolean(item));
  if (rendered.length > 0) parts.push(`capabilities: ${rendered.slice(0, 8).join(", ")}`);
  const summary = parts.join("; ");
  return summary.length <= 600 ? summary : `${summary.slice(0, 597)}...`;
}

function requiredDatabaseUrl(config: ServerConfig): string {
  if (!config.databaseUrl) {
    throw new Error("Agent delegation tools require SERVER_DATABASE_URL");
  }
  return config.databaseUrl;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0))];
}

function isHardTerminalRunStatus(status: string): boolean {
  return status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "degraded" ||
    status === "orphaned";
}

function terminalRunResultSummary(run: RunRecord): string {
  const envelope = recordValue(run.output_json);
  const output = recordValue(envelope.result);
  const text = stringValue(envelope.summary)
    ?? stringValue(output.result_summary);
  if (text) return truncateResultSummary(text);

  const error = recordValue(run.error_json);
  const errorText = stringValue(error.error_text)
    ?? stringValue(error.error_message)
    ?? stringValue(run.error_message);
  if (errorText) return truncateResultSummary(errorText);

  if (run.status === "succeeded") return "Run completed successfully without display output.";
  if (run.status === "cancelled") return "Run was cancelled.";
  if (run.status === "degraded") return "Run completed with degraded status.";
  return "Run failed without display output.";
}

function truncateResultSummary(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}
