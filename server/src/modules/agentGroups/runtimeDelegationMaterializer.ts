import { createHash } from "node:crypto";
import type {
  RunMaterializationItemSummary,
  RuntimeDelegationOutputItem,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import { loadProtocol } from "../providers/protocolRuntime";
import type { RunRecord } from "../runs/repository";
import { AgentGroupRunService } from "./service";

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

export class AgentGroupRuntimeDelegationMaterializer
  implements RuntimeDelegationMaterializerPort
{
  constructor(private readonly service: Pick<AgentGroupRunService, "spawnChildRun">) {}

  static fromConfig(config: ServerConfig): AgentGroupRuntimeDelegationMaterializer {
    if (!config.databaseUrl) {
      throw new Error("Agent group delegation materialization requires SERVER_DATABASE_URL");
    }
    return new AgentGroupRuntimeDelegationMaterializer(
      new AgentGroupRunService(config, getDbPool(config.databaseUrl)),
    );
  }

  async materialize(input: {
    run: RunRecord;
    output_json: unknown;
  }): Promise<RuntimeDelegationMaterializationResult> {
    const protocol = await loadProtocol();
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

    const items: RunMaterializationItemSummary[] = [];
    const errors: string[] = [];
    for (const [index, entry] of parsed.data.delegations.entries()) {
      const item = await this.materializeOne(input.run, entry, index);
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
          tool_call_id: runtimeOutputDelegationKey(run.id, entry, index),
        },
      );
      if (result.delegation.status === "policy_denied" || !result.child_run_id) {
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
      return failedItem(
        "output_delegation_materialization_error",
        error instanceof Error ? error.message : "Runtime delegation materialization failed.",
        index,
      );
    }
  }
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
