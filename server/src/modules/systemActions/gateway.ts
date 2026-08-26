import type { SystemActionActorType, SystemActionDefinition, SystemActionId } from "@agent-space/protocol";
import { loadSystemActionRegistry } from "./registry.js";

export interface SystemActionActor {
  type: SystemActionActorType;
  space_id: string;
  user_id?: string | null;
  agent_id?: string | null;
  run_id?: string | null;
}

export interface SystemActionPolicyDecision {
  allowed: boolean;
  policy_decision_record_id?: string | null;
  reason?: string;
  details?: unknown;
}

export interface SystemActionDispatchContext {
  actor: SystemActionActor;
  visibility: "internal_only" | "agent_tool" | "public_api" | "system_job";
  idempotency_key?: string | null;
  policy_decision?: SystemActionPolicyDecision;
}

export type SystemActionExecutor = (input: unknown, context: SystemActionDispatchContext) => Promise<unknown>;
export type SystemActionPolicyEnforcer = (
  definition: SystemActionDefinition,
  input: unknown,
  context: SystemActionDispatchContext,
) => Promise<SystemActionPolicyDecision>;

export class SystemActionGatewayError extends Error {
  constructor(readonly code: string, message: string,readonly policy_decision_record_id:string|null=null) {
    super(message);
  }
}

export class SystemActionGateway {
  constructor(
    private readonly executors: ReadonlyMap<SystemActionId, SystemActionExecutor>,
    private readonly enforcePolicy: SystemActionPolicyEnforcer,
    private readonly hooks: {
      onValidated?: (definition: SystemActionDefinition, input: unknown, context: SystemActionDispatchContext) => Promise<void>;
      onCompleted?: (definition: SystemActionDefinition, result: { output: unknown; policy_decision_record_id: string | null }, context: SystemActionDispatchContext) => Promise<void>;
      onFailed?: (definition: SystemActionDefinition, error: unknown, context: SystemActionDispatchContext) => Promise<void>;
    } = {},
  ) {}

  async dispatch(actionId: string, input: unknown, context: SystemActionDispatchContext): Promise<{
    definition: SystemActionDefinition;
    output: unknown;
    policy_decision_record_id: string | null;
  }> {
    const registry = await loadSystemActionRegistry();
    const definition = registry.get(actionId as SystemActionId);
    if (!definition) throw new SystemActionGatewayError("unknown_system_action", `Unknown system action '${actionId}'`);
    try {
    if (!definition.allowed_actor_types.includes(context.actor.type)) {
      throw new SystemActionGatewayError("system_action_actor_denied", `Actor type '${context.actor.type}' cannot invoke '${actionId}'`);
    }
    if (!definition.visibility.has(context.visibility)) {
      throw new SystemActionGatewayError("system_action_visibility_denied", `Action '${actionId}' is not visible on '${context.visibility}'`);
    }
    if (definition.idempotency_required && !context.idempotency_key) {
      throw new SystemActionGatewayError("system_action_idempotency_required", `Action '${actionId}' requires an idempotency key`);
    }
    const parsedInput = definition.input_schema.safeParse(input);
    if (!parsedInput.success) throw new SystemActionGatewayError("system_action_invalid_input", parsedInput.error.message);
    await this.hooks.onValidated?.(definition, parsedInput.data, context);
    const policy = await this.enforcePolicy(definition, parsedInput.data, context);
    if (!policy.allowed) {
      const approvalRequired = policyRequiresApproval(policy.details);
      throw new SystemActionGatewayError(
        approvalRequired ? "system_action_approval_required" : "system_action_policy_denied",
        policy.reason ?? (approvalRequired ? "Action requires approval" : "Action denied by policy"),
        policy.policy_decision_record_id ?? null,
      );
    }
    const executor = this.executors.get(definition.id as SystemActionId);
    if (!executor) throw new SystemActionGatewayError("system_action_not_implemented", `No executor registered for '${actionId}'`);
    const output = await executor(parsedInput.data, { ...context, policy_decision: policy });
    const parsedOutput = definition.output_schema.safeParse(output);
    if (!parsedOutput.success) throw new SystemActionGatewayError("system_action_invalid_output", parsedOutput.error.message);
    const executorDecisionId = policyDecisionRecordIdFromOutput(parsedOutput.data);
    const result = {
      definition,
      output: parsedOutput.data,
      policy_decision_record_id: executorDecisionId ?? policy.policy_decision_record_id ?? null,
    };
    await this.hooks.onCompleted?.(definition, result, context);
    return result;
    } catch(error) {
      await this.hooks.onFailed?.(definition,error,context);
      throw error;
    }
  }
}

function policyRequiresApproval(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const value = details as Record<string, unknown>;
  return value.status === "require_approval"
    || value.decision === "require_approval"
    || value.error_code === "policy_requires_approval";
}

function policyDecisionRecordIdFromOutput(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const summary = (output as { summary?: unknown }).summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const value = (summary as { policy_decision_record_id?: unknown }).policy_decision_record_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
