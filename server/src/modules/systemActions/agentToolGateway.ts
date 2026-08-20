import type { CanonicalToolDefinition, RuntimeHostExecuteRequest, RuntimeHostExecuteResponse } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import {
  resolveAgentDelegationToolBinding,
  runAgentRoomToolCall,
  agentDelegatePolicyInput,
  type AgentDelegationToolDeps,
} from "../runs/managedAgentDelegationTools";
import {
  retrievalToolContribution,
  resolveRetrievalToolBinding,
  type ManagedApiRetrievalToolDeps,
  type RuntimeHostExecutor,
  runRetrievalToolCall,
  validateRetrievalToolInput,
  type ResolvedRetrievalToolBinding,
} from "../runs/managedRetrievalTools";
import type { RunRecord } from "../runs/repository";
import { PgRunRepository } from "../runs/repository";
import { getDbPool } from "../../db/pool";
import {
  executeManagedToolLoop,
  mergeManagedToolContributions,
  type ManagedToolContribution,
} from "../runs/managedToolLoop";
import type { CanonicalToolCall } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { loadSystemActionRegistry } from "./registry";
import { SystemActionGateway, type SystemActionExecutor } from "./gateway";
import type { SystemActionId } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { enforceRetrievalToolCallPolicy, type RetrievalToolPolicyAction } from "../retrieval/tool/policy";
import { loadActionRegistry } from "../policy/actionRegistry";
import { enforce } from "../policy/service";
import { SourceChannelService } from "../sources/channels/sourceChannelService";
import { ProjectSourceProposalService } from "../projects/projectSourceProposalService";
import { ProjectDefinitionProposalService } from "../projects/projectDefinitionProposalService";
import { SourceBackfillPlanningService } from "../sources/sourceBackfillService";
import { PgPlanRepository } from "../plans/repository";
import { InquiryConclusionProposalService } from "../inquiry/inquiryConclusionProposalService";
import { InquiryThreadProposalService } from "../inquiry/inquiryThreadProposalService";
import { KnowledgePromotionCandidateService } from "../knowledgePromotion/candidateService";
import { assembleRunInputEnvelope } from "../runs/runInputEnvelope";
import { AuthorizationRequestService } from "../policy/authorizationRequestService";
import { SystemActionGatewayError } from "./gateway";
import { ActionApprovalGrantService } from "../policy/actionApprovalGrantService";
import {
  DURABLE_ACTION_CLAIM_POLICY,
  PLAIN_STATUS_RESPONSE_POLICY,
} from "./conversationPolicy";
import { ResearchAcquisitionService } from "../projectResearch/pipeline/researchAcquisitionService";
import { PgAgentGroupRepository } from "../agentGroups/repository";

export interface AgentToolGatewayDeps extends ManagedApiRetrievalToolDeps {
  agentDelegationTools?: AgentDelegationToolDeps;
  actionEventSink?: (eventType: "action_invoked" | "action_completed", call: CanonicalToolCall, metadata?: Record<string, unknown>) => Promise<void>;
  abortSignal?: AbortSignal;
}

const GENERIC_TRANSPORT_ACTION_IDS = ["authorization.request", "source.channel.propose_activation", "project.source.propose_bind", "project.propose_definition", "source.backfill.propose_start", "task.plan.propose", "inquiry.propose_thread", "inquiry.record_conclusion", "inquiry.promote_knowledge"];
const GENERIC_PROPOSAL_ACTION_IDS = GENERIC_TRANSPORT_ACTION_IDS.filter((id) => id !== "authorization.request");
// `research.start_acquisition` is a direct, non-proposal durable action
// (room-advancement-reliability-plan Phase 4) — it does not belong in
// GENERIC_TRANSPORT_ACTION_IDS, whose tool/binding metadata always describes
// a proposal (`side_effect_level: "proposal"`, `approval_required: true`).
const RESEARCH_ACQUISITION_ACTION_ID = "research.start_acquisition";
const MANAGED_ACTION_RESPONSE_POLICY = [
  "System action schemas and tool results are internal execution details.",
  "Do not print raw action arguments, JSON schemas, placeholder payloads, or tool-result objects unless the user explicitly asks for JSON.",
  DURABLE_ACTION_CLAIM_POLICY,
  "When the user has clearly confirmed a supported action, call the action instead of simulating it in prose; then summarize the real result in ordinary language.",
  PLAIN_STATUS_RESPONSE_POLICY,
  "If no offered action can perform the request, state that limitation briefly and point to the owning product area.",
].join(" ");

/** Managed-run adapter over the registry-driven action surface. */
export class AgentToolGateway {
  constructor(private readonly config: ServerConfig) {}

  async execute(
    run: RunRecord,
    request: RuntimeHostExecuteRequest,
    execute: RuntimeHostExecutor,
    deps: AgentToolGatewayDeps = {},
  ): Promise<RuntimeHostExecuteResponse> {
    const [retrieval, delegation] = await Promise.all([
      resolveRetrievalToolBinding(this.config, run, deps),
      resolveAgentDelegationToolBinding(this.config, run, deps.agentDelegationTools),
    ]);
    const registry = await loadSystemActionRegistry();
    const executors = new Map<SystemActionId, SystemActionExecutor>();
    const grantedActionIds = new Set(
      assembleRunInputEnvelope(run).tool_grants.map((grant) => grant.action_id),
    );

    const genericDefinitions: CanonicalToolDefinition[] = [...registry.values()]
      .filter(
        (definition) =>
          GENERIC_TRANSPORT_ACTION_IDS.includes(definition.id) &&
          grantedActionIds.has(definition.id),
      )
      .map((definition) => ({ name: definition.id, description: definition.description, input_schema: proposalActionJsonSchema(definition.id) }));

    const genericBindings = genericDefinitions.map((tool) => ({
      id: tool.name,
      external_type: "internal",
      external_ref: tool.name,
      display_name: tool.name,
      required_scopes: [tool.name],
      credential_ref: null,
      data_exposure_level: "model_provider",
      observability_level: "structured_events",
      side_effect_level: "proposal",
      approval_required: true,
    }));

    const researchAcquisitionRegistryDefinition = registry.get(RESEARCH_ACQUISITION_ACTION_ID as SystemActionId);
    const researchAcquisitionDefinitions: CanonicalToolDefinition[] = researchAcquisitionRegistryDefinition
      ? [{ name: RESEARCH_ACQUISITION_ACTION_ID, description: researchAcquisitionRegistryDefinition.description, input_schema: researchAcquisitionActionJsonSchema() }]
      : [];
    const researchAcquisitionBindings = researchAcquisitionDefinitions.map((tool) => ({
      id: tool.name,
      external_type: "internal",
      external_ref: tool.name,
      display_name: tool.name,
      required_scopes: [tool.name],
      credential_ref: null,
      data_exposure_level: "model_provider",
      observability_level: "structured_events",
      side_effect_level: "durable",
      approval_required: false,
    }));

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

    if (genericDefinitions.length && this.config.databaseUrl && run.instructed_by_user_id) {
      this.registerGenericProposalExecutors(executors, run);
    }
    if (permittedResearchAcquisitionDefinitions.length && this.config.databaseUrl && run.instructed_by_user_id) {
      this.registerResearchAcquisitionExecutor(executors, run);
    }

    const actionEvents = deps.actionEventSink ?? this.actionEventSink(run);
    const actor = {
      spaceId: run.space_id,
      instructedByUserId: run.instructed_by_user_id as string,
      agentId: run.agent_id,
      runId: run.id,
    };

    if (retrieval) {
      for (const definition of registry.values()) {
        if (definition.application_service !== "RetrievalToolService.search" && definition.application_service !== "RetrievalToolService.brief") continue;
        executors.set(definition.id as SystemActionId, async (input, context) => {
          const result = await runRetrievalToolCall(
            { id: definition.id, name: definition.id, arguments_json: JSON.stringify(input) },
            retrieval,
            actor,
            run,
            true,
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

    // RetrievalToolService and AgentGroupRunService are the canonical policy
    // adapters today; each executor performs the fail-closed PolicyGateway
    // decision and returns its durable decision-record id in the summary.
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
      (definition, input) => this.enforcePolicyForAction(definition, input, run, retrieval, actor, delegation),
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

    const dispatch = async (call: CanonicalToolCall) => {
      if (!grantedActionIds.has(call.name)) {
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
        const dispatched = await gateway.dispatch(call.name, input, {
          actor: { type: "agent", space_id: run.space_id, agent_id: run.agent_id, user_id: run.instructed_by_user_id, run_id: run.id },
          visibility: "agent_tool",
          idempotency_key: call.id,
        });
        return dispatched.output as { modelResult: unknown; summary: Record<string, unknown>; artifact?: unknown; suspend?: RuntimeHostExecuteResponse };
      } catch (error) {
        return this.toolCallFailureResult(call, error);
      }
    };

    // One loop for every managed tool family, assembled from three named
    // contributions. A family with nothing to offer contributes nothing; there
    // is no placeholder carrier, and no family owns the loop on behalf of the
    // others. Retrieval resolves last because a preflight mode performs a
    // governed call through the dispatch built above.
    const contributions: (ManagedToolContribution | null)[] = [
      retrieval
        ? await retrievalToolContribution(retrieval, run, request, request.messages ?? [], dispatch)
        : null,
      delegation
        ? { definitions: delegation.toolDefinitions, bindings: delegation.toolBindings }
        : null,
      permittedGenericDefinitions.length
        ? { definitions: permittedGenericDefinitions, bindings: permittedGenericBindings }
        : null,
      permittedResearchAcquisitionDefinitions.length
        ? { definitions: permittedResearchAcquisitionDefinitions, bindings: permittedResearchAcquisitionBindings }
        : null,
    ];
    return executeManagedToolLoop(
      this.config,
      {
        ...request,
        system_prompt: [request.system_prompt, MANAGED_ACTION_RESPONSE_POLICY]
          .filter((value): value is string => Boolean(value))
          .join("\n\n"),
      },
      execute,
      mergeManagedToolContributions(contributions, dispatch),
      { signal: deps.abortSignal },
    );
  }

  private registerGenericProposalExecutors(executors: Map<SystemActionId, SystemActionExecutor>, run: RunRecord): void {
    const db = getDbPool(this.config.databaseUrl!);
    const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

    executors.set("authorization.request" as SystemActionId, async (input) => {
      const body = input as { policy_decision_record_id: string; reason: string };
      const request = await new AuthorizationRequestService(db, this.config).createFromDeniedDecision({
        spaceId: run.space_id,
        runId: run.id,
        agentId: run.agent_id,
        policyDecisionRecordId: body.policy_decision_record_id,
        reason: body.reason,
      });
      return {
        modelResult: { ok: true, authorization_request: request },
        summary: {
          tool_name: "authorization.request",
          ok: true,
          authorization_request_id: request.id,
          status: request.status,
        },
        suspend: authorizationRequestPauseResponse(request.id),
      };
    });

    executors.set("source.channel.propose_activation" as SystemActionId, async (input, context) => {
      const result = await new SourceChannelService(db, this.config).proposeActivation(identity, input as Record<string, unknown>, {
        agentId: run.agent_id,
        runId: run.id,
        idempotencyKey: context.idempotency_key,
        projectId: run.project_id,
      });
      return {
        modelResult: { ok: true, proposal: result.proposal },
        summary: { tool_name: "source.channel.propose_activation", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
      };
    });

    executors.set("project.source.propose_bind" as SystemActionId, async (input, context) => {
      if (!run.project_id) throw new Error("project.source.propose_bind requires a project-scoped run");
      const result = await new ProjectSourceProposalService(db, this.config).proposeBind(identity, run.project_id, input as Record<string, unknown>, {
        agentId: run.agent_id,
        runId: run.id,
        idempotencyKey: context.idempotency_key,
      });
      return {
        modelResult: { ok: true, proposal: result.proposal },
        summary: { tool_name: "project.source.propose_bind", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
      };
    });

    executors.set("source.backfill.propose_start" as SystemActionId, async (input, context) => {
      const body = input as Record<string, unknown>;
      const channelId = String(body.source_channel_id ?? "");
      const planId = String(body.source_backfill_plan_id ?? "");
      const result = await new SourceBackfillPlanningService(db, this.config).proposeStart(identity, channelId, planId, {
        agentId: run.agent_id,
        runId: run.id,
        idempotencyKey: context.idempotency_key,
        projectId: run.project_id,
      });
      return {
        modelResult: { ok: true, proposal: result.proposal },
        summary: { tool_name: "source.backfill.propose_start", ok: true, proposal_id: (result.proposal as { id?: string }).id, auto_applied: result.auto_applied },
      };
    });

    executors.set("task.plan.propose" as SystemActionId, async (input, context) => {
      const body = input as Record<string, unknown>;
      const plan = await new PgPlanRepository(db).createPlanFromAgent(identity, {
        sourceTaskId: String(body.task_id ?? ""),
        planId: typeof body.plan_id === "string" ? body.plan_id : null,
        planningRunId: run.id,
        planningToolCallId: context.idempotency_key ?? "",
        agentId: run.agent_id,
        definitionJson: body.definition_json,
        referenceWorkflowVersionId: typeof body.reference_workflow_version_id === "string" ? body.reference_workflow_version_id : null,
        budgetCap: typeof body.budget_cap === "number" ? body.budget_cap : null,
        plannerMetadata: body.planner_metadata && typeof body.planner_metadata === "object" && !Array.isArray(body.planner_metadata) ? body.planner_metadata as Record<string, unknown> : null,
      });
      return {
        modelResult: { ok: true, plan },
        summary: { tool_name: "task.plan.propose", ok: true, plan_id: (plan as { id?: string }).id, plan_version_id: (plan as { current_version?: { id?: string } }).current_version?.id },
      };
    });

    executors.set("inquiry.propose_thread" as SystemActionId, async (input, context) => {
      if (!run.project_id) throw new Error("inquiry.propose_thread requires a project-scoped run");
      const result = await new InquiryThreadProposalService(db).proposeThread(
        identity,
        run.project_id,
        input as Record<string, unknown>,
        {
          agentId: run.agent_id,
          runId: run.id,
          idempotencyKey: context.idempotency_key,
          visibility: runVisibility(run.visibility),
        },
      );
      return {
        modelResult: { ok: true, proposal: result.proposal },
        summary: { tool_name: "inquiry.propose_thread", ok: true, proposal_id: (result.proposal as { id?: string }).id },
      };
    });

    executors.set("project.propose_definition" as SystemActionId, async (input, context) => {
      if (!run.project_id) throw new Error("project.propose_definition requires a project-scoped run");
      const result = await new ProjectDefinitionProposalService(db).proposeDefinition(
        identity,
        run.project_id,
        input as Record<string, unknown>,
        {
          agentId: run.agent_id,
          runId: run.id,
          idempotencyKey: context.idempotency_key,
          visibility: runVisibility(run.visibility),
        },
      );
      return {
        modelResult: { ok: true, proposal: result.proposal },
        summary: { tool_name: "project.propose_definition", ok: true, proposal_id: (result.proposal as { id?: string }).id },
      };
    });

    executors.set("inquiry.record_conclusion" as SystemActionId, async (input, context) => {
      if (!run.project_id) throw new Error("inquiry.record_conclusion requires a project-scoped run");
      const result = await new InquiryConclusionProposalService(db).proposeConclusion(
        identity,
        run.project_id,
        input as Record<string, unknown>,
        {
          agentId: run.agent_id,
          runId: run.id,
          idempotencyKey: context.idempotency_key,
          visibility: runVisibility(run.visibility),
        },
      );
      return {
        modelResult: { ok: true, proposal: result.proposal },
        summary: { tool_name: "inquiry.record_conclusion", ok: true, proposal_id: (result.proposal as { id?: string }).id },
      };
    });

    executors.set("inquiry.promote_knowledge" as SystemActionId, async (input, context) => {
      if (!run.project_id) throw new Error("inquiry.promote_knowledge requires a project-scoped run");
      const result = await new KnowledgePromotionCandidateService(db).proposeFromThreadForAgent(
        identity,
        run.project_id,
        input as Record<string, unknown>,
        {
          agentId: run.agent_id,
          runId: run.id,
          idempotencyKey: context.idempotency_key,
          visibility: runVisibility(run.visibility),
        },
      );
      return {
        modelResult: { ok: true, candidate: result.candidate },
        summary: { tool_name: "inquiry.promote_knowledge", ok: true, proposal_id: result.proposal_id },
      };
    });
  }

  /** `research.start_acquisition` (room-advancement-reliability-plan Phase 4):
   * unlike the generic proposal set, this is direct-execution, so the
   * executor calls `ResearchAcquisitionService` rather than a proposal
   * service. Room origin is resolved from the Run's own agent-group
   * membership — the same lookup `AgentGroupRunLifecycleProjector` uses for
   * delegation-completion notifications — not carried by the tool call
   * itself, matching how `agent.delegate` never asks the model for room
   * context either. */
  private registerResearchAcquisitionExecutor(executors: Map<SystemActionId, SystemActionExecutor>, run: RunRecord): void {
    const db = getDbPool(this.config.databaseUrl!);
    const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };
    executors.set(RESEARCH_ACQUISITION_ACTION_ID as SystemActionId, async (input) => {
      if (!run.project_id) throw new Error("research.start_acquisition requires a project-scoped run");
      const body = input as { thread_id: string; intent_note?: string };
      const origin = run.run_group_id ? await new PgAgentGroupRepository(db).getGroup(run.space_id, run.run_group_id) : null;
      const result = await new ResearchAcquisitionService(db).startAcquisition(identity, run.project_id, {
        threadId: body.thread_id,
        intentNote: body.intent_note ?? null,
        originRoomId: origin?.room_id ?? null,
        originSessionId: origin?.session_id ?? null,
      });
      return {
        modelResult: { ok: true, tool: RESEARCH_ACQUISITION_ACTION_ID, ...result },
        summary: { tool_name: RESEARCH_ACQUISITION_ACTION_ID, ok: true, ...result },
      };
    });
  }

  private async enforcePolicyForAction(
    definition: { id: string; application_service: string; policy_action: string; owning_module: string },
    input: unknown,
    run: RunRecord,
    retrieval: ResolvedRetrievalToolBinding | null,
    actor: { spaceId: string; instructedByUserId: string; agentId: string; runId: string },
    delegation: Awaited<ReturnType<typeof resolveAgentDelegationToolBinding>>,
  ) {
    if (definition.id === "authorization.request" && this.config.databaseUrl) {
      const decision = await enforce({ databaseUrl: this.config.databaseUrl }, await loadActionRegistry(), {
        action: definition.policy_action,
        force_record: true,
        actor_type: "agent",
        actor_id: run.agent_id,
        space_id: run.space_id,
        resource_space_id: run.space_id,
        resource_type: "authorization_request",
        resource_id: run.id,
        run_id: run.id,
        context: { action_id: definition.id, instructed_by_user_id: run.instructed_by_user_id },
        metadata_json: { surface: "managed_run_system_action_gateway", action_id: definition.id },
      });
      return {
        allowed: decision.status === "allow",
        policy_decision_record_id: decision.policy_decision_record_id ?? null,
        reason: decision.message ?? undefined,
        details: decision,
      };
    }
    if (definition.id === "agent.delegate" && delegation?.service.preflightSpawnChildRunPolicy) {
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

    if (definition.id === "research.start_acquisition" && this.config.databaseUrl) {
      // `thread_id` is required and non-empty by this point — `dispatch`
      // (gateway.ts) already ran the strict input schema before calling
      // this policy branch — so this is always the real Thread id, never a
      // fallback.
      const threadId = String((input as Record<string, unknown>).thread_id);
      const decision = await enforce({ databaseUrl: this.config.databaseUrl }, await loadActionRegistry(), {
        action: definition.policy_action,
        force_record: true,
        actor_type: "agent",
        actor_id: run.agent_id,
        space_id: run.space_id,
        resource_space_id: run.space_id,
        resource_type: "inquiry_thread",
        resource_id: threadId,
        run_id: run.id,
        context: { action_id: definition.id, project_id: run.project_id, instructed_by_user_id: run.instructed_by_user_id },
        metadata_json: { surface: "managed_run_system_action_gateway", action_id: definition.id },
      });
      return {
        allowed: decision.status === "allow",
        policy_decision_record_id: decision.policy_decision_record_id ?? null,
        reason: decision.message ?? undefined,
        details: decision,
      };
    }

    if (definition.application_service.startsWith("RetrievalToolService.")) {
      validateRetrievalToolInput(definition.id, input);
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
        databaseUrl: retrieval ? retrieval.policyDatabaseUrl : this.config.databaseUrl,
        actor,
        action: definition.id as RetrievalToolPolicyAction,
        domain,
        domainEnabled: Boolean(retrieval?.services[domain as keyof typeof retrieval.services]),
        surface: "managed_run_system_action_gateway",
      });
      return { allowed: true, policy_decision_record_id: decision.policy_decision_record_id };
    }

    if (definition.id === "agent.wait_for_results" && this.config.databaseUrl) {
      const decision = await enforce({ databaseUrl: this.config.databaseUrl }, await loadActionRegistry(), {
        action: definition.policy_action,
        force_record: true,
        actor_type: "agent",
        actor_id: run.agent_id,
        space_id: run.space_id,
        resource_space_id: run.space_id,
        resource_type: "run",
        resource_id: run.id,
        run_id: run.id,
        context: { tool_name: definition.id, instructed_by_user_id: run.instructed_by_user_id },
        metadata_json: { surface: "managed_run_system_action_gateway", action_id: definition.id },
      });
      return {
        allowed: decision.status === "allow",
        policy_decision_record_id: decision.policy_decision_record_id ?? null,
        reason: decision.message ?? undefined,
        details: decision,
      };
    }

    if (GENERIC_PROPOSAL_ACTION_IDS.includes(definition.id) && this.config.databaseUrl) {
      const resourceType = definition.id === "source.backfill.propose_start" ? "source_backfill_plan" : definition.id === "task.plan.propose" ? "plan" : definition.owning_module;
      const resourceId = definition.id === "source.backfill.propose_start"
        ? String((input as Record<string, unknown>).source_backfill_plan_id ?? run.id)
        : definition.id === "task.plan.propose"
          ? String((input as Record<string, unknown>).task_id ?? run.id)
        : (run.project_id ?? run.id);
      const hasActionGrant = await new ActionApprovalGrantService(
        getDbPool(this.config.databaseUrl),
      ).hasMatching({
        spaceId: run.space_id,
        agentId: run.agent_id,
        actionId: definition.id,
        runId: run.id,
        projectId: run.project_id,
        resourceKind: resourceType,
        resourceId,
      });
      const decision = await enforce({ databaseUrl: this.config.databaseUrl }, await loadActionRegistry(), {
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
          project_id: run.project_id,
          instructed_by_user_id: run.instructed_by_user_id,
          surface: "managed_run_system_action_gateway",
          has_action_approval_grant: hasActionGrant,
        },
        metadata_json: {
          surface: "managed_run_system_action_gateway",
          action_id: definition.id,
        },
      });
      return {
        allowed: decision.status === "allow",
        policy_decision_record_id: decision.policy_decision_record_id ?? null,
        reason: decision.message ?? undefined,
        details: decision,
      };
    }

    return { allowed: false, reason: "No canonical policy adapter is registered for this action" };
  }

  private toolCallFailureResult(call: CanonicalToolCall, error: unknown) {
    const disabledRetrievalDomain = error instanceof Error && error.message.includes("is not enabled for domain");
    const errorCode = disabledRetrievalDomain
      ? "retrieval_tool_domain_not_enabled"
      : ((error as { code?: string }).code ?? (call.name.includes("retrieval") ? "retrieval_tool_call_failed" : "system_action_failed"));
    return {
      modelResult: {
        ok: false,
        tool: call.name,
        error_code: errorCode,
        error: disabledRetrievalDomain ? "Retrieval tool domain is not enabled for this run." : error instanceof Error ? error.message : "Action failed",
        ...(policyDecisionRecordId(error)
          ? { policy_decision_record_id: policyDecisionRecordId(error) }
          : {}),
      },
      summary: {
        tool_name: call.name,
        ...(disabledRetrievalDomain ? { domain: call.name.split(".")[0] === "memory" ? "memory" : call.name.split(".")[0] } : {}),
        ok: false,
        error_code: errorCode,
        ...(policyDecisionRecordId(error)
          ? { policy_decision_record_id: policyDecisionRecordId(error) }
          : {}),
      },
    };
  }

  private actionEventSink(run: RunRecord) {
    if (!this.config.databaseUrl) return undefined;
    const repository = new PgRunRepository(getDbPool(this.config.databaseUrl));
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
}

function policyDecisionRecordId(error: unknown): string | null {
  if (error instanceof SystemActionGatewayError) return error.policy_decision_record_id;
  if (!error || typeof error !== "object") return null;
  const value = (error as { policy_decision_record_id?: unknown }).policy_decision_record_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function authorizationRequestPauseResponse(requestId: string): RuntimeHostExecuteResponse {
  return {
    success: false,
    stdout: "",
    stderr: "",
    output_text: "",
    output_json: {
      authorization_request_id: requestId,
      authorization_request_status: "pending",
    },
    exit_code: null,
    error_text: "Agent authorization request is pending review.",
    error_code: "authorization_request_pending",
    started_at: null,
    completed_at: new Date().toISOString(),
    model: null,
    usage: null,
    events: [],
    adapter_metadata: {},
    adapter_log_json: null,
  };
}

export function proposalActionJsonSchema(actionId: string): Record<string, unknown> {
  const properties: Record<string, unknown> =
      actionId === "authorization.request"
        ? {
            policy_decision_record_id: { type: "string" },
            reason: { type: "string", minLength: 1, maxLength: 1000 },
          }
      : actionId === "task.plan.propose"
        ? {
            task_id: { type: "string" },
            plan_id: { type: ["string", "null"] },
            definition_json: { type: "object" },
            reference_workflow_version_id: { type: ["string", "null"] },
            budget_cap: { type: ["number", "null"] },
            budget_sources: { type: "array" },
            planner_metadata: { type: ["object", "null"] },
          }
        : actionId === "source.channel.propose_activation"
      ? { provider_key: { type: "string" }, name: { type: "string" }, query: { type: "object" }, endpoint_url: { type: "string" } }
      : actionId === "project.source.propose_bind"
        ? { source_channel_id: { type: "string" } }
      : actionId === "inquiry.propose_thread"
        ? {
            kind: { type: "string", enum: ["question", "hypothesis"] },
            statement: { type: "string" },
            answerability: { type: "string" },
            resolution_criteria: { type: "string" },
            proposed_claim: { type: "string" },
            predictions: { type: "string" },
            falsification_criteria: { type: "string" },
          }
      : actionId === "project.propose_definition"
        ? {
            goal: { type: "string", description: "The formal Project goal or core problem statement." },
            scope_included: { type: "string" },
            scope_excluded: { type: "string" },
            success_definition: { type: "string" },
            constraints: { type: "string" },
            assumptions: { type: "string" },
          }
      : actionId === "inquiry.record_conclusion"
        ? {
            thread_id: { type: "string" },
            change_summary: { type: "string" },
            reasoning_summary: { type: "string" },
            answer_state: { type: "string", enum: ["open", "partial", "answered", "unanswerable"] },
            current_answer_summary: { type: "string" },
            known_gaps: { type: "string" },
            answerability: { type: "string" },
            evaluation_state: { type: "string", enum: ["untested", "supported", "challenged", "contradicted", "inconclusive"] },
            confidence: { type: "number" },
            confidence_method: { type: "string" },
            unresolved_gaps: { type: "string" },
            confirmed_next_focus: { type: "string" },
            next_focus_note: { type: "string" },
          }
      : actionId === "inquiry.promote_knowledge"
        ? {
            thread_id: { type: "string" },
            candidate_kind: { type: "string", enum: ["concept", "lesson", "procedure", "decision", "summary"] },
            proposed_title: { type: "string" },
            proposed_content: { type: "string" },
            supersedes_knowledge_item_id: { type: "string" },
          }
        : { source_channel_id: { type: "string" }, source_backfill_plan_id: { type: "string" } };
  const required = actionId === "project.propose_definition"
    ? ["goal"]
    : actionId === "inquiry.propose_thread"
    ? ["statement"]
    : actionId === "inquiry.record_conclusion"
    ? ["thread_id", "change_summary"]
    : actionId === "inquiry.promote_knowledge"
      ? ["thread_id", "candidate_kind", "proposed_title", "proposed_content"]
      : Object.keys(properties);
  return { type: "object", properties, required, additionalProperties: true };
}

export function researchAcquisitionActionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The accepted Inquiry Thread (Question) to start acquisition for." },
      intent_note: { type: "string", description: "Optional short note on why acquisition is starting now." },
    },
    required: ["thread_id"],
    additionalProperties: false,
  };
}

function runVisibility(value: unknown): "private" | "space_shared" | "selected_users" {
  return value === "selected_users" || value === "space_shared" ? value : "private";
}
