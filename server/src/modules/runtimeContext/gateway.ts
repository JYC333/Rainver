import { usesIsolatedAgentContext } from "../agents/projectContextIsolation.js";
import { randomUUID } from "node:crypto";
import { retryTaskInstruction } from "../runs/retryPolicy.js";
import * as protocol from "@rainver/protocol";
import type { ContextEvent, ContextItem, ExecutionControlSnapshot, InvocationDelivery, InvocationSnapshotSafe, RetrievalObjectType, RuntimeContextEnvelope, RuntimeContextEventIngress } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Pool, Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import { contentReadSql, roomConversationAudienceSql } from "../access/contentAccessSql.js";
import { isExplicitReferenceType, roomScopedAgentReadSql } from "./workContextService.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { projectFolderReadAccessSql } from "../projectFolders/access.js";
import { retrievalEgressAllowed, type RetrievalEgressDestination } from "../retrieval/egress/egressPolicy.js";
import { excerptAroundQuery } from "../retrieval/normalize.js";
import { RetrievalRegistry } from "../retrieval/registry.js";
import {
  loadSourcePolicySnapshots,
  sourceEgressPoliciesForSnapshots,
  sourcePolicyAllowsRead,
} from "../retrieval/sourcePolicy.js";
import { readSpaceRetrievalSettings } from "../retrieval/settings.js";
import { inquiryRetrievalAdapter } from "../inquiry/retrievalAdapter.js";
import { knowledgeRetrievalAdapter } from "../knowledge/retrievalAdapter.js";
import { memoryRetrievalAdapter } from "../memory/retrievalAdapter.js";
import { projectRetrievalAdapter } from "../projects/retrievalAdapter.js";
import { sourceRetrievalAdapter } from "../sources/retrievalAdapter.js";
import type {
  RuntimeContextDeliveryAcknowledgement,
  RuntimeContextFinalizeInput,
  RuntimeContextInvocationGatewayPort,
  RuntimeContextInvocationInput,
  RuntimeContextPreviewInput,
} from "./contracts.js";
import {
  InvocationSnapshotService,
  stableJson,
  type InvocationAttemptInput,
  type InvocationDeliveryAuthorizer,
} from "./invocationSnapshotService.js";
import type { RuntimeContextPlanningService } from "./planningService.js";
import { estimateModelTokens } from "../usage/modelCatalog.js";
import { loadConversationContinuityThroughMessage } from "./conversationContinuity.js";
import { contextItemText } from "./itemNormalizer.js";
import { instructionInRunRequest } from "./runRequest.js";
import {
  briefingReferencesInRecipientInstruction,
  createProductionRuntimeContextPlanningService,
  groupedAgentIdentityContext,
  isRoomConversation,
  loadAuthorizedCurrentContextMessage,
  renderCheckpointContinuity,
  roomRoutingInstruction,
} from "./productionAcquisition.js";
import { RuntimeContextContinuityService } from "./continuity/service.js";
import { trimContextText } from "./windowPlanner.js";
import { PgRuntimeContextAcquisitionRepository } from "./acquisitionRepository.js";
import { PgRuntimeSkillProvider } from "../skills/runtimeSkillProvider.js";
import { isVendorCliAdapter } from "../runtimeAdapters/specs.js";
import { assertBriefingReferencesDeliverable, lockBriefingReferenceClosure, lockBriefingVersionClosure, pendingBriefingReferences } from "../informationDigest/briefing/referenceDelivery.js";
import { classifyRunDestination, loadRunProvider } from "./runDestination.js";
import { assertProjectHeld, holdProjects, lockProjectAudience } from "../projects/access.js";
import type { ReleaseGroup } from "../retrieval/releaseClosure.js";
import { assertRoomsHeld, discoverEnvelopeProjects, readingRunAuthority, type EnvelopeRun } from "./envelopeAuthority.js";
import { loadConversationMessageContext } from "../sessions/conversationInputService.js";

const deliverySourceRegistry = new RetrievalRegistry();
for (const adapter of [
  knowledgeRetrievalAdapter,
  memoryRetrievalAdapter,
  projectRetrievalAdapter,
  sourceRetrievalAdapter,
  inquiryRetrievalAdapter,
]) deliverySourceRegistry.register(adapter);

export interface InvocationSnapshotStorePort {
  createAttempt(input: Parameters<InvocationSnapshotService["createAttempt"]>[0]): ReturnType<InvocationSnapshotService["createAttempt"]>;
  acknowledge(input: Parameters<InvocationSnapshotService["acknowledge"]>[0]): ReturnType<InvocationSnapshotService["acknowledge"]>;
  finalize(input: Parameters<InvocationSnapshotService["finalize"]>[0]): ReturnType<InvocationSnapshotService["finalize"]>;
}

export interface ExecutionControlLoaderPort {
  load(spaceId: string, snapshotId: string): Promise<ExecutionControlSnapshot>;
}

export interface RuntimeContextContinuityPort {
  ingest(event: RuntimeContextEventIngress): Promise<ContextEvent>;
  recordCaptureGap?(input: { invocationId: string; code: string; detail?: string | null; event?: RuntimeContextEventIngress }): Promise<void>;
}

export class RuntimeContextInvocationGateway implements RuntimeContextInvocationGatewayPort {
  constructor(
    private readonly planning: RuntimeContextPlanningService,
    private readonly snapshots: InvocationSnapshotStorePort,
    private readonly controls: ExecutionControlLoaderPort,
    private readonly continuity?: RuntimeContextContinuityPort,
  ) {}

  preview(input: RuntimeContextPreviewInput) {
    return this.planning.preview(input);
  }

  async prepareInvocation(input: RuntimeContextInvocationInput): Promise<InvocationDelivery> {
    if (this.continuity && (input.turn.current_message_ref.type === "message"
      || input.turn.current_message_ref.type === "run_request")) {
      await this.ingestRuntimeEvent({
        invocation_id: input.invocationId,
        event_type: input.turn.current_message_ref.type === "message"
          ? "user_message_received"
          : "run_request_received",
        canonical_ref: input.turn.current_message_ref,
        semantic_role: "user_input",
        token_estimate: 0,
      });
    }
    const deliveryId = randomUUID();
    const snapshotId = randomUUID();
    const plan = await this.planning.planExecution({
      identity: input.identity,
      turn: input.turn,
      invocationId: input.invocationId,
      deliveryId,
    });
    if (plan.envelope.execution_control_snapshot_id !== input.executionControlSnapshotId) {
      throw new HttpError(409, "Live Runtime Context authority changed before delivery");
    }
    const control = await this.controls.load(input.identity.spaceId, input.executionControlSnapshotId);
    const attempt = await this.snapshots.createAttempt({
      spaceId: input.identity.spaceId,
      invocationId: input.invocationId,
      envelope: plan.envelope,
      control,
      runtimeKey: input.runtimeKey,
      providerId: input.providerId ?? null,
      // Planning owns the authoritative model binding. Callers may repeat it,
      // but worker inputs are not required to rediscover AgentVersion config.
      model: input.model ?? plan.envelope.window_plan.model,
      usageSourceId: input.usageSourceId,
      runtimeSessionBindingRef: input.runtimeSessionBindingRef,
      rawReplayPayload: input.rawReplayPayload,
      viewerUserId: input.identity.userId,
      requireLiveAuthorization: true,
      deliveryId,
      snapshotId,
    });
    return attempt.delivery;
  }

  async acknowledgeDelivery(input: RuntimeContextDeliveryAcknowledgement): Promise<InvocationSnapshotSafe> {
    const snapshot = await this.snapshots.acknowledge({
      spaceId: input.spaceId,
      deliveryId: input.deliveryId,
      status: input.status,
      actualTokens: input.actualPromptTokens,
      adapterReceiptRef: input.adapterReceiptRef,
      errorCode: input.errorCode,
    });
    if (input.actualPromptTokens !== undefined && input.actualPromptTokens !== null) {
      await this.planning.reconcileActualUsage({
        spaceId: input.spaceId,
        invocationId: snapshot.invocation_id,
        deliveryId: snapshot.delivery_id,
        actualPromptTokens: input.actualPromptTokens,
      });
    }
    return snapshot;
  }

  finalizeInvocation(input: RuntimeContextFinalizeInput): Promise<InvocationSnapshotSafe> {
    return this.snapshots.finalize(input);
  }

  async ingestRuntimeEvent(event: RuntimeContextEventIngress): Promise<ContextEvent> {
    if (!this.continuity) throw new Error("Runtime Context Event capture is unavailable");
    try {
      return await this.continuity.ingest(event);
    } catch (error) {
      if (!/^(policy_checked|tool_call_|approval_)/.test(event.event_type)) {
        try {
          await this.continuity.recordCaptureGap?.({
            invocationId: event.invocation_id,
            code: "runtime_event_capture_failed",
            detail: error instanceof Error ? error.message : String(error),
            event,
          });
        } catch {
          // The caller still receives the original capture error. A database
          // outage can prevent both the event and its gap marker and is found
          // by terminal/cursor reconciliation.
        }
      }
      throw error;
    }
  }

  async recordRuntimeEventGap(event: RuntimeContextEventIngress, detail?: string | null): Promise<void> {
    if (!this.continuity?.recordCaptureGap) throw new Error("Runtime Context gap capture is unavailable");
    await this.continuity.recordCaptureGap({
      invocationId: event.invocation_id,
      code: "runtime_event_canonical_write_failed",
      detail,
      event,
    });
  }
}

export class PgExecutionControlLoader implements ExecutionControlLoaderPort {
  constructor(private readonly db: Queryable) {}

  async load(spaceId: string, snapshotId: string): Promise<ExecutionControlSnapshot> {
    const result = await this.db.query<{ snapshot_json: unknown }>(
      `SELECT snapshot_json FROM execution_control_snapshots WHERE space_id=$1 AND id=$2`,
      [spaceId, snapshotId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Execution Control Snapshot not found");
    return protocol.ExecutionControlSnapshotSchema.parse(result.rows[0].snapshot_json);
  }
}

export class PgInvocationDeliveryAuthorizer implements InvocationDeliveryAuthorizer {
  constructor(_config?: ServerConfig) {}

  async authorize(db: Queryable, input: InvocationAttemptInput, control: ExecutionControlSnapshot): Promise<void> {
    await this.authorizeEnvelope(db, input, control, "delivery");
  }

  /**
   * Whether a stored Runtime Context preview may still be shown to this
   * person: the same live gate as Delivery, applied to every item the
   * envelope carries (blocked ones included, since a preview shows them),
   * with no consumption side effect. Items no preview acquisition produces,
   * or whose source type has no owner re-check here, fail closed. Run in the
   * reader's transaction so its FOR SHARE locks order it against each
   * source's writers until the release decision commits.
   */
  async authorizePreviewRelease<T>(
    db: Queryable,
    identity: { spaceId: string; userId: string },
    envelope: RuntimeContextEnvelope,
    release: { retrievalGroups: readonly ReleaseGroup[]; workContextProject: string | null; afterGate: () => Promise<T> },
  ): Promise<T> {
    const row = (await db.query<{ run_id: string; snapshot_json: unknown; runtime_key: string | null; model_provider_id: string | null }>(
      `SELECT control_row.run_id,control_row.snapshot_json,run.runtime_key,run.model_provider_id
         FROM execution_control_snapshots control_row
         JOIN runs run ON run.id=control_row.run_id AND run.space_id=control_row.space_id
        WHERE control_row.id=$1 AND control_row.space_id=$2`,
      [envelope.execution_control_snapshot_id, identity.spaceId],
    )).rows[0];
    if (!row) throw new HttpError(404, "Runtime Context preview authority is no longer readable");
    const control = protocol.ExecutionControlSnapshotSchema.parse(row.snapshot_json);
    if (control.work_context_scope_id !== envelope.turn_request.work_context_scope_id
      || control.work_context_setup_ref?.id !== envelope.setup_ref?.id
      || (control.work_context_setup_ref?.version ?? null) !== (envelope.setup_ref?.version ?? null)) {
      throw new HttpError(409, "Runtime Context preview no longer matches its execution authority");
    }
    return this.authorizeEnvelope(db, {
      spaceId: identity.spaceId,
      invocationId: row.run_id,
      envelope,
      control,
      // Compared with the persisted Run below; a preview has no adapter of its own.
      runtimeKey: row.runtime_key as string,
      providerId: row.model_provider_id,
      model: null,
      usageSourceId: `runtime_context_preview:${row.run_id}`,
      viewerUserId: identity.userId,
    }, control, "preview", release);
  }

  /**
   * One outer lock order, all `FOR SHARE` (the canonical release-closure
   * order, `lockDemotionReleaseClosure`): the Work Context lock → every
   * Project the envelope's checks lock, each with its audience, in id order
   * (`discoverEnvelopeProjects`) → this person's Space membership → Space →
   * the Run's Folder → Rooms and this person's Room member rows
   * (`lockEnvelopeRooms`) → the Run → the Setup, Agent, Folder, Project,
   * egress and each item's owner check. Project archive takes the Project
   * `FOR UPDATE` before its workflow Runs, and "Continue anyway" and the other
   * Room writers take the Room before its Runs, so neither may be locked after
   * the Run. Projects and Rooms are discovered without locks; while this gate
   * runs, a Project lock outside the held set (`assertProjectHeld`) or a Room
   * outside it is refused with 409 before it is taken. No deadlock is caught
   * or retried.
   */
  private async authorizeEnvelope<T = void>(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    mode: "delivery" | "preview",
    release?: { retrievalGroups: readonly ReleaseGroup[]; workContextProject: string | null; afterGate: () => Promise<T> },
  ): Promise<T> {
    if (!input.viewerUserId) throw new HttpError(403, "Invocation Delivery requires a live viewer authority");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `work-context:${input.spaceId}:${control.work_context_scope_id ?? input.invocationId}`,
    ]);
    const unlockedRun = (await db.query<EnvelopeRun>(
      `SELECT ${ENVELOPE_RUN_COLUMNS} FROM runs run WHERE run.id=$1 AND run.space_id=$2`,
      [input.invocationId, input.spaceId],
    )).rows[0];
    if (!unlockedRun) throw new HttpError(404, "Runtime Context Run authority is no longer readable");
    const items = gatedItems(input.envelope, mode);
    const roomIds = await this.discoverEnvelopeRooms(db, input, control, items);
    const projectIds = await discoverEnvelopeProjects(db, input, control, items, unlockedRun, roomIds, release ?? {});
    const releaseHeld = holdProjects(db, projectIds);
    try {
      for (const projectId of projectIds) await lockProjectAudience(db, input.spaceId, projectId);
      const spaceMember = await db.query<{ role: string }>(
        `SELECT role FROM space_memberships
          WHERE space_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,
        [input.spaceId, input.viewerUserId],
      );
      if (!spaceMember.rows[0]) throw new HttpError(404, "Runtime Context Space authority is no longer readable");
      await db.query(`SELECT id FROM spaces WHERE id=$1 FOR SHARE`, [input.spaceId]);
      if (control.project_folder_id) {
        await db.query(`SELECT id FROM project_folders WHERE space_id=$1 AND id=$2 FOR SHARE`, [input.spaceId, control.project_folder_id]);
      }
      const heldRoomIds = await this.lockEnvelopeRooms(db, input, roomIds);
      const runResult = await db.query<{
        runtime_key: string | null;
        model_provider_id: string | null;
        owner_user_id: string | null;
        instructed_by_user_id: string | null;
        prompt: string | null;
        instruction: string | null;
        delegation_id: string | null;
        error_json: unknown;
        run_group_id: string | null;
        session_id: string | null;
        model_override_json: unknown;
        runtime_profile_id: string | null;
        runtime_profile_snapshot_json: unknown;
        contract_snapshot_json: unknown;
        root_run_id: string | null;
        agent_id: string | null;
        project_id: string | null;
        project_folder_id: string | null;
        capability_id: string | null;
        capabilities_json: unknown;
      }>(
        `SELECT run.runtime_key,run.model_provider_id,run.owner_user_id,run.instructed_by_user_id,
                run.prompt,run.instruction,run.delegation_id,run.error_json,run.run_group_id,
                run.session_id,run.model_override_json,run.runtime_profile_id,run.runtime_profile_snapshot_json,run.contract_snapshot_json,run.root_run_id,run.agent_id,run.project_id,
                run.project_folder_id,run.capability_id,run.capabilities_json
           FROM execution_control_snapshots control_row
           JOIN runs run ON run.id=control_row.run_id AND run.space_id=control_row.space_id
          WHERE control_row.id=$1 AND control_row.space_id=$2 AND run.id=$3
          FOR SHARE OF run`,
        [control.id, input.spaceId, input.invocationId],
      );
      const run = runResult.rows[0];
      if (!run || (run.owner_user_id !== input.viewerUserId && run.instructed_by_user_id !== input.viewerUserId)) {
        throw new HttpError(404, "Runtime Context Run authority is no longer readable");
      }
      // Re-derived under the Run lock: the Run's own Room and a `room_recipient`
      // scope's Room must be ones taken above.
      assertRoomsHeld([await envelopeRunRoom(db, input.spaceId, input.invocationId), ...await recipientRooms(db, input.spaceId, control)], heldRoomIds);
      if (run.project_id) assertProjectHeld(db, run.project_id);
      if (run.runtime_key !== input.runtimeKey) {
        throw new HttpError(409, "Invocation Delivery adapter does not match the persisted Run");
      }
      if ((run.model_provider_id ?? null) !== input.providerId) {
        throw new HttpError(409, "Invocation Delivery provider does not match the persisted Run");
      }
      const agentName = await this.authorizeSetupAndAgent(db, input, control, run);
      const revalidatedRun = { ...run, agent_name: agentName, held_room_ids: heldRoomIds };
      await this.authorizeProject(db, input, control);
      const egress = await this.authorizeEgress(db, input, control, run);
      await this.authorizeAcceptedSources(db, input, control, spaceMember.rows[0].role, egress, revalidatedRun, mode);
      return release ? await release.afterGate() : undefined as T;
    } finally {
      releaseHeld();
    }
  }

  /**
   * Every Room this envelope's gates read, discovered without locks: the
   * Run's own conversation Room (its session or Agent group; the message and
   * continuity gates read it), the Room of a `room_recipient` Work Context
   * scope (the Room-scoped Agent read), and the Rooms of each Evidence Matrix
   * release closure (`artifactReleaseRooms`: the producing and
   * research-requesting Runs' Rooms).
   */
  private async discoverEnvelopeRooms(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    items: readonly ContextItem[],
  ): Promise<string[]> {
    const rooms = new Set<string>();
    const own = await envelopeRunRoom(db, input.spaceId, input.invocationId);
    if (own) rooms.add(own);
    for (const room of await recipientRooms(db, input.spaceId, control)) rooms.add(room);
    const { artifactReleaseRooms } = await import("../contentAccess/demotionReleaseClosure.js");
    for (const item of items) {
      if (item.acquisition !== "direct" || item.source_ref.type !== "project_research_evidence_matrix") continue;
      for (const room of await artifactReleaseRooms(db, input.spaceId, [item.source_ref.id])) rooms.add(room);
    }
    return [...rooms].sort();
  }

  /**
   * The discovered Rooms, share-locked with this person's member rows in id
   * order after Projects, Space and Folder and before the Run. A Room writer
   * that takes the Room exclusively takes it before that Room's Runs —
   * "Continue anyway" (`room.quota.continue`: Room → conversation queue →
   * every held Run of the conversation `FOR UPDATE`, recovery holds
   * included), the roster writer, the context reset — so a Room share taken
   * after this Run's share would wait on a writer that waits on this Run: a
   * deadlock, not a conflict. Each Room gate refuses, with 409, a Room this
   * set does not hold.
   *
   * The `room_recipient` Agent read (`roomScopedAgentReadSql`) also reads the
   * scope's recipient row, its Room Agent member row and the Room Agent
   * grants, which are not row-locked here: every writer of a member's status
   * or of a grant (`RoomRosterService` add/remove Agent and User,
   * invitation activation and decision) takes this Room `FOR UPDATE` first,
   * so this Room share excludes them until commit; a scope row
   * (`room_conversation_recipients`) is insert-only and a member's Room never
   * changes. The read's Project check is held by the Room's Project audience,
   * taken above with every other Project.
   */
  private async lockEnvelopeRooms(db: Queryable, input: InvocationAttemptInput, ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    await db.query(`SELECT id FROM rooms WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE`, [input.spaceId, [...ids]]);
    await db.query(
      `SELECT id FROM room_user_members WHERE space_id=$1 AND room_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE`,
      [input.spaceId, [...ids], input.viewerUserId],
    );
    return [...ids];
  }

  private async authorizeSetupAndAgent(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    run: { project_id: string | null; project_folder_id: string | null },
  ): Promise<string | null> {
    const viewerUserId = input.viewerUserId;
    if (!viewerUserId) throw new HttpError(403, "Invocation Delivery requires a live viewer authority");
    const setup = await db.query<{ id: string; version: number; scope_kind: string; agent_id: string | null; project_id: string | null; project_folder_id: string | null }>(
      `SELECT id,version,scope_kind,agent_id,project_id,project_folder_id FROM work_context_setups
        WHERE space_id=$1 AND work_context_scope_id=$2 AND user_id=$3
        ORDER BY version DESC LIMIT 1 FOR SHARE`,
      [input.spaceId, control.work_context_scope_id, viewerUserId],
    );
    const row = setup.rows[0];
    // Match resolveEffectiveBindingsForRun: an unset Setup binding inherits
    // the persisted Run binding. The caller holds that Run FOR SHARE, and the
    // effective Project/Folder still undergo live access checks below.
    if (!row || control.work_context_setup_ref?.id !== row.id
      || control.work_context_setup_ref.version !== String(row.version)
      || row.agent_id !== control.agent_id
      || (row.project_id ?? run.project_id) !== control.project_id
      || (row.project_folder_id ?? run.project_folder_id) !== control.project_folder_id) {
      throw new HttpError(409, "Invocation Delivery setup authority is no longer current");
    }
    const agentId = control.agent_id;
    if (!agentId) throw new HttpError(409, "Invocation Delivery Agent authority is missing");
    const agent = await db.query<{ name: string | null }>(
      `SELECT agent.name FROM agents agent
        WHERE agent.id=$1 AND agent.space_id=$2 AND agent.status='active'
          AND (
            ($5::varchar <> 'room_recipient' AND ${contentReadSql("agent", "agent", "$3")})
            OR (
              $5::varchar = 'room_recipient'
              AND ${roomScopedAgentReadSql("agent", "$3", "$4")}
            )
          )
        FOR SHARE OF agent`,
      [agentId, input.spaceId, viewerUserId, control.work_context_scope_id, row.scope_kind],
    );
    if (!agent.rows[0]) throw new HttpError(404, "Invocation Delivery Agent authority is no longer readable");
    // A Room grant authorizes execution, never the retained Agent content.
    // Room and audience locks are already held by the outer delivery fence.
    if (row.scope_kind !== "room_recipient") {
      await this.lockContentAclDependencies(db, input.spaceId, "agent", agentId, viewerUserId);
    }
    const reauthorizedAgent = await db.query<{ name: string | null }>(
      `SELECT agent.name FROM agents agent
        JOIN work_context_setups setup
          ON setup.agent_id=agent.id AND setup.space_id=agent.space_id
         AND setup.work_context_scope_id=$4 AND setup.user_id=$3
         AND setup.version=$5
        WHERE agent.id=$1 AND agent.space_id=$2 AND agent.status='active'
          AND (
            (setup.scope_kind::varchar <> 'room_recipient' AND ${contentReadSql("agent", "agent", "$3")})
            OR (
              setup.scope_kind = 'room_recipient'
              AND ${roomScopedAgentReadSql("agent", "$3", "$4")}
            )
          )
        FOR SHARE OF agent`,
      [agentId, input.spaceId, viewerUserId, control.work_context_scope_id, row.version],
    );
    if (!reauthorizedAgent.rows[0]) {
      throw new HttpError(404, "Invocation Delivery Agent authority is no longer readable");
    }
    if (control.project_folder_id) {
      const folder = await db.query(
        `SELECT 1 FROM project_folders folder
          WHERE folder.id=$1 AND folder.space_id=$2
            AND folder.project_id IS NOT DISTINCT FROM $3 AND folder.status='active'
            AND ${projectFolderReadAccessSql({ spaceExpr: "folder.space_id", projectFolderExpr: "folder.id", userExpr: "$4" })}
          FOR SHARE OF folder`,
        [control.project_folder_id, input.spaceId, control.project_id, viewerUserId],
      );
      if (!folder.rows[0]) throw new HttpError(404, "Invocation Delivery Project Folder authority is no longer readable");
    }
    return reauthorizedAgent.rows[0].name;
  }

  private async authorizeProject(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
  ): Promise<void> {
    if (!control.project_id) return;
    assertProjectHeld(db, control.project_id);
    const project = await db.query<{ owner_user_id: string | null; space_type: string; active_instruction_version_id: string | null }>(
      `SELECT project.owner_user_id,space.type AS space_type,project.active_instruction_version_id
         FROM projects project JOIN spaces space ON space.id=project.space_id
        WHERE project.id=$1 AND project.space_id=$2 AND project.deleted_at IS NULL
        FOR SHARE OF project,space`,
      [control.project_id, input.spaceId],
    );
    const row = project.rows[0];
    if (!row) throw new HttpError(404, "Invocation Delivery Project authority is no longer readable");
    if (control.project_instruction_ref
      && row.active_instruction_version_id !== control.project_instruction_ref.id) {
      throw new HttpError(409, "Invocation Delivery Project Instruction authority is no longer current");
    }
    if (row.space_type === "personal" || row.owner_user_id === input.viewerUserId) return;
    const membership = await db.query(
      `SELECT 1 FROM project_members
        WHERE space_id=$1 AND project_id=$2 AND user_id=$3 AND status='active'
        FOR SHARE`,
      [input.spaceId, control.project_id, input.viewerUserId],
    );
    if (!membership.rows[0]) throw new HttpError(404, "Invocation Delivery Project authority is no longer readable");
  }

  private async authorizeEgress(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    run: { runtime_key: string | null; model_provider_id: string | null; model_override_json: unknown; runtime_profile_snapshot_json: unknown },
  ): Promise<{ destination: RetrievalEgressDestination; externalEgressEnabled: boolean }> {
    let external = isVendorCliAdapter(run.runtime_key);
    let destination: RetrievalEgressDestination = external ? "external_provider" : "internal_process";
    if (external && !run.model_provider_id
      && (control.egress.destination_type !== "local_cli"
        || control.egress.destination_id !== run.runtime_key)) {
      throw new HttpError(409, "Invocation Delivery CLI egress authority no longer matches the adapter");
    }
    if (run.model_provider_id) {
      const provider = await loadRunProvider(db, input.spaceId, run.model_provider_id, { lock: true });
      if (!provider || control.egress.destination_id !== run.model_provider_id
        || !control.egress.allowed_provider_ids.includes(run.model_provider_id)) {
        throw new HttpError(409, "Invocation Delivery provider grant is no longer active");
      }
      destination = classifyRunDestination(run, provider, input.spaceId);
      external = destination === "external_provider";
    }
    if (!external) return { destination, externalEgressEnabled: true };
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`runtime-egress-settings:${input.spaceId}`]);
    const settings = await readSpaceRetrievalSettings(db, input.spaceId);
    if (!settings.externalEgressEnabled || !control.egress.external_egress_allowed) {
      throw new HttpError(409, "External Invocation Delivery egress is no longer authorized");
    }
    return { destination, externalEgressEnabled: settings.externalEgressEnabled };
  }

  private async authorizeAcceptedSources(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    viewerSpaceRole: string,
    egress: { destination: RetrievalEgressDestination; externalEgressEnabled: boolean },
    run: {
      prompt: string | null;
      instruction: string | null;
      delegation_id?: string | null;
      error_json: unknown;
      run_group_id: string | null;
      agent_name: string | null;
      session_id: string | null;
      model_override_json: unknown;
      runtime_key?: string | null;
      agent_id?: string | null;
      runtime_profile_id?: string | null;
      project_id?: string | null;
      capability_id?: string | null;
      capabilities_json?: unknown;
      contract_snapshot_json?: unknown;
      root_run_id?: string | null;
      held_room_ids: readonly string[];
    },
    mode: "delivery" | "preview" = "delivery",
  ): Promise<void> {
    const accepted = gatedItems(input.envelope, mode);
    await this.authorizeBriefingReferences(db, input, accepted, run, egress.destination);
    await this.authorizeBriefingGeneration(db, input, run, egress.destination);
    await this.authorizeReadingMethod(db,input,run);
    for (const item of accepted) {
      if (item.acquisition === "direct" && item.source_ref.type === "message") {
        await this.authorizeMessageSource(db, input, item, run);
      } else if (item.acquisition === "direct" && item.source_ref.type === "run_request") {
        if (item.source_ref.id !== input.invocationId || contextItemText(item) !== runRequestText(run)
          || (item.revalidation.run_instruction_in_request === true && !instructionInRunRequest(run))) {
          throw new HttpError(409, "Invocation Delivery Run request changed after planning");
        }
      } else if (item.acquisition === "direct" && item.source_ref.type === "run_instruction") {
        if (item.source_ref.id !== input.invocationId || contextItemText(item) !== (run.instruction ?? "").trim()) {
          throw new HttpError(409, "Invocation Delivery Run instruction changed after planning");
        }
      } else if (item.acquisition === "direct" && item.source_ref.type === "supervisor_retry") {
        if (item.source_ref.id !== input.invocationId || contextItemText(item) !== supervisorRetryContext(run.error_json)) {
          throw new HttpError(409, "Invocation Delivery supervisor retry changed after planning");
        }
      } else if (item.acquisition === "direct" && item.source_ref.type === "run_group_agent_identity") {
        if (item.source_ref.id !== input.invocationId || contextItemText(item) !== groupedAgentIdentityContext(run)) {
          throw new HttpError(409, "Invocation Delivery room Agent identity changed after planning");
        }
      } else if (item.acquisition === "direct" && item.source_ref.type === "room_recipient_instruction") {
        if (!isRoomConversation(run.model_override_json)
          || item.source_ref.id !== input.invocationId
          || contextItemText(item) !== (run.prompt ?? "").trim()) {
          throw new HttpError(409, "Invocation Delivery Room recipient instruction changed after planning");
        }
      } else if (item.acquisition === "direct" && item.source_ref.type === "room_routing_instruction") {
        if (item.source_ref.id !== input.invocationId
          || contextItemText(item) !== roomRoutingInstruction(run.model_override_json)) {
          throw new HttpError(409, "Invocation Delivery Room routing instruction changed after planning");
        }
      } else if (item.acquisition === "direct" && item.source_ref.type === "room_briefing_reference") {
        // Verified with this turn's pending references, above.
      } else if (item.acquisition === "direct" && item.source_ref.type === "personal_memory_grant") {
        // Only execution acquires a grant summary, and authorizing it consumes the grant.
        if (mode === "preview") throw new HttpError(409, "Runtime Context preview carries an execution-only grant");
        await this.authorizePersonalMemoryGrant(db, input, item);
      } else if (item.acquisition === "direct" && item.source_ref.type === "project_research_evidence_matrix") {
        await this.authorizeProjectResearchMatrix(db, input, control, item, run.held_room_ids);
      } else if (item.acquisition === "direct" && item.source_ref.type === "runtime_skill_binding") {
        // No acquisition produces legacy capability renderings. Old plans
        // must be rebuilt, never delivered without their retired authority.
        throw new HttpError(409, "Legacy Runtime Skill plan must be rebuilt");
      } else if (item.acquisition === "direct" && item.source_ref.type === "skill_package_binding") {
        await this.authorizeRuntimeSkill(db, input, control, item);
      } else if (item.acquisition === "continuity") {
        await this.authorizeContinuitySource(db, input, item, run, egress.destination);
      } else if (item.acquisition === "runtime_event") {
        // CLI history replay no longer exists: the vendor session holds the
        // conversation and the Context Event ledger is audit, not prompt.
        throw new HttpError(409, "Invocation Delivery carries a runtime-event item no acquisition produces");
      } else if (item.acquisition === "retrieval") {
        await this.authorizeRetrievalSource(db, input, control, item, viewerSpaceRole, egress);
      } else if (item.acquisition === "explicit"
        || (item.acquisition === "direct"
          && isExplicitReferenceType(item.source_ref.type))) {
        await this.authorizeExplicitSource(db, input, control, item);
      } else if (item.acquisition === "direct" && item.source_ref.type === "agent_version") {
        await this.authorizeAgentVersionInstruction(db, input, control, item);
      } else {
        // Fail closed: an item no acquisition produces has no owner re-check.
        throw new HttpError(409, mode === "preview"
          ? `Runtime Context preview source type '${item.source_ref.type}' is not reauthorizable`
          : `Invocation Delivery source type '${item.source_ref.type}' is not reauthorizable`);
      }
    }
  }

  /**
   * The Run's own AgentVersion, of the Agent authorized above, with its
   * current instruction. Isolation is judged on the snapshot's Project, the
   * same one acquisition uses to decide whether the instruction is planned.
   */
  private async authorizeAgentVersionInstruction(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    item: ContextItem,
  ): Promise<void> {
    if (await usesIsolatedAgentContext(db, input.spaceId, control.agent_id, control.project_id)) {
      throw new HttpError(409, "Source Project Agent instructions cannot enter an isolated execution");
    }
    const version = (await db.query<{ system_prompt: string | null }>(
      `SELECT version.system_prompt FROM runs run
         JOIN agent_versions version
           ON version.id=run.agent_version_id AND version.space_id=run.space_id AND version.agent_id=run.agent_id
        WHERE run.id=$1 AND run.space_id=$2 AND run.agent_id=$3 AND version.id=$4
        FOR SHARE OF version`,
      [input.invocationId, input.spaceId, control.agent_id, item.source_ref.id],
    )).rows[0];
    if (!version || contextItemText(item) !== (version.system_prompt ?? "").trim()) {
      throw new HttpError(409, "Runtime Context Agent instruction changed after planning");
    }
  }

  /**
   * A vendor CLI Room turn carries the briefing references attached since the
   * Agent's last reply — in the recipient instruction of a resumed session,
   * or as their own items in a fresh one. Each is re-gated here on the
   * destination this Delivery is authorized for (`authorizeEgress`, from the
   * Run's own adapter and ModelProvider, not the live Profile;
   * `informationDigest/briefing/referenceDelivery.ts`), after the
   * reference messages, the briefing rows and every Source item, Source
   * connection and subscription the copy rests on are locked: a concurrent
   * revocation either commits first and is refused here, or waits for this
   * Delivery to commit. A delivered item must be exactly one of them, as
   * attached.
   */
  private async authorizeBriefingReferences(
    db: Queryable,
    input: InvocationAttemptInput,
    accepted: readonly ContextItem[],
    run: { session_id: string | null; model_override_json: unknown; runtime_key?: string | null; agent_id?: string | null },
    destination: RetrievalEgressDestination,
  ): Promise<void> {
    const items = accepted.filter((item) => item.source_ref.type === "room_briefing_reference");
    const currentRef = input.envelope.turn_request.current_message_ref;
    const roomTurn = currentRef.type === "message" && isRoomConversation(run.model_override_json)
      && isVendorCliAdapter(run.runtime_key) && Boolean(run.session_id && run.agent_id);
    if (!roomTurn) {
      if (items.length) throw new HttpError(409, "Invocation Delivery carries a briefing reference outside a Room turn");
      return;
    }
    const pending = await pendingBriefingReferences(db, {
      spaceId: input.spaceId,
      sessionId: run.session_id!,
      currentMessageId: currentRef.id,
      agentId: run.agent_id!,
    });
    if (pending.length) {
      await db.query(
        `SELECT id FROM messages WHERE space_id=$1 AND session_id=$2 AND id=ANY($3::varchar[]) FOR SHARE`,
        [input.spaceId, run.session_id, pending.map((message) => message.id)],
      );
    }
    await this.lockBriefingReferences(db, input.spaceId, pending);
    await assertBriefingReferencesDeliverable(db, input.spaceId, pending, destination);
    const byId = new Map(pending.map((message) => [message.id, message.content]));
    const inInstruction = briefingReferencesInRecipientInstruction(run.model_override_json);
    for (const item of items) {
      if (inInstruction || item.acquisition !== "direct" || byId.get(item.source_ref.id) !== contextItemText(item)) {
        throw new HttpError(409, "Invocation Delivery briefing reference changed after planning");
      }
    }
  }

  /**
   * Locks what briefing references rest on, in one order: the briefing rows,
   * then each Source item with its connection and the attacher's
   * subscriptions, then every other Source connection behind an analysis or
   * signal — the same canonical Source locks a retrieved Source item takes.
   */
  private async lockBriefingReferences(db: Queryable, spaceId: string, messages: ReadonlyArray<{ id: string; metadata_json?: unknown }>): Promise<void> {
    const closure = await lockBriefingReferenceClosure(db, spaceId, messages);
    for (const attacher of closure.attachers) {
      for (const itemId of closure.itemIds) await this.lockSourceItemDependencies(db, spaceId, itemId, attacher);
      for (const connectionId of closure.connectionIds) await this.lockSourceConnectionDependencies(db, spaceId, connectionId, attacher);
    }
  }

  /**
   * A briefing Run's request carries the version's frozen material. Its
   * Delivery re-authorizes that version on the destination this Delivery is
   * authorized for (`authorizeEgress`: the Run's own adapter and ModelProvider,
   * never the live, editable Profile), after locking the version's whole
   * closure — briefing row, audience, context roots, signals, grants and
   * subscriptions, then its Source items and connections — held to commit.
   * The same rule as the orchestrator's dispatch guard
   * (`informationDigest/briefing/settlement.ts`, `assertBriefingVersionDispatchable`).
   */
  private async authorizeBriefingGeneration(
    db: Queryable,
    input: InvocationAttemptInput,
    run: { prompt: string | null; instruction: string | null; contract_snapshot_json?: unknown; root_run_id?: string | null },
    destination: RetrievalEgressDestination,
  ): Promise<void> {
    const settlement = await import("../informationDigest/briefing/settlement.js");
    const context = settlement.briefingRunContext(run);
    if (!context) return;
    await this.lockBriefingGenerationAuthority(db, { ...run, id: input.invocationId, space_id: input.spaceId, root_run_id: run.root_run_id ?? null });
    await settlement.assertBriefingVersionDispatchable(db, {
      id: input.invocationId,
      space_id: input.spaceId,
      prompt: run.prompt,
      instruction: run.instruction,
      contract_snapshot_json: run.contract_snapshot_json,
      root_run_id: run.root_run_id ?? null,
    }, { destination });
  }

  /** Canonical whole-version fence, shared by physical Delivery and theme
   * publication. The caller re-authorizes its actual destination after locking. */
  async lockBriefingGenerationAuthority(db: Queryable, run: import('../informationDigest/briefing/settlement.js').BriefingDispatchRun): Promise<void> {
    const {briefingRunContext}=await import('../informationDigest/briefing/settlement.js');
    const context=briefingRunContext(run);if(!context)return;
    const requester = (await db.query<{ requested_by_user_id: string }>(
      `SELECT requested_by_user_id FROM information_briefings WHERE space_id=$1 AND id=$2`,
      [run.space_id, context.id],
    )).rows[0]?.requested_by_user_id;
    if (requester) {
      const closure = await lockBriefingVersionClosure(db, run.space_id, context.id, requester);
      for (const itemId of closure.itemIds) await this.lockSourceItemDependencies(db, run.space_id, itemId, requester);
      for (const connectionId of closure.connectionIds) await this.lockSourceConnectionDependencies(db, run.space_id, connectionId, requester);
    }
  }

  private async authorizeReadingMethod(db:Queryable,input:InvocationAttemptInput,request:{contract_snapshot_json?:unknown}):Promise<void>{
    const workflow=(request.contract_snapshot_json as {workflow_input_json?:{source_collection?:unknown;reading_method?:unknown;reading_method_trial?:unknown;reading_method_generation?:unknown}}|null)?.workflow_input_json;
    if(!workflow?.source_collection&&!workflow?.reading_method&&!workflow?.reading_method_trial&&!workflow?.reading_method_generation)return;
    const {PgRunRepository}=await import('../runs/repository.js');
    const full=await new PgRunRepository(db).getRun(input.spaceId,input.invocationId);if(!full)throw new HttpError(403,'Reading Run missing');
    await this.lockReadingRunAuthority(db,full);
    await (await import('../prompts/reading/dispatch.js')).assertReadingRunDispatch(db,full);
  }

  /** Same canonical Source/Project ACL locks at Delivery and Source commit boundaries. */
  /** One Source connection's read authority for a viewer, FOR SHARE and in Delivery order: the row, the viewer's subscriptions, its content ACL. */
  async lockSourceConnectionAuthority(db:Queryable,spaceId:string,connectionId:string,viewerUserId:string):Promise<void>{
    await this.lockSourceConnectionDependencies(db,spaceId,connectionId,viewerUserId);
    await this.lockContentAclDependencies(db,spaceId,'source_connection',connectionId,viewerUserId);
  }
  async lockReadingRunAuthority(db:Queryable,full:import('../runs/repository.js').RunRecord):Promise<void>{
    await (await import('../sourceAnnotation/dispatch.js')).lockAnnotationRunAuthority(db,full);
    const authority=await readingRunAuthority(db,full);
    if(authority.assetId)await (await import('../evolution/assetLocks.js')).lockEvolutionAssets(db,[authority.assetId]);
    const spaceId=full.space_id;
    if(authority.deep?.original)await db.query('SELECT id FROM source_snapshots WHERE id=$1 AND space_id=$2 FOR SHARE',[authority.deep.original.snapshot_id,spaceId]);
    const {lockProjectAudience,projectReaderIds}=await import('../projects/access.js');
    // Canonical closure order: every Project audience (the Following goals' own
    // Projects included) before the goals, as Goal writers lock them (`lockGoal`).
    for(const id of authority.audienceProjects)await lockProjectAudience(db,spaceId,id);
    for(const ref of authority.following)await db.query(`SELECT g.id FROM source_goals g JOIN source_goal_versions v ON v.goal_id=g.id AND v.space_id=g.space_id WHERE g.id=$1 AND v.id=$2 AND g.space_id=$3 FOR SHARE OF g,v`,[ref.goal_id,ref.version_id,full.space_id]);
    for(const deps of authority.dependencies){
      const readers=deps.projectId?await projectReaderIds(db,spaceId,deps.projectId):[deps.readerUserId??full.instructed_by_user_id!];
      if(deps.caseId)await db.query(`SELECT id FROM evaluation_cases WHERE id=$1 AND space_id=$2 FOR SHARE`,[deps.caseId,spaceId]);
      for(const reader of readers.sort()){
        if(deps.itemId){await this.lockSourceItemDependencies(db,spaceId,deps.itemId,reader);await this.lockContentAclDependencies(db,spaceId,'source_item',deps.itemId,reader);}
        if(deps.connectionId){await this.lockSourceConnectionDependencies(db,spaceId,deps.connectionId,reader);await this.lockContentAclDependencies(db,spaceId,'source_connection',deps.connectionId,reader);}
        if(deps.artifactId)await this.lockContentAclDependencies(db,spaceId,'artifact',deps.artifactId,reader);
      }
    }
  }

  private async authorizePersonalMemoryGrant(
    db: Queryable,
    input: InvocationAttemptInput,
    item: ContextItem,
  ): Promise<void> {
    const grant = await db.query<{
      id: string;
      status: "active" | "used";
      personal_space_id: string;
      target_space_id: string;
    }>(
      `SELECT id,status,personal_space_id,target_space_id
         FROM personal_memory_grants
        WHERE id=$1 AND target_run_id=$2 AND target_space_id=$3
          AND granting_user_id=$4 AND grant_scope='run'
          AND access_mode='summary_only' AND target_agent_id IS NULL
          AND status IN ('active','used') AND read_expires_at > $5
        FOR UPDATE`,
      [item.source_ref.id, input.invocationId, input.spaceId, input.viewerUserId, new Date().toISOString()],
    );
    const row = grant.rows[0];
    if (!row) throw new HttpError(409, "Invocation Delivery PersonalMemoryGrant is no longer usable");
    const run = await new PgRuntimeContextAcquisitionRepository(db).loadRun(input.spaceId, input.invocationId);
    const canonical = run
      ? await new PgRuntimeContextAcquisitionRepository(db).loadPersonalGrantForRun(run)
      : null;
    if (!canonical || canonical.metadata.grant_id !== row.id || contextItemText(item) !== canonical.summary) {
      throw new HttpError(409, "Invocation Delivery PersonalMemoryGrant summary changed after planning");
    }
    if (row.status === "used") return;
    const now = new Date().toISOString();
    await db.query(
      `UPDATE personal_memory_grants
          SET status='consuming',consume_started_at=$1,updated_at=$1
        WHERE id=$2 AND status='active'`,
      [now, row.id],
    );
    await this.insertPersonalGrantEvent(db, row, input.invocationId, "consuming", {
      access_mode: "summary_only",
      raw_private_memory_included: false,
    });
    await db.query(
      `UPDATE personal_memory_grants
          SET status='used',used_at=$1,updated_at=$1
        WHERE id=$2 AND status='consuming'`,
      [now, row.id],
    );
    await this.insertPersonalGrantEvent(db, row, input.invocationId, "used", {
      memory_count: canonical.metadata.memory_count,
      access_mode: "summary_only",
      raw_private_memory_included: false,
      personal_summary_persisted: false,
    });
  }

  private async insertPersonalGrantEvent(
    db: Queryable,
    grant: { id: string; personal_space_id: string; target_space_id: string },
    runId: string,
    eventType: "consuming" | "used",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db.query(
      `INSERT INTO personal_memory_grant_events
         (id,grant_id,event_type,run_id,source_space_id,target_space_id,metadata_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [randomUUID(), grant.id, eventType, runId, grant.personal_space_id,
        grant.target_space_id, JSON.stringify(metadata), new Date().toISOString()],
    );
  }

  /**
   * The Evidence Matrix through the ordinary Artifact release gate, not a
   * bare ACL: its own row in the Run's Project, then every row that gate
   * reads to release its body — the research call that produced it and,
   * recursively, every `input_refs` Artifact, Note, Thread and Task with their
   * Operations, Runs, Source items/channels/connections, subscriptions,
   * Projects and grants — share-locked in the canonical release order
   * (`lockArtifactReleaseClosure`, re-discovered under the locks), and held to
   * this transaction's commit. Preview release and execution Delivery share
   * this check, so a withdrawn dependency withholds the whole preview and
   * refuses Delivery exactly when the Artifact reader withholds the body.
   */
  private async authorizeProjectResearchMatrix(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    item: ContextItem,
    heldRoomIds: readonly string[],
  ): Promise<void> {
    if (!control.project_id || !input.viewerUserId) throw new HttpError(409, "Project Research Matrix has no Project authority");
    const identity = { spaceId: input.spaceId, userId: input.viewerUserId };
    const { lockArtifactReleaseClosure } = await import("../contentAccess/demotionReleaseClosure.js");
    // Its Rooms were taken before the Run (`lockEnvelopeRooms`); any other is drift.
    await lockArtifactReleaseClosure(db, identity, [item.source_ref.id], { heldRoomIds });
    const matrix = (await db.query<{ id: string }>(
      `SELECT artifact.id FROM artifacts artifact
        WHERE artifact.id=$1 AND artifact.space_id=$2 AND artifact.project_id=$3
          AND artifact.artifact_type='evidence_matrix'`,
      [item.source_ref.id, input.spaceId, control.project_id],
    )).rows[0];
    const { artifactBodyReleased } = await import("../artifacts/repository.js");
    const body = matrix ? await artifactBodyReleased(db, identity, matrix.id) : null;
    if (!body || contextItemText(item) !== body) {
      throw new HttpError(409, "Invocation Delivery Project Research Matrix changed after planning");
    }
    await this.authorizeReferencedProject(db, input.spaceId, control.project_id, input.viewerUserId);
  }

  private async authorizeRuntimeSkill(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    item: ContextItem,
  ): Promise<void> {
    const run = await new PgRuntimeContextAcquisitionRepository(db).loadRun(input.spaceId, input.invocationId);
    if (!run) throw new HttpError(409, "Skill invocation disappeared");
    const scope = {
      space_id: input.spaceId, run_id: input.invocationId, runtime_key: run.runtime_key ?? null,
      project_id: control.project_id, agent_id: control.agent_id,
      instructed_by_user_id: run.instructed_by_user_id, viewer_user_id: input.viewerUserId,
      session_id: run.session_id,
      message_id: input.envelope.turn_request.current_message_ref.type === "message"
        ? input.envelope.turn_request.current_message_ref.id : null,
    };
    const provider = new PgRuntimeSkillProvider(db);
    const candidates = await provider.loadCandidatesForRun(scope);
    if (!candidates.some(skill => skill.binding_id === item.source_ref.id)) {
      throw new HttpError(409, "Skill package authorization changed after planning");
    }
    // The same package lock is taken by binding writers. Reload under the
    // lock so a disable or higher-precedence binding cannot race Delivery.
    const authorizedCandidates = await provider.loadCandidatesForRun({ ...scope, lock: true });
    const skill = authorizedCandidates.find(skill => skill.binding_id === item.source_ref.id);
    if (!skill || item.source_ref.version !== `${skill.content.package_hash}:${run.id}`
      || contextItemText(item) !== selectedSkillInstruction(skill.content)
      // A stored plan comes back from jsonb with its keys reordered.
      || stableJson(JSON.parse(JSON.stringify(item.payload.skill_package ?? null))) !== stableJson(JSON.parse(JSON.stringify(skill.content)))) {
      throw new HttpError(409, "Skill package authorization changed after planning");
    }
  }

  private async authorizeMessageSource(
    db: Queryable,
    input: InvocationAttemptInput,
    item: ContextItem,
    run: { session_id: string | null; model_override_json: unknown; held_room_ids: readonly string[] },
  ): Promise<void> {
    if (!input.viewerUserId) throw new HttpError(403, "Invocation Delivery requires a live viewer authority");
    const currentRef = input.envelope.turn_request.current_message_ref;
    if (currentRef.type !== "message" || currentRef.id !== item.source_ref.id || !run.session_id) {
      throw new HttpError(409, "Invocation Delivery Message authority does not match the turn");
    }
    const session = await this.lockConversationSession(db, input, run.session_id, run.held_room_ids);
    const row = await loadAuthorizedCurrentContextMessage(db, {
      messageId: item.source_ref.id,
      spaceId: input.spaceId,
      sessionId: run.session_id,
      userId: input.viewerUserId,
      runId: input.invocationId,
    });
    const canonicalMessageId = chatTurnMessageId(run.model_override_json);
    const liveInput = canonicalMessageId !== item.source_ref.id
      && await new (await import("../runs/repository.js")).PgRunRepository(db).isPendingLiveInputMessage(input.spaceId, input.invocationId, item.source_ref.id, input.viewerUserId);
    if (!row || (canonicalMessageId !== item.source_ref.id && !liveInput)
      || item.trust !== (row.role === "system" ? "system_approved" : "user_confirmed")
      || (session.roomId === null && row.linked_run_id !== input.invocationId)) {
      throw new HttpError(409, "Invocation Delivery Message changed or is no longer authoritative");
    }
    const messageContext = await loadConversationMessageContext(db, {
      spaceId: input.spaceId,
      messageId: item.source_ref.id,
      content: row.content,
    });
    if (contextItemText(item) !== messageContext.text) {
      throw new HttpError(409, "Invocation Delivery Message changed or is no longer authoritative");
    }
  }

  private async authorizeContinuitySource(
    db: Queryable,
    input: InvocationAttemptInput,
    item: ContextItem,
    run: { session_id: string | null; held_room_ids: readonly string[] },
    destination: RetrievalEgressDestination,
  ): Promise<void> {
    if (!run.session_id) throw new HttpError(409, "Invocation Delivery continuity has no Session authority");
    await this.lockConversationSession(db, input, run.session_id, run.held_room_ids);
    const currentRef = input.envelope.turn_request.current_message_ref;
    if (currentRef.type !== "message") {
      throw new HttpError(409, "Invocation Delivery continuity current Message is unavailable");
    }
    const scopeId = input.envelope.turn_request.work_context_scope_id;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `context-event:${input.spaceId}:${scopeId}`,
    ]);
    const planned = await loadConversationContinuityThroughMessage(db, {
      spaceId: input.spaceId,
      sessionId: run.session_id,
      workContextScopeId: scopeId,
      currentMessageId: currentRef.id,
    });
    const { messages, checkpoint } = planned;
    const current = messages.find((message) => message.id === currentRef.id);
    if (!current) throw new HttpError(409, "Invocation Delivery continuity current Message is unavailable");
    if (checkpoint) {
      await lockRequiredRow(
        db,
        `SELECT id FROM context_semantic_checkpoints
          WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3 AND version=$4
            AND status IN ('active','superseded')
          FOR SHARE`,
        [checkpoint.id, input.spaceId, scopeId, checkpoint.version],
        "Invocation Delivery semantic checkpoint changed after planning",
      );
    }
    const messageIds = messages.map((message) => message.id);
    const locked = messageIds.length
      ? await db.query(
          `SELECT id FROM messages
            WHERE space_id=$1 AND session_id=$2 AND id=ANY($3::varchar[])
            FOR SHARE`,
          [input.spaceId, run.session_id, messageIds],
        )
      : { rows: [] };
    if (locked.rows.length !== messageIds.length) {
      throw new HttpError(409, "Invocation Delivery continuity messages changed after planning");
    }
    const canonical = await loadConversationContinuityThroughMessage(db, {
      spaceId: input.spaceId,
      sessionId: run.session_id,
      workContextScopeId: scopeId,
      currentMessageId: currentRef.id,
    });
    const canonicalCurrent = canonical.messages.find((message) => message.id === currentRef.id);
    if (!canonicalCurrent) {
      throw new HttpError(409, "Invocation Delivery continuity current Message is unavailable");
    }
    const rendered = renderCheckpointContinuity(
      canonical.messages,
      canonicalCurrent,
      canonical.checkpoint,
      canonical.room_conversation,
    );
    const expectedRef = canonical.checkpoint
      ? { type: "semantic_checkpoint", id: canonical.checkpoint.id, version: String(canonical.checkpoint.version) }
      : { type: "session", id: run.session_id, version: null };
    const decision = input.envelope.window_plan.decisions.find((entry) => entry.item_id === item.id);
    const canonicalTokens = rendered ? estimateModelTokens(rendered.text) : 0;
    const expectedText = rendered && decision?.decision === "trimmed"
      ? trimContextText(rendered.text, item.acquisition, decision.planned_tokens)
      : rendered?.text;
    const trimIsCanonical = decision?.decision !== "trimmed"
      || (item.payload.trimmed_from_tokens === canonicalTokens
        && item.token_estimate === decision.planned_tokens);
    if (!rendered || item.source_ref.type !== expectedRef.type
      || item.source_ref.id !== expectedRef.id
      || (item.source_ref.version ?? null) !== expectedRef.version
      || contextItemText(item) !== expectedText
      || !trimIsCanonical
      || stableStringArray(messageRefs(item)).join("\0") !== stableStringArray(rendered.messageRefs.map((ref) => ref.id)).join("\0")) {
      throw new HttpError(409, "Invocation Delivery continuity changed after planning");
    }
    const replayed = new Set(rendered.messageRefs.map((ref) => ref.id));
    const references = canonical.messages.filter((message) => replayed.has(message.id));
    await this.lockBriefingReferences(db, input.spaceId, references);
    await assertBriefingReferencesDeliverable(db, input.spaceId, references, destination);
  }

  private async lockConversationSession(
    db: Queryable,
    input: InvocationAttemptInput,
    sessionId: string,
    heldRoomIds: readonly string[],
  ): Promise<{ roomId: string | null }> {
    const session = await db.query<{ room_id: string | null; user_id: string | null }>(
      `SELECT room_id,user_id FROM sessions
        WHERE id=$1 AND space_id=$2 AND status='active' FOR SHARE`,
      [sessionId, input.spaceId],
    );
    const row = session.rows[0];
    if (!row) throw new HttpError(409, "Invocation Delivery Session is no longer active");
    if (row.room_id === null) {
      if (row.user_id !== input.viewerUserId) {
        throw new HttpError(404, "Invocation Delivery Session is no longer readable");
      }
      return { roomId: null };
    }
    // Taken before the Run (`lockEnvelopeRooms`); re-locked below, never first here.
    if (!heldRoomIds.includes(row.room_id)) {
      throw new HttpError(409, "Invocation Delivery Room authority changed; read again");
    }
    const membership = await db.query(
      `SELECT member.user_id FROM rooms room
         JOIN room_user_members member
           ON member.room_id=room.id AND member.space_id=room.space_id
        WHERE room.id=$1 AND room.space_id=$2 AND room.status='active'
          AND member.user_id=$3 AND member.status='active'
          AND ${roomConversationAudienceSql("room.space_id", "$4::varchar", "$3")}
        FOR SHARE OF room,member`,
      [row.room_id, input.spaceId, input.viewerUserId, sessionId],
    );
    if (!membership.rows[0]) {
      throw new HttpError(404, "Invocation Delivery Room membership is no longer active");
    }
    return { roomId: row.room_id };
  }

  private async authorizeExplicitSource(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    item: ContextItem,
  ): Promise<void> {
    const { type, id, version } = item.source_ref;
    if (type === "project_brief_version") {
      const result = await db.query<{ version: string; project_id: string }>(
        `SELECT brief.version,brief.project_id FROM project_brief_versions brief
          JOIN projects project ON project.id=brief.project_id AND project.space_id=brief.space_id
         WHERE brief.id=$1 AND brief.space_id=$2 AND brief.status IN ('published','archived')
           AND brief.published_at IS NOT NULL AND project.deleted_at IS NULL
         FOR SHARE OF brief`,
        [id, input.spaceId],
      );
      const row = result.rows[0];
      if (!row || (version != null && version !== row.version)) {
        throw new HttpError(409, "Invocation Delivery Project Brief reference is no longer current");
      }
      await this.authorizeReferencedProject(db, input.spaceId, row.project_id, input.viewerUserId!);
      return;
    }
    if (type === "project_instruction_version") {
      const result = await db.query<{ version: string; project_id: string }>(
        `SELECT instruction.version,instruction.project_id FROM project_instruction_versions instruction
          JOIN projects project ON project.id=instruction.project_id AND project.space_id=instruction.space_id
         WHERE instruction.id=$1 AND instruction.space_id=$2 AND instruction.status='published'
           AND instruction.published_at IS NOT NULL AND project.deleted_at IS NULL
           AND project.active_instruction_version_id=instruction.id
         FOR SHARE OF instruction`,
        [id, input.spaceId],
      );
      const row = result.rows[0];
      if (!row || row.project_id !== control.project_id || (version != null && version !== row.version)) {
        throw new HttpError(409, "Invocation Delivery Project Instruction reference is no longer current");
      }
      await this.authorizeReferencedProject(db, input.spaceId, row.project_id, input.viewerUserId!);
      return;
    }
    throw new HttpError(409, `Invocation Delivery explicit source type '${type}' is not reauthorizable`);
  }

  private async authorizeRetrievalSource(
    db: Queryable,
    input: InvocationAttemptInput,
    control: ExecutionControlSnapshot,
    item: ContextItem,
    viewerSpaceRole: string,
    egress: { destination: RetrievalEgressDestination; externalEgressEnabled: boolean },
  ): Promise<void> {
    const viewerUserId = input.viewerUserId;
    if (!viewerUserId) throw new HttpError(403, "Invocation Delivery requires a live viewer authority");
    const objectType = item.source_ref.type as RetrievalObjectType;
    const adapter = deliverySourceRegistry.adapterFor(objectType);
    if (!adapter) throw new HttpError(409, `Invocation Delivery retrieval source type '${objectType}' is not reauthorizable`);
    await lockRetrievalAuthority(db, input.spaceId, objectType, item.source_ref.id, viewerUserId);
    await this.lockRetrievalAclDependencies(db, input.spaceId, objectType, item.source_ref.id, viewerUserId);
    if (objectType === "source_item" || objectType === "extracted_evidence") {
      await this.lockSourceRetrievalDependencies(db, input.spaceId, objectType, item.source_ref.id, viewerUserId);
    }
    const [canonical, readable] = await Promise.all([
      adapter.loadCanonical(db, input.spaceId, objectType, item.source_ref.id),
      adapter.revalidate(db, input.spaceId, objectType, item.source_ref.id, viewerUserId),
    ]);
    const sourceUpdatedAt = stringOrNull(item.revalidation.source_updated_at);
    if (!canonical || !readable || sourceUpdatedAt !== canonical.updatedAt) {
      throw new HttpError(409, "Invocation Delivery retrieval source is stale or no longer readable");
    }
    const query = input.envelope.turn_request.retrieval_intent ?? "";
    const fullText = [readable.title, readable.text ? excerptAroundQuery(readable.text, query) : null]
      .filter((value): value is string => Boolean(value)).join("\n");
    // A ranked item the window trimmed carries the canonical trim of the live text.
    const decision = input.envelope.window_plan.decisions.find((entry) => entry.item_id === item.id);
    const expectedText = decision?.decision === "trimmed"
      && item.payload.trimmed_from_tokens === estimateModelTokens(fullText)
      ? trimContextText(fullText, item.acquisition, decision.planned_tokens)
      : fullText;
    if (contextItemText(item) !== expectedText) {
      throw new HttpError(409, "Invocation Delivery retrieval source changed after planning");
    }
    const recordedSourceIds = stringArray(item.revalidation.source_connection_ids);
    const currentSourceIds = [...canonical.sourceConnectionIds].sort();
    if (recordedSourceIds.sort().join("\0") !== currentSourceIds.join("\0")) {
      throw new HttpError(409, "Invocation Delivery retrieval source policy lineage changed after planning");
    }
    if (currentSourceIds.length === 0) return;
    await db.query(
      `SELECT id FROM source_connections
        WHERE space_id=$1 AND id=ANY($2::varchar[]) AND status<>'archived' AND deleted_at IS NULL
        FOR SHARE`,
      [input.spaceId, currentSourceIds],
    );
    const snapshots = await loadSourcePolicySnapshots(db, input.spaceId, currentSourceIds);
    const readableBySource = currentSourceIds.every((sourceId) => {
      const snapshot = snapshots.get(sourceId);
      return snapshot ? sourcePolicyAllowsRead(snapshot, {
        viewerUserId,
        agentId: control.agent_id,
        viewerSpaceRole,
      }) : false;
    });
    const egressAllowed = retrievalEgressAllowed({
      object_type: objectType,
      object_id: item.source_ref.id,
      source_connection_ids: currentSourceIds,
    }, {
      externalEgressEnabled: egress.externalEgressEnabled,
      destination: egress.destination,
      sourcePolicies: sourceEgressPoliciesForSnapshots(snapshots),
    });
    if (!readableBySource || !egressAllowed) {
      throw new HttpError(409, "Invocation Delivery retrieval source policy is no longer authorized");
    }
  }

  private async authorizeReferencedProject(
    db: Queryable,
    spaceId: string,
    projectId: string,
    viewerUserId: string,
  ): Promise<void> {
    if (!await this.lockReadableProject(db, spaceId, projectId, viewerUserId)) {
      throw new HttpError(404, "Invocation Delivery referenced Project is no longer readable");
    }
  }

  /** Locks the Project and the viewer's membership in it; true when the viewer may read it. */
  private async lockReadableProject(
    db: Queryable,
    spaceId: string,
    projectId: string,
    viewerUserId: string,
  ): Promise<boolean> {
    assertProjectHeld(db, projectId);
    const project = await db.query<{ owner_user_id: string | null; space_type: string }>(
      `SELECT project.owner_user_id,space.type AS space_type
         FROM projects project JOIN spaces space ON space.id=project.space_id
        WHERE project.id=$1 AND project.space_id=$2 AND project.deleted_at IS NULL
        FOR SHARE OF project,space`,
      [projectId, spaceId],
    );
    const row = project.rows[0];
    if (!row) return false;
    if (row.space_type === "personal" || row.owner_user_id === viewerUserId) return true;
    const member = await db.query(
      `SELECT 1 FROM project_members
        WHERE space_id=$1 AND project_id=$2 AND user_id=$3 AND status='active' FOR SHARE`,
      [spaceId, projectId, viewerUserId],
    );
    return Boolean(member.rows[0]);
  }

  async lockContentAclDependencies(
    db: Queryable,
    spaceId: string,
    resourceType: string,
    resourceId: string,
    viewerUserId: string,
  ): Promise<void> {
    await db.query(`SELECT id FROM spaces WHERE id=$1 FOR SHARE`, [spaceId]);
    const definition = contentResourceDefinition(resourceType);
    if (!definition) throw new HttpError(409, `Invocation Delivery content type '${resourceType}' is not lockable`);
    const projectSelection = definition.projectColumn
      ? `${definition.projectColumn} AS project_id`
      : "NULL::varchar AS project_id";
    const accessProjectSelection = definition.accessProjectColumn
      ? `${definition.accessProjectColumn} AS access_project_id`
      : "NULL::varchar AS access_project_id";
    const folderSelection = definition.projectFolderColumn
      ? `${definition.projectFolderColumn} AS project_folder_id`
      : "NULL::varchar AS project_folder_id";
    const scope = await db.query<{ project_id: string | null; access_project_id: string | null; project_folder_id: string | null }>(
      `SELECT ${projectSelection},${accessProjectSelection},${folderSelection}
         FROM ${definition.tableName}
        WHERE space_id=$1 AND id=$2 FOR SHARE`,
      [spaceId, resourceId],
    );
    const row = scope.rows[0];
    if (!row) throw new HttpError(409, "Invocation Delivery content authority no longer exists");
    // The viewer's grant after the resource root, the order every audience writer
    // (`content.access.update`, the egress-review applier) takes them: root
    // `FOR UPDATE`, then the grant rows. Grant first would let a reader holding the
    // grant and a writer holding the root wait on each other.
    await db.query(
      `SELECT id FROM content_access_grants
        WHERE space_id=$1 AND resource_type=$2 AND resource_id=$3
          AND grantee_user_id=$4 AND revoked_at IS NULL FOR SHARE`,
      [spaceId, resourceType, resourceId, viewerUserId],
    );
    // The read rule's Project scope is an OR: no Project, the object's own
    // Project, or any Project it is shared to. The share rows are locked
    // either way; one readable Project is enough.
    const sharedProjectIds = definition.projectShare
      ? (await db.query<{ project_id: string }>(
          `SELECT ${definition.projectShare.projectColumn} AS project_id FROM ${definition.projectShare.tableName}
            WHERE space_id=$1 AND ${definition.projectShare.resourceColumn}=$2 AND ${definition.projectShare.revokedColumn} IS NULL
            ORDER BY ${definition.projectShare.projectColumn}
            FOR SHARE`,
          [spaceId, resourceId],
        )).rows.map((share) => share.project_id)
      : [];
    // The retained access Project is mandatory, independent of Project shares.
    if (row.access_project_id) {
      await this.authorizeReferencedProject(db, spaceId, row.access_project_id, viewerUserId);
    }
    if (row.project_id) {
      let readable = false;
      for (const projectId of [row.project_id, ...sharedProjectIds]) {
        if (await this.lockReadableProject(db, spaceId, projectId, viewerUserId)) {
          readable = true;
          break;
        }
      }
      if (!readable) throw new HttpError(404, "Invocation Delivery referenced Project is no longer readable");
    }
    if (row.project_folder_id) {
      const folder = await db.query<{ project_id: string | null }>(
        `SELECT folder.project_id FROM project_folders folder
          WHERE folder.id=$1 AND folder.space_id=$2 AND folder.status='active'
            AND ${projectFolderReadAccessSql({ spaceExpr: "folder.space_id", projectFolderExpr: "folder.id", userExpr: "$3" })}
          FOR SHARE OF folder`,
        [row.project_folder_id, spaceId, viewerUserId],
      );
      if (!folder.rows[0]) throw new HttpError(409, "Invocation Delivery content Folder is no longer readable");
      if (folder.rows[0].project_id) {
        await this.authorizeReferencedProject(db, spaceId, folder.rows[0].project_id, viewerUserId);
      }
    }
  }

  private async lockSourceRetrievalDependencies(
    db: Queryable,
    spaceId: string,
    objectType: "source_item" | "extracted_evidence",
    objectId: string,
    viewerUserId: string,
  ): Promise<void> {
    if (objectType === "source_item") {
      await this.lockSourceItemDependencies(db, spaceId, objectId, viewerUserId);
      return;
    }
    const evidence = await db.query<{
      source_item_id: string | null;
      source_snapshot_id: string | null;
      source_object_id: string | null;
    }>(
      `SELECT COALESCE(source_item_id,origin_source_item_id) AS source_item_id,
              source_snapshot_id,source_object_id
         FROM extracted_evidence WHERE space_id=$1 AND id=$2 FOR SHARE`,
      [spaceId, objectId],
    );
    const row = evidence.rows[0];
    if (!row) throw new HttpError(409, "Invocation Delivery Evidence authority no longer exists");
    if (row.source_item_id) {
      await lockRequiredRow(db,
        "SELECT id FROM source_items WHERE space_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE",
        [spaceId, row.source_item_id],
        "Invocation Delivery Evidence Source Item is no longer readable",
      );
      await this.lockContentAclDependencies(db, spaceId, "source_item", row.source_item_id, viewerUserId);
      await this.lockSourceItemDependencies(db, spaceId, row.source_item_id, viewerUserId);
    }
    if (row.source_snapshot_id) {
      const snapshot = await db.query<{ connection_id: string | null }>(
        `SELECT connection_id FROM source_snapshots
          WHERE space_id=$1 AND id=$2 FOR SHARE`,
        [spaceId, row.source_snapshot_id],
      );
      if (!snapshot.rows[0]) throw new HttpError(409, "Invocation Delivery Evidence Snapshot is no longer readable");
      await this.lockContentAclDependencies(db, spaceId, "source_snapshot", row.source_snapshot_id, viewerUserId);
      if (snapshot.rows[0].connection_id) {
        await this.lockSourceConnectionDependencies(db, spaceId, snapshot.rows[0].connection_id, viewerUserId);
      }
    }
    if (row.source_object_id) {
      const object = await db.query(
        `SELECT id FROM space_objects
          WHERE space_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
        [spaceId, row.source_object_id],
      );
      if (object.rows[0]) {
        await this.lockContentAclDependencies(db, spaceId, "space_object", row.source_object_id, viewerUserId);
      }
    }
  }

  /** Canonical Source/Artifact locks for an explicitly bounded reading investigation. */
  async lockSourceReadingReferences(db:Queryable,spaceId:string,refs:readonly {item_id:string;artifact_id:string}[],userId:string,targetItemId?:string){
    // Lock publication and history items in one order before any shared locks
    // are upgraded by the Source writer (two articles may cite each other).
    if(targetItemId)await db.query(`SELECT id FROM source_items WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE`,[spaceId,[...new Set([targetItemId,...refs.map(ref=>ref.item_id)])].sort()]);
    if(targetItemId)await db.query(`SELECT id FROM source_snapshots WHERE space_id=$1 AND artifact_id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[spaceId,refs.map(ref=>ref.artifact_id)]);
    for(const ref of [...refs].sort((a,b)=>a.item_id.localeCompare(b.item_id))){
      await this.lockSourceItemDependencies(db,spaceId,ref.item_id,userId);
      await this.lockContentAclDependencies(db,spaceId,'source_item',ref.item_id,userId);
      await this.lockContentAclDependencies(db,spaceId,'artifact',ref.artifact_id,userId);
    }
  }

  private async lockSourceItemDependencies(
    db: Queryable,
    spaceId: string,
    sourceItemId: string,
    viewerUserId: string,
  ): Promise<void> {
    const item = await db.query<{ connection_id: string | null }>(
      `SELECT connection_id FROM source_items
        WHERE space_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
      [spaceId, sourceItemId],
    );
    if (!item.rows[0]) throw new HttpError(409, "Invocation Delivery Source Item is no longer readable");
    if (item.rows[0].connection_id) {
      await this.lockSourceConnectionDependencies(db, spaceId, item.rows[0].connection_id, viewerUserId);
    }
  }

  private async lockSourceConnectionDependencies(
    db: Queryable,
    spaceId: string,
    connectionId: string,
    viewerUserId: string,
  ): Promise<void> {
    await lockRequiredRow(db,
      `SELECT id FROM source_connections
        WHERE space_id=$1 AND id=$2 AND status<>'archived' AND deleted_at IS NULL FOR SHARE`,
      [spaceId, connectionId],
      "Invocation Delivery Source connection is no longer readable",
    );
    await db.query(
      `SELECT subscription.id FROM source_channel_user_subscriptions subscription
        JOIN source_channels channel ON channel.id=subscription.source_channel_id
          AND channel.space_id=subscription.space_id
       WHERE subscription.space_id=$1 AND channel.source_connection_id=$2
         AND subscription.user_id=$3 AND subscription.status='subscribed'
       FOR SHARE OF subscription,channel`,
      [spaceId, connectionId, viewerUserId],
    );
  }

  private async lockRetrievalAclDependencies(
    db: Queryable,
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
    viewerUserId: string,
  ): Promise<void> {
    const contentTypes: Partial<Record<RetrievalObjectType, string>> = {
      knowledge_item: "space_object",
      note: "space_object",
      source: "space_object",
      claim: "space_object",
      memory_entry: "memory",
      source_item: "source_item",
      extracted_evidence: "extracted_evidence",
    };
    const contentType = contentTypes[objectType];
    if (contentType) {
      await this.lockContentAclDependencies(db, spaceId, contentType, objectId, viewerUserId);
    }
    const projectSql: Partial<Record<RetrievalObjectType, string>> = {
      knowledge_item: "SELECT folder.project_id FROM space_objects object LEFT JOIN project_folders folder ON folder.id=object.project_folder_id AND folder.space_id=object.space_id WHERE object.space_id=$1 AND object.id=$2",
      note: "SELECT folder.project_id FROM space_objects object LEFT JOIN project_folders folder ON folder.id=object.project_folder_id AND folder.space_id=object.space_id WHERE object.space_id=$1 AND object.id=$2",
      source: "SELECT folder.project_id FROM space_objects object LEFT JOIN project_folders folder ON folder.id=object.project_folder_id AND folder.space_id=object.space_id WHERE object.space_id=$1 AND object.id=$2",
      claim: "SELECT folder.project_id FROM space_objects object LEFT JOIN project_folders folder ON folder.id=object.project_folder_id AND folder.space_id=object.space_id WHERE object.space_id=$1 AND object.id=$2",
      memory_entry: "SELECT project_id FROM memory_entries WHERE space_id=$1 AND id=$2",
      source_item: "SELECT project_id FROM source_items WHERE space_id=$1 AND id=$2",
      extracted_evidence: "SELECT project_id FROM extracted_evidence WHERE space_id=$1 AND id=$2",
      inquiry_thread: "SELECT project_id FROM inquiry_threads WHERE space_id=$1 AND object_id=$2",
    };
    const query = projectSql[objectType];
    if (!query) return;
    const projectId = (await db.query<{ project_id: string | null }>(query, [spaceId, objectId])).rows[0]?.project_id;
    if (!projectId) return;
    await this.authorizeReferencedProject(db, spaceId, projectId, viewerUserId);
  }
}

function supervisorRetryContext(errorJson: unknown): string | null {
  const error = errorJson && typeof errorJson === "object" && !Array.isArray(errorJson)
    ? errorJson as Record<string, unknown>
    : {};
  if (error.error_code !== "supervisor_retry_scheduled") return null;
  const reasonCode = typeof error.reason_code === "string" && error.reason_code.trim()
    ? error.reason_code.trim()
    : null;
  const attemptNumber = typeof error.attempt_number === "number"
    && Number.isInteger(error.attempt_number) && error.attempt_number > 0
    ? error.attempt_number
    : null;
  if (!reasonCode || attemptNumber === null) return null;
  return [
    "[Supervisor retry]",
    `This is physical attempt ${attemptNumber}.`,
    `The previous attempt did not complete acceptably (${reasonCode}).`,
    retryTaskInstruction(reasonCode),
  ].join("\n");
}

function runRequestText(run: { prompt: string | null; instruction: string | null }): string {
  return (run.prompt?.trim() ? run.prompt : run.instruction ?? "").trim();
}

async function lockRequiredRow(
  db: Queryable,
  sql: string,
  params: unknown[],
  message: string,
): Promise<void> {
  const result = await db.query(sql, params);
  if (!result.rows[0]) throw new HttpError(409, message);
}

async function lockRetrievalAuthority(
  db: Queryable,
  spaceId: string,
  objectType: RetrievalObjectType,
  objectId: string,
  viewerUserId: string,
): Promise<void> {
  const queries: Partial<Record<RetrievalObjectType, string>> = {
    knowledge_item: "SELECT item.object_id FROM knowledge_items item JOIN space_objects object ON object.id=item.object_id AND object.space_id=item.space_id WHERE item.space_id=$1 AND item.object_id=$2 FOR SHARE OF item,object",
    note: "SELECT note.object_id FROM notes note JOIN space_objects object ON object.id=note.object_id AND object.space_id=note.space_id WHERE note.space_id=$1 AND note.object_id=$2 FOR SHARE OF note,object",
    source: "SELECT source.object_id FROM sources source JOIN space_objects object ON object.id=source.object_id AND object.space_id=source.space_id WHERE source.space_id=$1 AND source.object_id=$2 FOR SHARE OF source,object",
    claim: "SELECT claim.object_id FROM claims claim JOIN space_objects object ON object.id=claim.object_id AND object.space_id=claim.space_id WHERE claim.space_id=$1 AND claim.object_id=$2 FOR SHARE OF claim,object",
    memory_entry: "SELECT id FROM memory_entries WHERE space_id=$1 AND id=$2 FOR SHARE",
    project_public_summary: "SELECT summary.project_id FROM project_public_summary_publications summary JOIN projects project ON project.id=summary.project_id AND project.space_id=summary.space_id WHERE summary.space_id=$1 AND summary.project_id=$2 FOR SHARE OF summary,project",
    source_item: "SELECT id FROM source_items WHERE space_id=$1 AND id=$2 FOR SHARE",
    extracted_evidence: "SELECT id FROM extracted_evidence WHERE space_id=$1 AND id=$2 FOR SHARE",
    inquiry_thread: "SELECT thread.object_id FROM inquiry_threads thread JOIN projects project ON project.id=thread.project_id AND project.space_id=thread.space_id WHERE thread.space_id=$1 AND thread.object_id=$2 FOR SHARE OF thread",
  };
  const sql = queries[objectType];
  if (!sql) throw new HttpError(409, `Invocation Delivery retrieval source type '${objectType}' cannot be locked`);
  // The Project row this join locks must be one the gate took before its Run.
  if (objectType === "project_public_summary") assertProjectHeld(db, objectId);
  // A Thread's Project row is locked by `authorizeReferencedProject` (held check), not here.
  const result = await db.query(sql, [spaceId, objectId]);
  if (!result.rows[0]) throw new HttpError(409, "Invocation Delivery retrieval source no longer exists");
  if (objectType === "inquiry_thread") {
    // Pins the viewer's membership row for the rest of the transaction, so a
    // concurrent removal cannot land between this check and the read it
    // authorises. The join is inner on purpose: PostgreSQL rejects `FOR SHARE`
    // on the nullable side of an outer join, and a non-member has no row to
    // pin anyway — an outer join could only ever have produced a NULL that
    // locks nothing. Zero rows is therefore the correct, unremarkable result
    // for a non-member. Do not assert about the result.
    await db.query(
      `SELECT member.user_id FROM inquiry_threads thread
        JOIN project_members member ON member.space_id=thread.space_id AND member.project_id=thread.project_id
          AND member.user_id=$3 AND member.status='active'
       WHERE thread.space_id=$1 AND thread.object_id=$2 FOR SHARE OF member`,
      [spaceId, objectId, viewerUserId],
    );
  }
}

/** The items a gate checks: Delivery sends only what the window accepted; a preview shows every item. */
function gatedItems(envelope: RuntimeContextEnvelope, mode: "delivery" | "preview"): ContextItem[] {
  if (mode === "preview") return envelope.items;
  const decisions = new Map(envelope.window_plan.decisions.map((decision) => [decision.item_id, decision.decision]));
  return envelope.items.filter((item) => decisions.get(item.id) !== "blocked");
}

const ENVELOPE_RUN_COLUMNS = "run.project_id,run.session_id,run.agent_id,run.runtime_key,run.model_override_json,run.prompt,run.instruction,run.contract_snapshot_json,run.root_run_id";

/** The Room of a `room_recipient` Work Context scope, read without locks (a scope's member and its Room never change). */
async function recipientRooms(db: Queryable, spaceId: string, control: ExecutionControlSnapshot): Promise<string[]> {
  if (!control.work_context_scope_id) return [];
  return (await db.query<{ room_id: string }>(
    `SELECT recipient.room_id FROM room_conversation_recipients scope
       JOIN room_agent_members recipient ON recipient.id=scope.room_agent_member_id AND recipient.space_id=scope.space_id
      WHERE scope.id=$1 AND scope.space_id=$2`,
    [control.work_context_scope_id, spaceId],
  )).rows.map((row) => row.room_id);
}

/** A Run's conversation Room — its Agent group's, else its session's — read without locks. */
async function envelopeRunRoom(db: Queryable, spaceId: string, runId: string): Promise<string | null> {
  const row = (await db.query<{ room_id: string | null }>(
    `SELECT COALESCE(grp.room_id, session.room_id) AS room_id
       FROM runs run
       LEFT JOIN agent_run_groups grp ON grp.id=run.run_group_id AND grp.space_id=run.space_id
       LEFT JOIN sessions session ON session.id=run.session_id AND session.space_id=run.space_id
      WHERE run.id=$1 AND run.space_id=$2`,
    [runId, spaceId],
  )).rows[0];
  return row?.room_id ?? null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function chatTurnMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const chatTurn = (value as Record<string, unknown>).chat_turn;
  if (!chatTurn || typeof chatTurn !== "object" || Array.isArray(chatTurn)) return null;
  const record = chatTurn as Record<string, unknown>;
  return record.schema_version === "chat_turn.v1"
    ? stringOrNull(record.user_message_id)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function messageRefs(item: ContextItem): string[] {
  const refs = item.payload.message_refs;
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const ref = value as Record<string, unknown>;
    return ref.type === "message" && typeof ref.id === "string" ? [ref.id] : [];
  });
}

function stableStringArray(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function createProductionRuntimeContextInvocationGateway(
  db: Pool,
  config?: ServerConfig,
): RuntimeContextInvocationGateway {
  const continuity = new RuntimeContextContinuityService(db);
  return new RuntimeContextInvocationGateway(
    createProductionRuntimeContextPlanningService(db, config),
    new InvocationSnapshotService(
      db,
      undefined,
      new PgInvocationDeliveryAuthorizer(config),
      continuity,
    ),
    new PgExecutionControlLoader(db),
    continuity,
  );
}

import { selectedSkillInstruction } from "../skills/selectedSkills.js";

/** Caller must hold a transaction through the Source writer/Delivery commit. */
export async function lockSourceConnectionAuthority(db:Queryable,spaceId:string,connectionId:string,viewerUserId:string){await new PgInvocationDeliveryAuthorizer().lockSourceConnectionAuthority(db,spaceId,connectionId,viewerUserId);}

/** One content object's read authority for a viewer, FOR SHARE and in Delivery order: the Space, the viewer's grant, the root, its Project scope, shares and Folder. Refuses (404/409) when the viewer no longer reads it. */
export async function lockContentReadAuthority(db:Queryable,spaceId:string,resourceType:string,resourceId:string,viewerUserId:string){await new PgInvocationDeliveryAuthorizer().lockContentAclDependencies(db,spaceId,resourceType,resourceId,viewerUserId);}

export async function lockReadingRunAuthority(db:Queryable,run:import('../runs/repository.js').RunRecord){await new PgInvocationDeliveryAuthorizer().lockReadingRunAuthority(db,run);}

export async function lockSourceReadingReferences(db:Queryable,spaceId:string,refs:readonly {item_id:string;artifact_id:string}[],userId:string,targetItemId?:string){await new PgInvocationDeliveryAuthorizer().lockSourceReadingReferences(db,spaceId,refs,userId,targetItemId);}

export async function lockBriefingGenerationAuthority(db:Queryable,run:import('../informationDigest/briefing/settlement.js').BriefingDispatchRun){await new PgInvocationDeliveryAuthorizer().lockBriefingGenerationAuthority(db,run);}
