import type {
  CanonicalToolCall,
  CanonicalToolDefinition,
  RuntimeHostExecuteRequest,
  RuntimeHostExecuteResponse,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type {
  SystemActionDefinition,
  SystemActionId,
  SystemActionPolicyResource,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import {
  resolveAgentDelegationToolBinding,
  runAgentRoomToolCall,
  agentDelegatePolicyInput,
  type AgentDelegationToolDeps,
} from "../runs/managedAgentDelegationTools";
import {
  resolveRetrievalToolBinding,
  isRetrievalPreflightMode,
  type ManagedApiRetrievalToolDeps,
  runRetrievalToolCall,
  validateRetrievalToolInput,
  type ResolvedRetrievalToolBinding,
} from "../runs/managedRetrievalTools";
import type { RunRecord } from "../runs/repository";
import { PgRunRepository } from "../runs/repository";
import { getDbPool } from "../../db/pool";
import { loadSystemActionRegistry } from "./registry";
import { loadProtocol } from "../providers/protocolRuntime";
import { SystemActionGateway, SystemActionGatewayError, type SystemActionExecutor } from "./gateway";
import { enforceRetrievalToolCallPolicy, type RetrievalToolPolicyAction } from "../retrieval/tool/policy";
import { loadActionRegistry } from "../policy/actionRegistry";
import { enforce } from "../policy/service";
import { assembleRunInputEnvelope } from "../runs/runInputEnvelope";
import { ActionApprovalGrantService } from "../policy/actionApprovalGrantService";
import { registerModuleSystemActionExecutors } from "./executorRegistry";

export interface SystemActionDispatcherDeps extends ManagedApiRetrievalToolDeps {
  agentDelegationTools?: AgentDelegationToolDeps;
  actionEventSink?: (eventType: "action_invoked" | "action_completed", call: CanonicalToolCall, metadata?: Record<string, unknown>) => Promise<void>;
}

export interface SystemActionDispatchResult {
  modelResult: unknown;
  summary: Record<string, unknown>;
  artifact?: unknown;
  /** Terminates the caller's batch — the `authorization.request` executor's own pause signal. */
  suspend?: RuntimeHostExecuteResponse;
}

/**
 * Run-scoped single-call entry point over `SystemActionGateway`: grants,
 * dispatch, and a normalized result. Shared by the managed model loop
 * (`ManagedAgentToolSurface`), the CLI MCP transport, and — by construction,
 * since there is only one path — any future thin adapter.
 */
export class SystemActionDispatcher {
  private constructor(
    private readonly run: RunRecord,
    private readonly gateway: SystemActionGateway,
    private readonly grantedActionIds: Set<string>,
    readonly retrieval: ResolvedRetrievalToolBinding | null,
    readonly delegation: Awaited<ReturnType<typeof resolveAgentDelegationToolBinding>>,
    readonly genericDefinitions: CanonicalToolDefinition[],
    readonly genericBindings: RuntimeHostExecuteRequest["tool_bindings"],
    readonly researchDefinitions: CanonicalToolDefinition[],
    readonly researchBindings: RuntimeHostExecuteRequest["tool_bindings"],
  ) {}

  static async create(
    config: ServerConfig,
    run: RunRecord,
    request: RuntimeHostExecuteRequest,
    deps: SystemActionDispatcherDeps = {},
  ): Promise<SystemActionDispatcher> {
    const [retrieval, delegation] = await Promise.all([
      resolveRetrievalToolBinding(config, run, deps),
      resolveAgentDelegationToolBinding(config, run, deps.agentDelegationTools),
    ]);
    const registry = await loadSystemActionRegistry();
    const { systemActionInputJsonSchema } = await loadProtocol();
    const executors = new Map<SystemActionId, SystemActionExecutor>();
    const grantedActionIds = new Set(
      assembleRunInputEnvelope(run).tool_grants.map((grant) => grant.action_id),
    );

    const genericRegistryDefinitions = [...registry.values()]
      .filter(
        (definition) =>
          definition.agent_tool_surface === "generic" &&
          grantedActionIds.has(definition.id),
      );
    const genericDefinitions: CanonicalToolDefinition[] = genericRegistryDefinitions
      .map((definition) => ({ name: definition.id, description: definition.description, input_schema: systemActionInputJsonSchema(definition) }));
    const genericBindings = genericRegistryDefinitions.map(systemActionToolBinding);

    const researchRegistryDefinitions = [...registry.values()]
      .filter((definition) => definition.agent_tool_surface === "research" && grantedActionIds.has(definition.id));
    const researchAcquisitionDefinitions: CanonicalToolDefinition[] = researchRegistryDefinitions
      .map((definition) => ({ name: definition.id, description: definition.description, input_schema: systemActionInputJsonSchema(definition) }));
    const researchAcquisitionBindings = researchRegistryDefinitions.map(systemActionToolBinding);

    const permitted = new Set(
      [...registry.values()]
        .filter(
          (definition) =>
            grantedActionIds.has(definition.id) &&
            definition.visibility.has("agent_tool") &&
            definition.allowed_actor_types.includes("agent"),
        )
        .map((definition) => definition.id),
    );
    if (retrieval) {
      retrieval.toolDefinitions = retrieval.toolDefinitions.filter((tool) => permitted.has(tool.name));
      retrieval.toolBindings = retrieval.toolBindings.filter((tool) => permitted.has(tool.id));
    }
    if (delegation) {
      delegation.toolDefinitions = delegation.toolDefinitions.filter((tool) => permitted.has(tool.name));
      delegation.toolBindings = delegation.toolBindings.filter((tool) => permitted.has(tool.id));
    }
    const permittedGenericDefinitions = genericDefinitions.filter((tool) => permitted.has(tool.name));
    const permittedGenericBindings = genericBindings.filter((tool) => permitted.has(tool.id));
    const permittedResearchAcquisitionDefinitions = researchAcquisitionDefinitions.filter((tool) => permitted.has(tool.name));
    const permittedResearchAcquisitionBindings = researchAcquisitionBindings.filter((tool) => permitted.has(tool.id));

    registerModuleSystemActionExecutors(executors, config, run, {
      generic: genericDefinitions.length > 0,
      researchAcquisition: permittedResearchAcquisitionDefinitions.length > 0,
    });

    const actionEvents = deps.actionEventSink ?? defaultActionEventSink(config, run);
    const actor = {
      spaceId: run.space_id,
      instructedByUserId: run.instructed_by_user_id as string,
      agentId: run.agent_id,
      runId: run.id,
    };

    if (retrieval) {
      for (const definition of registry.values()) {
        if (definition.policy_adapter !== "retrieval") continue;
        executors.set(definition.id as SystemActionId, async (input, context) => {
          const result = await runRetrievalToolCall(
            { id: definition.id, name: definition.id, arguments_json: JSON.stringify(input) },
            retrieval,
            actor,
            run,
          );
          result.summary.policy_decision_record_id = context.policy_decision?.policy_decision_record_id ?? null;
          return result;
        });
      }
    }
    if (delegation) {
      for (const tool of delegation.toolDefinitions) {
        executors.set(tool.name as SystemActionId, async (input, context) =>
          runAgentRoomToolCall(
            { id: tool.name, name: tool.name, arguments_json: JSON.stringify(input) },
            delegation,
            run,
            request,
            context.policy_decision?.details as never,
          ),
        );
      }
    }

    // Policy enforcement has already happened in the Dispatcher's adapter
    // before any executor runs. Executors receive the resulting decision only
    // when their domain call needs its durable decision-record metadata.
    const policyRegistry = await loadActionRegistry();
    const emitActionEvent = async (
      definition: { id: string; policy_action: string },
      eventType: "action_invoked" | "action_completed",
      context: { idempotency_key?: string | null },
      metadata: Record<string, unknown> = {},
    ) => {
      if (!actionEvents) return;
      try {
        await actionEvents(eventType, { id: context.idempotency_key ?? definition.id, name: definition.id, arguments_json: "{}" }, metadata);
      } catch (error) {
        if (policyRegistry.get(definition.policy_action)?.record_failure_mode === "fail_closed") throw error;
      }
    };

    const gateway = new SystemActionGateway(
      executors,
      (definition, input) => enforcePolicyForAction(config, definition, input, run, retrieval, actor, delegation),
      {
        onValidated: (definition, _input, context) => emitActionEvent(definition, "action_invoked", context),
        onCompleted: (definition, result, context) =>
          emitActionEvent(definition, "action_completed", context, {
            policy_decision_record_id: result.policy_decision_record_id,
            ...((result.output as { summary?: Record<string, unknown> }).summary ?? {}),
          }),
        onFailed: (definition, error, context) =>
          emitActionEvent(definition, "action_completed", context, {
            ok: false,
            error_code: (error as { code?: string }).code ?? "system_action_failed",
            policy_decision_record_id: (error as { policy_decision_record_id?: string | null }).policy_decision_record_id ?? null,
          }),
      },
    );

    return new SystemActionDispatcher(
      run,
      gateway,
      grantedActionIds,
      retrieval,
      delegation,
      permittedGenericDefinitions,
      permittedGenericBindings,
      permittedResearchAcquisitionDefinitions,
      permittedResearchAcquisitionBindings,
    );
  }

  /**
   * Every action definition this Run is granted, with model-facing schemas.
   * A retrieval binding in a preflight mode contributes no definitions here,
   * matching `retrievalToolContribution` for the managed loop: in
   * `preflight_search`/`preflight_brief` the system performs the governed
   * retrieval step itself, so the tool must not be offered for direct call.
   */
  listGrantedDefinitions(): CanonicalToolDefinition[] {
    const retrievalDefinitions = this.retrieval && !isRetrievalPreflightMode(this.retrieval.toolMode)
      ? this.retrieval.toolDefinitions
      : [];
    return [
      ...retrievalDefinitions,
      ...(this.delegation?.toolDefinitions ?? []),
      ...this.genericDefinitions,
      ...this.researchDefinitions,
    ];
  }

  async dispatch(call: CanonicalToolCall): Promise<SystemActionDispatchResult> {
    if (!this.grantedActionIds.has(call.name)) {
      return {
        modelResult: {
          ok: false,
          tool: call.name,
          error_code: "system_action_not_granted",
          error: "This system action is not granted to the Run.",
        },
        summary: {
          tool_name: call.name,
          ok: false,
          error_code: "system_action_not_granted",
        },
      };
    }
    let input: unknown;
    try {
      input = JSON.parse(call.arguments_json || "{}");
    } catch {
      input = {};
    }
    try {
      const dispatched = await this.gateway.dispatch(call.name, input, {
        actor: { type: "agent", space_id: this.run.space_id, agent_id: this.run.agent_id, user_id: this.run.instructed_by_user_id, run_id: this.run.id },
        visibility: "agent_tool",
        idempotency_key: call.id,
      });
      return dispatched.output as SystemActionDispatchResult;
    } catch (error) {
      return toolCallFailureResult(call, error);
    }
  }
}

function systemActionToolBinding(
  definition: SystemActionDefinition,
): RuntimeHostExecuteRequest["tool_bindings"][number] {
  return {
    id: definition.id,
    external_type: "internal",
    external_ref: definition.id,
    display_name: definition.id,
    required_scopes: [definition.id],
    credential_ref: null,
    data_exposure_level: "model_provider",
    observability_level: "structured_events",
    side_effect_level: definition.side_effects,
    approval_required: definition.side_effects === "proposal",
  };
}

/**
 * `agent.delegate` and retrieval keep an explicit custom adapter — their
 * enforcement genuinely differs (group budget/lineage; domain enablement).
 * Every other agent-visible action declares `policy_resource` (D4): the
 * generic adapter below reads it declaratively instead of a hand-written
 * `if (definition.id === ...)` branch, so adding one more declarative
 * action means adding metadata to its definition, not a fifth branch here.
 */
async function enforcePolicyForAction(
  config: ServerConfig,
  definition: SystemActionDefinition,
  input: unknown,
  run: RunRecord,
  retrieval: ResolvedRetrievalToolBinding | null,
  actor: { spaceId: string; instructedByUserId: string; agentId: string; runId: string },
  delegation: Awaited<ReturnType<typeof resolveAgentDelegationToolBinding>>,
) {
  if (definition.policy_adapter === "agent_delegate" && delegation?.service.preflightSpawnChildRunPolicy) {
    const call = { id: definition.id, name: definition.id, arguments_json: JSON.stringify(input) };
    const prepared = agentDelegatePolicyInput(call, delegation, run);
    const decision = await delegation.service.preflightSpawnChildRunPolicy(prepared.identity, prepared.input);
    return {
      allowed: decision.status === "allow",
      policy_decision_record_id: decision.policy_decision_record_id ?? null,
      reason: decision.message ?? undefined,
      details: decision,
    };
  }

  if (definition.policy_adapter === "retrieval") {
    try {
      validateRetrievalToolInput(definition.id, input);
    } catch (error) {
      // Retrieval's `input_schema` in the registry stays the generic
      // `objectInput` (its real, dynamic-per-binding schema is a documented
      // exception — see the plan's "Remaining exceptions"), so this is the
      // one action family whose input validation happens here instead of
      // the gateway's own `input_schema.safeParse`. Code it the same way
      // that check would, rather than falling through to a generic failure.
      throw new SystemActionGatewayError(
        "system_action_invalid_input",
        error instanceof Error ? error.message : "Invalid retrieval tool input.",
      );
    }
    const domain = definition.id.startsWith("memory.")
      ? "memory"
      : definition.id.startsWith("project.")
        ? "project_public_summary"
        : definition.id.startsWith("source.")
          ? "source"
          : "knowledge";
    const decision = await enforceRetrievalToolCallPolicy({
      // `policyDatabaseUrl` is not a copy of the server's URL: a
      // test-injected retrieval service deliberately sets it to null to mean
      // "no policy database". Honour that when a binding exists, and use the
      // server's own URL when there is none — a model-invented retrieval call
      // on a run that owns no retrieval tool is denied before any executor
      // runs, and that denial is still a decision worth recording.
      databaseUrl: retrieval ? retrieval.policyDatabaseUrl : config.databaseUrl,
      actor,
      action: definition.id as RetrievalToolPolicyAction,
      domain,
      domainEnabled: Boolean(retrieval?.services[domain as keyof typeof retrieval.services]),
      surface: "managed_run_system_action_gateway",
    });
    return {
      allowed: decision.allowed,
      policy_decision_record_id: decision.policy_decision_record_id,
      reason: decision.message,
      details: decision,
    };
  }

  if (definition.policy_adapter === "declared_resource" && definition.policy_resource && config.databaseUrl) {
    return enforceDeclaredResourcePolicy(config.databaseUrl, definition, definition.policy_resource, input, run);
  }

  return { allowed: false, reason: "No canonical policy adapter is registered for this action" };
}

async function enforceDeclaredResourcePolicy(
  databaseUrl: string,
  definition: SystemActionDefinition,
  resource: SystemActionPolicyResource,
  input: unknown,
  run: RunRecord,
) {
  const resourceType = resource.resource_type ?? definition.owning_module;
  const resourceId = resolveDeclaredResourceId(resource, input, run);
  const hasActionGrant = resource.check_action_approval_grant
    ? await new ActionApprovalGrantService(getDbPool(databaseUrl)).hasMatching({
        spaceId: run.space_id,
        agentId: run.agent_id,
        actionId: definition.id,
        runId: run.id,
        projectId: run.project_id,
        resourceKind: resourceType,
        resourceId,
      })
    : undefined;
  const decision = await enforce({ databaseUrl }, await loadActionRegistry(), {
    action: definition.policy_action,
    force_record: true,
    actor_type: "agent",
    actor_id: run.agent_id,
    space_id: run.space_id,
    resource_space_id: run.space_id,
    resource_type: resourceType,
    resource_id: resourceId,
    run_id: run.id,
    context: {
      action_id: definition.id,
      // `runtime.execute`'s `ruleToolPermission` reads `tool_name`
      // specifically (agent.wait_for_results shares that policy_action with
      // the Run's own upstream execution gate); harmless for every other
      // declared action, whose policy_action never inspects this key.
      tool_name: definition.id,
      project_id: run.project_id,
      instructed_by_user_id: run.instructed_by_user_id,
      surface: "managed_run_system_action_gateway",
      ...(hasActionGrant !== undefined ? { has_action_approval_grant: hasActionGrant } : {}),
    },
    metadata_json: { surface: "managed_run_system_action_gateway", action_id: definition.id },
  });
  return {
    allowed: decision.status === "allow",
    policy_decision_record_id: decision.policy_decision_record_id ?? null,
    reason: decision.message ?? undefined,
    details: decision,
  };
}

export function resolveDeclaredResourceId(resource: SystemActionPolicyResource, input: unknown, run: RunRecord): string {
  const fromInput = resource.resource_id_input_field
    ? (input as Record<string, unknown>)[resource.resource_id_input_field]
    : undefined;
  if (typeof fromInput === "string" && fromInput.length > 0) return fromInput;
  return resource.resource_id_fallback === "project_or_run" ? (run.project_id ?? run.id) : run.id;
}

function toolCallFailureResult(call: CanonicalToolCall, error: unknown): SystemActionDispatchResult {
  // A disabled retrieval domain and an unknown-retrieval-tool-call failure
  // both normalize through here now: the gateway's own decision (D6/D7) is
  // the single enforcement point, so a disabled domain is an ordinary
  // `system_action_policy_denied`, and no other retrieval-specific error
  // code is fabricated by name-matching — every action gets the same
  // fallback.
  const errorCode = (error as { code?: string }).code ?? "system_action_failed";
  return {
    modelResult: {
      ok: false,
      tool: call.name,
      error_code: errorCode,
      error: error instanceof Error ? error.message : "Action failed",
      ...(policyDecisionRecordId(error)
        ? { policy_decision_record_id: policyDecisionRecordId(error) }
        : {}),
    },
    summary: {
      tool_name: call.name,
      ok: false,
      error_code: errorCode,
      ...(policyDecisionRecordId(error)
        ? { policy_decision_record_id: policyDecisionRecordId(error) }
        : {}),
    },
  };
}

function defaultActionEventSink(config: ServerConfig, run: RunRecord) {
  if (!config.databaseUrl) return undefined;
  const repository = new PgRunRepository(getDbPool(config.databaseUrl));
  return async (
    eventType: "action_invoked" | "action_completed",
    call: CanonicalToolCall,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    try {
      await repository.appendRunEvent({
        run_id: run.id,
        space_id: run.space_id,
        event_type: eventType,
        status: eventType === "action_invoked" ? "running" : (metadata.ok === false ? "failed" : "succeeded"),
        actor_id: run.agent_id,
        metadata_json: { action_id: call.name, action_version: 1, tool_call_id: call.id, instructed_by_user_id: run.instructed_by_user_id ?? null, ...metadata },
      });
    } catch {
      // RunEvent evidence follows the execution-model best-effort rule; the
      // PolicyGateway decision record remains the fail-closed audit seam.
    }
  };
}

function policyDecisionRecordId(error: unknown): string | null {
  if (error instanceof SystemActionGatewayError) return error.policy_decision_record_id;
  if (!error || typeof error !== "object") return null;
  const value = (error as { policy_decision_record_id?: unknown }).policy_decision_record_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
