import { createHash } from "node:crypto";
import * as protocol from "@rainver/protocol";
import type {
  RunMaterializationItemSummary,
  RuntimeDelegationOutputItem,
} from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { PgRunRepository, type RunRecord } from "../runs/repository.js";
import { assembleRunInputEnvelope } from "../runs/runInputEnvelope.js";
import { AgentGroupRunService } from "./service.js";

export interface RuntimeDelegationMaterializationResult {
  items: RunMaterializationItemSummary[];
  errors: string[];
}

export interface RuntimeDelegationMaterializerPort {
  materialize(input: {
    run: RunRecord;
    output_json: unknown;
  }): Promise<RuntimeDelegationMaterializationResult>;
}

/**
 * Runtime delegation output ("Path B" — an Agent ending its turn with a
 * structured `delegations` array) and the `agent.delegate` tool call
 * ("Path A") both mean "this Agent decided another Agent should do work"
 * (action authority consolidation plan, D8). Both now check the same grant
 * — an Agent configured without `agent.delegate` cannot reach
 * `spawnChildRun` from either path — and emit the same `action_invoked`/
 * `action_completed` RunEvents once past that gate, so Agent configuration
 * means the same thing regardless of which path a turn used. A post-terminal
 * grant refusal cannot return a tool error to the model, so it emits an
 * `action_completed` denial audit event instead. RunEvent persistence is
 * best-effort here, matching the documented rule that RunEvent failure never
 * blocks or rolls back an action already under way.
 */
export class AgentGroupRuntimeDelegationMaterializer
  implements RuntimeDelegationMaterializerPort
{
  constructor(
    private readonly service: Pick<AgentGroupRunService, "spawnChildRun">,
    private readonly runEvents: Pick<PgRunRepository, "appendRunEvent">,
  ) {}

  static fromConfig(config: ServerConfig): AgentGroupRuntimeDelegationMaterializer {
    if (!config.databaseUrl) {
      throw new Error("Agent group delegation materialization requires SERVER_DATABASE_URL");
    }
    const pool = getDbPool(config.databaseUrl);
    return new AgentGroupRuntimeDelegationMaterializer(
      new AgentGroupRunService(config, pool),
      new PgRunRepository(pool),
    );
  }

  async materialize(input: {
    run: RunRecord;
    output_json: unknown;
  }): Promise<RuntimeDelegationMaterializationResult> {
    const raw = recordValue(input.output_json);
    if (!Object.prototype.hasOwnProperty.call(raw, "delegations")) {
      return { items: [], errors: [] };
    }
    const parsed = protocol.RuntimeDelegationsOutputSchema.safeParse(raw);
    if (!parsed.success) {
      const item = failedItem("invalid_runtime_delegations", parsed.error.message);
      return { items: [item], errors: [errorText(item)] };
    }
    if (parsed.data.delegations.length === 0) {
      return { items: [], errors: [] };
    }
    if (!input.run.run_group_id || !input.run.root_run_id) {
      const item = failedItem(
        "run_not_in_agent_group",
        "Runtime delegation output is only supported for grouped runs.",
      );
      return { items: [item], errors: [errorText(item)] };
    }
    if (!input.run.instructed_by_user_id) {
      const item = failedItem(
        "missing_manager_user",
        "Grouped run is missing instructed_by_user_id.",
      );
      return { items: [item], errors: [errorText(item)] };
    }

    // The same grant snapshot `SystemActionDispatcher` checks for the
    // `agent.delegate` tool call (D8) — an Agent deliberately configured
    // without it is refused here exactly as it would be on that path,
    // instead of this second transport silently bypassing the grant.
    const granted = assembleRunInputEnvelope(input.run).tool_grants
      .some((grant) => grant.action_id === "agent.delegate");

    const items: RunMaterializationItemSummary[] = [];
    const errors: string[] = [];
    for (const [index, entry] of parsed.data.delegations.entries()) {
      const item = granted
        ? await this.materializeOne(input.run, entry, index)
        : await this.materializeNotGranted(input.run, entry, index);
      items.push(item);
      if (item.status === "failed") errors.push(errorText(item));
    }
    return { items, errors };
  }

  private async materializeOne(
    run: RunRecord,
    entry: RuntimeDelegationOutputItem,
    index: number,
  ): Promise<RunMaterializationItemSummary> {
    const toolCallId = runtimeOutputDelegationKey(run.id, entry, index);
    await this.appendActionEventBestEffort(run, "action_invoked", toolCallId, {
      tool_name: "agent.delegate",
    });
    try {
      const result = await this.service.spawnChildRun(
        { spaceId: run.space_id, userId: run.instructed_by_user_id as string },
        {
          space_id: run.space_id,
          group_id: run.run_group_id as string,
          parent_run_id: run.id,
          root_run_id: run.root_run_id as string,
          requesting_agent_id: run.agent_id,
          target_agent_id: entry.target_agent_id,
          manager_user_id: run.instructed_by_user_id as string,
          instruction: entry.instruction,
          reason: entry.reason ?? "runtime_delegation_output",
          budget_json: objectValue(entry.budget),
          context_policy_json: objectValue(entry.context),
          tool_call_id: toolCallId,
        },
      );
      if (result.delegation.status === "policy_denied" || !result.child_run_id) {
        await this.appendActionEventBestEffort(run, "action_completed", toolCallId, {
          tool_name: "agent.delegate",
          ok: false,
          error_code: "delegation_policy_denied",
          target_agent_id: entry.target_agent_id,
          delegation_id: result.delegation.id,
          child_run_id: result.child_run_id,
          delegation_status: result.delegation.status,
          policy_decision_record_id: result.policy_decision_record_id,
        });
        return {
          kind: "delegation",
          status: "warning",
          error_code: "delegation_policy_denied",
          error_message: "Runtime delegation was blocked by policy.",
          metadata_json: {
            label: `output_delegation_${index}`,
            operation: "run.spawn_child",
            group_id: run.run_group_id as string,
            delegation_id: result.delegation.id,
            child_run_id: result.child_run_id,
            delegation_status: result.delegation.status,
            policy_decision_record_id: result.policy_decision_record_id,
            target_agent_id: entry.target_agent_id,
            service_event_written: true,
          },
        };
      }
      await this.appendActionEventBestEffort(run, "action_completed", toolCallId, {
        tool_name: "agent.delegate",
        ok: true,
        target_agent_id: entry.target_agent_id,
        delegation_id: result.delegation.id,
        child_run_id: result.child_run_id,
        delegation_status: result.delegation.status,
        policy_decision_record_id: result.policy_decision_record_id,
      });
      return {
        kind: "delegation",
        status: "succeeded",
        metadata_json: {
          label: `output_delegation_${index}`,
          operation: "run.spawn_child",
          group_id: run.run_group_id as string,
          delegation_id: result.delegation.id,
          child_run_id: result.child_run_id,
          delegation_status: result.delegation.status,
          policy_decision_record_id: result.policy_decision_record_id,
          target_agent_id: entry.target_agent_id,
          service_event_written: true,
        },
      };
    } catch (error) {
      await this.appendActionEventBestEffort(run, "action_completed", toolCallId, {
        tool_name: "agent.delegate",
        ok: false,
        error_code: "output_delegation_materialization_error",
      });
      return failedItem(
        "output_delegation_materialization_error",
        error instanceof Error ? error.message : "Runtime delegation materialization failed.",
        index,
      );
    }
  }

  private async materializeNotGranted(
    run: RunRecord,
    entry: RuntimeDelegationOutputItem,
    index: number,
  ): Promise<RunMaterializationItemSummary> {
    const toolCallId = runtimeOutputDelegationKey(run.id, entry, index);
    await this.appendActionEventBestEffort(run, "action_completed", toolCallId, {
      tool_name: "agent.delegate",
      ok: false,
      error_code: "delegation_not_granted",
      target_agent_id: entry.target_agent_id,
    });
    return notGrantedItem(entry, index, toolCallId);
  }

  private async appendActionEventBestEffort(
    run: RunRecord,
    eventType: "action_invoked" | "action_completed",
    toolCallId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.runEvents.appendRunEvent({
        run_id: run.id,
        space_id: run.space_id,
        event_type: eventType,
        status: eventType === "action_invoked" ? "running" : (metadata.ok === false ? "failed" : "succeeded"),
        actor_id: run.agent_id,
        metadata_json: {
          action_id: "agent.delegate",
          action_version: 1,
          tool_call_id: toolCallId,
          instructed_by_user_id: run.instructed_by_user_id ?? null,
          ...metadata,
        },
      });
    } catch {
      // RunEvent evidence follows the execution-model best-effort rule; see
      // the class doc comment.
    }
  }
}

function notGrantedItem(entry: RuntimeDelegationOutputItem, index: number, toolCallId: string): RunMaterializationItemSummary {
  return {
    kind: "delegation",
    status: "warning",
    error_code: "delegation_not_granted",
    error_message: "Agent is not granted agent.delegate.",
    metadata_json: {
      label: `output_delegation_${index}`,
      operation: "run.spawn_child",
      target_agent_id: entry.target_agent_id,
      tool_call_id: toolCallId,
      action_event_attempted: true,
      service_event_written: false,
    },
  };
}

function runtimeOutputDelegationKey(
  runId: string,
  entry: RuntimeDelegationOutputItem,
  index: number,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalJson({
      run_id: runId,
      output_index: index,
      target_agent_id: entry.target_agent_id,
      instruction: entry.instruction,
      reason: entry.reason ?? null,
      budget: objectValue(entry.budget),
      context: objectValue(entry.context),
    })))
    .digest("hex");
  return `runtime_output:${digest}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function failedItem(
  errorCode: string,
  message: string,
  index: number | null = null,
): RunMaterializationItemSummary {
  return {
    kind: "delegation",
    status: "failed",
    error_code: errorCode,
    error_message: message,
    metadata_json: {
      label: index === null ? "output_delegations" : `output_delegation_${index}`,
      operation: "run.spawn_child",
    },
  };
}

function errorText(item: RunMaterializationItemSummary): string {
  return `${item.kind}:${item.error_code ?? item.status}:${item.error_message ?? ""}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
