import type {
  ConversationAttachmentMutation,
  ConversationAttachmentMutationResponse,
  ConversationExecutionHostSummary,
  ConversationExecutionInitializeRequest,
  ConversationExecutionPreflightRequest,
  ConversationExecutionPreflightResponse,
  ConversationExecutionRuntimeProfile,
  ConversationExecutionSummary,
  ConversationExecutionSelection,
  ConversationPrimarySelection,
  ConversationRuntimeSelection,
  ConversationRuntimeChoice,
} from "@rainver/protocol";
import type { Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { PgHostRepository } from "../hosts/repository.js";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
import { PgHostThreadRepository } from "../hosts/threadRepository.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { PgAgentRepository } from "../agents/repository.js";
import { PgConversationRuntimeSessionRepository } from "./conversationRuntimeSessionRepository.js";
import { PgSessionRepository } from "./repository.js";
import {
  attachmentSummary,
  hostIsOnline,
  hostSummary,
  PgConversationExecutionContextRepository,
  primarySummary,
  type ExecutionContextRow,
  type ExecutionHostRow,
  type ExecutionLocationRow,
  type ExecutionSessionRow,
  type RuntimeProfileRow,
} from "./executionContextRepository.js";

export interface ConversationExecutionContextIdentity extends SpaceUserIdentity {}

export class ConversationExecutionContextError extends HttpError {
  constructor(statusCode: number, message: string) {
    super(statusCode, message);
    this.name = "ConversationExecutionContextError";
  }
}

export class ConversationExecutionContextService {
  constructor(private readonly pool: Pool) {}

  async preflight(
    identity: ConversationExecutionContextIdentity,
    sessionId: string,
    request: ConversationExecutionPreflightRequest = { selection: null, runtime: null },
  ): Promise<ConversationExecutionPreflightResponse> {
    const repository = new PgConversationExecutionContextRepository(this.pool);
    const session = await repository.getVisibleSession(identity, sessionId);
    if (!session) throw new ConversationExecutionContextError(404, "Conversation not found");
    await new PgHostRepository(this.pool).ensureServerHostId();
    const context = await repository.ensureDraft(session);
    return this.buildPreflight(repository, identity, session, context, request);
  }

  async initialize(
    identity: ConversationExecutionContextIdentity,
    sessionId: string,
    request: ConversationExecutionInitializeRequest,
  ): Promise<ConversationExecutionSummary> {
    return withTransaction(this.pool, async (client) => {
      await new PgConversationRuntimeSessionRepository(client).lockConversation(
        identity.spaceId,
        sessionId,
      );
      const repository = new PgConversationExecutionContextRepository(client);
      const session = await repository.getVisibleSession(identity, sessionId, { forUpdate: true });
      if (!session) throw new ConversationExecutionContextError(404, "Conversation not found");
      await new PgHostRepository(client).ensureServerHostId();
      const context = await repository.lockDraft(session);
      const requestedRuntimes = requestedRuntimeSelections(request);
      if (context.state === "initialized") {
        await this.assertImmutableSelection(repository, session, context, request.selection, request.runtime);
        const participantAgentIds = await repository.listConversationParticipantAgentIds(session);
        for (const runtime of requestedRuntimes) {
          if (!participantAgentIds.includes(runtime.agent_id)) {
            throw new ConversationExecutionContextError(403, "The selected Agent is not a participant in this Conversation");
          }
        }
        // Runtime pins are immutable per Conversation × Agent, but each
        // participating Agent may be explicitly initialized after the
        // Conversation itself has been initialized. This keeps multi-Agent
        // Room dispatch deterministic without guessing a CLI profile.
        const host = await this.requireHost(repository, identity.userId, context.execution_host_id!);
        this.assertHostUsable(host);
        const primary = {
          kind: context.primary_workspace_mode!,
          projectFolderId: context.primary_project_folder_id,
          locationId: context.primary_workspace_location_id,
        } as { kind: "managed" | "location"; projectFolderId: string | null; locationId: string | null };
        for (const runtime of requestedRuntimes) {
          const existingBinding = await repository.getBinding(identity.spaceId, session.id, runtime.agent_id);
          if (existingBinding) {
            const existingThread = await repository.getConversationThread(identity.spaceId, session.id, runtime.agent_id);
            if ((runtime.runtime_profile_id !== null && existingBinding.runtime_profile_id !== runtime.runtime_profile_id)
              || existingBinding.credential_profile_id !== runtime.credential_profile_id
              || existingThread?.adapter_type !== runtime.adapter_type
              || existingThread?.runtime_installation !== runtime.runtime_installation) {
              throw new ConversationExecutionContextError(409, "CLI runtime is fixed for this Conversation Agent; start a new Conversation to change it");
            }
            continue;
          }
          const selectedProfile = await this.resolveRuntime(repository, client, session, host, primary, runtime, identity.userId);
          await repository.bindRuntime({
            spaceId: identity.spaceId,
            sessionId: session.id,
            userId: identity.userId,
            agentId: selectedProfile.agent_id,
            profileId: selectedProfile.id,
            credentialProfileId: runtime.credential_profile_id,
          });
          const thread = await new PgHostThreadRepository(client).getOrCreateForConversationAgent({
            executionHostId: host.id,
            workspaceMode: primary.kind,
            workspaceLocationId: primary.locationId,
            spaceId: identity.spaceId,
            sessionId: session.id,
            agentId: selectedProfile.agent_id,
            adapterType: selectedProfile.adapter_type,
            runtimeInstallation: selectedProfile.runtime_installation!,
            createdByUserId: identity.userId,
          });
          if (thread.execution_host_id !== host.id
            || thread.workspace_mode !== primary.kind
            || thread.workspace_location_id !== primary.locationId
            || thread.adapter_type !== selectedProfile.adapter_type
            || thread.runtime_installation !== selectedProfile.runtime_installation) {
            throw new ConversationExecutionContextError(409, "Conversation runtime continuity is already pinned to a different execution target");
          }
          const event = await new PgSessionRepository(client).addExecutionSystemEvent(
            identity.spaceId,
            identity.userId,
            session.id,
            {
              event: "execution_agent_runtime_initialized",
              eventKey: `execution_agent_runtime:${selectedProfile.agent_id}`,
              content: `Agent ${selectedProfile.agent_name} joined the Conversation runtime on ${host.name} with ${selectedProfile.adapter_type} (${selectedProfile.runtime_installation}).`,
              details: {
                execution_host_id: host.id,
                primary_workspace_mode: primary.kind,
                primary_project_folder_id: primary.projectFolderId,
                primary_workspace_location_id: primary.locationId,
                agent_id: selectedProfile.agent_id,
                runtime_profile_id: selectedProfile.id,
                adapter_type: selectedProfile.adapter_type,
                runtime_installation: selectedProfile.runtime_installation,
              },
            },
          );
          if (!event) {
            throw new ConversationExecutionContextError(409, "Conversation access changed before the Agent runtime could be recorded; retry");
          }
        }
        return this.buildSummary(repository, identity, session, context, request.runtime);
      }

      const host = await this.requireHost(repository, identity.userId, request.selection.execution_host_id);
      this.assertHostUsable(host);
      const primary = await this.validatePrimary(repository, session, host, request.selection.primary);
      const profile = await this.resolveRuntime(repository, client, session, host, primary, request.runtime, identity.userId);
      const participantAgentIds = await repository.listConversationParticipantAgentIds(session);
      for (const runtime of requestedRuntimes) {
        if (!participantAgentIds.includes(runtime.agent_id)) {
          throw new ConversationExecutionContextError(403, "The selected Agent is not a participant in this Conversation");
        }
      }
      const participantProfiles: RuntimeProfileRow[] = [];
      for (const agentId of participantAgentIds) {
        const selected = requestedRuntimes.find((runtime) => runtime.agent_id === agentId);
        if (selected) {
          participantProfiles.push(agentId === profile.agent_id
            ? profile
            : await this.resolveRuntime(repository, client, session, host, primary, selected, identity.userId));
          continue;
        }
        const candidates = (await repository.listRuntimeProfiles(identity.spaceId, agentId)).filter((candidate) =>
          candidate.execution_host_id === host.id
          && candidate.workspace_mode === primary.kind
          && (primary.kind !== "location" || candidate.workspace_location_id === primary.locationId)
          && hostInstallationAvailability(host, candidate.adapter_type, candidate.runtime_installation).usable,
        );
        if (candidates.length !== 1) {
          throw new ConversationExecutionContextError(
            409,
            `Agent '${agentId}' needs an explicit usable CLI runtime on the selected Host before this Conversation can start`,
          );
        }
        participantProfiles.push(candidates[0]!);
      }
      const initialized = await repository.initialize({
        spaceId: identity.spaceId,
        sessionId: session.id,
        hostId: host.id,
        primaryMode: primary.kind,
        projectFolderId: primary.projectFolderId,
        locationId: primary.locationId,
        userId: identity.userId,
      });
      const threads = new PgHostThreadRepository(client);
      for (const participant of participantProfiles) {
        const existingBinding = await repository.getBinding(identity.spaceId, session.id, participant.agent_id);
        if (existingBinding && (
          existingBinding.runtime_profile_id !== participant.id
          || existingBinding.credential_profile_id !== null
        )) {
          throw new ConversationExecutionContextError(409, "The Conversation Agent runtime is already initialized with a different CLI");
        }
        await repository.bindRuntime({
          spaceId: identity.spaceId,
          sessionId: session.id,
          userId: identity.userId,
          agentId: participant.agent_id,
          profileId: participant.id,
          credentialProfileId: null,
        });
        const thread = await threads.getOrCreateForConversationAgent({
          executionHostId: host.id,
          workspaceMode: primary.kind,
          workspaceLocationId: primary.locationId,
          spaceId: identity.spaceId,
          sessionId: session.id,
          agentId: participant.agent_id,
          adapterType: participant.adapter_type,
          runtimeInstallation: participant.runtime_installation!,
          createdByUserId: identity.userId,
        });
        if (thread.execution_host_id !== host.id
          || thread.workspace_mode !== primary.kind
          || thread.workspace_location_id !== primary.locationId
          || thread.adapter_type !== participant.adapter_type
          || thread.runtime_installation !== participant.runtime_installation) {
          throw new ConversationExecutionContextError(409, "Conversation runtime continuity is already pinned to a different execution target");
        }
      }
      const event = await new PgSessionRepository(client).addExecutionSystemEvent(
        identity.spaceId,
        identity.userId,
        session.id,
        {
          event: "execution_context_initialized",
          eventKey: initialized.id,
          content: `Conversation initialized on ${host.name} with ${participantProfiles.length} Agent runtime${participantProfiles.length === 1 ? "" : "s"}.`,
          details: {
            execution_host_id: host.id,
            primary_workspace_mode: primary.kind,
            primary_project_folder_id: primary.projectFolderId,
            primary_workspace_location_id: primary.locationId,
            agent_id: profile.agent_id,
            runtime_profile_id: profile.id,
            adapter_type: profile.adapter_type,
            runtime_installation: profile.runtime_installation,
            agents: participantProfiles.map((participant) => ({
              agent_id: participant.agent_id,
              runtime_profile_id: participant.id,
              adapter_type: participant.adapter_type,
              runtime_installation: participant.runtime_installation,
            })),
          },
        },
      );
      if (!event) {
        throw new ConversationExecutionContextError(409, "Conversation access changed before initialization could be recorded; retry");
      }
      return this.buildSummary(repository, identity, session, initialized, request.runtime);
    });
  }

  async mutateAttachment(
    identity: ConversationExecutionContextIdentity,
    sessionId: string,
    mutation: ConversationAttachmentMutation,
  ): Promise<ConversationAttachmentMutationResponse> {
    return withTransaction(this.pool, async (client) => {
      // Attachment state is read into every subsequent Run under the same
      // Conversation advisory lock. Taking the lock before the row lock
      // prevents a grant/revoke from committing between dispatch admission
      // and the launch snapshot that dispatch persists.
      await new PgConversationRuntimeSessionRepository(client).lockConversation(
        identity.spaceId,
        sessionId,
      );
      const repository = new PgConversationExecutionContextRepository(client);
      const session = await repository.getVisibleSession(identity, sessionId, { forUpdate: true });
      if (!session) throw new ConversationExecutionContextError(404, "Conversation not found");
      if (session.project_id) await assertProjectWriter(client, identity.spaceId, session.project_id, identity.userId);
      const context = await repository.lockDraft(session);
      if (context.state !== "initialized" || !context.execution_host_id) {
        throw new ConversationExecutionContextError(409, "Initialize the Conversation before changing Folder access");
      }
      const effectiveAfterRunId = await repository.latestRunId(identity.spaceId, session.id);
      const sessionRepository = new PgSessionRepository(client);
      const mutationEventKey = `execution_attachment:${mutation.mutation_id}`;
      const replay = await sessionRepository.findExecutionSystemEvent(
        identity.spaceId,
        identity.userId,
        session.id,
        mutationEventKey,
      );
      if (replay) {
        const existing = await repository.getAttachment(identity.spaceId, session.id, replay.attachment_id);
        if (!existing) {
          throw new ConversationExecutionContextError(409, "The previous Folder access change is no longer available; retry");
        }
        return {
          attachment: attachmentSummary(existing),
          effective_after_run_id: replay.effective_after_run_id,
        };
      }
      if (mutation.action !== "revoke" && mutation.access_mode === "write") {
        const host = await this.requireHost(repository, identity.userId, context.execution_host_id);
        if (host.kind === "server") {
          throw new ConversationExecutionContextError(
            422,
            "Server-host Folder attachments are read-only; use a trusted remote Host for direct attached-Folder writes",
          );
        }
      }
      let attachment;
      let event: string;
      let eventKey: string;
      if (mutation.action === "attach") {
        const location = (await repository.listProjectLocations(identity.spaceId, session.project_id))
          .find((candidate) => candidate.project_folder_id === mutation.project_folder_id
            && candidate.id === mutation.workspace_location_id
            && candidate.status === "active");
        if (!location) {
          throw new ConversationExecutionContextError(404, "Project Folder Location not found");
        }
        if (!locationIsOnline(location) || location.execution_ready !== true) {
          throw new ConversationExecutionContextError(409, "The attached Workspace Location is not ready");
        }
        if (location.execution_host_id !== context.execution_host_id) {
          throw new ConversationExecutionContextError(409, "Attached Folders must use the Conversation's execution Host");
        }
        if (context.primary_workspace_location_id === location.id) {
          throw new ConversationExecutionContextError(409, "The Primary Workspace is already part of this Conversation");
        }
        const existing = (await repository.listAttachments(identity.spaceId, session.id))
          .find((row) => row.status === "active" && row.project_folder_id === mutation.project_folder_id);
        if (existing) throw new ConversationExecutionContextError(409, "This Folder is already attached to the Conversation");
        try {
          attachment = await repository.insertAttachment({
            spaceId: identity.spaceId,
            sessionId: session.id,
            projectFolderId: mutation.project_folder_id,
            locationId: mutation.workspace_location_id,
            accessMode: mutation.access_mode,
            userId: identity.userId,
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw new ConversationExecutionContextError(409, "This Folder is already attached to the Conversation");
          throw error;
        }
        event = "execution_attachment_granted";
        eventKey = mutationEventKey;
      } else if (mutation.action === "set_access") {
        attachment = await repository.setAttachmentAccess(identity.spaceId, session.id, mutation.attachment_id, mutation.access_mode);
        if (!attachment) throw new ConversationExecutionContextError(404, "Active Conversation attachment not found");
        event = "execution_attachment_access_changed";
        eventKey = mutationEventKey;
      } else {
        attachment = await repository.revokeAttachment(identity.spaceId, session.id, mutation.attachment_id, identity.userId);
        if (!attachment) throw new ConversationExecutionContextError(404, "Active Conversation attachment not found");
        event = "execution_attachment_revoked";
        eventKey = mutationEventKey;
      }
      const eventMessage = await sessionRepository.addExecutionSystemEvent(
        identity.spaceId,
        identity.userId,
        session.id,
        {
          event,
          eventKey,
          content: event === "execution_attachment_revoked"
            ? "Conversation Folder access revoked for later Runs."
            : event === "execution_attachment_access_changed"
              ? `Conversation Folder access changed to ${attachment.access_mode} for later Runs.`
              : `Folder attached to the Conversation with ${attachment.access_mode} access for later Runs.`,
          details: {
            attachment_id: attachment.id,
            project_folder_id: attachment.project_folder_id,
            workspace_location_id: attachment.workspace_location_id,
            access_mode: attachment.access_mode,
            status: attachment.status,
            effective_after_run_id: effectiveAfterRunId,
            mutation_id: mutation.mutation_id,
          },
        },
      );
      if (!eventMessage) {
        throw new ConversationExecutionContextError(409, "Conversation access changed before the Folder access change could be recorded; retry");
      }
      return { attachment: attachmentSummary(attachment), effective_after_run_id: effectiveAfterRunId };
    });
  }

  private async buildPreflight(
    repository: PgConversationExecutionContextRepository,
    identity: ConversationExecutionContextIdentity,
    session: ExecutionSessionRow,
    context: ExecutionContextRow,
    request: ConversationExecutionPreflightRequest,
  ): Promise<ConversationExecutionPreflightResponse> {
    const hosts = await repository.listHosts(identity.userId);
    const locations = (await repository.listProjectLocations(identity.spaceId, session.project_id))
      .filter((location) => !location.host_owner_user_id || location.host_owner_user_id === identity.userId);
    const activeLocations = locations.filter((location) => location.status === "active");
    const participantAgents = await repository.listConversationParticipantAgents(session);
    const participantAgentIds = participantAgents.map((agent) => agent.agent_id);
    // Room membership determines who participates, while the canonical Agent
    // access predicate determines whose runtime metadata this user may see.
    // Keep the roster intact so an inaccessible participant blocks setup, but
    // never expose that Agent's private runtime profiles in preflight.
    const visibleParticipantAgentIds: string[] = [];
    for (const agentId of participantAgentIds) {
      if (await repository.canAgentParticipate(session, agentId, identity.userId)) {
        visibleParticipantAgentIds.push(agentId);
      }
    }
    const rawRuntimeProfiles = (await Promise.all(
      visibleParticipantAgentIds.map((agentId) => repository.listRuntimeProfiles(identity.spaceId, agentId)),
    )).flat();
    const availableRuntimeProfiles: ConversationExecutionRuntimeProfile[] = rawRuntimeProfiles.map((profile) => {
      const host = profile.execution_host_id
        ? hosts.find((candidate) => candidate.id === profile.execution_host_id) ?? null
        : null;
      const location = profile.workspace_location_id
        ? locations.find((candidate) => candidate.id === profile.workspace_location_id) ?? null
        : null;
      const availability = runtimeAvailability(profile, host, location, {
        allowStaleLocation: context.state === "initialized"
          && context.primary_workspace_location_id === location?.id,
      });
      return {
        agent_id: profile.agent_id,
        agent_name: profile.agent_name,
        runtime_profile_id: profile.id,
        adapter_type: profile.adapter_type,
        runtime_installation: profile.runtime_installation,
        execution_host_id: profile.execution_host_id,
        workspace_mode: profile.workspace_mode,
        workspace_location_id: profile.workspace_location_id,
        preferred: profile.is_default,
        usable: availability.usable,
        reason: availability.reason,
      } satisfies ConversationExecutionRuntimeProfile;
    });
    // A disabled reusable profile must not hide a still-valid installation
    // reported by the Host; initialization may materialize a fresh enabled one.
    const existingTargets = new Set(rawRuntimeProfiles.filter((profile) => profile.enabled).map(runtimeTargetKey));
    const hostTargets = await new PgWorkspaceLocationRepository(this.pool)
      .listHostExecutionTargets(identity.spaceId, session.project_id, identity.userId);
    for (const participant of participantAgents) {
      if (!visibleParticipantAgentIds.includes(participant.agent_id)) continue;
      for (const target of hostTargets) {
        for (const adapter of target.adapters) {
          for (const installation of adapter.installations) {
            const workspaceChoices = [
              ...(target.managed_workspace_available
                ? [{ mode: "managed" as const, locationId: null, ready: true }]
                : []),
              ...target.locations.map((location) => ({
                mode: "location" as const,
                locationId: location.id,
                ready: location.execution_ready,
              })),
            ];
            for (const workspace of workspaceChoices) {
              const candidateKey = runtimeTargetKey({
                agent_id: participant.agent_id,
                execution_host_id: target.host_id,
                workspace_mode: workspace.mode,
                workspace_location_id: workspace.locationId,
                adapter_type: adapter.adapter_type,
                runtime_installation: installation.id,
              });
              if (existingTargets.has(candidateKey)) continue;
              const usable = target.host_online && workspace.ready && installation.logged_in !== false;
              availableRuntimeProfiles.push({
                agent_id: participant.agent_id,
                agent_name: participant.agent_name,
                runtime_profile_id: null,
                adapter_type: adapter.adapter_type,
                runtime_installation: installation.id,
                execution_host_id: target.host_id,
                workspace_mode: workspace.mode,
                workspace_location_id: workspace.locationId,
                preferred: false,
                usable,
                reason: !target.host_online
                  ? "The execution Host is offline"
                  : !workspace.ready
                    ? "The Workspace Location is not ready"
                    : installation.logged_in === false
                      ? "The CLI installation is not logged in"
                      : null,
              });
            }
          }
        }
      }
    }
    const agentId = request.runtime?.agent_id ?? await repository.resolveConversationAgent(identity.spaceId, session.id, session.project_id);
    const usableRuntimeCandidates = availableRuntimeProfiles.filter((candidate) =>
      candidate.agent_id === agentId && candidate.usable);
    const preferredRuntimeCandidates = usableRuntimeCandidates.filter((candidate) => candidate.preferred);
    const persistedRuntimeCandidates = usableRuntimeCandidates.filter((candidate) => candidate.runtime_profile_id !== null);
    const suggestedRuntimeCandidate = preferredRuntimeCandidates.length === 1
      ? preferredRuntimeCandidates[0]!
      : persistedRuntimeCandidates.length === 1
        ? persistedRuntimeCandidates[0]!
      : usableRuntimeCandidates.length === 1
        ? usableRuntimeCandidates[0]!
        : null;
    const runtime = context.state === "initialized"
      ? await this.runtimeForInitialized(repository, identity, session, context)
      : request.runtime ?? (suggestedRuntimeCandidate ? runtimeChoice(suggestedRuntimeCandidate) : null);
    const runtimes = context.state === "initialized"
      ? await this.runtimesForInitialized(repository, identity, session)
      : [];
    const initializedBindings = context.state === "initialized"
      ? await repository.listBindings(identity.spaceId, session.id)
      : [];
    const initializedRuntimeAvailability = context.state === "initialized"
      ? await Promise.all(initializedBindings.map(async (binding) => {
          const agentName = participantAgents.find((agent) => agent.agent_id === binding.agent_id)?.agent_name
            ?? "Unknown Agent";
          if (!visibleParticipantAgentIds.includes(binding.agent_id)) {
            return { agentName, usable: false, reason: "The pinned Agent is no longer accessible in this Conversation" };
          }
          // Candidate profiles answer a different question: what may be
          // selected for a new Conversation right now. Continuity for an
          // initialized Conversation is persisted separately and must be
          // restored from its binding + Host thread. In particular, a server
          // or daemon restart must not turn a temporary catalog miss into a
          // claim that the pinned runtime disappeared.
          const profile = await repository.getRuntimeProfile(
            identity.spaceId,
            binding.agent_id,
            binding.runtime_profile_id,
          );
          const thread = await repository.getConversationThread(identity.spaceId, session.id, binding.agent_id);
          if (!profile || !thread) {
            return { agentName, usable: false, reason: "The persisted runtime binding or Host thread is missing" };
          }
          const stillPinned = thread.execution_host_id === context.execution_host_id
            && thread.workspace_mode === context.primary_workspace_mode
            && thread.workspace_location_id === context.primary_workspace_location_id
            && profile.execution_host_id === thread.execution_host_id
            && profile.workspace_mode === thread.workspace_mode
            && profile.workspace_location_id === thread.workspace_location_id
            && profile.adapter_type === thread.adapter_type
            && profile.runtime_installation === thread.runtime_installation;
          const pinnedHost = hosts.find((host) => host.id === thread.execution_host_id) ?? null;
          const pinnedLocation = thread.workspace_location_id
            ? locations.find((location) => location.id === thread.workspace_location_id) ?? null
            : null;
          const availability = runtimeAvailability(profile, pinnedHost, pinnedLocation, {
            allowStaleLocation: context.primary_workspace_location_id === pinnedLocation?.id,
          });
          return stillPinned
            ? { agentName, usable: availability.usable, reason: availability.reason }
            : { agentName, usable: false, reason: "The runtime profile no longer matches the pinned Host, CLI, or Primary Workspace" };
        }))
      : [];
    const executableLocations = activeLocations.filter((location) => location.execution_ready && locationIsOnline(location));
    const requestedPrimary = context.state === "initialized" ? primarySelection(context) : request.selection?.primary ?? null;
    const suggestedPrimary = suggestedRuntimeCandidate?.workspace_mode === "location" && suggestedRuntimeCandidate.workspace_location_id
      ? { kind: "location" as const, workspace_location_id: suggestedRuntimeCandidate.workspace_location_id }
      : suggestedRuntimeCandidate?.workspace_mode === "managed"
        ? { kind: "managed" as const }
        : null;
    const defaultPrimary = requestedPrimary ?? suggestedPrimary ?? (executableLocations.length === 1
      ? { kind: "location" as const, workspace_location_id: executableLocations[0]!.id }
      : executableLocations.length === 0
        ? { kind: "managed" as const }
        : null);
    const selectedHostId = context.state === "initialized"
      ? context.execution_host_id
      : request.selection?.execution_host_id
        ?? (suggestedRuntimeCandidate ? suggestedRuntimeCandidate.execution_host_id
          : executableLocations.length === 1 ? executableLocations[0]!.execution_host_id
            : hosts.filter((candidate) => hostIsOnline(candidate)).length === 1 ? hosts.find((candidate) => hostIsOnline(candidate))?.id ?? null
              : null);
    const host = hosts.find((candidate) => candidate.id === selectedHostId) ?? null;
    const primaryLocation = defaultPrimary?.kind === "location"
      ? locations.find((location) => location.id === defaultPrimary.workspace_location_id) ?? null
      : null;
    const primary = context.state === "initialized"
      ? primarySummary(context, primaryLocation, session.id)
      : defaultPrimary === null
        ? null
        : primaryLocation
        ? { kind: "location" as const, project_folder_id: primaryLocation.project_folder_id, workspace_location_id: primaryLocation.id, display_path: primaryLocation.display_path }
        : { kind: "managed" as const, managed_workspace_id: session.id, display_path: null };
    const summary = this.summaryFromParts(context, session.id, host ? hostSummary(host, session.id) : null, pinnedRuntimeChoice(runtime), primary, await repository.listAttachments(identity.spaceId, session.id), runtimes);
    const blockedReason = context.state === "initialized"
      ? initializedBlockReason(summary, initializedRuntimeAvailability)
      : draftBlockReason(host, defaultPrimary, primaryLocation, runtime, hosts, executableLocations, usableRuntimeCandidates);
    return {
      summary: { ...summary, can_send: blockedReason === null, blocked_reason: blockedReason },
      available_hosts: hosts.map((candidate) => hostSummary(candidate, session.id)),
      available_runtime_profiles: availableRuntimeProfiles,
      available_primary_locations: activeLocations.map((location) => ({
        workspace_location_id: location.id,
        project_folder_id: location.project_folder_id,
        folder_name: location.folder_name,
        execution_host_id: location.execution_host_id,
        display_path: location.display_path,
        execution_ready: location.execution_ready,
      })),
    };
  }

  private async buildSummary(
    repository: PgConversationExecutionContextRepository,
    identity: ConversationExecutionContextIdentity,
    session: ExecutionSessionRow,
    context: ExecutionContextRow,
    requestedRuntime?: ConversationRuntimeChoice | null,
  ): Promise<ConversationExecutionSummary> {
    const hosts = await repository.listHosts(identity.userId);
    const host = context.execution_host_id ? hosts.find((candidate) => candidate.id === context.execution_host_id) ?? null : null;
    const location = context.primary_workspace_location_id && context.primary_project_folder_id
      ? await repository.getLocation(identity.spaceId, context.primary_project_folder_id, context.primary_workspace_location_id)
      : null;
    const runtime = context.state === "initialized"
      ? await this.runtimeForInitialized(repository, identity, session, context, requestedRuntime)
      : requestedRuntime ?? null;
    const runtimes = context.state === "initialized"
      ? await this.runtimesForInitialized(repository, identity, session)
      : [];
    return this.summaryFromParts(context, session.id, host ? hostSummary(host, session.id) : null, pinnedRuntimeChoice(runtime), primarySummary(context, location, session.id), await repository.listAttachments(identity.spaceId, session.id), runtimes);
  }

  private summaryFromParts(
    context: ExecutionContextRow,
    sessionId: string,
    host: ConversationExecutionHostSummary | null,
    runtime: ConversationRuntimeSelection | null,
    primary: ConversationExecutionSummary["primary"],
    attachments: ReturnType<typeof attachmentSummary>[],
    runtimes: ConversationRuntimeSelection[] = runtime ? [runtime] : [],
  ): ConversationExecutionSummary {
    return {
      session_id: sessionId,
      state: context.state,
      host,
      runtime,
      runtimes,
      primary,
      attachments,
      dispatch_locked: Boolean(context.dispatch_lock_id),
      queue_paused_at: context.queue_paused_at,
      can_send: false,
      blocked_reason: null,
    };
  }

  private async runtimeForInitialized(
    repository: PgConversationExecutionContextRepository,
    identity: ConversationExecutionContextIdentity,
    session: ExecutionSessionRow,
    _context: ExecutionContextRow,
    requested?: ConversationRuntimeChoice | null,
  ): Promise<ConversationRuntimeSelection | null> {
    const agentId = requested?.agent_id ?? await repository.resolveConversationAgent(identity.spaceId, session.id, session.project_id);
    if (!agentId) return null;
    if (!await repository.canAgentParticipate(session, agentId, identity.userId)) return null;
    const binding = await repository.getBinding(identity.spaceId, session.id, agentId);
    const thread = await repository.getConversationThread(identity.spaceId, session.id, agentId);
    if (!binding || !thread) return null;
    return {
      agent_id: agentId,
      runtime_profile_id: binding.runtime_profile_id,
      credential_profile_id: binding.credential_profile_id,
      adapter_type: thread.adapter_type,
      runtime_installation: thread.runtime_installation,
    };
  }

  private async runtimesForInitialized(
    repository: PgConversationExecutionContextRepository,
    identity: ConversationExecutionContextIdentity,
    session: ExecutionSessionRow,
  ): Promise<ConversationRuntimeSelection[]> {
    const bindings = await repository.listBindings(identity.spaceId, session.id);
    const runtimes: ConversationRuntimeSelection[] = [];
    for (const binding of bindings) {
      if (!await repository.canAgentParticipate(session, binding.agent_id, identity.userId)) continue;
      const thread = await repository.getConversationThread(identity.spaceId, session.id, binding.agent_id);
      if (!thread) continue;
      runtimes.push({
        agent_id: binding.agent_id,
        runtime_profile_id: binding.runtime_profile_id,
        credential_profile_id: binding.credential_profile_id,
        adapter_type: thread.adapter_type,
        runtime_installation: thread.runtime_installation,
      });
    }
    return runtimes;
  }

  private async assertImmutableSelection(
    repository: PgConversationExecutionContextRepository,
    session: ExecutionSessionRow,
    context: ExecutionContextRow,
    selection: ConversationExecutionSelection,
    runtime: ConversationRuntimeChoice,
  ): Promise<void> {
    if (context.execution_host_id !== selection.execution_host_id
      || context.primary_workspace_mode !== selection.primary.kind
      || (selection.primary.kind === "location"
        && (context.primary_workspace_location_id !== selection.primary.workspace_location_id))) {
      throw new ConversationExecutionContextError(409, "Host and Primary Workspace are fixed for this Conversation; start a new Conversation to change them");
    }
    const binding = await repository.getBinding(session.space_id, session.id, runtime.agent_id);
    const thread = binding
      ? await repository.getConversationThread(session.space_id, session.id, runtime.agent_id)
      : null;
    if (binding && ((runtime.runtime_profile_id !== null && binding.runtime_profile_id !== runtime.runtime_profile_id)
      || binding.credential_profile_id !== runtime.credential_profile_id
      || thread?.adapter_type !== runtime.adapter_type
      || thread?.runtime_installation !== runtime.runtime_installation)) {
      throw new ConversationExecutionContextError(409, "CLI runtime is fixed for this Conversation Agent; start a new Conversation to change it");
    }
  }

  private async requireHost(repository: PgConversationExecutionContextRepository, userId: string, hostId: string): Promise<ExecutionHostRow> {
    const host = (await repository.listHosts(userId)).find((candidate) => candidate.id === hostId);
    if (!host) throw new ConversationExecutionContextError(404, "Execution Host not found");
    return host;
  }

  private assertHostUsable(host: ExecutionHostRow): void {
    if (!hostIsOnline(host)) throw new ConversationExecutionContextError(503, "Execution Host is offline; reconnect it before initializing");
    if (host.owner_user_id) return;
  }

  private async validatePrimary(
    repository: PgConversationExecutionContextRepository,
    session: ExecutionSessionRow,
    host: ExecutionHostRow,
    primary: ConversationPrimarySelection,
  ): Promise<{ kind: "managed" | "location"; projectFolderId: string | null; locationId: string | null }> {
    if (primary.kind === "managed") return { kind: "managed", projectFolderId: null, locationId: null };
    const location = (await repository.listProjectLocations(session.space_id, session.project_id))
      .find((candidate) => candidate.id === primary.workspace_location_id && candidate.status === "active");
    if (!location || location.execution_host_id !== host.id || location.execution_ready !== true || !locationIsOnline(location)) {
      throw new ConversationExecutionContextError(409, "Primary Workspace Location is unavailable or belongs to another Host");
    }
    if (!session.project_id || location.project_folder_id === null) throw new ConversationExecutionContextError(422, "A Location Primary requires a Project Folder");
    return { kind: "location", projectFolderId: location.project_folder_id, locationId: location.id };
  }

  private async resolveRuntime(
    repository: PgConversationExecutionContextRepository,
    db: Queryable,
    session: ExecutionSessionRow,
    host: ExecutionHostRow,
    primary: { kind: "managed" | "location"; projectFolderId: string | null; locationId: string | null },
    runtime: ConversationRuntimeChoice,
    userId: string,
  ): Promise<RuntimeProfileRow> {
    if (runtime.credential_profile_id !== null) {
      throw new ConversationExecutionContextError(422, "Host-bound CLI runtimes use the selected Host installation and do not accept a server credential profile");
    }
    if (!await repository.canAgentParticipate(session, runtime.agent_id, userId)) {
      throw new ConversationExecutionContextError(403, "The selected Agent is not a participant in this Conversation");
    }
    let runtimeProfileId = runtime.runtime_profile_id;
    if (runtimeProfileId === null) {
      if (host.kind !== "remote") {
        throw new ConversationExecutionContextError(422, "The selected CLI requires a reusable runtime profile on the server Host");
      }
      const ensured = await new PgAgentRepository(this.pool).ensureHostRuntimeProfileInTransaction(db, {
        spaceId: session.space_id,
        agentId: runtime.agent_id,
        actorUserId: userId,
        executionHostId: host.id,
        workspaceLocationId: primary.locationId,
        workspaceMode: primary.kind,
        adapterType: runtime.adapter_type,
        runtimeInstallation: runtime.runtime_installation,
      });
      runtimeProfileId = ensured.id;
    }
    const profile = await repository.getRuntimeProfile(session.space_id, runtime.agent_id, runtimeProfileId);
    if (!profile || !profile.enabled || profile.execution_host_id !== host.id || profile.adapter_type !== runtime.adapter_type || profile.runtime_installation !== runtime.runtime_installation) {
      throw new ConversationExecutionContextError(409, "Selected CLI runtime is not available on the selected Host");
    }
    if (!profile.workspace_mode || (profile.workspace_mode === "location" && !profile.workspace_location_id)) {
      throw new ConversationExecutionContextError(409, "Selected runtime is not a host-bound conversation runtime");
    }
    const installation = hostInstallationAvailability(host, profile.adapter_type, profile.runtime_installation);
    if (!installation.usable) throw new ConversationExecutionContextError(409, installation.reason!);
    if (profile.workspace_mode !== primary.kind
      || (primary.kind === "location" && profile.workspace_location_id !== primary.locationId)) {
      throw new ConversationExecutionContextError(409, "Selected CLI runtime and Primary Workspace do not describe the same execution directory");
    }
    return profile;
  }
}

function runtimeChoice(candidate: ConversationExecutionRuntimeProfile): ConversationRuntimeChoice {
  if (!candidate.runtime_installation) {
    throw new ConversationExecutionContextError(409, "The selected CLI installation is unavailable");
  }
  return {
    agent_id: candidate.agent_id,
    runtime_profile_id: candidate.runtime_profile_id,
    credential_profile_id: null,
    adapter_type: candidate.adapter_type,
    runtime_installation: candidate.runtime_installation,
  };
}

function pinnedRuntimeChoice(choice: ConversationRuntimeChoice | null): ConversationRuntimeSelection | null {
  return choice?.runtime_profile_id
    ? { ...choice, runtime_profile_id: choice.runtime_profile_id }
    : null;
}

function runtimeTargetKey(target: Pick<
  RuntimeProfileRow,
  "agent_id" | "execution_host_id" | "workspace_mode" | "workspace_location_id" | "adapter_type" | "runtime_installation"
>): string {
  return [
    target.agent_id,
    target.execution_host_id ?? "",
    target.workspace_mode ?? "",
    target.workspace_location_id ?? "",
    target.adapter_type,
    target.runtime_installation ?? "",
  ].join("\u0000");
}

function requestedRuntimeSelections(request: ConversationExecutionInitializeRequest): ConversationRuntimeChoice[] {
  const selections = [request.runtime, ...(request.additional_runtimes ?? [])];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.agent_id)) {
      throw new ConversationExecutionContextError(422, "Each Conversation Agent may have only one selected CLI runtime");
    }
    seen.add(selection.agent_id);
  }
  return selections;
}

function primarySelection(context: ExecutionContextRow): ConversationPrimarySelection | null {
  if (context.primary_workspace_mode === "managed") return { kind: "managed" };
  return context.primary_workspace_location_id ? { kind: "location", workspace_location_id: context.primary_workspace_location_id } : null;
}

function draftBlockReason(
  host: ExecutionHostRow | null,
  primary: ConversationPrimarySelection | null,
  primaryLocation: ExecutionLocationRow | null,
  runtime: ConversationRuntimeChoice | null,
  hosts: ExecutionHostRow[],
  executableLocations: ExecutionLocationRow[],
  usableRuntimes: ConversationExecutionRuntimeProfile[],
): string | null {
  if (!host) return hosts.filter(hostIsOnline).length > 1 ? "Choose an execution Host" : "No usable execution Host is configured";
  if (!hostIsOnline(host)) return "Execution Host is offline; reconnect it before sending";
  if (!primary) return "Choose a Primary Folder or managed workspace";
  if (primary.kind === "location" && (!primaryLocation || !primaryLocation.execution_ready)) return "Choose a ready Primary Workspace Location";
  if (primaryLocation && primaryLocation.execution_host_id !== host.id) return "Primary Workspace and Host must be on the same execution Host";
  if (!runtime) return usableRuntimes.length > 1 ? "Choose a CLI installation" : "The selected Host reports no usable CLI installation";
  if (runtime.agent_id === "") return "Choose an Agent";
  const selectedRuntime = usableRuntimes.find((candidate) =>
    candidate.agent_id === runtime.agent_id
    && candidate.adapter_type === runtime.adapter_type
    && candidate.runtime_installation === runtime.runtime_installation
    && (runtime.runtime_profile_id === null || candidate.runtime_profile_id === runtime.runtime_profile_id));
  if (!selectedRuntime || selectedRuntime.adapter_type !== runtime.adapter_type || selectedRuntime.runtime_installation !== runtime.runtime_installation) {
    return "The selected CLI installation is unavailable";
  }
  if (selectedRuntime.execution_host_id !== host.id) return "CLI installation and Host must be on the same execution Host";
  if (selectedRuntime.workspace_mode !== primary.kind
    || (primary.kind === "location" && selectedRuntime.workspace_location_id !== primary.workspace_location_id)) {
    return "CLI installation and Primary Workspace must describe the same execution directory";
  }
  return null;
}

function initializedBlockReason(
  summary: ConversationExecutionSummary,
  boundRuntimes: Array<{ agentName: string; usable: boolean; reason: string | null }>,
): string | null {
  if (!summary.host) return "Execution Host is unavailable";
  if (!summary.host.online) return "Execution Host is offline; reconnect it before sending";
  if (!summary.runtime) return "The pinned CLI runtime is unavailable; start a new Conversation to change it";
  if (!summary.primary) return "The pinned Primary Workspace is unavailable";
  const unavailable = boundRuntimes.find((runtime) => !runtime.usable);
  if (unavailable) {
    return `Pinned CLI runtime for Agent '${unavailable.agentName}' is unavailable${unavailable.reason ? `: ${unavailable.reason}` : ""}`;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

function locationIsOnline(location: Pick<ExecutionLocationRow, "host_kind" | "host_status" | "last_heartbeat_at">): boolean {
  return hostIsOnline({
    kind: location.host_kind,
    status: location.host_status,
    last_heartbeat_at: location.last_heartbeat_at,
  });
}

function runtimeAvailability(
  profile: RuntimeProfileRow,
  host: ExecutionHostRow | null,
  location: ExecutionLocationRow | null,
  options: { allowStaleLocation?: boolean } = {},
): { usable: boolean; reason: string | null } {
  if (!profile.enabled) return { usable: false, reason: "The runtime profile is disabled" };
  if (!profile.execution_host_id || !profile.workspace_mode || !profile.runtime_installation) {
    return { usable: false, reason: "The runtime is not bound to an execution Host and workspace" };
  }
  if (!host) return { usable: false, reason: "The execution Host is unavailable" };
  // `listHosts(userId)` has already applied Host ownership visibility; this
  // helper only evaluates the current heartbeat/capability state.
  if (!hostIsOnline(host)) return { usable: false, reason: "The execution Host is offline" };
  const installation = hostInstallationAvailability(host, profile.adapter_type, profile.runtime_installation);
  if (!installation.usable) return installation;
  if (profile.workspace_mode === "location") {
    if (!location || location.execution_host_id !== host.id) {
      return { usable: false, reason: "The bound Workspace Location is unavailable" };
    }
    if (location.status !== "active" && !(options.allowStaleLocation && location.status === "stale")) {
      return { usable: false, reason: "The bound Workspace Location is unavailable" };
    }
    if (!location.execution_ready || !locationIsOnline(location)) {
      return { usable: false, reason: "The bound Workspace Location is not ready" };
    }
  }
  return { usable: true, reason: null };
}

function hostInstallationAvailability(
  host: ExecutionHostRow,
  adapterType: string,
  installationId: string | null,
): { usable: boolean; reason: string | null } {
  if (host.kind === "server") return { usable: true, reason: null };
  const installation = normalizeHostCapabilities(host.capabilities_json).installations[adapterType]
    ?.find((candidate) => candidate.id === installationId);
  if (!installation) return { usable: false, reason: "The CLI installation is unavailable on the Host" };
  if (installation.logged_in === false) return { usable: false, reason: "The CLI installation is not logged in" };
  return { usable: true, reason: null };
}
