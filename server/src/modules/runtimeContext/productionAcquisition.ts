import type {
  ContextItem,
  MessageOut,
  RetrievalObjectType,
  SemanticCheckpoint,
} from "@rainver/protocol";
import * as protocol from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import {
  PgRuntimeContextAcquisitionRepository,
  type RunContextRecord,
} from "./acquisitionRepository.js";
import { RetrievalRegistry, RetrievalSearchService } from "../retrieval/index.js";
import { knowledgeRetrievalAdapter } from "../knowledge/retrievalAdapter.js";
import { memoryRetrievalAdapter } from "../memory/retrievalAdapter.js";
import { projectRetrievalAdapter } from "../projects/retrievalAdapter.js";
import { sourceRetrievalAdapter } from "../sources/retrievalAdapter.js";
import { inquiryRetrievalAdapter } from "../inquiry/retrievalAdapter.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import {
  loadSourcePolicySnapshots,
  sourceEgressPoliciesForSnapshots,
} from "../retrieval/sourcePolicy.js";
import {
  retrievalEgressAllowed,
  runtimeProviderEgressDestination,
  type RetrievalEgressDestination,
} from "../retrieval/egress/egressPolicy.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";
import {
  ContentAccessAuditService,
  contentResourceTypeForRetrievalObject,
} from "../contentAccess/audit.js";
import { ContextWindowReconciliationRepository } from "./reconciliationRepository.js";
import { normalizeContextItem } from "./itemNormalizer.js";
import {
  RuntimeContextAcquisitionComposition,
  type RuntimeContextAuthorityPort,
  type RuntimeContextAuthoritySnapshot,
  type RuntimeContextChannelProvider,
  type RuntimeContextRetrievalIntentPort,
} from "./acquisitionComposition.js";
import { RuntimeContextPlanningService, type RuntimeContextPlanningRequest } from "./planningService.js";
import { RetrievalCoordinator, type RetrievalContextAuthorizationPort } from "./retrievalCoordinator.js";
import { resolveExplicitReferences, roomScopedAgentReadSql } from "./workContextService.js";
import { PgSessionRepository } from "../sessions/repository.js";
import {
  buildChatConversationWindow,
  renderConversationWindow,
} from "../agents/messageContinuityWindow.js";
import {
  loadActiveSemanticCheckpoint,
  loadConversationContinuityThroughMessage,
  loadRoomContinuityForRunRequest,
} from "./conversationContinuity.js";
import { assembleRoomConversationContext, type RoomSummaryCoverage } from "../rooms/conversationContext.js";
import {
  PgRuntimeSkillProvider,
  renderRuntimeSkillCandidate,
  type RuntimeSkillCandidate,
} from "../capabilities/runtimeSkillProvider.js";
import { enforce } from "../policy/service.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { isVendorCliAdapter } from "../runtimeAdapters/specs.js";

type SetupRow = {
  id: string;
  version: number;
  scope_kind: string;
  project_id: string | null;
  agent_id: string | null;
  retrieval_preferences_json: unknown;
  pinned_refs_json: unknown;
  excluded_refs_json: unknown;
};

const registry = new RetrievalRegistry();
for (const adapter of [
  knowledgeRetrievalAdapter,
  memoryRetrievalAdapter,
  projectRetrievalAdapter,
  sourceRetrievalAdapter,
  inquiryRetrievalAdapter,
]) registry.register(adapter);

class PgAuthorityProvider implements RuntimeContextAuthorityPort {
  private readonly context: PgRuntimeContextAcquisitionRepository;

  constructor(private readonly db: Pool) {
    this.context = new PgRuntimeContextAcquisitionRepository(db);
  }

  async resolve(request: RuntimeContextPlanningRequest): Promise<RuntimeContextAuthoritySnapshot> {
    const setup = await loadSetup(this.db, request);
    const run = await loadInvocationRun(this.db, this.context, request);
    if (!run || (run.owner_user_id !== request.identity.userId && run.instructed_by_user_id !== request.identity.userId)) {
      throw new Error("Runtime Context root task is not readable by the requesting user");
    }
    const control = await this.context.loadExecutionControlSnapshot(request.identity.spaceId, run.id);
    if (!control || control.work_context_setup_ref?.id !== setup.id
      || control.work_context_setup_ref.version !== String(setup.version)
      || control.agent_id !== setup.agent_id) {
      throw new Error("Execution control snapshot does not match the active Work Context authority");
    }
    if (!setup.agent_id) throw new Error("Agent task context requires an authoritative Agent id");
    const agent = await this.db.query(
      `SELECT 1 FROM agents agent
        WHERE agent.id=$1 AND agent.space_id=$2 AND agent.status='active'
          AND (
            ${contentReadSql("agent", "agent", "$3")}
            OR (
              $4::varchar = 'room_recipient'
              AND ${roomScopedAgentReadSql("agent", "$3", "$5")}
            )
          )`,
      [setup.agent_id, request.identity.spaceId, request.identity.userId, setup.scope_kind, request.turn.work_context_scope_id],
    );
    if (!agent.rows[0]) throw new Error("Runtime Context Agent authority is no longer active or readable");
    const egressDestination = await revalidateExecutionDestination(this.db, control, run.adapter_type ?? null);
    const modelOverride = record(run.model_override_json);
    const modelConfig = record(run.model_config_json);
    // Keep planning authority aligned with runtimeProviderBinding.modelFromRun:
    // a per-run override wins over the immutable AgentVersion default.
    const model = stringValue(modelOverride.model)
      ?? stringValue(modelConfig.model)
      ?? (control.egress.destination_type === "model_provider"
        ? await providerDefaultModel(this.db, run.space_id, control.egress.destination_id)
        : null);
    if (!model) throw new Error("Runtime Context planning requires a resolved model");
    return {
      executionControlSnapshotId: control.id,
      setupRef: { type: "work_context_setup", id: setup.id, version: String(setup.version) },
      model,
      outputReserveTokens: control.output_contract.max_output_tokens,
      modelWindowOverride: null,
      agentId: setup.agent_id,
      projectId: setup.project_id,
      controlSnapshot: control,
      egressDestination,
    };
  }
}

async function providerDefaultModel(db: Pool, spaceId: string, providerId: string | null): Promise<string | null> {
  if (!providerId) return null;
  const result = await db.query<{ default_model: string | null }>(
    `SELECT provider.default_model
       FROM model_provider_space_grants provider_grant
       JOIN model_providers provider ON provider.id=provider_grant.provider_id
      WHERE provider_grant.space_id=$1 AND provider_grant.provider_id=$2
        AND provider_grant.enabled=TRUE AND provider.enabled=TRUE`,
    [spaceId, providerId],
  );
  return stringValue(result.rows[0]?.default_model);
}

class PgDirectProvider implements RuntimeContextChannelProvider {
  private readonly context: PgRuntimeContextAcquisitionRepository;
  constructor(private readonly db: Pool, private readonly config?: ServerConfig) {
    this.context = new PgRuntimeContextAcquisitionRepository(db);
  }

  async acquire(
    request: RuntimeContextPlanningRequest,
    authority: RuntimeContextAuthoritySnapshot,
    mode: "preview" | "execution",
  ): Promise<ContextItem[]> {
    const run = await loadInvocationRun(this.db, this.context, request);
    if (!run) throw new Error("Runtime Context root task disappeared during acquisition");
    const current = request.turn.current_message_ref.type === "run_request"
      && request.turn.current_message_ref.id === run.id
      ? { content: runRequestText(run), role: "run_request", created_at: "" }
      : await loadAuthorizedCurrentContextMessage(this.db, {
          messageId: request.turn.current_message_ref.id,
          spaceId: request.identity.spaceId,
          sessionId: run.session_id ?? "",
          userId: request.identity.userId,
          runId: run.id,
        });
    if (!current || !current.content.trim()) throw new Error("Current input is missing or outside the Work Context scope");
    const project = await this.context.loadPublishedProjectContext(
      request.identity.spaceId,
      authority.projectId,
      request.turn.work_context_scope_id,
      request.identity.userId,
      authority.setupRef,
      {
        brief: authority.controlSnapshot.project_brief_ref,
        instruction: authority.controlSnapshot.project_instruction_ref,
        instructionEnabled: authority.controlSnapshot.project_instruction_ref !== null,
      },
    );
    const items: ContextItem[] = [normalizeOwned({
      authority,
      request,
      // The row lookup above is the authority for the canonical source type;
      // never preserve a caller-supplied provenance label for a Message.
      sourceRef: { type: request.turn.current_message_ref.type, id: request.turn.current_message_ref.id },
      selection: "required",
      semanticRole: "user_input",
      trust: current.role === "system" ? "system_approved" : "user_confirmed",
      text: current.content,
      revalidation: { message_created_at: String(current.created_at ?? "") },
    })];
    if (request.turn.current_message_ref.type === "message" && isRoomConversation(run.model_override_json)) {
      if (run.prompt?.trim()) {
        items.push(normalizeOwned({
          authority, request,
          sourceRef: { type: "room_recipient_instruction", id: run.id },
          selection: "required", semanticRole: "user_input", trust: "user_confirmed",
          text: run.prompt,
          conflictKey: "room_recipient_instruction",
        }));
      }
      const routing = roomRoutingInstruction(run.model_override_json);
      if (routing) {
        items.push(normalizeOwned({
          authority, request,
          sourceRef: { type: "room_routing_instruction", id: run.id },
          selection: "required", semanticRole: "reference_data", trust: "derived",
          text: routing,
          conflictKey: "room_routing_instruction",
        }));
      }
    }
    if (run.prompt?.trim() && run.instruction?.trim()) {
      items.push(normalizeOwned({
        authority, request,
        sourceRef: { type: "run_instruction", id: run.id },
        selection: "required", semanticRole: "delegated_instruction", trust: "system_approved",
        text: run.instruction,
        conflictKey: "run_instruction",
      }));
    }
    const supervisorRetry = supervisorRetryContext(run.error_json);
    if (supervisorRetry) {
      items.push(normalizeOwned({
        authority, request,
        sourceRef: { type: "supervisor_retry", id: run.id },
        selection: "required", semanticRole: "delegated_instruction", trust: "system_approved",
        text: supervisorRetry,
        conflictKey: "supervisor_retry",
      }));
    }
    const roomIdentity = groupedAgentIdentityContext(run);
    if (roomIdentity) {
      items.push(normalizeOwned({
        authority, request,
        sourceRef: { type: "run_group_agent_identity", id: run.id },
        selection: "required", semanticRole: "delegated_instruction", trust: "system_approved",
        text: roomIdentity,
        conflictKey: "run_group_agent_identity",
      }));
    }
    if (run.system_prompt?.trim()) {
      if (!run.agent_version_id) throw new Error("Agent instruction has no authoritative version");
      items.push(normalizeOwned({
        authority, request,
        sourceRef: { type: "agent_version", id: run.agent_version_id },
        selection: "required", semanticRole: "delegated_instruction", trust: "system_approved",
        text: run.system_prompt,
      }));
    }
    if (project.instruction) items.push(normalizeOwned({
      authority, request,
      sourceRef: { type: "project_instruction_version", id: String(project.instruction.id), version: String(project.instruction.version) },
      selection: "required", semanticRole: "delegated_instruction", trust: "system_approved",
      text: String(project.instruction.instruction_text ?? ""),
      conflictKey: "project_instruction",
    }));
    if (project.brief) items.push(normalizeOwned({
      authority, request,
      sourceRef: { type: "project_brief_version", id: String(project.brief.id), version: String(project.brief.version) },
      selection: "required", semanticRole: "reference_data", trust: "domain_approved",
      // The model needs the Project's meaning, not its persistence/audit
      // envelope. Keep ids, version state, timestamps and reviewer identities
      // in server-owned provenance only; never serialize them into prompt text.
      text: JSON.stringify(projectBriefConversationProjection(project.brief)),
    }));
    const researchMatrix = await this.loadProjectResearchMatrix(run, request, authority);
    if (researchMatrix) items.push(researchMatrix);
    if (mode === "execution") {
      const personalGrant = await this.context.loadPersonalGrantForRun(run);
      if (personalGrant) {
        items.push(normalizeContextItem({
          sourceRef: { type: "personal_memory_grant", id: personalGrant.metadata.grant_id },
          acquisition: "direct",
          selection: "required",
          semanticRole: "reference_data",
          trust: "user_confirmed",
          sensitivity: "highly_restricted",
          visibility: "private",
          ownerUserId: personalGrant.metadata.granting_user_id,
          spaceId: request.identity.spaceId,
          // PersonalMemoryGrant is a cross-Space exception for a local Run,
          // not an implicit external-disclosure approval.
          egressEligible: authority.controlSnapshot.egress.destination_type === "local_runtime"
            && sensitivityRank("highly_restricted")
              <= sensitivityRank(authority.controlSnapshot.egress.sensitivity_ceiling),
          text: personalGrant.summary,
          structuredPayload: { grant: personalGrant.metadata },
          revalidation: {
            status: "live",
            checked_at: new Date().toISOString(),
            execution_control_snapshot_id: authority.controlSnapshot.id,
          },
        }));
      }
    }
    items.push(...await this.loadRuntimeSkillItems(run, request, authority));
    return items;
  }

  private async loadProjectResearchMatrix(
    run: RunContextRecord,
    request: RuntimeContextPlanningRequest,
    authority: RuntimeContextAuthoritySnapshot,
  ): Promise<ContextItem | null> {
    const contract = record(run.contract_snapshot_json);
    const projectResearch = record(record(contract.workflow_input_json).project_research);
    const artifactId = stringValue(projectResearch.evidence_matrix_artifact_id);
    if (!artifactId || !authority.projectId) return null;
    const result = await this.db.query<{
      content: string | null;
      visibility: "private" | "space_shared" | "selected_users";
      owner_user_id: string | null;
      updated_at: unknown;
    }>(
      `SELECT artifact.content,artifact.visibility,artifact.owner_user_id,artifact.updated_at
         FROM artifacts artifact
        WHERE artifact.id=$1 AND artifact.space_id=$2 AND artifact.project_id=$3
          AND artifact.artifact_type='evidence_matrix'
          AND ${contentReadSql("artifact", "artifact", "$4")}`,
      [artifactId, request.identity.spaceId, authority.projectId, request.identity.userId],
    );
    const row = result.rows[0];
    if (!row?.content?.trim()) throw new Error("Project Research Evidence Matrix is unavailable");
    return normalizeContextItem({
      sourceRef: { type: "project_research_evidence_matrix", id: artifactId },
      acquisition: "direct",
      selection: "required",
      semanticRole: "reference_data",
      trust: "domain_approved",
      sensitivity: "sensitive",
      visibility: row.visibility,
      ownerUserId: row.owner_user_id,
      spaceId: request.identity.spaceId,
      egressEligible: contextEgressEligible(authority, "sensitive"),
      text: row.content,
      structuredPayload: {
        project_id: authority.projectId,
        operation_id: stringValue(projectResearch.operation_id),
      },
      revalidation: {
        status: "live",
        checked_at: new Date().toISOString(),
        execution_control_snapshot_id: authority.controlSnapshot.id,
        source_updated_at: String(row.updated_at),
      },
    });
  }

  private async loadRuntimeSkillItems(
    run: RunContextRecord,
    request: RuntimeContextPlanningRequest,
    authority: RuntimeContextAuthoritySnapshot,
  ): Promise<ContextItem[]> {
    if (!run.adapter_type) return [];
    const candidates = await new PgRuntimeSkillProvider(this.db).loadCandidatesForRun({
      space_id: run.space_id,
      run_id: run.id,
      adapter_type: run.adapter_type,
      capability_id: run.capability_id,
      agent_id: run.agent_id,
      project_id: run.project_id,
      instructed_by_user_id: run.instructed_by_user_id,
      capabilities_json: run.capabilities_json,
    });
    const items: ContextItem[] = [];
    for (const candidate of candidates) {
      if (this.config) await enforceRuntimeSkillRender(this.config, run.id, run.space_id, candidate);
      const rendered = renderRuntimeSkillCandidate(candidate);
      if (!rendered) continue;
      const text = rendered.rendered.prompt_block
        ?? rendered.rendered.files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n");
      if (!text.trim()) continue;
      items.push(normalizeOwned({
        authority,
        request,
        sourceRef: {
          type: "runtime_skill_binding",
          id: candidate.binding_id,
          version: candidate.capability_version_id ?? candidate.capability.version,
        },
        selection: "required",
        semanticRole: "delegated_instruction",
        trust: "system_approved",
        text,
        structuredPayload: {
          capability_id: candidate.capability_id,
          capability_version_id: candidate.capability_version_id,
          capability_enablement_id: candidate.capability_enablement_id,
          runtime_adapter_type: candidate.runtime_adapter_type,
          render_mode: candidate.render_mode,
        },
      }));
    }
    return items;
  }
}

export async function loadAuthorizedCurrentContextMessage(
  db: Queryable,
  input: { messageId: string; spaceId: string; sessionId: string; userId: string; runId: string },
): Promise<{ content: string; role: string; created_at: unknown; metadata_run_id: string | null } | undefined> {
  return (await db.query<{ content: string; role: string; created_at: unknown; metadata_run_id: string | null }>(
    `SELECT message.content, message.role, message.created_at,
            message.metadata_json->>'run_id' AS metadata_run_id
       FROM messages message
       JOIN sessions session ON session.id=message.session_id AND session.space_id=message.space_id
       LEFT JOIN room_user_members room_member
         ON room_member.room_id=session.room_id AND room_member.space_id=session.space_id
        AND room_member.user_id=$4 AND room_member.status='active'
      WHERE message.id=$1 AND message.space_id=$2
        AND message.session_id=$3
        AND (
          (message.role='user' AND message.user_id=$4
            AND session.room_id IS NULL AND session.user_id=$4
            AND message.metadata_json->>'run_id'=$5)
          OR (message.role='user' AND message.user_id=$4
            AND session.room_id IS NOT NULL AND room_member.user_id IS NOT NULL)
          OR (message.role='system'
            AND session.room_id IS NOT NULL AND room_member.user_id IS NOT NULL
            AND message.metadata_json->>'room_display'='internal'
            AND message.metadata_json->>'continuation'='true'
            AND message.metadata_json->>'continuation_requested_by_user_id'=$4)
        )
      FOR SHARE OF message`,
    [input.messageId, input.spaceId, input.sessionId, input.userId, input.runId],
  )).rows[0];
}

const PROJECT_BRIEF_CONVERSATION_FIELDS = [
  "goal",
  "scope_included",
  "scope_excluded",
  "success_definition",
  "constraints",
  "assumptions",
  "current_focus",
  "confirmed_decisions",
  "workspace_identity",
  "workspace_boundary",
  "source_refs",
] as const;

/** Semantic Project Brief view safe to place in model-visible context text. */
export function projectBriefConversationProjection(
  brief: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of PROJECT_BRIEF_CONVERSATION_FIELDS) {
    const value = brief[field];
    if (hasConversationValue(value)) projected[field] = value;
  }
  return projected;
}

function hasConversationValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

class PgExplicitProvider implements RuntimeContextChannelProvider {
  constructor(private readonly db: Pool) {}

  async acquire(request: RuntimeContextPlanningRequest, authority: RuntimeContextAuthoritySnapshot): Promise<ContextItem[]> {
    const setupRefs = await this.db.query<{ pinned_refs_json: unknown; excluded_refs_json: unknown }>(
      `SELECT pinned_refs_json, excluded_refs_json FROM work_context_setups
        WHERE id=$1 AND space_id=$2 AND version=$3 AND user_id=$4`,
      [authority.setupRef.id, request.identity.spaceId, Number(authority.setupRef.version), request.identity.userId],
    );
    const excluded = refs(setupRefs.rows[0]?.excluded_refs_json);
    const excludedKeys = new Set(excluded.map(refKey));
    const directRefKeys = new Set([
      authority.controlSnapshot.project_brief_ref,
      authority.controlSnapshot.project_instruction_ref,
    ].flatMap((ref) => ref ? [`${ref.type}:${ref.id}`] : []));
    // The approved Brief and Instruction are already direct required inputs.
    // A Setup may also retain them in pinned_refs; acquiring them twice would
    // duplicate reference data or manufacture a mandatory instruction conflict.
    const pinned = refs(setupRefs.rows[0]?.pinned_refs_json)
      .filter((ref) => !directRefKeys.has(refKey(ref)) && !excludedKeys.has(refKey(ref)));
    const oneOff = request.turn.one_off_refs.filter((ref) => !excludedKeys.has(refKey(ref)));
    assertExplicitControls(authority, refs(setupRefs.rows[0]?.pinned_refs_json), request.turn.one_off_refs);
    const resolved = await resolveExplicitReferences(
      this.db,
      request.identity,
      [...pinned, ...oneOff],
      authority.projectId,
    );
    return resolved.map((value, index) => {
      const ref = [...pinned, ...oneOff][index]!;
      const instruction = ref.type === "project_instruction_version";
      return normalizeOwned({
        authority, request, sourceRef: ref,
        selection: "pinned",
        semanticRole: instruction ? "delegated_instruction" : "reference_data",
        trust: instruction ? "system_approved" : "user_confirmed",
        text: instruction ? String(value.instruction_text ?? "") : JSON.stringify(value),
        conflictKey: instruction ? "project_instruction" : null,
        acquisition: "explicit",
        sensitivity: "normal",
      });
    });
  }
}

class PgCheckpointContinuityProvider implements RuntimeContextChannelProvider {
  private readonly context: PgRuntimeContextAcquisitionRepository;
  private readonly sessions: PgSessionRepository;

  constructor(private readonly db: Pool) {
    this.context = new PgRuntimeContextAcquisitionRepository(db);
    this.sessions = new PgSessionRepository(db);
  }

  async acquire(
    request: RuntimeContextPlanningRequest,
    authority: RuntimeContextAuthoritySnapshot,
  ): Promise<ContextItem[]> {
    const run = await loadInvocationRun(this.db, this.context, request);
    if (!run?.session_id) return [];
    const session = await this.sessions.getConversationForBackendSelection(
      request.identity.spaceId,
      request.identity.userId,
      run.session_id,
    );
    if (!session) throw new Error("Conversation continuity is outside the active user's scope");
    const bounded = request.turn.current_message_ref.type === "message"
      ? await loadConversationContinuityThroughMessage(this.db, {
          spaceId: request.identity.spaceId,
          sessionId: session.id,
          workContextScopeId: request.turn.work_context_scope_id,
          currentMessageId: request.turn.current_message_ref.id,
        })
      : {
          ...(session.room_id
            ? await loadRoomContinuityForRunRequest(this.db, {
                spaceId: request.identity.spaceId,
                sessionId: session.id,
              })
            : {
                messages: await this.sessions.listRecentMessagesForContext(
                request.identity.spaceId,
                request.identity.userId,
                session.id,
                80,
                ) ?? [],
                room_summary: null,
                room_conversation: false,
              }),
          checkpoint: await loadActiveSemanticCheckpoint(
            this.db,
            request.identity.spaceId,
            request.turn.work_context_scope_id,
          ),
        };
    const { messages, checkpoint } = bounded;
    const current = request.turn.current_message_ref.type === "message"
      ? messages.find((message) => message.id === request.turn.current_message_ref.id)
      : syntheticRunRequestMessage(run, request);
    if (!current) throw new Error("Current conversation message is unavailable for continuity planning");
    const continuity = renderCheckpointContinuity(messages, current, checkpoint, bounded.room_summary, bounded.room_conversation);
    if (!continuity) return [];
    return [normalizeOwned({
      authority,
      request,
      sourceRef: bounded.room_summary
        ? { type: "room_conversation_summary", id: bounded.room_summary.id, version: String(bounded.room_summary.version) }
        : checkpoint
          ? { type: "semantic_checkpoint", id: checkpoint.id, version: String(checkpoint.version) }
          : { type: "session", id: session.id },
      selection: "ranked",
      semanticRole: "reference_data",
      trust: "derived",
      text: continuity.text,
      acquisition: "continuity",
      rank: 1,
      structuredPayload: {
        session_ref: { type: "session", id: session.id },
        checkpoint_ref: checkpoint
          ? { type: "semantic_checkpoint", id: checkpoint.id, version: String(checkpoint.version) }
          : null,
        message_refs: continuity.messageRefs,
        conversation_window_trace: continuity.trace,
      },
      revalidation: { session_status: session.status },
    })];
  }
}

export function renderCheckpointContinuity(
  messages: readonly MessageOut[],
  current: MessageOut,
  checkpoint: SemanticCheckpoint | null,
  roomSummary: RoomSummaryCoverage | null = null,
  roomConversation = false,
): { text: string; messageRefs: Array<{ type: "message"; id: string }>; trace: Record<string, unknown> } | null {
  if (roomConversation) {
    const roomContext = assembleRoomConversationContext({ messages, currentMessage: current, summary: roomSummary });
    if (!roomContext) return null;
    const recent = roomContext.recent_messages.length > 0
      ? ["[Recent Room turns]", ...roomContext.recent_messages.map((message) => `${message.role}:\n${message.content}`)].join("\n\n")
      : "";
    const summary = roomContext.summary?.summary_text
      ? `[Room rolling summary]\n${roomContext.summary.summary_text}`
      : "";
    return {
      text: [summary, recent].filter(Boolean).join("\n\n"),
      messageRefs: roomContext.message_refs.map((id) => ({ type: "message" as const, id })),
      trace: {
        ...roomContext.trace,
        semantic_checkpoint_ref: null,
        semantic_checkpoint_cursor: checkpoint?.covered_cursor ?? null,
      },
    };
  }
  const window = buildChatConversationWindow({ messages, currentMessage: current });
  const history = renderConversationWindow({
    ...window,
    messages: window.messages.filter((message) => !message.current),
  }).trim();
  const checkpointText = checkpoint ? renderSemanticCheckpoint(checkpoint) : "";
  const text = [checkpointText, history].filter(Boolean).join("\n\n");
  if (!text) return null;
  return {
    text,
    messageRefs: window.messages
      .filter((message) => !message.current && message.message_id)
      .map((message) => ({ type: "message" as const, id: message.message_id! })),
    trace: {
      ...window.trace,
      semantic_checkpoint_ref: checkpoint
        ? { type: "semantic_checkpoint", id: checkpoint.id, version: String(checkpoint.version) }
        : null,
      semantic_checkpoint_cursor: checkpoint?.covered_cursor ?? null,
    },
  };
}

function renderSemanticCheckpoint(checkpoint: SemanticCheckpoint): string {
  return `Validated continuity checkpoint (derived reference data):\n${JSON.stringify({
    goals: checkpoint.goals,
    user_intent: checkpoint.user_intent,
    decisions: checkpoint.decisions,
    constraints: checkpoint.constraints,
    facts: checkpoint.facts,
    open_questions: checkpoint.open_questions,
    tasks: checkpoint.tasks,
    artifact_refs: checkpoint.artifact_refs,
    tool_refs: checkpoint.tool_refs,
    correction_refs: checkpoint.correction_refs,
  })}`;
}

class PgRetrievalIntentProvider implements RuntimeContextRetrievalIntentPort {
  constructor(private readonly db: Pool) {}

  async resolve(request: RuntimeContextPlanningRequest, authority: RuntimeContextAuthoritySnapshot) {
    const setup = await loadSetup(this.db, request);
    const preferences = record(setup.retrieval_preferences_json);
    const scope = authority.controlSnapshot.readable_scope;
    if (preferences.enabled === false || !scope.retrieval_enabled) return null;
    const query = request.turn.retrieval_intent?.trim();
    if (!query) return null;
    const preferredDomains = Array.isArray(preferences.preferred_domains)
      ? preferences.preferred_domains.filter((value): value is string => typeof value === "string")
      : undefined;
    const governedDomains = scope.unrestricted_source_categories.includes("retrieval")
      ? undefined
      : scope.allowed_source_types
          .filter((value) => value.startsWith("retrieval:"))
          .map((value) => value.slice("retrieval:".length));
    if (preferredDomains && governedDomains
      && preferredDomains.some((domain) => !governedDomains.includes(domain))) {
      throw new Error("Work Context retrieval domains exceed immutable execution controls");
    }
    const effectiveDomains = preferredDomains ?? governedDomains;
    const objectTypes = effectiveDomains ? objectTypesForDomains(effectiveDomains) : registry.objectTypes();
    const mode: "exact" | "hybrid" | "broad" = preferences.mode === "exact" || preferences.mode === "broad"
      ? preferences.mode
      : "hybrid";
    return {
      spaceId: request.identity.spaceId,
      userId: request.identity.userId,
      agentId: authority.agentId,
      executionControlSnapshotId: authority.executionControlSnapshotId,
      query,
      objectTypes,
      maxResults: effectiveRetrievalMaximum(preferences.max_candidates, scope.retrieval_max_candidates),
      mode,
      excludedRefs: [
        ...refs(setup.excluded_refs_json),
        ...scope.excluded_source_ids,
      ],
      allowedRefs: scope.allowed_source_ids,
      egressDestination: authority.egressDestination,
    };
  }
}

class PgRetrievalAuthorization implements RetrievalContextAuthorizationPort {
  constructor(private readonly db: Pool) {}

  async authorize({ request, result: retrieved }: Parameters<RetrievalContextAuthorizationPort["authorize"]>[0]) {
    const result = await this.db.query<{ snapshot_json: unknown }>(
      `SELECT snapshot_json FROM execution_control_snapshots
        WHERE id=$1 AND space_id=$2`,
      [request.executionControlSnapshotId, request.spaceId],
    );
    const snapshot = protocol.ExecutionControlSnapshotSchema.parse(result.rows[0]?.snapshot_json);
    if (snapshot.agent_id !== request.agentId) throw new Error("Retrieval Agent does not match execution authority");
    const globalEligible = snapshot.egress.sensitivity_ceiling === "highly_restricted"
      && (snapshot.egress.destination_type === "local_runtime"
        || (snapshot.egress.destination_type === "local_cli"
          && snapshot.egress.external_egress_allowed)
        || (snapshot.egress.destination_id !== null
          && snapshot.egress.allowed_provider_ids.includes(snapshot.egress.destination_id)));
    const adapter = registry.adapterFor(retrieved.object_type);
    const canonical = await adapter?.loadCanonical(
      this.db,
      request.spaceId,
      retrieved.object_type,
      retrieved.object_id,
    );
    if (!canonical) throw new Error("Retrieval source disappeared during Runtime Context planning");
    const sourceIds = canonical.sourceConnectionIds;
    const [sourceSnapshots, settings] = await Promise.all([
      loadSourcePolicySnapshots(this.db, request.spaceId, sourceIds),
      readSpaceRetrievalSettings(this.db, request.spaceId),
    ]);
    const destination = request.egressDestination ?? "internal_process";
    const eligible = globalEligible && retrievalEgressAllowed({
      object_type: retrieved.object_type,
      object_id: retrieved.object_id,
      source_connection_ids: sourceIds,
    }, {
      externalEgressEnabled: settings.externalEgressEnabled,
      destination,
      sourcePolicies: sourceEgressPoliciesForSnapshots(sourceSnapshots),
    });
    return {
      sensitivity: "highly_restricted" as const,
      visibility: "private" as const,
      ownerUserId: request.userId,
      egressEligible: eligible,
      revalidation: {
        status: "live" as const,
        checked_at: new Date().toISOString(),
        execution_control_snapshot_id: snapshot.id,
        checked_by: "retrieval_engine_and_execution_control",
        source_updated_at: canonical.updatedAt,
        source_connection_ids: sourceIds,
      },
    };
  }
}

export function createProductionRuntimeContextPlanningService(
  db: Pool,
  config?: ServerConfig,
): RuntimeContextPlanningService {
  const retrieval = new RetrievalCoordinator(
    new RuntimeContextRetrievalEngine(db),
    new PgRetrievalAuthorization(db),
  );
  return new RuntimeContextPlanningService(
    new RuntimeContextAcquisitionComposition(
      new PgAuthorityProvider(db),
      new PgDirectProvider(db, config),
      new PgExplicitProvider(db),
      new PgCheckpointContinuityProvider(db),
      new PgRetrievalIntentProvider(db),
      retrieval,
    ),
    new ContextWindowReconciliationRepository(db),
  );
}

async function enforceRuntimeSkillRender(
  config: ServerConfig,
  runId: string,
  spaceId: string,
  candidate: RuntimeSkillCandidate,
): Promise<void> {
  const result = await enforce(config, await loadActionRegistry(), {
    action: "runtime_skill.render",
    force_record: false,
    actor_type: "run",
    actor_id: runId,
    space_id: spaceId,
    resource_type: "runtime_skill_binding",
    resource_id: candidate.binding_id,
    run_id: runId,
    context: {
      adapter_type: candidate.runtime_adapter_type,
      render_mode: candidate.render_mode,
      capability_id: candidate.capability_id,
      capability_version_id: candidate.capability_version_id,
      capability_enablement_id: candidate.capability_enablement_id,
      enabled_binding: true,
      risk_level: candidate.risk_level,
    },
    metadata_json: {
      binding_id: candidate.binding_id,
      capability_id: candidate.capability_id,
      capability_version_id: candidate.capability_version_id,
      capability_enablement_id: candidate.capability_enablement_id,
      adapter_type: candidate.runtime_adapter_type,
      render_mode: candidate.render_mode,
      risk_level: candidate.risk_level,
    },
  });
  if (result.status !== "allow") throw new Error(result.message ?? "Policy denied Runtime Skill rendering");
}

class RuntimeContextRetrievalEngine {
  private readonly searchService: RetrievalSearchService;
  constructor(private readonly db: Pool) {
    this.searchService = new RetrievalSearchService(db, registry);
  }

  async search(input: Parameters<RetrievalSearchService["search"]>[0]) {
    return this.searchService.search({ ...input, skipAudit: true });
  }

  async recordReads(input: {
    spaceId: string;
    userId: string;
    agentId: string;
    items: readonly { object_type: RetrievalObjectType; object_id: string }[];
  }): Promise<void> {
    const grouped = new Map<string, string[]>();
    for (const item of input.items) {
      const resourceType = contentResourceTypeForRetrievalObject(item.object_type);
      if (!resourceType) continue;
      grouped.set(resourceType, [...(grouped.get(resourceType) ?? []), item.object_id]);
    }
    const audit = new ContentAccessAuditService(this.db);
    for (const [resourceType, resourceIds] of grouped) {
      await audit.recordReads({
        spaceId: input.spaceId,
        resourceType,
        resourceIds,
        viewerUserId: input.userId,
        agentId: input.agentId,
        accessType: "context_injection",
        reason: "runtime context retrieval",
      });
    }
  }
}

async function loadSetup(db: Pool, request: RuntimeContextPlanningRequest): Promise<SetupRow> {
  const result = await db.query<SetupRow>(
    `SELECT id, version, scope_kind, project_id, agent_id, retrieval_preferences_json,
            pinned_refs_json, excluded_refs_json
       FROM work_context_setups
      WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3 AND version=$4
        AND version=(SELECT max(active.version) FROM work_context_setups active
                      WHERE active.space_id=$1 AND active.work_context_scope_id=$2 AND active.user_id=$3)`,
    [request.identity.spaceId, request.turn.work_context_scope_id, request.identity.userId, request.turn.expected_setup_version],
  );
  if (!result.rows[0]) throw new Error("Requested Work Context Setup version is unavailable");
  return result.rows[0];
}

async function loadInvocationRun(
  db: Pool,
  context: PgRuntimeContextAcquisitionRepository,
  request: RuntimeContextPlanningRequest,
) {
  const invocationId = "invocationId" in request && typeof request.invocationId === "string"
    ? request.invocationId
    : null;
  if (invocationId && request.turn.current_message_ref.type === "run_request"
    && request.turn.current_message_ref.id !== invocationId) {
    throw new Error("Run request reference does not match the active invocation");
  }
  const messageRun = !invocationId && request.turn.current_message_ref.type === "message"
    ? (await db.query<{ run_id: string | null }>(
        `SELECT metadata_json->>'run_id' AS run_id
           FROM messages
          WHERE id=$1 AND space_id=$2 AND user_id=$3 AND role='user'`,
        [request.turn.current_message_ref.id, request.identity.spaceId, request.identity.userId],
      )).rows[0]?.run_id ?? null
    : null;
  const runId = invocationId
    ?? (request.turn.current_message_ref.type === "run_request"
      ? request.turn.current_message_ref.id
      : messageRun);
  if (!runId) throw new Error("Runtime Context invocation Run is unavailable");
  return context.loadRun(request.identity.spaceId, runId);
}

function syntheticRunRequestMessage(
  run: { id: string; session_id: string | null; prompt: string | null; instruction: string | null },
  request: RuntimeContextPlanningRequest,
): MessageOut {
  return {
    id: run.id,
    session_id: run.session_id ?? request.turn.work_context_scope_id,
    space_id: request.identity.spaceId,
    user_id: request.identity.userId,
    sender_agent_id: null,
    role: "user",
    content: runRequestText(run),
    metadata_json: null,
    created_at: new Date(0).toISOString(),
  };
}

function runRequestText(run: { prompt: string | null; instruction: string | null }): string {
  return run.prompt?.trim() ? run.prompt : run.instruction ?? "";
}

export function isRoomConversation(value: unknown): boolean {
  return record(value).execution_mode === "room_conversation.v1";
}

export function roomRoutingInstruction(value: unknown): string | null {
  const routing = record(record(value).room_turn_routing);
  if (routing.schema_version !== "room_turn_routing.v1") return null;
  const segments = Array.isArray(routing.recipient_segments)
    ? routing.recipient_segments.map(record)
    : [];
  const currentIndex = nonnegativeInteger(routing.current_segment_index);
  const currentRecipient = stringValue(routing.current_recipient_agent_id);
  if (currentIndex === null || !currentRecipient || segments.length === 0) return null;
  const lines = segments.map((segment, index) => {
    const labels = Array.isArray(segment.recipient_labels)
      ? segment.recipient_labels.filter((label): label is string => typeof label === "string")
      : [];
    const recipients = Array.isArray(segment.recipient_agent_ids)
      ? segment.recipient_agent_ids.filter((id): id is string => typeof id === "string")
      : [];
    const marker = index === currentIndex && recipients.includes(currentRecipient)
      ? " (this run)"
      : "";
    return `${index + 1}. ${(labels.length ? labels : recipients).join(", ")}${marker}\n   Task: ${stringValue(segment.task) ?? ""}`;
  });
  return [
    "Room turn routing context:",
    "The user's canonical Room message was split into multiple auditable recipient runs.",
    `Routing mode: ${stringValue(routing.routing_mode) ?? "direct"}`,
    `Recipient segments:\n${lines.join("\n")}`,
  ].join("\n\n");
}

function normalizeOwned(input: {
  authority: RuntimeContextAuthoritySnapshot;
  request: RuntimeContextPlanningRequest;
  sourceRef: { type: string; id: string; version?: string | null };
  selection: "required" | "pinned" | "ranked";
  semanticRole: "delegated_instruction" | "user_input" | "reference_data";
  trust: "system_approved" | "user_confirmed" | "domain_approved" | "derived";
  text: string;
  acquisition?: "direct" | "explicit" | "continuity";
  conflictKey?: string | null;
  revalidation?: Record<string, unknown>;
  sensitivity?: ContextItem["sensitivity"];
  rank?: number | null;
  structuredPayload?: Record<string, unknown>;
}): ContextItem {
  const control = input.authority.controlSnapshot;
  const sensitivity = input.sensitivity ?? "highly_restricted";
  const egressEligible = contextEgressEligible(input.authority, sensitivity);
  return normalizeContextItem({
    sourceRef: input.sourceRef,
    acquisition: input.acquisition ?? "direct",
    selection: input.selection,
    semanticRole: input.semanticRole,
    trust: input.trust,
    sensitivity,
    visibility: "private",
    ownerUserId: input.request.identity.userId,
    spaceId: input.request.identity.spaceId,
    egressEligible,
    text: input.text,
    rank: input.rank,
    structuredPayload: input.structuredPayload,
    revalidation: {
      status: "live",
      checked_at: new Date().toISOString(),
      execution_control_snapshot_id: control.id,
      egress_destination: input.authority.egressDestination,
      ...(input.revalidation ?? {}),
    },
    conflictKey: input.conflictKey,
  });
}

function contextEgressEligible(
  authority: RuntimeContextAuthoritySnapshot,
  sensitivity: ContextItem["sensitivity"],
): boolean {
  const control = authority.controlSnapshot;
  return sensitivityRank(sensitivity) <= sensitivityRank(control.egress.sensitivity_ceiling)
    && (control.egress.destination_type === "local_runtime"
      || (control.egress.destination_type === "local_cli"
        && control.egress.external_egress_allowed)
      || (control.egress.destination_id !== null
        && control.egress.allowed_provider_ids.includes(control.egress.destination_id)));
}

function supervisorRetryContext(errorJson: unknown): string | null {
  const error = record(errorJson);
  if (error.error_code !== "supervisor_retry_scheduled") return null;
  const reasonCode = stringValue(error.reason_code);
  const attemptNumber = typeof error.attempt_number === "number"
    && Number.isInteger(error.attempt_number) && error.attempt_number > 0
    ? error.attempt_number
    : null;
  if (!reasonCode || attemptNumber === null) return null;
  return [
    "[Supervisor retry]",
    `This is physical attempt ${attemptNumber}.`,
    `The previous attempt did not complete acceptably (${reasonCode}).`,
    "Re-attempt the original task and correct that failure; do not merely repeat the prior response.",
  ].join("\n");
}

function groupedAgentIdentityContext(run: {
  run_group_id: string | null;
  agent_name: string | null;
}): string | null {
  if (!run.run_group_id) return null;
  const label = stringValue(run.agent_name) ?? "the current room agent";
  return [
    "Agent room execution context:",
    `- You are ${label} for this run.`,
    "- If the user message includes a structured @mention matching your name, treat it as addressing you directly.",
    "- Do not claim to be the room manager or another room member unless this run's agent identity is that agent.",
    "- Internal agent IDs, run IDs, UUIDs, and tool identifiers are system details. Do not include them in user-facing replies unless the user explicitly asks for audit/debug identifiers.",
  ].join("\n");
}

function refs(value: unknown): Array<{ type: string; id: string; version?: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is { type: string; id: string; version?: string | null } =>
    Boolean(candidate && typeof candidate === "object"
      && typeof (candidate as { type?: unknown }).type === "string"
      && typeof (candidate as { id?: unknown }).id === "string"));
}

function objectTypesForDomains(domains: string[]): RetrievalObjectType[] {
  const available = new Set(registry.objectTypes());
  const aliases: Record<string, RetrievalObjectType[]> = {
    memory: ["memory_entry"],
    projects: ["project_public_summary"],
    knowledge: ["knowledge_item", "note", "source", "claim"],
    sources: ["source_item", "extracted_evidence"],
    inquiry: ["inquiry_thread"],
  };
  return [...new Set(domains.flatMap((domain) => aliases[domain] ?? (available.has(domain as RetrievalObjectType) ? [domain as RetrievalObjectType] : [])))];
}

function assertExplicitControls(
  authority: RuntimeContextAuthoritySnapshot,
  pinned: readonly { type: string; id: string }[],
  oneOff: readonly { type: string; id: string }[],
): void {
  const scope = authority.controlSnapshot.readable_scope;
  const unrestricted = scope.unrestricted_source_categories.includes("explicit_reference");
  const allowedTypes = new Set(scope.explicit_reference_types);
  const allowedIds = new Set(scope.allowed_source_ids.map(refKey));
  const excludedIds = new Set(scope.excluded_source_ids.map(refKey));
  if (scope.explicit_reference_max !== null && pinned.length + oneOff.length > scope.explicit_reference_max) {
    throw new Error("Explicit reference count exceeds immutable execution controls");
  }
  for (const ref of oneOff) {
    if ((!unrestricted && !allowedTypes.has(ref.type))
      || (allowedIds.size > 0 && !allowedIds.has(refKey(ref)))
      || excludedIds.has(refKey(ref))) {
      throw new Error("One-off reference is prohibited by immutable execution controls");
    }
  }
  const ceiling = scope.explicit_reference_sensitivity_ceiling;
  if (oneOff.length > 0 && ceiling !== null && sensitivityRank("normal") > sensitivityRank(ceiling)) {
    throw new Error("One-off reference exceeds immutable sensitivity controls");
  }
}

function effectiveRetrievalMaximum(setupValue: unknown, controlValue: number | null): number {
  const requested = nonnegativeInteger(setupValue);
  if (requested !== null && controlValue !== null && requested > controlValue) {
    throw new Error("Work Context retrieval limit exceeds immutable execution controls");
  }
  return Math.min(50, requested ?? controlValue ?? 10);
}

export async function revalidateExecutionDestination(
  db: Pool,
  control: Pick<RuntimeContextAuthoritySnapshot["controlSnapshot"], "space_id" | "egress">,
  adapterType: string | null,
): Promise<RetrievalEgressDestination> {
  if (control.egress.destination_type !== "model_provider") {
    const cli = isVendorCliAdapter(adapterType);
    if (cli) {
      if (control.egress.destination_type !== "local_cli"
        || control.egress.destination_id !== adapterType
        || !control.egress.external_egress_allowed) {
        throw new Error("Execution CLI adapter is not authorized by the control snapshot");
      }
      if (!(await readSpaceRetrievalSettings(db, control.space_id)).externalEgressEnabled) {
        throw new Error("External CLI egress is no longer authorized");
      }
      return "external_provider";
    }
    if (control.egress.destination_type !== "local_runtime") {
      throw new Error("Execution local runtime is not authorized by the control snapshot");
    }
    return "internal_process";
  }
  const providerId = control.egress.destination_id;
  if (!providerId || !control.egress.allowed_provider_ids.includes(providerId)) {
    throw new Error("Execution provider is not authorized by the control snapshot");
  }
  const result = await db.query<{
    provider_type: string;
    base_url: string | null;
    config_json: unknown;
  }>(
    `SELECT provider.provider_type, provider.base_url, provider.config_json
       FROM model_provider_space_grants provider_grant
       JOIN model_providers provider
         ON provider.id=provider_grant.provider_id
      WHERE provider_grant.space_id=$1 AND provider_grant.provider_id=$2
        AND provider_grant.enabled=TRUE AND provider.enabled=TRUE`,
    [control.space_id, providerId],
  );
  const provider = result.rows[0];
  if (!provider) throw new Error("Execution model-provider grant is no longer active");
  const destination = runtimeContextProviderDestination(adapterType, provider);
  if (destination === "external_provider") {
    const settings = await readSpaceRetrievalSettings(db, control.space_id);
    if (!settings.externalEgressEnabled || !control.egress.external_egress_allowed) {
      throw new Error("External model egress is no longer authorized");
    }
  }
  return destination;
}

export function runtimeContextProviderDestination(
  adapterType: string | null,
  provider: { provider_type: string; base_url: string | null; config_json: unknown },
): RetrievalEgressDestination {
  return runtimeProviderEgressDestination(adapterType, provider);
}

function refKey(ref: { type: string; id: string }): string {
  return `${ref.type}:${ref.id}`;
}

function sensitivityRank(value: string): number {
  return ["normal", "sensitive", "restricted", "highly_restricted"].indexOf(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
