import {
  NO_SESSION_CONFIG,
  reconcileSavedSessionConfig,
  resolveSessionConfig,
  sessionConfigRunOverride,
  type ResolvedSessionConfig,
} from "../sessions/sessionConfig.js";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool, type PoolClient } from "../../db/pool.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { enforce, type EnforceResult } from "../policy/service.js";
import { HttpError, withDbTransaction } from "../routeUtils/common.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { PgRunRepository, type GroupedRunTrigger, type RunRecord } from "../runs/repository.js";
import { visibleMessagePathSql } from "../sessions/messagePath.js";
import { CONVERSATION_SERIALIZATION_WAIT_SCOPE } from "./waitScopes.js";
import {
  PgConversationBackendRepository,
  type ResolvedConversationBackend,
} from "../sessions/conversationBackendRepository.js";
import { PgConversationExecutionContextRepository } from "../sessions/executionContextRepository.js";
import { isLocalCliRuntimeAdapter } from "../runtimeAdapters/index.js";
import { hostInstallationIds } from "../hosts/capabilities.js";
import { hostIsOnline } from "../sessions/executionContextRepository.js";
import { locationIsOnline } from "../sessions/executionContextService.js";
import { PgHostThreadRepository, type HostThread } from "../hosts/threadRepository.js";
import { renderRoomStandingContext, roomExecutionRules, standingContextRequired } from "./roomStandingContext.js";
import { chargeContainer, containerGroupOf } from "../rooms/discussionService.js";
import { roomBudgetLimits, warnRoomSoftBudget } from "../rooms/delegationBudget.js";
import { admitAgentOriginRun } from "../rooms/quotaGate.js";
import { AgentGroupRunLifecycleProjector } from "./lifecycleProjector.js";
import { liveQuotaSource } from "../rooms/subscriptionLogins.js";
import {
  HANDOFF_TOOL_ALLOWANCE,
  handoffBudgetTokens,
  handoffPromptBlock,
  loadHandoffText,
  renderHandoffPrompt,
} from "./sessionHandoff.js";
import { containsRunChangeLink } from "./runChangeBlock.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { readOnlyWorkspaceHostRefusal } from "../runs/workspaceAccessPolicy.js";
import { contractWorkspaceAccess, type RunGitSnapshot } from "../runs/contractSnapshot.js";
import { RUN_REQUEST_INCLUDES_INSTRUCTION } from "../runtimeContext/runRequest.js";
import { resolveModelWindow } from "../usage/modelCatalog.js";
import {
  conversationToolGrantInput as conversationToolGrantInputFor,
} from "../systemActions/scenarioToolAllowance.js";
import {
  type AgentCapabilitySnapshotRecord,
  type AgentRunGroupRecord,
  type AgentRunMessageRecord,
  type RunDelegationRecord,
  PgAgentGroupRepository,
} from "./repository.js";

import type { ConversationInputPart, LaunchWorkspace, PolicyCheckRequest, RuntimeSessionConfigSelection } from "@rainver/protocol";

export interface AgentGroupIdentity {
  spaceId: string;
  userId: string;
}

export interface CreateAgentGroupInput {
  space_id: string;
  title: string;
  goal?: string | null;
  manager_agent_id: string;
  room_id?: string | null;
  session_id?: string | null;
  trigger_message_id?: string | null;
  project_id?: string | null;
  project_folder_id?: string | null;
  member_agent_ids: string[];
  budget_json?: Record<string, unknown> | null;
  context_policy_json?: Record<string, unknown> | null;
}

export interface UpdateAgentGroupInput {
  space_id: string;
  group_id: string;
  title?: string | null;
  goal?: string | null;
}

export interface SendAgentGroupMessageInput {
  space_id: string;
  group_id: string;
  content: string;
  /** Allows a Room turn to carry only persisted structured input. */
  input_parts?: ConversationInputPart[];
  /**
   * Read-only kinds of the parts the persisted message already owns. A retry
   * claims nothing new, so this — not `input_parts` — is what says whether the
   * turn still carries resources the Run must be able to read.
   */
  capability_input_parts?: Array<{ kind: "image" | "file_reference" | "input_resource" | "skill" }>;
  /** Marks a Room retry so remote prompt hydration can use immutable inputs. */
  retry_of_run_id?: string | null;
  /**
   * What started this turn. Absent is a person's own message (`manual`); a
   * Room continuation names itself and its cause, so the turn's authority is
   * its cause's rather than a fresh person's (`effectiveRunTrigger`).
   */
  trigger?: GroupedRunTrigger;
  parent_message_id?: string | null;
  routing_mode?: "direct" | "agent_coordination" | null;
  recipient_segments?: AgentGroupMessageRecipientSegment[] | null;
  /**
   * Under `agent_coordination`: the Agents the person referred to, already
   * checked as active Room members by the caller. The manager's prompt names
   * them so it arranges the work with them; ignored for a direct send.
   */
  coordination_targets?: RoomCoordinationTarget[] | null;
  metadata_json?: Record<string, unknown> | null;
  backends?: Array<{
    agent_id: string;
    runtime_profile_id: string;
    session_config?: RuntimeSessionConfigSelection[];
    /**
     * `session_config` replays an earlier turn's selections (a retry) rather
     * than a choice made now, so a withdrawn value falls back instead of
     * refusing the turn.
     */
    session_config_inherited?: boolean;
  }> | null;
  /**
   * The one recipient of this turn writes a summary of the conversation
   * instead of answering: a handoff-shaped turn (`sessionHandoff.ts`) that
   * resumes its session, may call only `handoff.write`, and is not followed
   * by a rotation. Set by `RoomService.summarizeAgentContext`.
   */
  summary_agent_id?: string | null;
  /**
   * Precomputed Project state context text (mode projection + attention),
   * prefixed onto the assigned task for a Room-dispatched run. Built once per dispatch by the caller — not here — so a
   * multi-recipient dispatch reads the Project once rather than per
   * recipient. Domain-neutral: sourced from the generic Project Overview
   * contract, never assembled from a specific domain's tables.
   */
  project_state_context?: string | null;
  /**
   * The message is a domain-event continuation — an Agent-triggered turn
   * (a discussion wave, a closing turn, a delegation result) — so its first
   * Run is admitted through the subscription quota gate.
   */
  agent_origin?: boolean;
}

export interface AgentGroupMessageRecipientSegment {
  recipient_agent_ids: string[];
  content: string;
}

export interface SpawnChildRunInput {
  space_id: string;
  group_id: string;
  parent_run_id: string;
  root_run_id: string;
  requesting_agent_id: string;
  target_agent_id: string;
  manager_user_id: string;
  request_message_id?: string | null;
  instruction: string;
  reason?: string | null;
  budget_json?: Record<string, unknown> | null;
  context_policy_json?: Record<string, unknown> | null;
  /**
   * `read`: the child reviews the Conversation's workspace and may not write
   * it (`contract.workspace_access`). Omitted: the parent's own access — a
   * read-only parent's child is read-only too; `write` from a read-only
   * parent is refused (a child never gets more than its parent).
   */
  workspace_access?: "read" | "write" | null;
  /**
   * The originating tool call's canonical id. When set, a delegation request
   * carrying the same (space, parent_run, tool_call_id) replays the prior
   * result instead of spawning a second child Run — required so a retried
   * `agent.delegate` tool call cannot duplicate the durable delegation. A CLI
   * Run's calls carry the caller's `Idempotency-Key`, so a reconnect or a
   * retry of the same call arrives with the same id. See
   * uq_run_delegations_parent_tool_call.
   */
  tool_call_id?: string | null;
}

interface AgentGroupTimeline {
  group: AgentRunGroupRecord;
  members: Awaited<ReturnType<PgAgentGroupRepository["listMembers"]>>;
  messages: AgentRunMessageRecord[];
  delegations: RunDelegationRecord[];
}

const MAX_DELEGATION_DEPTH = 3;
const MAX_PARENT_FANOUT = 8;
const MAX_GROUP_CONCURRENCY = 4;

type PolicyEnforcer = (
  config: Pick<ServerConfig, "databaseUrl">,
  registry: Awaited<ReturnType<typeof loadActionRegistry>>,
  req: PolicyCheckRequest,
) => Promise<EnforceResult>;

export class AgentGroupRunService {
  constructor(
    private readonly config: ServerConfig,
    private readonly pool: Pool,
    private readonly policyEnforcer: PolicyEnforcer = enforce,
  ) {}

  static fromConfig(config: ServerConfig): AgentGroupRunService {
    if (!config.databaseUrl) {
      throw new HttpError(502, "SERVER_DATABASE_URL is required");
    }
    return new AgentGroupRunService(config, getDbPool(config.databaseUrl));
  }

  async createGroup(identity: AgentGroupIdentity, input: CreateAgentGroupInput): Promise<{
    group: AgentRunGroupRecord;
    members: AgentGroupTimeline["members"];
  }> {
    return withDbTransaction(this.pool, (client) =>
      this.createGroupInTransaction(client, identity, input, { allowSystemAssistant: false }),
    );
  }

  async createGroupInTransaction(
    client: PoolClient,
    identity: AgentGroupIdentity,
    input: CreateAgentGroupInput,
    options: { allowSystemAssistant?: boolean } = {},
  ): Promise<{
    group: AgentRunGroupRecord;
    members: AgentGroupTimeline["members"];
  }> {
    assertIdentitySpace(identity, input.space_id);
    const managerAgentId = requiredTrimmed(input.manager_agent_id, "manager_agent_id");
    const memberAgentIds = uniqueIds([managerAgentId, ...input.member_agent_ids]);
    if (memberAgentIds.length === 0) {
      throw new HttpError(422, "member_agent_ids is required");
    }

    const repos = this.repos(client);
    await assertAgentsActive(
      repos.groups,
      input.space_id,
      identity.userId,
      memberAgentIds,
      options.allowSystemAssistant === true,
      input.room_id ?? null,
    );
    const capabilitySnapshots = new Map(
      (await repos.groups.listAgentCapabilitySnapshots(input.space_id, identity.userId, memberAgentIds, input.room_id ?? null))
        .map((snapshot) => [snapshot.id, snapshot]),
    );

    const budgetLimits = delegationBudgetLimits(input.budget_json ?? {}, Boolean(input.room_id));
    const policySnapshot = {
      action: "run.spawn_child",
      max_depth: budgetLimits.max_depth,
      max_fanout: budgetLimits.max_fanout,
      max_concurrency: budgetLimits.max_concurrency,
      context_policy_json: input.context_policy_json ?? {},
    };
    const group = await repos.groups.createGroup({
      space_id: input.space_id,
      manager_user_id: identity.userId,
      manager_agent_id: managerAgentId,
      room_id: input.room_id ?? null,
      session_id: input.session_id ?? null,
      trigger_message_id: input.trigger_message_id ?? null,
      project_id: input.project_id ?? null,
      project_folder_id: input.project_folder_id ?? null,
      title: requiredTrimmed(input.title, "title"),
      goal: optionalTrimmed(input.goal),
      budget_json: input.budget_json ?? {},
      policy_snapshot_json: policySnapshot,
    });

    for (const agentId of memberAgentIds) {
      await repos.groups.createMember({
        space_id: input.space_id,
        group_id: group.id,
        agent_id: agentId,
        role: agentId === managerAgentId ? "manager" : "worker",
        capabilities_json: memberCapabilitySnapshot(capabilitySnapshots.get(agentId)),
        context_policy_json: input.context_policy_json ?? {},
      });
    }

    return {
      group,
      members: await repos.groups.listMembers(input.space_id, group.id),
    };
  }

  async listGroups(identity: AgentGroupIdentity, input: {
    status?: string | null;
    limit: number;
    offset: number;
  }): Promise<{ items: AgentRunGroupRecord[]; total: number; limit: number; offset: number }> {
    const repo = new PgAgentGroupRepository(this.pool);
    const filters = {
      space_id: identity.spaceId,
      manager_user_id: identity.userId,
      status: input.status ?? null,
    };
    const [items, total] = await Promise.all([
      repo.listGroups({ ...filters, limit: input.limit, offset: input.offset }),
      repo.countGroups(filters),
    ]);
    return { items, total, limit: input.limit, offset: input.offset };
  }

  async getGroup(identity: AgentGroupIdentity, groupId: string): Promise<{
    group: AgentRunGroupRecord;
    members: AgentGroupTimeline["members"];
  }> {
    const repo = new PgAgentGroupRepository(this.pool);
    const group = await this.requireReadableGroup(repo, identity, groupId);
    return {
      group,
      members: await repo.listMembers(identity.spaceId, groupId),
    };
  }

  async updateGroup(identity: AgentGroupIdentity, input: UpdateAgentGroupInput): Promise<{
    group: AgentRunGroupRecord;
  }> {
    assertIdentitySpace(identity, input.space_id);
    return withDbTransaction(this.pool, async (client) => {
      const repo = new PgAgentGroupRepository(client);
      await this.requireManagedGroup(repo, identity, input.group_id);
      const title = input.title === undefined ? undefined : requiredTrimmed(input.title ?? "", "title");
      const goal = input.goal === undefined ? undefined : optionalTrimmed(input.goal);
      const group = await repo.updateGroupDetails({
        space_id: input.space_id,
        group_id: input.group_id,
        title,
        goal,
      });
      if (!group) {
        throw new HttpError(404, "Agent group not found in this space");
      }
      return { group };
    });
  }

  async sendUserMessage(identity: AgentGroupIdentity, input: SendAgentGroupMessageInput): Promise<{
    message: AgentRunMessageRecord;
  }> {
    return withDbTransaction(this.pool, (client) =>
      this.sendUserMessageInTransaction(client, identity, input),
    );
  }

  async sendUserMessageInTransaction(
    client: PoolClient,
    identity: AgentGroupIdentity,
    input: SendAgentGroupMessageInput,
  ): Promise<{ message: AgentRunMessageRecord }> {
    return this.dispatchMessageInTransaction(client, identity, input, false);
  }

  async sendRoomMessageInTransaction(
    client: PoolClient,
    identity: AgentGroupIdentity,
    input: SendAgentGroupMessageInput,
  ): Promise<{ message: AgentRunMessageRecord }> {
    return this.dispatchMessageInTransaction(client, identity, input, true);
  }

  private async dispatchMessageInTransaction(
    client: PoolClient,
    identity: AgentGroupIdentity,
    input: SendAgentGroupMessageInput,
    roomAuthority: boolean,
  ): Promise<{
    message: AgentRunMessageRecord;
  }> {
    assertIdentitySpace(identity, input.space_id);
      const repos = this.repos(client);
      const hostThreads = new PgHostThreadRepository(client);
      const group = await repos.groups.lockGroup(input.space_id, input.group_id);
      if (!group || !(await this.canManageGroup(repos.groups, identity, group))) {
        throw new HttpError(404, "Agent group not found in this space");
      }
      if (group.status !== "active") {
        throw new HttpError(409, `Agent group is not active (current status: ${group.status})`);
      }
      if (!roomAuthority && (group.room_id || group.session_id)) {
        throw new HttpError(
          409,
          "Room-backed messages must be sent through the Room conversation endpoint",
        );
      }
      if (!group.manager_agent_id) {
        throw new HttpError(409, "Agent group has no manager agent");
      }
      const content = input.content.trim();
      if (!content && !(input.input_parts?.length || input.capability_input_parts?.length)) {
        throw new HttpError(422, "content or an input part is required");
      }
      const trigger: GroupedRunTrigger = input.trigger ?? { origin: "manual" };
      const routingMode = input.routing_mode ?? "direct";
      const routingSegments = messageRecipientSegmentsForInput(input, group.manager_agent_id, content);
      const managerAgentId = group.manager_agent_id;
      const coordinationTargets = routingMode === "agent_coordination"
        ? uniqueCoordinationTargets(input.coordination_targets ?? [])
          .filter((target) => target.agent_id !== managerAgentId)
        : [];
      const recipientAgentIds = routingSegments.flatMap((segment) => segment.recipient_agent_ids);
      const allRecipientAgentIds = uniqueIds(recipientAgentIds);
      if (group.session_id && recipientAgentIds.length !== allRecipientAgentIds.length) {
        throw new HttpError(
          422,
          "A Room agent may receive only one segment per message",
        );
      }
      const plannedRecipientRunCount = routingSegments.reduce(
        (count, segment) => count + segment.recipient_agent_ids.length,
        0,
      );
      for (const recipientAgentId of allRecipientAgentIds) {
        await assertActiveGroupMember(
          repos.groups,
          input.space_id,
          group.id,
          recipientAgentId,
          identity.userId,
          "recipient_segments.recipient_agent_ids",
          roomAuthority,
        );
      }
      const recipientSnapshots = plannedRecipientRunCount > 1
        ? new Map(
          (await repos.groups.listAgentCapabilitySnapshots(input.space_id, identity.userId, allRecipientAgentIds, group.room_id))
            .map((snapshot) => [snapshot.id, snapshot]),
        )
        : new Map<string, AgentCapabilitySnapshotRecord>();
      if (group.session_id && !group.room_id) {
        throw new HttpError(409, "Room conversation is missing its Room authority");
      }
      const backends = group.session_id
        ? await prepareRoomConversationBackends({
            config: this.config,
            db: client,
            identity,
            roomId: group.room_id!,
            sessionId: group.session_id,
            projectId: group.project_id,
            messageCursorId: group.trigger_message_id,
            agentIds: allRecipientAgentIds,
            requested: input.backends ?? [],
          })
        : new Map<string, PreparedRoomConversationBackend>();
      // Advancing a Project by talking about it is a capability of the Room,
      // not of whichever Agent its roster happens to name — a Room roster is
      // fixed at creation, so binding these to the Agent would mean a Room
      // built around a differently configured Agent silently does nothing.
      //
      // A group with no Room is still a conversation with a person, and gets
      // what belongs to that: the memory writes, and nothing that touches a
      // Project. Do not leave a group with no Room at an empty allowance:
      // the intersection with the Agent's standing permissions is then empty
      // and it can call nothing.
      //
      // Host kind is intentionally absent from this decision. It selects the
      // delivery mechanism for the same Run-scoped tool surface; it is not a
      // second authority for what a conversation may do.
      const turnInputPartKinds: ReadonlyArray<{ kind: string }> = input.input_parts?.length
        ? input.input_parts
        : input.capability_input_parts ?? [];
      const conversationToolGrantInput = conversationToolGrantInputFor({
        ...group,
        // A turn handed another Run's `[Changes]` link
        // reads it through the same resource tools.
        has_input_resources: turnInputPartKinds.some((part) => part.kind === "input_resource")
          // The resource executors are registered from a Room turn's message,
          // so only a Room turn is told it can follow a change link.
          || (Boolean(group.room_id && group.session_id) && (
            containsRunChangeLink(input.content)
            || Boolean(input.recipient_segments?.some((segment) => containsRunChangeLink(segment.content)))
          )),
      });
      const summaryTurn = input.summary_agent_id
        ? await prepareSummaryTurn(client, {
            identity,
            agentId: input.summary_agent_id,
            backend: backends.get(input.summary_agent_id),
          })
        : null;
      // A recipient's Run inputs: the turn it was asked for, or — for the
      // summary turn — the summary prompt with the handoff tool alone.
      const turnInputs = (
        agentId: string,
        defaults: { prompt: string; model_override_json: Record<string, unknown> | null },
      ) => summaryTurn && summaryTurn.agent_id === agentId
        ? {
            prompt: summaryTurn.prompt,
            model_override_json: {
              ...(defaults.model_override_json ?? {}),
              chat_turn: {
                ...recordValue(defaults.model_override_json?.chat_turn),
                kind: "handoff",
                assigned_task: "Write a summary of this conversation for its record.",
              },
              host_thread: { ...recordValue(defaults.model_override_json?.host_thread), identity_sent: false },
              handoff: summaryTurn.handoff,
            },
            capabilities_json: [...HANDOFF_TOOL_ALLOWANCE],
            scenario_tool_allowance: HANDOFF_TOOL_ALLOWANCE,
          }
        : { ...defaults, ...conversationToolGrantInput };
      const roomRunGranteeUserIds = group.room_id
        ? await repos.groups.listActiveRoomUserIds(input.space_id, group.room_id)
        : [];
      const roomRunVisibility = group.room_id
        ? "selected_users" as const
        : undefined;
      const groupPolicy = recordValue(group.policy_snapshot_json);
      const contextPolicy = recordValue(groupPolicy.context_policy_json);
      let rootRunId: string;
      const recipientRuns: Array<{
        run: RunRecord;
        segment_index: number;
      }> = [];

      if (group.root_run_id) {
        const rootRun = await repos.runs.getVisibleRun(
          input.space_id,
          identity.userId,
          group.root_run_id,
        );
        if (!rootRun || rootRun.run_group_id !== group.id) {
          throw new HttpError(409, "Agent group root run is not available");
        }
        rootRunId = group.root_run_id;
        for (let segmentIndex = 0; segmentIndex < routingSegments.length; segmentIndex += 1) {
          const segment = routingSegments[segmentIndex]!;
          for (const recipientAgentId of segment.recipient_agent_ids) {
            const preparedBackend = backends.get(recipientAgentId);
            const run = await repos.runs.createGroupedAgentRun({
              execution_kind: "agent",
              agent_id: recipientAgentId,
              space_id: input.space_id,
              user_id: identity.userId,
              trigger,
              parent_run_id: rootRunId,
              root_run_id: rootRunId,
              run_group_id: group.id,
              project_folder_id: preparedBackend?.host_project_folder_id ?? rootRun.project_folder_id,
              session_id: rootRun.session_id,
              project_id: rootRun.project_id,
              workspace_location_id: preparedBackend?.workspace_location_id ?? null,
              trust_mode: preparedBackend?.host_is_remote ? "trusted_host" : null,
              host_task_thread_id: preparedBackend?.host_thread?.id ?? null,
              ...turnInputs(recipientAgentId, { prompt: roomRunPrompt(preparedBackend, segment.content, content, input.project_state_context, coordinationTargets), model_override_json: roomRunModelOverride(preparedBackend, {
                content,
                routingMode,
                routingSegments,
                currentSegmentIndex: segmentIndex,
                currentRecipientAgentId: recipientAgentId,
                plannedRecipientRunCount,
                recipientSnapshots,
                retryOfRunId: input.retry_of_run_id,
                coordinationTargets,
              }) }),
              instruction: optionalTrimmedOrNull(group.goal),
              runtime_profile_id: preparedBackend?.runtime_profile_id ?? null,
              allow_system_assistant: Boolean(group.room_id),
              budget_json: group.budget_json,
              context_policy_json: contextPolicy,
              contract_snapshot: roomRunContract(group, preparedBackend),
              visibility: roomRunVisibility,
              grantee_user_ids: roomRunGranteeUserIds,
            });
            recipientRuns.push({ run, segment_index: segmentIndex });
            const hostThread = preparedBackend?.host_thread;
            if (hostThread) {
              await recordHostDispatch(hostThreads, hostThread, {
                lastRunId: run.id,
                sessionId: group.session_id!,
                dispatchLockId: preparedBackend!.host_dispatch_lock_id!,
              });
            }
          }
        }
      } else {
        const firstSegment = routingSegments[0];
        const firstRecipientAgentId = firstSegment?.recipient_agent_ids[0];
        if (!firstSegment || !firstRecipientAgentId) {
          throw new HttpError(422, "recipient_segments is required");
        }
        const preparedRootBackend = backends.get(firstRecipientAgentId);
        const rootRun = await repos.runs.createQueuedRun({
          execution_kind: "agent",
          agent_id: firstRecipientAgentId,
          space_id: input.space_id,
          user_id: identity.userId,
          mode: "live",
          run_type: "agent",
          trigger_origin: trigger.origin,
          cause_run_id: trigger.origin === "continuation" ? trigger.cause_run_id : null,
              ...turnInputs(firstRecipientAgentId, { prompt: roomRunPrompt(preparedRootBackend, firstSegment.content, content, input.project_state_context, coordinationTargets), model_override_json: roomRunModelOverride(preparedRootBackend, {
            content,
            routingMode,
            routingSegments,
            currentSegmentIndex: 0,
            currentRecipientAgentId: firstRecipientAgentId,
            plannedRecipientRunCount,
            recipientSnapshots,
            retryOfRunId: input.retry_of_run_id,
            coordinationTargets,
          }) }),
              instruction: optionalTrimmedOrNull(group.goal),
              session_id: group.session_id,
              project_id: group.project_id,
          project_folder_id: preparedRootBackend?.host_project_folder_id ?? group.project_folder_id,
          workspace_location_id: preparedRootBackend?.workspace_location_id ?? null,
          trust_mode: preparedRootBackend?.host_is_remote ? "trusted_host" : null,
          host_task_thread_id: preparedRootBackend?.host_thread?.id ?? null,
              runtime_profile_id: preparedRootBackend?.runtime_profile_id ?? null,
              runtime_profile_selection_source: preparedRootBackend
                ? "explicit"
                : "default",
              contract_snapshot: roomRunContract(group, preparedRootBackend),          visibility: roomRunVisibility,
          grantee_user_ids: roomRunGranteeUserIds,
          allow_system_assistant: Boolean(group.room_id),
        });
        const linkedRootRun = await repos.runs.linkRunToGroupRoot({
          space_id: input.space_id,
          run_id: rootRun.id,
          run_group_id: group.id,
        });
        if (!linkedRootRun) {
          throw new HttpError(409, "Root run could not be linked to the agent group");
        }
        await repos.groups.updateGroupRootRun({
          space_id: input.space_id,
          group_id: group.id,
          root_run_id: linkedRootRun.id,
        });
        rootRunId = linkedRootRun.id;
        recipientRuns.push({ run: linkedRootRun, segment_index: 0 });
        const rootHostThread = preparedRootBackend?.host_thread;
        if (rootHostThread) {
          await recordHostDispatch(hostThreads, rootHostThread, {
            lastRunId: linkedRootRun.id,
            sessionId: group.session_id!,
            dispatchLockId: preparedRootBackend!.host_dispatch_lock_id!,
          });
        }
        for (let segmentIndex = 0; segmentIndex < routingSegments.length; segmentIndex += 1) {
          const segment = routingSegments[segmentIndex]!;
          for (let recipientIndex = 0; recipientIndex < segment.recipient_agent_ids.length; recipientIndex += 1) {
            if (segmentIndex === 0 && recipientIndex === 0) continue;
            const recipientAgentId = segment.recipient_agent_ids[recipientIndex]!;
            const preparedBackend = backends.get(recipientAgentId);
            const run = await repos.runs.createGroupedAgentRun({
              execution_kind: "agent",
              agent_id: recipientAgentId,
              space_id: input.space_id,
              user_id: identity.userId,
              trigger,
              parent_run_id: rootRunId,
              root_run_id: rootRunId,
              run_group_id: group.id,
              project_folder_id: preparedBackend?.host_project_folder_id ?? linkedRootRun.project_folder_id,
              session_id: linkedRootRun.session_id,
              project_id: linkedRootRun.project_id,
              workspace_location_id: preparedBackend?.workspace_location_id ?? null,
              trust_mode: preparedBackend?.host_is_remote ? "trusted_host" : null,
              host_task_thread_id: preparedBackend?.host_thread?.id ?? null,
              ...turnInputs(recipientAgentId, { prompt: roomRunPrompt(preparedBackend, segment.content, content, input.project_state_context, coordinationTargets), model_override_json: roomRunModelOverride(preparedBackend, {
                content,
                routingMode,
                routingSegments,
                currentSegmentIndex: segmentIndex,
                currentRecipientAgentId: recipientAgentId,
                plannedRecipientRunCount,
                recipientSnapshots,
                retryOfRunId: input.retry_of_run_id,
                coordinationTargets,
              }) }),
              instruction: optionalTrimmedOrNull(group.goal),
              runtime_profile_id: preparedBackend?.runtime_profile_id ?? null,
              allow_system_assistant: Boolean(group.room_id),
              budget_json: group.budget_json,
              context_policy_json: contextPolicy,
              contract_snapshot: roomRunContract(group, preparedBackend),
              visibility: roomRunVisibility,
              grantee_user_ids: roomRunGranteeUserIds,
            });
            recipientRuns.push({ run, segment_index: segmentIndex });
            const hostThread = preparedBackend?.host_thread;
            if (hostThread) {
              await recordHostDispatch(hostThreads, hostThread, {
                lastRunId: run.id,
                sessionId: group.session_id!,
                dispatchLockId: preparedBackend!.host_dispatch_lock_id!,
              });
            }
          }
        }
      }

      const primaryRun = recipientRuns[0]?.run;
      if (!primaryRun) {
        throw new HttpError(422, "recipient_segments is required");
      }
      const routingSegmentsWithRuns = routingSegments.map((segment, index) => ({
        recipient_agent_ids: segment.recipient_agent_ids,
        content: segment.content,
        recipient_run_ids: recipientRuns
          .filter((entry) => entry.segment_index === index)
          .map((entry) => entry.run.id),
      }));
      const message = await repos.groups.createMessage({
        space_id: input.space_id,
        group_id: input.group_id,
        run_id: primaryRun.id,
        parent_message_id: input.parent_message_id ?? null,
        sender_actor_ref_json: { actor_type: "user", user_id: identity.userId },
        sender_user_id: identity.userId,
        message_type: "user_instruction",
        content,
        mentions_json: allRecipientAgentIds.map((agentId) => ({ agent_id: agentId })),
        metadata_json: {
          ...(input.metadata_json ?? {}),
          routing_mode: routingMode,
          ...(coordinationTargets.length
            ? { coordination_target_agent_ids: coordinationTargets.map((target) => target.agent_id) }
            : {}),
          routing_segments: routingSegmentsWithRuns,
          root_run_id: rootRunId,
          recipient_agent_id: allRecipientAgentIds[0],
          recipient_agent_ids: allRecipientAgentIds,
          recipient_run_id: primaryRun.id,
          recipient_run_ids: recipientRuns.map((entry) => entry.run.id),
        },
      });

      const chain: RunRecord[] = [];
      for (const entry of recipientRuns) {
        chain.push(entry.run);
      }

      for (let recipientIndex = 0; recipientIndex < chain.length; recipientIndex += 1) {
        const recipientRun = chain[recipientIndex]!;
        // A Conversation has one filesystem scope and therefore one active
        // Run. Keep fan-out Runs durable, but park every recipient after the
        // first behind every preceding Run; the lifecycle projector requeues
        // the next one after its dependencies reach a terminal state. The
        // dependency list names every earlier recipient, not only the
        // immediately preceding one, so the admitted Run is handed all of the
        // replies this turn already produced (`serializedRecipientPrompt`).
        if (group.session_id && recipientIndex > 0) {
          const dependencyRunIds = chain
            .slice(0, recipientIndex)
            .map((run) => run.id);
          await client.query(
            `UPDATE runs
                SET status = 'waiting_for_dependency',
                    output_json = jsonb_build_object(
                      'waiting_for_results', jsonb_build_object(
                        'status', 'waiting',
                        'scope', $3::text,
                        'reason', 'Conversation Runs share one execution directory and run serially.',
                        'depends_on_run_ids', $4::jsonb
                      )
                    ),
                    updated_at = now()
              WHERE space_id = $1 AND id = $2 AND status = 'queued'`,
            [input.space_id, recipientRun.id, CONVERSATION_SERIALIZATION_WAIT_SCOPE, JSON.stringify(dependencyRunIds)],
          );
        }
        const jobPayload: Record<string, unknown> = {
          run_id: recipientRun.id,
          run_group_id: group.id,
          root_run_id: rootRunId,
          trigger_origin: trigger.origin,
        };
        // The host thread and the vendor session to resume are read from the
        // Run's own `host_thread` override by the job handler, not carried here.
        if (recipientRun.parent_run_id) jobPayload.parent_run_id = recipientRun.parent_run_id;

        if (group.session_id && recipientIndex > 0) continue;
        if (input.agent_origin && group.session_id) {
          // An Agent-triggered turn waits past the subscription reserve line
          // (`rooms/quotaGate.ts`); a person's turn never does.
          await admitAgentOriginRun(client, {
            spaceId: input.space_id,
            runId: recipientRun.id,
            job: {
              user_id: identity.userId,
              agent_id: recipientRun.agent_id,
              project_folder_id: recipientRun.project_folder_id ?? null,
              payload: jobPayload,
            },
            source: liveQuotaSource(this.pool),
          });
          continue;
        }
        await repos.jobs.enqueue({
          job_type: "agent_run",
          space_id: input.space_id,
          user_id: identity.userId,
          agent_id: recipientRun.agent_id,
          project_folder_id: recipientRun.project_folder_id ?? null,
          payload: jobPayload,
        });
      }

      return { message };
  }

  async spawnChildRun(identity: AgentGroupIdentity, input: SpawnChildRunInput): Promise<{
    delegation: RunDelegationRecord;
    child_run_id: string | null;
    policy_decision_record_id: string | null;
  }> {
    assertIdentitySpace(identity, input.space_id);
    if (input.manager_user_id !== identity.userId) {
      throw new HttpError(403, "manager_user_id must match the authenticated user");
    }
    return withDbTransaction(this.pool, async (client) =>
      this.spawnChildRunInTransaction(this.repos(client), identity, input),
    );
  }

  async spawnChildRunAuthorized(
    identity: AgentGroupIdentity,
    input: SpawnChildRunInput,
    policy: EnforceResult,
  ) {
    assertIdentitySpace(identity, input.space_id);
    if (input.manager_user_id !== identity.userId) throw new HttpError(403, "manager_user_id must match the authenticated user");
    return withDbTransaction(this.pool, async (client) =>
      this.spawnChildRunInTransaction(this.repos(client), identity, input, policy),
    );
  }

  async preflightSpawnChildRunPolicy(
    identity: AgentGroupIdentity,
    input: SpawnChildRunInput,
  ): Promise<EnforceResult> {
    assertIdentitySpace(identity, input.space_id);
    if (input.manager_user_id !== identity.userId) {
      throw new HttpError(403, "manager_user_id must match the authenticated user");
    }
    return withDbTransaction(this.pool, async (client) => {
      const repos = this.repos(client);
      const group = await repos.groups.lockGroup(input.space_id, input.group_id);
      if (!group || !(await this.canManageGroup(repos.groups, identity, group))) {
        throw new HttpError(404, "Agent group not found in this space");
      }
      if (group.status !== "active") throw new HttpError(409, `Agent group is not active (current status: ${group.status})`);
      if (!group.root_run_id || input.root_run_id !== group.root_run_id) throw new HttpError(409, "root_run_id must match the agent group root run");
      const parentRun = await repos.runs.getVisibleRun(input.space_id, identity.userId, input.parent_run_id);
      if (!parentRun || parentRun.run_group_id !== group.id) throw new HttpError(404, "Parent run not found in this agent group");
      if (parentRun.agent_id !== input.requesting_agent_id) throw new HttpError(403, "requesting_agent_id must match the parent run agent");
      if ((parentRun.root_run_id ?? parentRun.id) !== group.root_run_id) throw new HttpError(409, "Parent run does not belong to the group root lineage");
      // A retried call replays the delegation it already made; judged afresh,
      // that delegation would count against itself and be refused.
      if (input.tool_call_id) {
        const existing = await repos.groups.findDelegationByToolCallId(input.space_id, input.parent_run_id, input.tool_call_id);
        if (existing) return { status: "allow", policy_decision_record_id: existing.policy_decision_record_id };
      }
      await assertAgentsExist(repos.groups, input.space_id, identity.userId, [input.requesting_agent_id, input.target_agent_id], group.room_id);
      return this.enforceSpawnPolicy(repos.groups, group, parentRun, input);
    });
  }

  async getTimeline(identity: AgentGroupIdentity, groupId: string, page: {
    limit: number;
    offset: number;
  }): Promise<AgentGroupTimeline> {
    const repo = new PgAgentGroupRepository(this.pool);
    const group = await this.requireReadableGroup(repo, identity, groupId);
    const [members, messages, delegations] = await Promise.all([
      repo.listMembers(identity.spaceId, groupId),
      repo.listMessages({
        space_id: identity.spaceId,
        group_id: groupId,
        viewer_user_id: identity.userId,
        limit: page.limit,
        offset: page.offset,
      }),
      repo.listDelegations(identity.spaceId, groupId, identity.userId),
    ]);
    return { group, members, messages, delegations };
  }

  async getTrace(identity: AgentGroupIdentity, groupId: string): Promise<{
    group: AgentRunGroupRecord;
    members: AgentGroupTimeline["members"];
    root_run_id: string | null;
    timeline: AgentGroupTimeline;
    child_run_ids: string[];
    artifact_ids: string[];
    proposal_ids: string[];
    policy_decision_record_ids: string[];
  }> {
    const repo = new PgAgentGroupRepository(this.pool);
    const timeline = await this.getTimeline(identity, groupId, { limit: 200, offset: 0 });
    const runIds = await repo.listRunIdsForGroup(identity.spaceId, groupId, identity.userId);
    const childRunIds = runIds.filter((runId) => runId !== timeline.group.root_run_id);
    const [artifactIds, proposalIds, policyDecisionRecordIds] = await Promise.all([
      repo.listArtifactIdsForRuns(identity.spaceId, identity.userId, runIds),
      repo.listProposalIdsForRuns(identity.spaceId, identity.userId, runIds),
      repo.listPolicyDecisionRecordIdsForGroup(identity.spaceId, groupId, identity.userId),
    ]);
    return {
      group: timeline.group,
      members: timeline.members,
      root_run_id: timeline.group.root_run_id,
      timeline,
      child_run_ids: childRunIds,
      artifact_ids: artifactIds,
      proposal_ids: proposalIds,
      policy_decision_record_ids: policyDecisionRecordIds,
    };
  }

  async changeStatus(
    identity: AgentGroupIdentity,
    groupId: string,
    status: "active" | "paused" | "cancelled",
  ): Promise<AgentRunGroupRecord> {
    const updated = await withDbTransaction(this.pool, async (client) => {
      const repo = new PgAgentGroupRepository(client);
      await this.requireManagedGroup(repo, identity, groupId);
      const updated = await repo.updateGroupStatus({
        space_id: identity.spaceId,
        group_id: groupId,
        status,
      });
      if (!updated) {
        throw new HttpError(409, "Agent group status could not be changed");
      }
      return updated;
    });
    // A dependency that finished while the group was paused woke nobody:
    // resuming re-evaluates every Run still parked on one.
    if (updated.status === "active") {
      const waiting = await this.pool.query<{ id: string }>(
        `SELECT id FROM runs
          WHERE space_id = $1 AND run_group_id = $2 AND status = 'waiting_for_dependency'
          ORDER BY created_at, id`,
        [identity.spaceId, groupId],
      );
      const projector = new AgentGroupRunLifecycleProjector(this.pool, this.config);
      const runs = new PgRunRepository(this.pool);
      for (const row of waiting.rows) {
        const run = await runs.getRun(identity.spaceId, row.id);
        if (run) await projector.reconcileWaitingRun(run);
      }
    }
    return updated;
  }

  private repos(client: PoolClient): {
    db: PoolClient;
    groups: PgAgentGroupRepository;
    runs: PgRunRepository;
    jobs: PgJobQueueRepository;
  } {
    return {
      db: client,
      groups: new PgAgentGroupRepository(client),
      runs: new PgRunRepository(client),
      jobs: new PgJobQueueRepository(client),
    };
  }

  private async requireManagedGroup(
    repo: PgAgentGroupRepository,
    identity: AgentGroupIdentity,
    groupId: string,
  ): Promise<AgentRunGroupRecord> {
    const group = await repo.getGroup(identity.spaceId, groupId);
    if (!group || !(await this.canManageGroup(repo, identity, group))) {
      throw new HttpError(404, "Agent group not found in this space");
    }
    return group;
  }

  private async requireReadableGroup(
    repo: PgAgentGroupRepository,
    identity: AgentGroupIdentity,
    groupId: string,
  ): Promise<AgentRunGroupRecord> {
    const group = await repo.getGroup(identity.spaceId, groupId);
    if (
      group?.project_id
      && !(await repo.canReadProject(
        identity.spaceId,
        group.project_id,
        identity.userId,
      ))
    ) {
      throw new HttpError(404, "Agent group not found in this space");
    }
    // A Room task is read by the Room's active roster and nobody else:
    // `manager_user_id` is lifecycle provenance, not authority (B8A), so a
    // member who was removed from the Room loses the tasks they started with
    // it. Outside a Room the manager is the only reader.
    const readable = Boolean(
      group
      && (
        group.room_id
          ? await repo.isActiveRoomUser(identity.spaceId, group.room_id, identity.userId)
          : group.manager_user_id === identity.userId
      )
    );
    if (!group || !readable) {
      throw new HttpError(404, "Agent group not found in this space");
    }
    return group;
  }

  private async canManageGroup(
    repo: PgAgentGroupRepository,
    identity: AgentGroupIdentity,
    group: AgentRunGroupRecord,
  ): Promise<boolean> {
    if (group.manager_user_id !== identity.userId) return false;
    if (group.room_id && !(await repo.isActiveRoomUser(identity.spaceId, group.room_id, identity.userId))) return false;
    if (!group.project_id) return true;
    return repo.canReadProject(
      identity.spaceId,
      group.project_id,
      identity.userId,
    );
  }

  private async spawnChildRunInTransaction(
    repos: {
      db: PoolClient;
      groups: PgAgentGroupRepository;
      runs: PgRunRepository;
      jobs: PgJobQueueRepository;
    },
    identity: AgentGroupIdentity,
    input: SpawnChildRunInput,
    preflightPolicy?: EnforceResult,
  ): Promise<{
    delegation: RunDelegationRecord;
    child_run_id: string | null;
    policy_decision_record_id: string | null;
  }> {
    const group = await repos.groups.lockGroup(input.space_id, input.group_id);
    if (!group || !(await this.canManageGroup(repos.groups, identity, group))) {
      throw new HttpError(404, "Agent group not found in this space");
    }
    if (group.status !== "active") {
      throw new HttpError(409, `Agent group is not active (current status: ${group.status})`);
    }
    if (!group.root_run_id || input.root_run_id !== group.root_run_id) {
      throw new HttpError(409, "root_run_id must match the agent group root run");
    }

    const parentRun = await repos.runs.getVisibleRun(
      input.space_id,
      identity.userId,
      input.parent_run_id,
    );
    if (!parentRun || parentRun.run_group_id !== group.id) {
      throw new HttpError(404, "Parent run not found in this agent group");
    }
    if (parentRun.agent_id !== input.requesting_agent_id) {
      throw new HttpError(403, "requesting_agent_id must match the parent run agent");
    }
    if ((parentRun.root_run_id ?? parentRun.id) !== group.root_run_id) {
      throw new HttpError(409, "Parent run does not belong to the group root lineage");
    }
    const childAccess = delegatedWorkspaceAccessFor(parentRun, input.workspace_access);

    if (input.tool_call_id) {
      const existing = await repos.groups.findDelegationByToolCallId(
        input.space_id,
        input.parent_run_id,
        input.tool_call_id,
      );
      if (existing) {
        return {
          delegation: existing,
          child_run_id: existing.child_run_id,
          policy_decision_record_id: existing.policy_decision_record_id,
        };
      }
    }

    await assertAgentsExist(repos.groups, input.space_id, identity.userId, [
      input.requesting_agent_id,
      input.target_agent_id,
    ], group.room_id);
    if (input.request_message_id) {
      const requestMessage = await repos.groups.getMessage(
        input.space_id,
        input.request_message_id,
      );
      if (!requestMessage || requestMessage.group_id !== input.group_id) {
        throw new HttpError(422, "request_message_id must belong to this agent group");
      }
      if (requestMessage.run_id && requestMessage.run_id !== input.parent_run_id) {
        throw new HttpError(422, "request_message_id must belong to the parent run");
      }
      if (
        requestMessage.sender_agent_id &&
        requestMessage.sender_agent_id !== input.requesting_agent_id
      ) {
        throw new HttpError(422, "request_message_id sender must match requesting_agent_id");
      }
    }

    // The Conversation's pinned backend, not an Agent's mutable default, owns
    // execution placement. Refuse unsupported read-only delegation before any
    // message, budget charge, child Run or thread claim is created.
    if (childAccess === "read" && group.room_id && parentRun.session_id) {
      const backend = await new PgConversationBackendRepository(repos.db).resolveBinding({
        space_id: input.space_id, user_id: identity.userId,
        session_id: parentRun.session_id, agent_id: input.target_agent_id, requested: null,
      });
      const host = backend.execution_host_id
        ? (await repos.db.query<{ kind: string }>("SELECT kind FROM hosts WHERE id=$1", [backend.execution_host_id])).rows[0]
        : null;
      const refusal = readOnlyWorkspaceHostRefusal(childAccess, backend.runtime_key, host?.kind);
      if (refusal) throw new HttpError(409, refusal, { code: "workspace_read_only_unenforceable", detail: refusal });
    }

    // Policy preflight is deliberately before every domain write. The
    // delegation/message rows below are the authorized (or denied-evidence)
    // execution phase and reuse this durable decision.
    let policy = preflightPolicy ?? await this.enforceSpawnPolicy(repos.groups, group, parentRun, input);
    // The preflight counted in its own transaction; another delegation may
    // have been admitted since. Under this lock the counts are current again,
    // and one past a limit is judged anew, to a recorded refusal.
    if (preflightPolicy?.status === "allow") {
      const counts = await this.spawnCounts(repos.groups, group, input);
      if (counts.fanout_count > counts.max_fanout || counts.concurrency_count > counts.max_concurrency
        || counts.container_turns_count > counts.hard_max_turns) {
        policy = await this.enforceSpawnPolicy(repos.groups, group, parentRun, input);
      }
    }
    if (policy.status === "error") {
      throw new HttpError(503, policy.message ?? "Policy audit failed for child run delegation");
    }

    const collaborationAdmission = policy.status === "allow" ? await repos.groups.collaborationLimits(group, input, true) : null;

    const requestMessageId = input.request_message_id ?? (await repos.groups.createMessage({
      space_id: input.space_id,
      group_id: input.group_id,
      run_id: input.parent_run_id,
      sender_actor_ref_json: {
        actor_type: "agent",
        agent_id: input.requesting_agent_id,
        requested_by_user_id: identity.userId,
      },
      sender_agent_id: input.requesting_agent_id,
      message_type: "delegation_request",
      content: input.instruction,
      mentions_json: [{ agent_id: input.target_agent_id }],
      metadata_json: { reason: input.reason ?? null },
    })).id;

    const delegation = await repos.groups.createDelegation({
      space_id: input.space_id,
      group_id: input.group_id,
      parent_run_id: input.parent_run_id,
      request_message_id: requestMessageId,
      requesting_agent_id: input.requesting_agent_id,
      target_agent_id: input.target_agent_id,
      requested_by_user_id: identity.userId,
      instruction: requiredTrimmed(input.instruction, "instruction"),
      reason: input.reason ?? null,
      budget_json: collaborationAdmission ? { ...input.budget_json, collaboration_task_id: collaborationAdmission.task_id } : input.budget_json ?? {},
      context_policy_json: input.context_policy_json ?? {},
      tool_call_id: input.tool_call_id ?? null,
    });

    await repos.runs.appendRunEvent({
      run_id: input.parent_run_id,
      space_id: input.space_id,
      event_type: "delegation_requested",
      status: "pending",
      summary: "Child run delegation requested",
      metadata_json: {
        group_id: input.group_id,
        delegation_id: delegation.id,
        target_agent_id: input.target_agent_id,
      },
    });

    if (policy.status !== "allow") {
      const denied = await repos.groups.updateDelegationAfterPolicy({
        space_id: input.space_id,
        delegation_id: delegation.id,
        status: "policy_denied",
        policy_decision_record_id: policy.policy_decision_record_id ?? null,
      });
      await repos.runs.appendRunEvent({
        run_id: input.parent_run_id,
        space_id: input.space_id,
        event_type: "delegation_policy_denied",
        status: "failed",
        summary: policy.message ?? "Child run delegation denied by policy",
        metadata_json: {
          group_id: input.group_id,
          delegation_id: delegation.id,
          policy_decision_record_id: policy.policy_decision_record_id ?? null,
          reason_code: policy.decision?.reason_code ?? null,
        },
      });
      return {
        delegation: denied,
        child_run_id: null,
        policy_decision_record_id: policy.policy_decision_record_id ?? null,
      };
    }

    const roomRunGranteeUserIds = group.room_id
      ? await repos.groups.listActiveRoomUserIds(input.space_id, group.room_id)
      : [];
    let delegatedSessionConfig: ResolvedSessionConfig = NO_SESSION_CONFIG;
    let delegatedBackend: ResolvedConversationBackend | null = null;
    let delegatedHostDispatch: PreparedRoomHostDispatch | null = null;
    let delegatedStanding: { text: string; digest: string; sent: boolean } | null = null;
    let delegatedHandoff: string | null = null;
    let delegatedWorkspaceAccess: Array<{ workspace_location_id: string; access_mode: "read" | "write" }> = [];
    if (group.room_id) {
      if (!parentRun.session_id) {
        throw new HttpError(409, "Room delegation requires a Room conversation session");
      }
      const backendRepository = new PgConversationBackendRepository(repos.db);
      const executionContexts = new PgConversationExecutionContextRepository(repos.db);
      const executionContext = await executionContexts.getContext(input.space_id, parentRun.session_id);
      if (!executionContext || executionContext.state !== "initialized" || !executionContext.execution_host_id || !executionContext.primary_workspace_mode) {
        throw new HttpError(409, "Initialize the Conversation execution context before delegating a Room task");
      }
      const projectLocations = await executionContexts.listProjectLocations(input.space_id, parentRun.project_id);
      for (const attachment of await executionContexts.listAttachments(input.space_id, parentRun.session_id)) {
        if (attachment.status !== "active") continue;
        const location = projectLocations.find((candidate) => candidate.id === attachment.workspace_location_id
          && candidate.project_folder_id === attachment.project_folder_id);
        if (!location || location.execution_host_id !== executionContext.execution_host_id
          || location.execution_ready !== true
          || !locationIsOnline(location)) {
          throw new HttpError(409, "A Conversation attachment is no longer available on its execution Host");
        }
        delegatedWorkspaceAccess.push({
          workspace_location_id: location.id,
          // A review reads every attachment, a `write` grant included.
          access_mode: childAccess === "read" ? "read" : attachment.access_mode,
        });
      }
      {
        delegatedBackend = await backendRepository.resolveBinding({
          space_id: input.space_id,
          user_id: identity.userId,
          session_id: parentRun.session_id,
          agent_id: input.target_agent_id,
          requested: null,
        });
        if (!delegatedBackend) {
          throw new HttpError(409, `Conversation runtime for Agent '${input.target_agent_id}' is unavailable`);
        }
        // Nobody chose these for this delegation: a value the runtime has
        // since withdrawn falls back to its default rather than failing it.
        delegatedSessionConfig = {
          ...reconcileSavedSessionConfig(
            await backendRepository.sessionConfig(input.space_id, parentRun.session_id, input.target_agent_id),
            delegatedBackend.session_config_options ?? [],
          ),
          source: "saved",
        };
        const thread = await executionContexts.getConversationThread(
          input.space_id,
          parentRun.session_id,
          input.target_agent_id,
        );
        if (!thread || thread.execution_host_id !== executionContext.execution_host_id
          || thread.workspace_mode !== executionContext.primary_workspace_mode
          || thread.workspace_location_id !== executionContext.primary_workspace_location_id) {
          throw new HttpError(409, `Conversation runtime continuity for Agent '${input.target_agent_id}' is unavailable`);
        }
        delegatedBackend = {
          ...delegatedBackend,
          runtime_key: thread.runtime_key,
          execution_host_id: thread.execution_host_id,
          workspace_mode: thread.workspace_mode,
          workspace_location_id: thread.workspace_location_id,
          runtime_installation: thread.runtime_installation,
        };
        delegatedHostDispatch = await prepareHostConversationDispatch({
          db: repos.db,
          backend: delegatedBackend,
          container: { kind: "conversation", conversation_id: parentRun.session_id },
          sessionId: parentRun.session_id,
          spaceId: input.space_id,
          projectId: parentRun.project_id,
          agentId: input.target_agent_id,
          userId: identity.userId,
        });
        // A delegated specialist runs in the same vendor session as one that
        // was addressed directly — `host_threads` is unique per Conversation ×
        // Agent — so it is given the same standing context under the same
        // rule: whenever that session does not already hold it. Otherwise the
        // same Agent would run with its role and persona on one turn and
        // without them on the next, depending only on how it was reached.
        if (group.room_id && delegatedHostDispatch) {
          const standing = await renderRoomStandingContext(repos.db, {
            spaceId: input.space_id,
            agentId: input.target_agent_id,
            roomId: group.room_id,
          });
          delegatedStanding = {
            ...standing,
            sent: standingContextRequired({
              resumingVendorSession: delegatedHostDispatch.host_resume_attempted,
              threadDigest: delegatedHostDispatch.host_thread.identity_digest,
              digest: standing.digest,
            }),
          };
          // A delegation can be what opens a renewed session; the handoff
          // then goes into it, or every later turn resumes a session without.
          const handoffArtifactId = delegatedHostDispatch.host_thread.handoff_artifact_id;
          delegatedHandoff = delegatedHostDispatch.host_prompt_fresh && handoffArtifactId
            ? await loadHandoffText(repos.db, input.space_id, handoffArtifactId)
            : null;
        }
      }
    }
    const childRun = await repos.runs.createDelegatedChildRun({
      execution_kind: "agent",
      agent_id: input.target_agent_id,
      space_id: input.space_id,
      user_id: identity.userId,
      // The child acts in the same conversation its parent was spoken to in,
      // and is allowed the same things there. Do not declare an empty
      // allowance. A delegated specialist could call no action at all.
      ...conversationToolGrantInputFor({
        room_id: group.room_id,
        project_id: parentRun.project_id,
        // Only a Room child carries the parent's `chat_turn`, and the resource
        // executor is registered from that turn's message. A child without one
        // would be handed tools with nothing behind them, so it is not told it
        // has them.
        has_input_resources: Boolean(group.room_id)
          && Array.isArray(parentRun.capabilities_json)
          && parentRun.capabilities_json.some((capability) => capability === "input_resource.read"),
      }),
      parent_run_id: input.parent_run_id,
      root_run_id: input.root_run_id,
      run_group_id: input.group_id,
      delegation_id: delegation.id,
      instructed_by_agent_id: input.requesting_agent_id,
      project_folder_id: delegatedHostDispatch?.project_folder_id ?? parentRun.project_folder_id,
      workspace_location_id: delegatedBackend?.workspace_location_id ?? null,
      trust_mode: delegatedHostDispatch?.host_is_remote ? "trusted_host" : null,
      host_task_thread_id: delegatedHostDispatch?.host_thread.id ?? null,
      session_id: parentRun.session_id,
      project_id: parentRun.project_id,
      prompt: group.room_id
        ? [
          delegatedStanding?.sent ? delegatedStanding.text : null,
          delegatedHandoff ? handoffPromptBlock(delegatedHandoff) : null,
          childAccess === "read" ? READ_ONLY_REVIEW_NOTICE : null,
          input.instruction,
        ].filter(Boolean).join("\n\n")
        : null,
      instruction: !group.room_id && childAccess === "read"
        ? `${READ_ONLY_REVIEW_NOTICE}\n\n${input.instruction}`
        : input.instruction,
      model_override_json: group.room_id
        ? delegatedRoomModelOverride(
          parentRun,
          input.target_agent_id,
          (await repos.groups.getMemberWithAgentStatus({
            space_id: input.space_id,
            group_id: input.group_id,
            agent_id: input.target_agent_id,
            user_id: group.manager_user_id,
          }))?.agent_current_version_id ?? null,
          input.instruction,
          delegatedBackend,
          delegatedHostDispatch,
          delegatedWorkspaceAccess,
          delegatedStanding,
          delegatedSessionConfig,
        )
        : null,
      runtime_profile_id: delegatedBackend?.runtime_profile_id ?? null,
      runtime_profile_selection_source: delegatedBackend ? "explicit" : "default",
      contract_snapshot: group.room_id
        ? { ...roomRunContract(group, undefined)!, workspace_access: childAccess }
        : childAccess === "read" ? { source: { kind: "direct" as const, id: null }, workspace_access: childAccess } : undefined,
      budget_json: input.budget_json ?? {},
      context_policy_json: input.context_policy_json ?? {},
      visibility: group.room_id ? "selected_users" : undefined,
      grantee_user_ids: roomRunGranteeUserIds,
      allow_system_assistant: Boolean(group.room_id),
    });
    if (delegatedHostDispatch) {
      await recordHostDispatch(new PgHostThreadRepository(repos.db), delegatedHostDispatch.host_thread, {
        lastRunId: childRun.id,
        sessionId: parentRun.session_id!,
        dispatchLockId: delegatedHostDispatch.dispatch_lock_id,
      });
    }
    const queued = await repos.groups.updateDelegationAfterPolicy({
      space_id: input.space_id,
      delegation_id: delegation.id,
      status: "queued",
      child_run_id: childRun.id,
      policy_decision_record_id: policy.policy_decision_record_id ?? null,
    });
    await repos.runs.appendRunEvent({
      run_id: input.parent_run_id,
      space_id: input.space_id,
      event_type: "delegation_queued",
      status: "succeeded",
      summary: "Child run delegation queued",
      metadata_json: {
        group_id: input.group_id,
        delegation_id: delegation.id,
        child_run_id: childRun.id,
        policy_decision_record_id: policy.policy_decision_record_id ?? null,
      },
    });
    // A Room Conversation serializes filesystem access. The child remains a
    // durable queued Run and is enqueued when its parent yields/finishes by
    // the lifecycle projector, so it cannot overlap the parent's turn.
    if (group.room_id && group.session_id) {
      await chargeDelegatedChild(repos.db, group, childRun.id);
    }

    return {
      delegation: queued,
      child_run_id: childRun.id,
      policy_decision_record_id: policy.policy_decision_record_id ?? null,
    };
  }

  /**
   * The fan-out and concurrency a delegation would bring the group to, and
   * their limits. Every count is the prospective one — what the group holds
   * if this delegation is admitted — because the policy compares `count > max`.
   */
  private async spawnCounts(
    repo: PgAgentGroupRepository,
    group: AgentRunGroupRecord,
    input: SpawnChildRunInput,
  ): Promise<{ fanout_count: number; max_fanout: number; soft_max_fanout: number; hard_max_fanout: number;
    container_turns_count: number; soft_max_turns: number; hard_max_turns: number; concurrency_count: number; max_concurrency: number }> {
    const fanoutCount = await repo.countDelegationsForParent({
      space_id: input.space_id,
      parent_run_id: input.parent_run_id,
    });
    const concurrencyCount = await repo.countActiveDelegationsForGroup({
      space_id: input.space_id,
      group_id: input.group_id,
    });
    const limits = delegationBudgetLimits(group.budget_json, Boolean(group.room_id));
    const collaboration = await repo.collaborationLimits(group, input);
    // A Room turn's delegations also draw on its container's Agent-triggered
    // turns (the fan-out ceiling), which several recipients of one wave share:
    // a parent's own `max_fanout` alone would let a wave spawn past it.
    const container = group.room_id ? await repo.roomBudgetContainer(group.space_id, group.id) : null;
    const containerLimits = roomBudgetLimits(container?.budget_json ?? group.budget_json);
    const containerCount = container ? await repo.countContainerDelegations(group.space_id, container.id) : fanoutCount;
    const turns = group.room_id ? await containerTurnsUsed(repo, group) : 0;
    const hard = collaboration?.max_fanout ?? (group.room_id
      ? (container ? Math.min(containerLimits.hard, limits.max_fanout) : 0)
      : limits.max_fanout);
    const soft = collaboration?.max_fanout ?? (group.room_id ? containerLimits.soft : limits.max_fanout);
    return {
      fanout_count: collaboration?.fanout_count ?? containerCount + 1,
      max_fanout: hard,
      soft_max_fanout: soft,
      hard_max_fanout: hard,
      container_turns_count: turns + 1,
      soft_max_turns: collaboration?.max_turns ?? (group.room_id ? containerLimits.softTurns : Number.MAX_SAFE_INTEGER),
      hard_max_turns: collaboration?.max_turns ?? (group.room_id ? containerLimits.hardTurns : Number.MAX_SAFE_INTEGER),
      concurrency_count: concurrencyCount + 1,
      max_concurrency: limits.max_concurrency,
    };
  }

  private async enforceSpawnPolicy(
    repo: PgAgentGroupRepository,
    group: AgentRunGroupRecord,
    parentRun: RunRecord,
    input: SpawnChildRunInput,
  ): Promise<EnforceResult> {
    const registry = await loadActionRegistry();
    // Spawn runs inside the caller's transaction, so every repository read
    // uses the same checked-out Client and must finish before the next starts.
    const requestingMember = await repo.getMemberWithAgentStatus({
      space_id: input.space_id,
      group_id: input.group_id,
      agent_id: input.requesting_agent_id,
      user_id: group.manager_user_id,
    });
    const targetMember = await repo.getMemberWithAgentStatus({
      space_id: input.space_id,
      group_id: input.group_id,
      agent_id: input.target_agent_id,
      user_id: group.manager_user_id,
    });
    const depth = await repo.runDepth({ space_id: input.space_id, run_id: input.parent_run_id });
    const counts = await this.spawnCounts(repo, group, input);
    const widening = authorityWidening(parentRun, input.context_policy_json ?? {});
    const limits = delegationBudgetLimits(group.budget_json, Boolean(group.room_id));
    const req: PolicyCheckRequest = {
      action: "run.spawn_child",
      actor_type: "agent",
      actor_id: input.requesting_agent_id,
      actor_ref: {
        agent_id: input.requesting_agent_id,
        requested_by_user_id: input.manager_user_id,
      },
      space_id: input.space_id,
      resource_space_id: input.space_id,
      resource_type: "run",
      resource_id: input.parent_run_id,
      run_id: input.parent_run_id,
      context: {
        group_id: input.group_id,
        parent_run_id: input.parent_run_id,
        root_run_id: input.root_run_id,
        requesting_agent_id: input.requesting_agent_id,
        target_agent_id: input.target_agent_id,
        manager_user_id: input.manager_user_id,
        group_status: group.status,
        requesting_agent_status: requestingMember?.agent_status ?? "missing",
        target_agent_status: targetMember?.agent_status ?? "missing",
        requesting_member_status: requestingMember?.status ?? "missing",
        target_member_status: targetMember?.status ?? "missing",
        // Every count is the prospective one — what the group holds if this
        // delegation is admitted — because the policy compares `count > max`.
        // Fanout uses the shared container total for Room temporary budgets,
        // or the current declared collaboration epoch; denied calls cost none.
        depth: depth + 1,
        max_depth: limits.max_depth,
        fanout_count: counts.fanout_count,
        max_fanout: counts.max_fanout,
        soft_max_fanout: counts.soft_max_fanout,
        hard_max_fanout: counts.hard_max_fanout,
        container_turns_count: counts.container_turns_count,
        soft_max_turns: counts.soft_max_turns,
        hard_max_turns: counts.hard_max_turns,
        concurrency_count: counts.concurrency_count,
        max_concurrency: counts.max_concurrency,
        group_budget_json: group.budget_json ?? {},
        requested_budget_json: input.budget_json ?? {},
        ...widening,
        trigger_origin: "delegation",
      },
      metadata_json: {
        group_id: input.group_id,
        delegation_id: null,
        parent_run_id: input.parent_run_id,
        root_run_id: input.root_run_id,
        requesting_agent_id: input.requesting_agent_id,
        target_agent_id: input.target_agent_id,
      },
      force_record: true,
    };
    return this.policyEnforcer(this.config, registry, req);
  }
}

async function assertAgentsActive(
  repo: PgAgentGroupRepository,
  spaceId: string,
  userId: string,
  agentIds: readonly string[],
  allowSystemAssistant = false,
  roomId?: string | null,
): Promise<void> {
  const statuses = await repo.listAgentStatuses(spaceId, userId, agentIds, roomId);
  const byId = new Map(statuses.map((row) => [row.id, row]));
  for (const agentId of agentIds) {
    const status = byId.get(agentId);
    if (!status) throw new HttpError(404, `Agent '${agentId}' not found in this space`);
    if (status.agent_kind === "system_assistant" && !allowSystemAssistant) {
      throw new HttpError(404, `Agent '${agentId}' not found in this space`);
    }
    if (status.status !== "active") {
      throw new HttpError(409, `Agent '${agentId}' is not active`);
    }
  }
}

async function assertActiveGroupMember(
  repo: PgAgentGroupRepository,
  spaceId: string,
  groupId: string,
  agentId: string,
  userId: string,
  fieldName: string,
  allowSystemAssistant = false,
): Promise<void> {
  const member = await repo.getMemberWithAgentStatus({
    space_id: spaceId,
    group_id: groupId,
    agent_id: agentId,
    user_id: userId,
  });
  if (!member) {
    throw new HttpError(422, `${fieldName} must be a member of this agent group`);
  }
  if (member.status !== "active") {
    throw new HttpError(409, `${fieldName} is not active in this agent group`);
  }
  if (member.agent_status !== "active") {
    throw new HttpError(409, `${fieldName} agent is not active`);
  }
  if (member.agent_kind === "system_assistant" && !allowSystemAssistant) {
    throw new HttpError(404, `${fieldName} must reference an ordinary Agent`);
  }
}

async function assertAgentsExist(
  repo: PgAgentGroupRepository,
  spaceId: string,
  userId: string,
  agentIds: readonly string[],
  roomId?: string | null,
): Promise<void> {
  const statuses = await repo.listAgentStatuses(spaceId, userId, uniqueIds(agentIds), roomId);
  const existing = new Set(statuses.map((row) => row.id));
  for (const agentId of agentIds) {
    if (!existing.has(agentId)) {
      throw new HttpError(404, `Agent '${agentId}' not found in this space`);
    }
  }
}

function messageRecipientSegmentsForInput(
  input: SendAgentGroupMessageInput,
  managerAgentId: string,
  fullContent: string,
): AgentGroupMessageRecipientSegment[] {
  const routingMode = input.routing_mode ?? "direct";
  if (routingMode === "agent_coordination") {
    return [{
      recipient_agent_ids: [requiredTrimmed(managerAgentId, "manager_agent_id")],
      content: fullContent,
    }];
  }
  if (routingMode !== "direct") {
    throw new HttpError(422, "routing_mode must be direct or agent_coordination");
  }
  const rawSegments = input.recipient_segments?.length
    ? input.recipient_segments
    : [{ recipient_agent_ids: [managerAgentId], content: fullContent }];
  const segments = rawSegments.map((segment, index) => ({
    recipient_agent_ids: uniqueIds(segment.recipient_agent_ids)
      .map((id) => requiredTrimmed(id, `recipient_segments[${index}].recipient_agent_ids`)),
    content: (input.input_parts?.length || input.capability_input_parts?.length)
      ? segment.content.trim()
      : requiredTrimmed(segment.content, `recipient_segments[${index}].content`),
  })).filter((segment) => segment.recipient_agent_ids.length > 0);
  if (segments.length === 0) throw new HttpError(422, "recipient_segments is required");
  return segments;
}

interface PreparedRoomConversationBackend extends ResolvedConversationBackend {
  session_config: ResolvedSessionConfig;
  room_id: string;
  session_id: string;
  user_id: string;
  project_id: string | null;
  agent_version_id: string;
  message_cursor_id: string;
  host_project_folder_id: string | null;
  host_is_remote: boolean;
  host_thread: HostThread | null;
  host_workspace: LaunchWorkspace | null;
  host_prompt_context: string | null;
  host_prompt_fresh: boolean;
  host_resume_attempted: boolean;
  host_dispatch_lock_id: string | null;
  /** The standing-context digest this turn was built with, and whether its block is in the prompt. */
  host_standing_context: { digest: string; sent: boolean } | null;
  /** Set when this thread's vendor session must hand off and rotate before the turn. */
  workspace_access: Array<{ workspace_location_id: string; access_mode: "read" | "write" }>;
  git_snapshot: RunGitSnapshot;
}

interface PreparedRoomHostDispatch {
  project_folder_id: string | null;
  host_is_remote: boolean;
  host_thread: HostThread;
  workspace: LaunchWorkspace;
  host_prompt_fresh: boolean;
  host_resume_attempted: boolean;
  dispatch_lock_id: string;
  git_snapshot: RunGitSnapshot;
}

async function recordHostDispatch(
  threads: PgHostThreadRepository,
  thread: HostThread,
  input: { lastRunId: string; sessionId: string; dispatchLockId: string },
): Promise<void> {
  if (thread.container_kind === "conversation") {
    await threads.recordConversationDispatch(thread.id, input);
  } else {
    await threads.recordDirectDispatch(thread.id, input);
  }
}

export async function prepareHostConversationDispatch(input: {
  db: Pool | PoolClient;
  backend: ResolvedConversationBackend;
  container: { kind: "conversation"; conversation_id: string } | { kind: "direct"; user_id: string };
  sessionId: string;
  spaceId: string;
  projectId: string | null;
  agentId: string;
  userId: string;
}): Promise<PreparedRoomHostDispatch | null> {
  const hostFields = [
    input.backend.execution_host_id,
    input.backend.workspace_mode,
    input.backend.runtime_installation,
  ];
  const hostBound = hostFields.every(Boolean);
  if (!hostBound) {
    if (hostFields.some(Boolean)) {
      throw new HttpError(409, `Room agent '${input.agentId}' has an incomplete host execution binding`);
    }
    return null;
  }
  if (!isLocalCliRuntimeAdapter(input.backend.runtime_key)) {
    throw new HttpError(409, `Room agent '${input.agentId}' has a host binding for an unsupported runtime`);
  }

  // A Project Room can contain several Conversations. Runtime continuity and
  // the managed cwd therefore belong to this Conversation, not to the Room.
  const conversationScoped = input.container.kind === "conversation";
  const directUserId = input.container.kind === "direct" ? input.container.user_id : null;

  const target = input.backend.workspace_mode === "location"
    ? await new PgWorkspaceLocationRepository(input.db).resolveDispatchTarget(
        input.backend.workspace_location_id!,
        { allowStale: conversationScoped },
      )
    : (await input.db.query<{
        host_id: string;
        host_kind: string;
        host_owner_user_id: string | null;
        host_status: string;
        last_heartbeat_at: string | null;
        capabilities_json: Record<string, unknown> | null;
      }>(
        `SELECT id AS host_id, kind AS host_kind, owner_user_id AS host_owner_user_id,
                status AS host_status, last_heartbeat_at, capabilities_json
           FROM hosts WHERE id = $1 LIMIT 1`,
        [input.backend.execution_host_id],
      )).rows[0];
  const hostKind = target && "execution_host_kind" in target
    ? target.execution_host_kind
    : target && "host_kind" in target
      ? target.host_kind
      : null;
  if (!target || target.host_id !== input.backend.execution_host_id || (hostKind !== "remote" && hostKind !== "server")) {
    throw new HttpError(409, `Room agent '${input.agentId}' has an invalid host execution target`);
  }
  if (!conversationScoped && !directUserId) {
    throw new HttpError(422, "Direct host dispatch requires a user-scoped container");
  }
  if (
    input.backend.workspace_mode === "location"
    && (!("project_id" in target) || target.project_id !== input.projectId)
  ) {
    throw new HttpError(409, `Location-bound Agent '${input.agentId}' requires its Project context`);
  }
  if (hostKind === "remote" && target.host_owner_user_id !== input.userId) {
    throw new HttpError(403, `Room agent '${input.agentId}' can only be triggered by its host owner`);
  }
  // Same predicate for both host kinds. `markOffline` only fires on a
  // WebSocket close, so a restart can leave `status = 'online'` against a
  // stale heartbeat. Do not skip the staleness term for the built-in host.
  const hostOnline = "host_online" in target
    ? target.host_online
    : hostIsOnline({ kind: hostKind, status: target.host_status, last_heartbeat_at: target.last_heartbeat_at });
  const executionReady = "execution_ready" in target ? target.execution_ready : true;
  // The built-in host runs the copies its daemon installed and has no vendor
  // CLI on PATH. Do not skip the installation check for it: a Room turn would
  // dispatch to a runtime that is not there and fail at the spawn.
  const runtimeAvailable = hostInstallationIds(target.capabilities_json, input.backend.runtime_key)
    .includes(input.backend.runtime_installation!);
  if (!hostOnline || !executionReady || !runtimeAvailable) {
    throw new HttpError(409, `Room agent '${input.agentId}' host is offline or its runtime is unavailable`);
  }

  const threads = new PgHostThreadRepository(input.db);
  let hostThread = conversationScoped
    ? await threads.getOrCreateForConversationAgent({
        executionHostId: input.backend.execution_host_id!,
        workspaceMode: input.backend.workspace_mode!,
        workspaceLocationId: input.backend.workspace_location_id,
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        runtimeKey: input.backend.runtime_key,
        runtimeInstallation: input.backend.runtime_installation!,
        createdByUserId: input.userId,
      })
    : input.backend.workspace_mode === "managed"
      ? await threads.getOrCreateForDirect({
          workspaceMode: "managed",
          executionHostId: input.backend.execution_host_id!,
          userId: directUserId!,
          agentId: input.agentId,
          runtimeKey: input.backend.runtime_key,
          runtimeInstallation: input.backend.runtime_installation!,
          createdByUserId: input.userId,
        })
      : await threads.getOrCreateForDirect({
          workspaceMode: "location",
          workspaceLocationId: input.backend.workspace_location_id!,
          executionHostId: input.backend.execution_host_id!,
          userId: directUserId!,
          agentId: input.agentId,
          runtimeKey: input.backend.runtime_key,
          runtimeInstallation: input.backend.runtime_installation!,
          createdByUserId: input.userId,
        });
  if (
    hostThread.execution_host_id !== input.backend.execution_host_id
    || hostThread.workspace_location_id !== input.backend.workspace_location_id
    || hostThread.workspace_mode !== input.backend.workspace_mode
    || hostThread.runtime_key !== input.backend.runtime_key
    || hostThread.runtime_installation !== input.backend.runtime_installation
  ) {
    throw new HttpError(
      409,
      `Room agent '${input.agentId}' has an existing host session pinned to a different runtime; remove and re-add it before changing the binding`,
    );
  }
  const dispatchLockId = randomUUID();
  const claimed = conversationScoped
    ? await threads.claimConversationDispatch(hostThread.id, dispatchLockId)
    : await threads.claimDirectDispatch(hostThread.id, dispatchLockId);
  if (!claimed) {
    const detail = `Room agent '${input.agentId}' is already handling another Room turn; wait for it to finish before sending another message`;
    throw new HttpError(409, detail, { detail, code: "room_agent_turn_in_progress" });
  }
  // A thread with no vendor session is fresh whatever its status says: a
  // first turn after a rotation or reset that failed before the runtime
  // started one leaves `active` with nothing to resume, and must still replay.
  const hostPromptFresh = hostThread.status === "session_reset"
    || hostThread.last_session_id !== input.sessionId
    || !hostThread.vendor_session_id;
  const gitSnapshot = await readRunGitSnapshot(
    input.db,
    input.spaceId,
    input.backend.workspace_mode === "location" ? input.backend.workspace_location_id : null,
    input.backend.workspace_mode === "managed",
  );
  return {
    project_folder_id: "project_folder_id" in target ? target.project_folder_id : null,
    host_is_remote: hostKind === "remote",
    workspace: input.backend.workspace_mode === "managed"
      ? { kind: "managed", agent_id: input.agentId, container: conversationScoped
          ? { kind: "conversation", conversation_id: input.sessionId }
          : { kind: "direct", user_id: directUserId! } }
      : { kind: "location", workspace_location_id: input.backend.workspace_location_id! },
    host_thread: { ...hostThread, dispatch_lock_id: dispatchLockId },
    host_prompt_fresh: hostPromptFresh,
    host_resume_attempted: Boolean(hostThread.vendor_session_id) && !hostPromptFresh,
    dispatch_lock_id: dispatchLockId,
    git_snapshot: gitSnapshot,
  };
}

async function prepareRoomConversationBackends(input: {
  config: ServerConfig;
  db: PoolClient;
  identity: AgentGroupIdentity;
  roomId: string;
  sessionId: string;
  projectId: string | null;
  messageCursorId: string | null;
  agentIds: readonly string[];
  requested: NonNullable<SendAgentGroupMessageInput["backends"]>;
}): Promise<Map<string, PreparedRoomConversationBackend>> {
  if (!input.messageCursorId) {
    throw new HttpError(409, "Room task is missing its triggering message");
  }
  const requestedByAgent = new Map(
    input.requested.map((selection) => [selection.agent_id, selection]),
  );
  for (const agentId of requestedByAgent.keys()) {
    if (!input.agentIds.includes(agentId)) {
      throw new HttpError(422, "backend agent_id must be a recipient of this Room message");
    }
  }
  const repository = new PgConversationBackendRepository(input.db);
  const turnSource = await loadRoomTurnSource(
    input.db,
    input.identity.spaceId,
    input.sessionId,
    input.messageCursorId,
  );
  const contextRevisions = await listRoomContextRevisions(
    input.db,
    input.identity.spaceId,
    input.projectId,
    input.agentIds,
  );
  const executionContexts = new PgConversationExecutionContextRepository(input.db);
  const session = await executionContexts.getVisibleSession(
    { spaceId: input.identity.spaceId, userId: input.identity.userId },
    input.sessionId,
    { forUpdate: true },
  );
  if (!session) throw new HttpError(404, "Room conversation not found");
  const executionContext = await executionContexts.lockDraft(session);
  if (!executionContext || executionContext.state !== "initialized" || !executionContext.execution_host_id || !executionContext.primary_workspace_mode) {
    throw new HttpError(409, "Initialize the Conversation execution context before sending a Room message");
  }
  const executionHost = await input.db.query<{ kind: "server" | "remote" }>(
    "SELECT kind FROM hosts WHERE id = $1 LIMIT 1",
    [executionContext.execution_host_id],
  );
  if (!executionHost.rows[0]) throw new HttpError(409, "The Conversation execution Host is unavailable");
  const hostIsRemote = executionHost.rows[0].kind === "remote";
  const pinnedLocations = await executionContexts.listProjectLocations(input.identity.spaceId, input.projectId);
  const workspaceAccess = [] as Array<{ workspace_location_id: string; access_mode: "read" | "write" }>;
  for (const attachment of await executionContexts.listAttachments(input.identity.spaceId, input.sessionId)) {
    if (attachment.status !== "active") continue;
    const location = pinnedLocations.find((candidate) => candidate.id === attachment.workspace_location_id
      && candidate.project_folder_id === attachment.project_folder_id);
    if (!location || location.execution_host_id !== executionContext.execution_host_id
      || location.execution_ready !== true
      || !locationIsOnline(location)) {
      throw new HttpError(409, "A Conversation attachment is no longer available on its execution Host");
    }
    workspaceAccess.push({
      workspace_location_id: location.id,
      access_mode: attachment.access_mode,
    });
  }
  const resolved = new Map<string, PreparedRoomConversationBackend>();
  for (const agentId of input.agentIds) {
    const requested = requestedByAgent.get(agentId);
    const backend = await repository.resolveBinding({
      space_id: input.identity.spaceId,
      user_id: input.identity.userId,
      session_id: input.sessionId,
      agent_id: agentId,
      requested: requested ? { runtime_profile_id: requested.runtime_profile_id } : null,
    });
    const thread = await executionContexts.getConversationThread(
      input.identity.spaceId,
      input.sessionId,
      agentId,
    );
    if (!thread || thread.execution_host_id !== executionContext.execution_host_id
      || thread.workspace_mode !== executionContext.primary_workspace_mode
      || thread.workspace_location_id !== executionContext.primary_workspace_location_id) {
      throw new HttpError(409, `Conversation runtime continuity for Agent '${agentId}' is unavailable`);
    }
    const pinnedBackend: ResolvedConversationBackend = {
      ...backend,
      runtime_key: thread.runtime_key,
      execution_host_id: thread.execution_host_id,
      workspace_mode: thread.workspace_mode,
      workspace_location_id: thread.workspace_location_id,
      runtime_installation: thread.runtime_installation,
    };
    // A selection sent with this message is strict; a saved, inherited or
    // replayed one the runtime has since withdrawn falls back to its default.
    const sessionConfig = requested?.session_config && requested.session_config_inherited
      ? { ...reconcileSavedSessionConfig(requested.session_config, pinnedBackend.session_config_options ?? []), source: "saved" as const }
      : await resolveSessionConfig(
        requested?.session_config,
        () => repository.sessionConfig(input.identity.spaceId, input.sessionId, agentId),
        pinnedBackend.session_config_options ?? [],
      );
    const revision = contextRevisions.get(agentId) ?? null;
    if (!revision?.agent_version_id) {
      throw new HttpError(409, `Room agent '${agentId}' has no active version`);
    }
    const hostBound = Boolean(
      pinnedBackend.execution_host_id && pinnedBackend.workspace_mode && pinnedBackend.runtime_installation,
    );
    let hostThread: HostThread | null = null;
    let hostWorkspace: LaunchWorkspace | null = null;
    let hostProjectFolderId: string | null = null;
    let hostPromptContext: string | null = null;
    let hostPromptFresh = false;
    let hostResumeAttempted = false;
    let hostDispatchLockId: string | null = null;
    let standingContext: { digest: string; sent: boolean } | null = null;
    let gitSnapshot = unavailableGitSnapshot();
    if (hostBound) {
      const hostDispatch = await prepareHostConversationDispatch({
        db: input.db,
        backend: pinnedBackend,
        container: { kind: "conversation", conversation_id: input.sessionId },
        sessionId: input.sessionId,
        spaceId: input.identity.spaceId,
        projectId: input.projectId,
        agentId,
        userId: input.identity.userId,
      });
      if (!hostDispatch) throw new HttpError(409, `Room agent '${agentId}' has an incomplete host execution binding`);
      hostProjectFolderId = hostDispatch.project_folder_id;
      hostThread = hostDispatch.host_thread;
      hostWorkspace = hostDispatch.workspace;
      hostDispatchLockId = hostDispatch.dispatch_lock_id;
      hostPromptFresh = hostDispatch.host_prompt_fresh;
      hostResumeAttempted = hostDispatch.host_resume_attempted;
      gitSnapshot = hostDispatch.git_snapshot;
      // A fresh session starts empty, as a cleared CLI session does: no
      // replay of the transcript, no rolling summary. What the Agent needs
      // of the history it reads with `conversation.search` / `.read`, and a
      // restart from a summary carries that summary (below). A resumed
      // session is sent what others said since its own last turn.
      const hostMessages = hostPromptFresh
        ? []
        : await listRoomMessagesSinceAgentTurn(
            input.db,
            input.identity.spaceId,
            input.sessionId,
            input.messageCursorId,
            agentId,
          );
      const conversationPrefix = hostPromptFresh
        ? `You are now in ${JSON.stringify(turnSource.conversation_title)}.`
        : null;
      // A fresh session after a rotation starts from the handoff the Agent
      // wrote, not only the turn that the rotation admitted.
      const handoffText = hostPromptFresh && hostThread.handoff_artifact_id
        ? await loadHandoffText(input.db, input.identity.spaceId, hostThread.handoff_artifact_id)
        : null;
      // Who this Agent is, and the Room's rules, before what it is being
      // asked — whenever the vendor session does not already hold exactly
      // this: a fresh or reset session, or a revised persona, a roster change
      // that alters which notes may be delivered, a rules edit. Re-sending
      // cannot *retract* what an earlier turn already put into that session;
      // only a context reset does, which is ADR 0003 §4's own position on the
      // audience filter guarding the moment of dispatch.
      const standing = await renderRoomStandingContext(input.db, {
        spaceId: input.identity.spaceId,
        agentId,
        roomId: input.roomId,
      });
      const sendStanding = standingContextRequired({
        resumingVendorSession: hostResumeAttempted,
        threadDigest: hostThread.identity_digest,
        digest: standing.digest,
      });
      standingContext = { digest: standing.digest, sent: sendStanding };
      hostPromptContext = [
        sendStanding ? standing.text : null,
        conversationPrefix,
        handoffText ? handoffPromptBlock(handoffText) : null,
        renderRoomPromptMessages(hostMessages),
      ].filter(Boolean).join("\n\n") || null;
    }
    resolved.set(agentId, {
      ...pinnedBackend,
      session_config: sessionConfig,
      room_id: input.roomId,
      session_id: input.sessionId,
      user_id: input.identity.userId,
      project_id: input.projectId,
      agent_version_id: revision.agent_version_id,
      message_cursor_id: input.messageCursorId,
      host_project_folder_id: hostProjectFolderId,
      host_is_remote: hostIsRemote,
      host_thread: hostThread,
      host_workspace: hostWorkspace,
      host_prompt_context: hostPromptContext,
      host_prompt_fresh: hostPromptFresh,
      host_resume_attempted: hostResumeAttempted,
      host_dispatch_lock_id: hostDispatchLockId,
      host_standing_context: standingContext,
      workspace_access: workspaceAccess,
      git_snapshot: gitSnapshot,
    });
  }
  return resolved;
}

/**
 * A delegated child is an Agent-triggered turn: it is charged to the turn's
 * container — the discussion's count when the group is a wave of one, the
 * group's own count otherwise — so a later completion turn inherits what is
 * left rather than a fresh budget. It is also a live turn of the message that
 * started the group: the child's Run id is listed in that message's
 * `delegated_run_ids`, beside the recipients' `run_ids`.
 */
/** Agent-triggered turns a Room group's container — or its discussion — has used. */
async function containerTurnsUsed(repo: PgAgentGroupRepository, group: AgentRunGroupRecord): Promise<number> {
  return repo.containerTurnsUsed({
    space_id: group.space_id,
    discussion_id: group.discussion_id ?? null,
    container_group_id: containerGroupOf(group.id, group.budget_json),
  });
}

async function chargeDelegatedChild(db: PoolClient, group: AgentRunGroupRecord, childRunId: string): Promise<void> {
  if (group.discussion_id) {
    await db.query(
      `UPDATE room_discussions SET turns_used = turns_used + 1, updated_at = now() WHERE space_id = $1 AND id = $2`,
      [group.space_id, group.discussion_id],
    );
  } else {
    await chargeContainer(db, group.space_id, containerGroupOf(group.id, group.budget_json));
  }
  await warnRoomSoftBudget(db, group.space_id, group.id);
  // Listed on the message a person can see: a continuation's own trigger is
  // a hidden instruction, so a wave's child goes on the discussion's origin
  // and a completion turn's on its container's message. Only in
  // `delegated_run_ids`: `run_ids` names a message's recipients, and retry
  // and the turn controls read it as exactly that.
  const visible = (await db.query<{ message_id: string | null }>(
    `SELECT COALESCE(discussion.origin_message_id, container.trigger_message_id, grp.trigger_message_id) AS message_id
       FROM agent_run_groups grp
       LEFT JOIN room_discussions discussion
         ON discussion.space_id = grp.space_id AND discussion.id = grp.discussion_id
       LEFT JOIN agent_run_groups container
         ON container.space_id = grp.space_id AND container.id = grp.budget_json->>'container_group_id'
      WHERE grp.space_id = $1 AND grp.id = $2`,
    [group.space_id, group.id],
  )).rows[0]?.message_id;
  if (visible) {
    await db.query(
      `UPDATE messages
          SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object(
                'delegated_run_ids', COALESCE(metadata_json->'delegated_run_ids', '[]'::jsonb) || to_jsonb($3::text))
        WHERE space_id = $1 AND id = $2 AND session_id = $4`,
      [group.space_id, visible, childRunId, group.session_id],
    );
  }
}

function roomRunModelOverride(
  backend: PreparedRoomConversationBackend | undefined,
  turn: Parameters<typeof roomTurnModelOverride>[0],
): Record<string, unknown> | null {
  const routing = {
    ...(roomTurnModelOverride(turn) ?? {}),
    ...roomCoordinationModelOverride(turn.coordinationTargets),
  };
  if (!backend) return Object.keys(routing).length > 0 ? routing : null;
  const assignedTask = turn.routingSegments[turn.currentSegmentIndex]?.content ?? "";
  return {
    ...routing,
    execution_mode: "room_conversation.v1",
    ...sessionConfigRunOverride(backend.session_config),
    conversation_backend: {
      schema_version: "conversation_backend.v1",
      runtime_profile_id: backend.runtime_profile_id,
      runtime_key: backend.runtime_key,
      model_name: backend.model_name,
      model_provider_id: backend.model_provider_id,
      prompt_capabilities: backend.prompt_capabilities ?? null,
    },
    chat_turn: {
      schema_version: "chat_turn.v1",
      // What this turn was asked to do, kept apart from the assembled prompt.
      // A sibling Agent waiting on this Run is shown the task; the prompt also
      // carries this Agent's own persona and notes, which are not the
      // sibling's to read (ADR 0003 §4).
      assigned_task: assignedTask,
      session_id: backend.session_id,
      room_id: backend.room_id,
      user_id: backend.user_id,
      user_message_id: backend.message_cursor_id,
      agent_id: turn.currentRecipientAgentId,
      agent_version_id: backend.agent_version_id,
      project_id: backend.project_id,
      ...(turn.retryOfRunId ? { retry_of_run_id: turn.retryOfRunId } : {}),
    },
    ...(backend.host_thread
      ? {
          workspace: backend.host_workspace,
          workspace_access: backend.workspace_access,
          host_thread: {
            schema_version: "host_thread.v1",
            thread_id: backend.host_thread.id,
            runtime_session_id: backend.host_resume_attempted
              ? backend.host_thread.vendor_session_id
              : null,
            fresh: backend.host_prompt_fresh,
            ...(backend.host_standing_context
              ? {
                  identity_digest: backend.host_standing_context.digest,
                  identity_sent: backend.host_standing_context.sent,
                }
              : {}),
          },
        }
      : {}),
  };
}


function delegatedRoomModelOverride(
  parentRun: Pick<RunRecord, "model_override_json">,
  targetAgentId: string,
  targetAgentVersionId: string | null,
  instruction: string,
  backend?: ResolvedConversationBackend | null,
  hostDispatch?: PreparedRoomHostDispatch | null,
  workspaceAccess: Array<{ workspace_location_id: string; access_mode: "read" | "write" }> = [],
  standing: { digest: string; sent: boolean } | null = null,
  sessionConfig: ResolvedSessionConfig = NO_SESSION_CONFIG,
): Record<string, unknown> {
  const parent = recordValue(parentRun.model_override_json);
  const parentTurn = recordValue(parent.chat_turn);
  return {
    execution_mode: "room_conversation.v1",
    ...sessionConfigRunOverride(sessionConfig),
    ...(backend
      ? {
          conversation_backend: {
            schema_version: "conversation_backend.v1",
            runtime_profile_id: backend.runtime_profile_id,
            runtime_key: backend.runtime_key,
                  model_name: backend.model_name,
            model_provider_id: backend.model_provider_id,
          },
        }
      : {}),
    // Always, not only when the parent had one. The parent's task is not this
    // child's. Do not inherit it. A sibling waiting on this Run would see the
    // Manager's request where its own delegation instruction belongs. Leaving
    // the key out is worse still: the child's prompt opens with its
    // own identity block, so a Run with no task falls back to handing that
    // block to whichever Agent waits on it. A sibling is shown the task, never
    // the prompt.
    chat_turn: {
      ...(parentTurn.schema_version === "chat_turn.v1" ? parentTurn : { schema_version: "chat_turn.v1" }),
      agent_id: targetAgentId,
      // The child's own version, not the Manager's that the spread carried:
      // the finalizer attributes the specialist's reply from this turn record.
      ...(targetAgentVersionId ? { agent_version_id: targetAgentVersionId } : {}),
      assigned_task: instruction,
    },
    // A Room child's prompt is assembled with this instruction as its last
    // part; acquisition reads this fact rather than matching the text.
    [RUN_REQUEST_INCLUDES_INSTRUCTION]: true,
    ...(backend && hostDispatch
      ? {
          workspace: hostDispatch.workspace,
          workspace_access: workspaceAccess,
          host_thread: {
            schema_version: "host_thread.v1",
            thread_id: hostDispatch.host_thread.id,
            runtime_session_id: hostDispatch.host_resume_attempted
              ? hostDispatch.host_thread.vendor_session_id
              : null,
            fresh: hostDispatch.host_prompt_fresh,
            ...(standing ? { identity_digest: standing.digest, identity_sent: standing.sent } : {}),
          },
        }
      : {}),
  };
}

interface RoomPromptMessage {
  id: string;
  user_id: string | null;
  sender_agent_id: string | null;
  role: string;
  content: string;
  created_at: string;
  instructed_by_user_id: string | null;
}

interface RoomContextRevision {
  agent_version_id: string | null;
  agent_updated_at: string;
  project_updated_at: string | null;
  active_brief_version_id: string | null;
}

async function listRoomContextRevisions(
  db: PoolClient,
  spaceId: string,
  projectId: string | null,
  agentIds: readonly string[],
): Promise<Map<string, RoomContextRevision>> {
  const result = await db.query<RoomContextRevision & { agent_id: string }>(
    `SELECT agent.id AS agent_id,
            agent.current_version_id AS agent_version_id,
            agent.updated_at AS agent_updated_at,
            project.updated_at AS project_updated_at,
            project.active_brief_version_id
       FROM agents agent
       LEFT JOIN projects project
         ON project.space_id = agent.space_id
        AND project.id = $3
      WHERE agent.space_id = $1
        AND agent.id = ANY($2::varchar[])`,
    [spaceId, agentIds, projectId],
  );
  return new Map(result.rows.map((row) => [row.agent_id, row]));
}

interface RoomTurnSource {
  conversation_title: string;
}

/** The turn's trigger message must still exist; the title orients a fresh session. */
async function loadRoomTurnSource(
  db: PoolClient,
  spaceId: string,
  sessionId: string,
  currentMessageId: string,
): Promise<RoomTurnSource> {
  const current = await db.query(
    `SELECT 1 FROM messages WHERE space_id = $1 AND session_id = $2 AND id = $3 LIMIT 1`,
    [spaceId, sessionId, currentMessageId],
  );
  if (!current.rows[0]) {
    throw new HttpError(409, "Room task trigger message is no longer available");
  }
  const conversation = await db.query<{ title: string | null }>(
    `SELECT title FROM sessions WHERE space_id = $1 AND id = $2 LIMIT 1`,
    [spaceId, sessionId],
  );
  return { conversation_title: conversation.rows[0]?.title?.trim() || "Untitled conversation" };
}

/**
 * The summary turn a person asked for: the handoff prompt variant that says
 * the session continues, bounded like a handoff, into the session the Agent
 * is in now. There must be one — a thread that has not run yet, or was just
 * reset, has nothing to summarize.
 */
async function prepareSummaryTurn(
  db: PoolClient,
  input: { identity: AgentGroupIdentity; agentId: string; backend: PreparedRoomConversationBackend | undefined },
): Promise<{ agent_id: string; prompt: string; handoff: { thread_id: string; context_tokens: number; budget_tokens: number; manual_summary: true } }> {
  const thread = input.backend?.host_thread;
  if (!thread || !input.backend) throw new HttpError(409, "This Agent has no host-bound session in this Conversation to summarize");
  if (!thread.vendor_session_id || !input.backend.host_resume_attempted) {
    throw new HttpError(409, "This Agent's session has nothing to summarize yet");
  }
  // The window the runtime reported, else the catalog's for the pinned model;
  // an unknown model gets a 200k-window budget rather than the floor.
  const window = thread.context_window_tokens
    ?? resolveModelWindow(input.backend.model_name ?? null).contextWindowTokens
    ?? 200_000;
  const budgetTokens = handoffBudgetTokens(window);
  const prompt = await renderHandoffPrompt(db, {
    spaceId: input.identity.spaceId,
    userId: input.identity.userId,
    agentId: input.agentId,
    budgetTokens,
  });
  if (!prompt) throw new HttpError(409, "The conversation summary prompt is unavailable");
  return {
    agent_id: input.agentId,
    prompt,
    handoff: { thread_id: thread.id, context_tokens: thread.context_tokens ?? 0, budget_tokens: budgetTokens, manual_summary: true },
  };
}

async function listRoomMessagesSinceAgentTurn(
  db: PoolClient,
  spaceId: string,
  sessionId: string,
  currentMessageId: string,
  agentId: string,
): Promise<RoomPromptMessage[]> {
  const result = await db.query<RoomPromptMessage>(
    // Bounded and ordered by `path_depth`: the window is a stretch of the
    // conversation's visible path, so a branch abandoned elsewhere in the
    // session must not appear in it, and two branches must not interleave by
    // the clock.
    `WITH current_message AS (
       SELECT path_depth, id
         FROM messages
        WHERE space_id = $1 AND session_id = $2 AND id = $3
     ), last_agent_message AS (
       SELECT message.path_depth, message.id
         FROM messages message
         JOIN current_message current ON true
        WHERE message.space_id = $1 AND message.session_id = $2
          AND message.sender_agent_id = $4 AND message.role = 'assistant'
          AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
          AND (message.path_depth, message.id) < (current.path_depth, current.id)
        ORDER BY message.path_depth DESC, message.id DESC
        LIMIT 1
     )
     SELECT message.id, message.user_id, message.sender_agent_id,
            message.role, message.content, message.created_at,
            producer.instructed_by_user_id
       FROM messages message
       JOIN current_message current ON true
       LEFT JOIN last_agent_message last_agent ON true
       LEFT JOIN runs producer
         ON producer.space_id = message.space_id
        AND producer.id = message.run_id
      WHERE message.space_id = $1 AND message.session_id = $2
        AND ${visibleMessagePathSql({ alias: "message", spaceParam: "$1", sessionParam: "$2" })}
        AND (message.path_depth, message.id) < (current.path_depth, current.id)
        AND (last_agent.id IS NULL OR (message.path_depth, message.id) > (last_agent.path_depth, last_agent.id))
      ORDER BY message.path_depth ASC, message.id ASC`,
    [spaceId, sessionId, currentMessageId, agentId],
  );
  return result.rows;
}

function renderRoomPromptMessages(messages: readonly RoomPromptMessage[]): string {
  if (messages.length === 0) return "";
  const lines = [
    "[Room conversation increment - messages are chronological]",
  ];
  for (const message of messages) {
    const sender = message.sender_agent_id
      ? `agent:${message.sender_agent_id}`
      : message.user_id
        ? `user:${message.user_id}`
        : message.role;
    lines.push("", `[${sender}]`, message.content);
  }
  return lines.join("\n");
}

function roomAssignedTaskSection(
  assignedTask: string,
  currentMessage: string | null,
  coordinationTargets: readonly RoomCoordinationTarget[] = [],
): string {
  // The message itself is the turn's current input, delivered once; when the
  // task is that whole message there is nothing to add about it.
  const task = currentMessage !== null && assignedTask.trim() === currentMessage.trim()
    ? null
    : ["[Assigned task for this Room turn]", assignedTask].join("\n\n");
  return [task, roomCoordinationSection(coordinationTargets)].filter(Boolean).join("\n\n");
}

/** An Agent the person referred to in a message handed to the manager. */
export interface RoomCoordinationTarget {
  agent_id: string;
  label: string;
}

function uniqueCoordinationTargets(targets: readonly RoomCoordinationTarget[]): RoomCoordinationTarget[] {
  const seen = new Set<string>();
  return targets.flatMap((target) => {
    const agentId = target.agent_id.trim();
    if (!agentId || seen.has(agentId)) return [];
    seen.add(agentId);
    return [{ agent_id: agentId, label: target.label.trim() || agentId }];
  });
}

/**
 * The manager's instruction for a message that mentioned Agents only in
 * passing ("you could send @Codex to check"): the person addressed the
 * manager and named who should do the work, so the manager arranges it with
 * them through its delegation tools rather than answering alone.
 */
function roomCoordinationSection(targets: readonly RoomCoordinationTarget[]): string | null {
  if (targets.length === 0) return null;
  return [
    "[The person asked you to arrange this with]",
    targets.map((target) => `- ${target.label} (agent id: ${target.agent_id})`).join("\n"),
    "The person's message mentions these Room Agents as the ones to do the work, and was sent to you to arrange it. Delegate the relevant work to them with agent.delegate (and wait for their results when you need them) unless that is clearly unnecessary; if you do not delegate, say why in your reply.",
  ].join("\n");
}

function roomCoordinationModelOverride(
  targets: readonly RoomCoordinationTarget[] | undefined,
): Record<string, unknown> {
  if (!targets?.length) return {};
  return {
    room_coordination: {
      schema_version: "room_coordination.v1",
      target_agent_ids: targets.map((target) => target.agent_id),
      target_labels: targets.map((target) => target.label),
    },
  };
}

function roomRunPrompt(
  backend: PreparedRoomConversationBackend | undefined,
  assignedTask: string,
  currentMessage: string,
  projectStateContext?: string | null,
  coordinationTargets: readonly RoomCoordinationTarget[] = [],
): string {
  // A host thread carries the rules inside its standing context, sent only
  // when its vendor session does not already hold them; a turn without one
  // has no session to remember them and is given them every time.
  return [
    backend?.host_thread
      ? (backend.host_prompt_fresh ? projectStateContext : null)
      : projectStateContext,
    backend?.host_thread ? backend.host_prompt_context : null,
    backend?.host_thread ? null : roomExecutionRules(),
    roomAssignedTaskSection(assignedTask, backend ? currentMessage : null, coordinationTargets),
  ].filter(Boolean).join("\n\n");
}

/** Told to a review: the workspace is mounted read-only, so it reports instead of editing. */
const READ_ONLY_REVIEW_NOTICE = "[Read-only review] Your workspace is mounted read-only for this turn: you cannot change, create or delete its files, and other Agents may be reviewing it at the same time. Reply with your findings; a longer report can go in $RAINVER_OUTPUT_DIR.";

/**
 * What a delegated child may do in the workspace. Never more than its parent:
 * a read-only parent's child reads, whatever was asked, and asking it to
 * write is refused rather than quietly narrowed.
 */
function delegatedWorkspaceAccessFor(
  parentRun: Pick<RunRecord, "contract_snapshot_json" | "required_sandbox_level">,
  requested: "read" | "write" | null | undefined,
): "read" | "write" {
  const parentReads = contractWorkspaceAccess(parentRun.contract_snapshot_json) === "read"
    || parentRun.required_sandbox_level === "read_only";
  if (parentReads && requested === "write") {
    throw new HttpError(403, "A read-only Run cannot delegate write access to its workspace", {
      detail: "A read-only Run cannot delegate write access to its workspace",
      code: "delegation_workspace_access_exceeds_parent",
    });
  }
  return parentReads ? "read" : requested ?? "write";
}

function roomRunContract(
  group: AgentRunGroupRecord,
  backend: (ResolvedConversationBackend & { host_thread?: HostThread | null }) | undefined,
) {
  if (!group.room_id) return undefined;
  return {
    source: { kind: "direct" as const, id: group.id },
    project_id: group.project_id,
    git_snapshot: backend?.git_snapshot ?? unavailableGitSnapshot(),
    definition_of_done:
      "Reply to the Room and capture any durable knowledge or memory candidates as proposal packets.",
    required_outputs_json: [{
      name: "conversation_capture",
      path: "conversation_capture.json",
      // Every Room turn runs on a Host thread, whose capture is the
      // Conversation's own record; the file is accepted when produced.
      required: false,
      media_type: "application/vnd.rainver.proposals+json",
      max_bytes: 262_144,
      json_schema: {
        type: "object",
        required: ["status", "proposed_changes"],
        properties: {
          status: {
            type: "string",
            enum: ["succeeded", "rejected"],
          },
          proposed_changes: {
            type: "array",
            items: { type: "object" },
          },
          rejection_reason: {
            type: "string",
          },
        },
        additionalProperties: false,
      },
    }],
    route_hints_json: {
      execution_shape: "conversational",
      room_id: group.room_id,
      session_id: group.session_id,
    },
  };
}

function unavailableGitSnapshot(): RunGitSnapshot {
  return {
    source: "unavailable",
    workspace_location_id: null,
    branch: null,
    commit_sha: null,
    dirty: null,
    execution_ready: false,
    observed_at: new Date().toISOString(),
  };
}

async function readRunGitSnapshot(
  db: Pool | PoolClient,
  spaceId: string,
  workspaceLocationId: string | null,
  managed: boolean,
): Promise<RunGitSnapshot> {
  if (managed) {
    return {
      source: "managed_workspace",
      workspace_location_id: null,
      branch: null,
      commit_sha: null,
      dirty: null,
      execution_ready: true,
      observed_at: new Date().toISOString(),
    };
  }
  if (!workspaceLocationId) return unavailableGitSnapshot();
  const result = await db.query<{
    branch: string | null;
    git_head: string | null;
    dirty: boolean | null;
    execution_ready: boolean;
  }>(
    `SELECT branch, git_head, dirty, execution_ready
       FROM workspace_locations
      WHERE space_id = $1 AND id = $2
      LIMIT 1`,
    [spaceId, workspaceLocationId],
  );
  const location = result.rows[0];
  if (!location) return unavailableGitSnapshot();
  return {
    source: "workspace_location",
    workspace_location_id: workspaceLocationId,
    branch: location.branch,
    commit_sha: location.git_head,
    dirty: location.dirty,
    execution_ready: location.execution_ready,
    observed_at: new Date().toISOString(),
  };
}

function roomTurnModelOverride(input: {
  content: string;
  routingMode: "direct" | "agent_coordination" | null;
  routingSegments: readonly AgentGroupMessageRecipientSegment[];
  currentSegmentIndex: number;
  currentRecipientAgentId: string;
  plannedRecipientRunCount: number;
  recipientSnapshots: ReadonlyMap<string, AgentCapabilitySnapshotRecord>;
  retryOfRunId?: string | null;
  coordinationTargets?: readonly RoomCoordinationTarget[];
}): Record<string, unknown> | null {
  if (input.plannedRecipientRunCount <= 1) return null;
  return {
    room_turn_routing: {
      schema_version: "room_turn_routing.v1",
      routing_mode: input.routingMode ?? "direct",
      current_recipient_agent_id: input.currentRecipientAgentId,
      current_segment_index: input.currentSegmentIndex,
      recipient_segments: input.routingSegments.map((segment) => ({
        recipient_agent_ids: [...segment.recipient_agent_ids],
        recipient_labels: segment.recipient_agent_ids
          .map((agentId) => agentLabel(agentId, input.recipientSnapshots)),
        task: segment.content,
      })),
    },
  };
}

function agentLabel(
  agentId: string,
  snapshots: ReadonlyMap<string, AgentCapabilitySnapshotRecord>,
): string {
  const name = snapshots.get(agentId)?.name?.trim();
  return name && name.length > 0 ? name : agentId;
}

function memberCapabilitySnapshot(
  snapshot: AgentCapabilitySnapshotRecord | undefined,
): Record<string, unknown> {
  if (!snapshot) return {};
  return {
    agent_id: snapshot.id,
    name: snapshot.name,
    ...(snapshot.description ? { description: snapshot.description } : {}),
    ...(snapshot.role_instruction ? { role_instruction: snapshot.role_instruction } : {}),
    capabilities: Array.isArray(snapshot.capabilities_json) ? snapshot.capabilities_json : [],
  };
}

export function authorityWidening(
  parentRun: Pick<RunRecord, "project_folder_id" | "project_id" | "model_provider_id">,
  contextPolicy: Record<string, unknown>,
): {
  context_widens_authority: boolean;
  workspace_scope_widens: boolean;
  project_scope_widens: boolean;
  credential_scope_widens: boolean;
  memory_scope_widens: boolean;
  durable_write_scope_widens: boolean;
} {
  const workspaceScopeWidens = valuesForKey(contextPolicy, "project_folder_id").some((value) =>
    widensNullableId(parentRun.project_folder_id, value),
  );
  const projectScopeWidens = valuesForKey(contextPolicy, "project_id").some((value) =>
    widensNullableId(parentRun.project_id, value),
  );
  const credentialScopeWidens =
    hasAnyKeyWithValue(contextPolicy, [
      "credential_id",
      "credential_profile_id",
      "provider_credential_id",
    ]) ||
    valuesForKey(contextPolicy, "model_provider_id").some((value) =>
      widensNullableId(parentRun.model_provider_id, value),
    );
  const memoryScopeWidens =
    hasBooleanTrue(contextPolicy, ["include_personal_memory", "personal_memory"]) ||
    valuesForKey(contextPolicy, "memory_scope").some((value) =>
      ["all", "private", "personal"].includes(String(value ?? "")),
    );
  const durableWriteScopeWidens =
    hasBooleanTrue(contextPolicy, [
      "memory_write",
      "knowledge_write",
      "direct_memory_write",
      "direct_knowledge_write",
      "write_memory",
      "write_knowledge",
    ]) ||
    hasAnyNonEmptyValue(contextPolicy, [
      "writable_scopes",
      "write_scopes",
      "memory_writable_scopes",
      "knowledge_writable_scopes",
    ]) ||
    hasBooleanFalse(contextPolicy, ["requires_proposal", "proposal_only"]);
  return {
    context_widens_authority:
      workspaceScopeWidens ||
      projectScopeWidens ||
      credentialScopeWidens ||
      memoryScopeWidens ||
      durableWriteScopeWidens,
    workspace_scope_widens: workspaceScopeWidens,
    project_scope_widens: projectScopeWidens,
    credential_scope_widens: credentialScopeWidens,
    memory_scope_widens: memoryScopeWidens,
    durable_write_scope_widens: durableWriteScopeWidens,
  };
}

function widensNullableId(parentValue: string | null | undefined, requested: unknown): boolean {
  if (typeof requested !== "string" || !requested.trim()) return false;
  return requested !== parentValue;
}

function delegationBudgetLimits(budget: Record<string, unknown> | null, room = false): {
  max_depth: number;
  max_fanout: number;
  max_concurrency: number;
} {
  return {
    max_depth: Math.min(room ? 1 : MAX_DELEGATION_DEPTH, boundedBudgetLimit(budget, "max_depth", MAX_DELEGATION_DEPTH)),
    max_fanout: room ? roomBudgetLimits(budget).hard : boundedBudgetLimit(budget, "max_fanout", MAX_PARENT_FANOUT),
    // Room children queue behind the same directory lease. Pending children
    // are not concurrent executions and must not meet the non-Room four-slot cap.
    max_concurrency: boundedBudgetLimit(budget, "max_concurrency", room ? Number.MAX_SAFE_INTEGER : MAX_GROUP_CONCURRENCY),
  };
}

function boundedBudgetLimit(
  budget: Record<string, unknown> | null,
  key: string,
  defaultLimit: number,
): number {
  const value = budget?.[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return defaultLimit;
  return Math.min(value, defaultLimit);
}

function valuesForKey(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => valuesForKey(item, key));
  const record = value as Record<string, unknown>;
  return [
    ...(Object.prototype.hasOwnProperty.call(record, key) ? [record[key]] : []),
    ...Object.values(record).flatMap((item) => valuesForKey(item, key)),
  ];
}

function hasAnyKeyWithValue(value: unknown, keys: readonly string[]): boolean {
  return keys.some((key) =>
    valuesForKey(value, key).some((candidate) => typeof candidate === "string" && candidate !== ""),
  );
}

function hasAnyNonEmptyValue(value: unknown, keys: readonly string[]): boolean {
  return keys.some((key) =>
    valuesForKey(value, key).some((candidate) => {
      if (typeof candidate === "string") return candidate.trim() !== "";
      if (Array.isArray(candidate)) return candidate.length > 0;
      if (candidate && typeof candidate === "object") return Object.keys(candidate).length > 0;
      return candidate !== null && candidate !== undefined && candidate !== false;
    }),
  );
}

function hasBooleanTrue(value: unknown, keys: readonly string[]): boolean {
  return keys.some((key) => valuesForKey(value, key).some((candidate) => candidate === true));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasBooleanFalse(value: unknown, keys: readonly string[]): boolean {
  return keys.some((key) => valuesForKey(value, key).some((candidate) => candidate === false));
}

function assertIdentitySpace(identity: AgentGroupIdentity, requestSpaceId: string): void {
  if (identity.spaceId !== requestSpaceId) {
    throw new HttpError(403, "space_id must match the authenticated space");
  }
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function requiredTrimmed(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new HttpError(422, `${field} is required`);
  return normalized;
}

function optionalTrimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function optionalTrimmedOrNull(value: string | null | undefined): string | null {
  const normalized = optionalTrimmed(value);
  return normalized || null;
}
