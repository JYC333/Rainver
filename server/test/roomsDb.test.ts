import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RoomService } from "../src/modules/rooms/service.js";
import { PgFrontendSupportService } from "../src/modules/frontendSupport/service.js";
import { registerProposalDecisionExecutor } from "../src/modules/proposals/proposalDecisionExecutor.js";
import { registerProposalsProjectIntegration } from "../src/modules/proposals/projectIntegration.js";
import { ProjectAttentionService } from "../src/modules/projects/attentionService.js";
import type { SystemActionId } from "@rainver/protocol";
import type { SystemActionExecutor } from "../src/modules/systemActions/gateway.js";
import { seedConversationMessages } from "./support/domainSeeds.js";

import { registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService.js";
import { SpaceAssistantService } from "../src/modules/agents/spaceAssistantService.js";
import { PgRunRepository, type RunRecord } from "../src/modules/runs/repository.js";
import { runAssignedTask } from "../src/modules/runs/runAssignedTask.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { seedProjectMainlineRoom, seedRoomManager } from "./support/domainSeeds.js";
import { PgRoomRepository, type RoomAgentMemberRecord } from "../src/modules/rooms/repository.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { AgentGroupRunService } from "../src/modules/agentGroups/service.js";
import { AgentGroupRunLifecycleProjector } from "../src/modules/agentGroups/lifecycleProjector.js";
import { agentOriginContinuation, RoomDiscussionService } from "../src/modules/rooms/discussionService.js";
import { admitAgentOriginRun, continueHeldRuns, conversationQuota, enqueueWhenTurnFree, releaseHeldRuns } from "../src/modules/rooms/quotaGate.js";
import { conversationTurnTaken } from "../src/modules/sessions/conversationRuntimeSessionRepository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { registerResearchOperationFailureNotifyHandler, RESEARCH_OPERATION_FAILURE_NOTIFY_JOB } from "../src/modules/projectResearch/pipeline/researchOperationFailureNotifyJob.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { roomsModule } from "../src/modules/rooms/index.js";
import { providersModule } from "../src/modules/providers/index.js";
import { withDbTransaction } from "../src/modules/routeUtils/common.js";
import type { QuotaSource } from "../src/modules/rooms/subscriptionLogins.js";
import { registerAgentHandoffExecutors } from "../src/modules/agentGroups/sessionHandoff.js";
import { resolveAgentDelegationToolBinding, runAgentRoomToolCall } from "../src/modules/runs/managedAgentDelegationTools.js";
import {
  ROOM_DELEGATION_COMPLETION_RETRY_JOB,
  registerRoomDelegationCompletionRetryHandler,
} from "../src/modules/agentGroups/delegationCompletionRetryJob.js";
import { PgAgentGroupRepository } from "../src/modules/agentGroups/repository.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { ConversationExecutionContextService } from "../src/modules/sessions/executionContextService.js";
import { ConversationInputResourceService } from "../src/modules/sessions/conversationInputResourceService.js";
import { finalizeChatTurn } from "../src/modules/runs/chatTurnFinalizer.js";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins.js";
import {
  RoomConversationSummaryService,
  requestRoomConversationSummary,
  type RoomConversationSummaryDependencies,
} from "../src/modules/rooms/conversationSummaryService.js";
import {
  requestRoomConversationTitle,
  RoomConversationTitleService,
} from "../src/modules/rooms/conversationTitleService.js";

import {
  loadRoomContinuityForRunRequest,
  loadRoomConversationReplayThroughMessage,
} from "../src/modules/runtimeContext/conversationContinuity.js";
import { loadAuthorizedCurrentContextMessage } from "../src/modules/runtimeContext/productionAcquisition.js";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { ROOM_CONVERSATION_TOOL_ALLOWANCE } from "../src/modules/systemActions/scenarioToolAllowance.js";
import type { CredentialSpendBasis } from "../src/modules/policy/credentialSpend.js";

let service: RoomService | undefined;
let groupService: AgentGroupRunService | undefined;
let testRoot: string | undefined;
const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");



async function addRoomMember(roomId: string, userId: string): Promise<void> {
    await db.pool.query(
    `INSERT INTO room_user_members (
       id, space_id, room_id, user_id, role, status, created_at, updated_at
     ) VALUES ($1, 'space-1', $2, $3, 'member', 'active', now(), now())
     ON CONFLICT (room_id, user_id) DO UPDATE SET status = 'active'`,
    [randomUUID(), roomId, userId],
  );
}

async function removeManagedAssistant(): Promise<void> {
    await db.pool.query("UPDATE agents SET current_version_id = NULL WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'");
  await db.pool.query("DELETE FROM actors WHERE space_id = 'space-1' AND agent_id IN (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant')");
  await db.pool.query("DELETE FROM agent_runtime_profiles WHERE space_id = 'space-1' AND agent_id IN (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant')");
  await db.pool.query("DELETE FROM agent_versions WHERE space_id = 'space-1' AND agent_id IN (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant')");
  await db.pool.query("DELETE FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'");
}

const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeAll(async () => {
  if (!db.available) return;
  testRoot = await mkdtemp(join(tmpdir(), "rainver-room-db-"));
  service = new RoomService(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: testRoot,
  }), db.pool);
  groupService = new AgentGroupRunService(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: testRoot,
  }), db.pool);
}, 120_000);

afterAll(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await resetTables(
    db.pool,
    ["workspace_locations", "spaces", "users", "hosts", "machines"],
    { cascade: true },
  );
  await syncBuiltinPrompts(db.pool, CATALOG_ROOT);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES
       ('user-1', 'Room Owner', 'active', $1, $1, lower(gen_random_uuid()::text || '@test.invalid'), 'system'),
       ('user-2', 'Room Member', 'active', $1, $1, lower(gen_random_uuid()::text || '@test.invalid'), 'system'),
       ('user-3', 'Outside Member', 'active', $1, $1, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ('space-1', 'Room Space', 'team', 'user-1', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (
       id, space_id, user_id, role, status, created_at, updated_at
     ) VALUES
       ('membership-1', 'space-1', 'user-1', 'owner', 'active', $1, $1),
       ('membership-2', 'space-1', 'user-2', 'member', 'active', $1, $1),
       ('membership-3', 'space-1', 'user-3', 'member', 'active', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO credentials (
       id, space_id, owner_user_id, name, credential_type, secret_ref,
       scopes_json, metadata_json, created_at, updated_at
     ) VALUES ('provider-credential-1', 'space-1', 'user-1', 'Test API key',
       'api_key', 'test-secret-ref', '{}'::jsonb, '{}'::jsonb, $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, default_model,
       enabled, credential_id, capabilities_json, config_json, created_at, updated_at
     ) VALUES ('provider-1', 'space-1', 'user-1', 'Test API', 'openai',
       'test-model', true, 'provider-credential-1', '{}'::jsonb, '{}'::jsonb, $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (
       id, provider_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES ('provider-grant-1', 'provider-1', 'space-1', 'user-1', 'user-1',
       true, true, $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO projects (
       id, space_id, owner_user_id, name, status, created_at, updated_at
     ) VALUES ('project-1', 'space-1', 'user-1', 'Room Project', 'active', $1, $1)`,
    [now],
  );
  // Every Project is created with its mainline Room (ADR 0018 decision 4),
  // empty and with no manager Agent until someone speaks in it.
  await db.pool.query(
    `INSERT INTO rooms (
       id, space_id, project_id, created_by_user_id, title, status,
       created_at, updated_at, is_mainline
     ) VALUES ('room-mainline', 'space-1', 'project-1', 'user-1', 'Room Project',
       'active', $1, $1, true)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO room_user_members (
       id, space_id, room_id, user_id, role, status, created_at, updated_at
     ) VALUES ('room-mainline-owner', 'space-1', 'room-mainline', 'user-1',
       'owner', 'active', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO project_members (
       id, space_id, project_id, user_id, role, status, created_at, updated_at
     ) VALUES (
       'project-member-2', 'space-1', 'project-1', 'user-2',
       'viewer', 'active', $1, $1
     )`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ('machine-1', NULL, 'Test server', 'server', $1, $1)`,
    [now],
  );
  await db.pool.query(
    // The built-in host reports the copy these Rooms dispatch to, and a
    // heartbeat, like any other host. It used to need neither: a server-host
    // Room turn ran a CLI the server spawned itself. It runs the copy this
    // host's daemon has now, so a host with no installation — or no
    // heartbeat — is one nothing can be dispatched to, which is the check
    // `prepareHostConversationDispatch` makes for every host alike.
    `INSERT INTO hosts (
       id, owner_user_id, machine_id, name, kind, environment_kind, status,
       capabilities_json, last_heartbeat_at, created_at, updated_at
     ) VALUES (
       'host-1', NULL, 'machine-1', 'server', 'server', 'server', 'online',
       '{"installations":{"claude_code":[{"id":"managed:1.0.0","version":"1.0.0","logged_in":true,"health_check_protocol":"acp"}],"opencode":[{"id":"managed:1.0.0","version":"1.0.0","logged_in":true,"health_check_protocol":"acp"}]}}'::jsonb,
       $1, $1, $1
     )`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, name, status, created_by_user_id, kind,
       is_primary, protected, system_managed, created_at, updated_at
     ) VALUES (
       'folder-1', 'space-1', 'project-1', 'Room Folder', 'active', 'user-1',
       'code', true, false, false, $1, $1
     )`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       execution_ready, status, created_at, updated_at
     ) VALUES ('location-1','space-1','folder-1','host-1','server',true,'active',$1,$1)`,
    [now],
  );
  await db.pool.query(
    // The Project's own Assistant instance, which is what a Room in that
    // Project binds to. A Space-level row here would make every Room in the
    // fixture provision a second Agent on creation.
    `INSERT INTO agents (
       id, space_id, project_id, owner_user_id, name, status, agent_kind,
       current_version_id, visibility, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', 'project-1', NULL, 'A stale name', 'active',
       'system_assistant', NULL, 'space_shared', $1, $1
     )`,
    [now],
  );
  await db.pool.query(
    // Marked as a materialization of the managed seed, which is what a
    // provisioned instance looks like — an unmarked version that differs from
    // the seed reads as somebody's own work and is deliberately not
    // overwritten.
    `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       risk_level,
       follows_seed_key,
       created_at
     ) VALUES (
       'version-1',
       'agent-1',
       'space-1',
       'v1',
       'Coordinate the Room.',
       '{}'::jsonb,
       '{}'::jsonb,
       '[]'::jsonb,
       '{}'::jsonb,
       'low',
       'agent_template.personal_assistant.system',
       $1
     )`,
    [now],
  );
  await db.pool.query(
    "UPDATE agents SET current_version_id = 'version-1' WHERE id = 'agent-1'",
  );
  await db.pool.query(
    `INSERT INTO actors (
       id, space_id, actor_type, user_id, agent_id, service_name,
       display_name, status, metadata_json, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', 'agent', NULL, 'agent-1', NULL,
       'Room Manager', 'active', '{}'::jsonb, $1, $1
     )`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-cli',
       'space-1',
       'agent-1',
       'Subscription',
       'claude_code',
       'runtime_native',
       'host-1',
       'managed',
       'managed:1.0.0',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       true,
       $1,
       $1
     )`,
    [now],
  );
});

async function dispatchQueuedRoomRuns(runIds: readonly string[]): Promise<void> {
  const repository = new PgRunRepository(db.pool!);
  const routing = new PgRouteDecisionRepository(db.pool!);
  for (const runId of runIds) {
    const run = await repository.getAgentRun("space-1", runId);
    if (!run) throw new Error(`Room Agent Run '${runId}' disappeared before dispatch`);
    if (run.status !== "queued") continue;
    await routing.routeRun(run);
    await repository.markRunRunning({
      run_id: runId,
      space_id: "space-1",
      started_at: new Date().toISOString(),
    });
  }
}

/**
 * A visible specialist Agent with one version, usable as a Room roster member
 * and a delegation target. Writes rows directly and checks nothing, like
 * `seedConversation` below.
 */
async function seedSpecialist(now: string, agentId: string, versionId: string, name: string): Promise<void> {
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, 'space-1', 'user-1', $2, 'active', 'standard', NULL, 'space_shared', $3, $3)`,
    [agentId, name, now],
  );
  await db.pool!.query(
    `INSERT INTO agent_versions (id, agent_id, space_id, version_label, system_prompt, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json, risk_level, created_at)
     VALUES ($1, $2, 'space-1', 'v1', 'Specialist.', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'low', $3)`,
    [versionId, agentId, now],
  );
  await db.pool!.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [agentId, versionId]);
  await db.pool!.query(
    `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
     VALUES ($1, 'space-1', 'agent', NULL, $1, NULL, $2, 'active', '{}'::jsonb, $3, $3)`,
    [agentId, name, now],
  );
}

/**
 * A conversation in a Room, as a fixture.
 *
 * Production opens a Conversation through the explicit draft endpoint before
 * any message. A test that starts from a later point in a conversation seeds
 * one directly rather than opening a draft through the service it does not
 * want to assert on.
 */
async function seedConversation(
  // Deliberately no identity: this writes the row directly and checks nothing,
  // so taking one would imply an authorization this fixture does not perform.
  scope: { spaceId: string },
  roomId: string,
  title?: string,
  execution: {
    hostId: string;
    primary: { kind: "managed" } | { kind: "location"; workspace_location_id: string };
  } = { hostId: "host-1", primary: { kind: "managed" } },
) {
  const room = await new PgRoomRepository(db.pool!).getRoomById(scope.spaceId, roomId);
  if (!room) throw new Error(`No such Room: ${roomId}`);
  await seedRoomManager(db.pool, { space: scope.spaceId, room: room.id, agent: "agent-1" });
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       workspace_location_id,
       workspace_mode,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     )
     SELECT gen_random_uuid()::varchar, member.space_id, member.agent_id,
            'Conversation fixture CLI', 'claude_code', 'runtime_native', $3::varchar, $4::varchar, $5::varchar, 'managed:1.0.0',
            '{}'::jsonb, '{}'::jsonb, true, false, now(), now()
       FROM room_agent_members member
      WHERE member.space_id = $1 AND member.room_id = $2 AND member.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM agent_runtime_profiles profile
           WHERE profile.space_id = member.space_id AND profile.agent_id = member.agent_id
             AND profile.enabled = true AND profile.execution_host_id = $3::varchar
             AND profile.workspace_mode = $5::varchar
             AND profile.workspace_location_id IS NOT DISTINCT FROM $4::varchar
             AND profile.runtime_key = 'claude_code' AND profile.runtime_installation = 'managed:1.0.0'
        )`,
    [
      scope.spaceId,
      room.id,
      execution.hostId,
      execution.primary.kind === "location" ? execution.primary.workspace_location_id : null,
      execution.primary.kind,
    ],
  );
  const conversation = await new PgSessionRepository(db.pool!).createRoomConversation({
    space_id: scope.spaceId,
    room_id: room.id,
    project_id: room.project_id,
    // A Room Folder is retrieval/context scope, never a Conversation Primary.
    project_folder_id: null,
    title: title ?? "New conversation",
    metadata: {},
  });
  await new ConversationExecutionContextService(db.pool).initialize(
    { spaceId: scope.spaceId, userId: "user-1" },
    conversation.id,
    {
      selection: { execution_host_id: execution.hostId, primary: execution.primary },
      runtime: {
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        runtime_key: "claude_code",
        runtime_installation: "managed:1.0.0",
      },
    },
  );
  return conversation;
}

async function releaseConversationTurn(runId: string): Promise<void> {
  const thread = await db.pool.query<{ id: string }>(
    `SELECT id FROM host_threads
      WHERE dispatch_lock_id = $1 AND container_kind = 'conversation'
      LIMIT 1`,
    [runId],
  );
  if (thread.rows[0]) {
    await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.rows[0].id, {
      lastRunId: runId,
      vendorSessionId: null,
      sessionReset: false,
    });
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A Room that has already been spoken in.
 *
 * Opening a Room creates neither a manager Agent nor a Conversation. The
 * explicit draft action provisions the manager and opens the Conversation; a
 * test that starts from a later point seeds that state directly rather than
 * dispatching a message it does not want to assert on.
 * The tests that own the lifecycle itself use the real path.
 */
async function openSpokenRoom(
  owner: { spaceId: string; userId: string },
  input: { project_id: string; title: string; project_folder_id?: string | null },
): Promise<{
  // The service's own room shape, which is the protocol's `Room` — not the
  // repository row. Restating it as `RoomRecord` is what made this file fail
  // `pnpm run typecheck` when `createRoom` gained its `RoomDetail` annotation.
  room: Awaited<ReturnType<RoomService["createRoom"]>>["room"];
  conversation: Awaited<ReturnType<typeof seedConversation>>;
  agent_members: RoomAgentMemberRecord[];
}> {
  const created = await service!.createRoom(owner, input);
  const conversation = await seedConversation(owner, created.room.id);
  const agentMembers = await new PgRoomRepository(db.pool)
    .listAgentMembers(owner.spaceId, created.room.id);
  return { room: created.room, conversation, agent_members: agentMembers };
}

/**
 * Open a Room and speak in it, which is what provisions the Project's
 * Assistant now that Room creation does not (ADR 0018 decision 4). Used by the
 * Assistant-lifecycle tests, whose subject is the provisioning itself.
 */
async function speakInNewRoom(
  owner: { spaceId: string; userId: string },
  projectId: string,
  title: string,
): Promise<{ room: Awaited<ReturnType<RoomService["createRoom"]>>["room"] }> {
  const created = await service!.createRoom(owner, { project_id: projectId, title });
  await service!.createConversationDraft(owner, created.room.id);
  return created;
}

describe("Room workflow (real Postgres)", () => {
  it("keeps system continuations out of the visible transcript while retaining execution context", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Continuation Room",
    });
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const sessions = new PgSessionRepository(db.pool);
    const visible = await sessions.addRoomUserMessage(
      owner.spaceId,
      owner.userId,
      created.room.id,
      conversation.id,
      { content: "Define the Project." },
    );
    const internal = await sessions.addRoomInternalInstruction(
      owner.spaceId,
      owner.userId,
      created.room.id,
      conversation.id,
      { content: "Continue after the accepted definition." },
    );

    expect(internal).toMatchObject({
      role: "system",
      user_id: null,
      metadata_json: { room_display: "internal", continuation: true },
    });
    await expect(service.listMessages(owner, created.room.id, conversation.id, {
      limit: 20,
      offset: 0,
    })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: visible!.id, content: "Define the Project." }),
      ]),
    });
    const listed = await service.listProjectConversations(owner, "project-1", { limit: 50, offset: 0 });
    const row = listed.items.find((item) => item.id === conversation.id);
    expect(row).toMatchObject({
      last_message_role: "user",
      last_message_preview: "Define the Project.",
    });
    expect(row?.last_message_preview).not.toContain("Continue after the accepted definition.");
    const replay = await loadRoomConversationReplayThroughMessage(db.pool, {
      spaceId: owner.spaceId,
      sessionId: conversation.id,
      currentMessageId: internal!.id,
    });
    expect(replay.messages.map(message => message.content)).toEqual([
      "Conversation initialized on server with 1 Agent runtime.",
      "Define the Project.",
      "Continue after the accepted definition.",
    ]);
  });

  it("reports each research pipeline run, and each run only once", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    // Keying the outcome by Thread meant a retry silently returned the first
    // attempt's message: the second failure was never reported, so an Agent's
    // "queued" was the last word in the conversation while nothing ran.
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await openSpokenRoom(owner, { project_id: "project-1", title: "Pipeline outcomes" });
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const thread = randomUUID();
    const failure = (jobId: string) => ({
      kind: "research_pipeline_outcome",
      key: `${thread}:${jobId}`,
      payload: { status: "stage_failed", stage: "start_intake", thread_id: thread, reason: `attempt ${jobId} failed` },
    });
    const client = await db.pool.connect();
    try {
      const say = async (jobId: string) => {
        await client.query("BEGIN");
        const result = await service!.continueAfterDomainEventInTransaction(
          client, owner, created.room.id, conversation.id, failure(jobId));
        await client.query("COMMIT");
        await dispatchQueuedRoomRuns(result.run_ids);
        // The turn this continuation started must finish before the next one
        // may begin; the pipeline's own retries are minutes apart.
        await db.pool.query(
          "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id = ANY ($1::varchar[])",
          [result.run_ids],
        );
        for (const runId of result.run_ids) await releaseConversationTurn(runId);
        return result;
      };
      const first = await say("job-1");
      const second = await say("job-2");
      const repeat = await say("job-1");

      expect(second.message.id).not.toBe(first.message.id);
      expect(second.message.content).toContain("attempt job-2 failed");
      // The same run reporting twice is still one message.
      expect(repeat.message.id).toBe(first.message.id);
    } finally {
      client.release();
    }
  });

  it("validates and deduplicates server-owned Proposal continuations", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Proposal continuation",
    });
    const conversation = await seedConversation(owner, created.room.id, "Main");
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-api',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       now(),
       now()
     )`,
    );
    const source = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Define the Project.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    await dispatchQueuedRoomRuns(source.run_ids);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [source.run_ids[0]],
    );
    await releaseConversationTurn(source.run_ids[0]!);
    const proposalId = randomUUID();
    await db.pool.query(
      `INSERT INTO proposals (
         id,space_id,created_by_run_id,proposal_type,status,risk_level,urgency,
         preview,title,payload_json,created_at,updated_at,reviewed_at,reviewed_by,
         visibility,access_level,project_id
       ) VALUES (
         $1,'space-1',$2,'project_brief_publish','accepted','medium','normal',
         false,'定义 Agent Memory 项目',$3::jsonb,now(),now(),now(),'user-1',
         'space_shared','full','project-1'
       )`,
      [proposalId, source.run_ids[0], JSON.stringify({
        proposal_type: "project_brief_publish",
        action_id: "project.propose_definition",
        project_id: "project-1",
        goal: "Research Agent Memory",
      })],
    );

    const first = await service.continueAfterProposal(owner, created.room.id, conversation.id, {
      proposal_id: proposalId,
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    expect(first.message).toMatchObject({
      role: "system",
      user_id: null,
      metadata_json: {
        room_display: "internal",
        continuation: true,
        continuation_proposal_id: proposalId,
        // The continuation names no tool: which first step the goal asks for
        // is the Agent's judgment (ADR 0019), and it takes exactly one.
        continuation_directive: null,
      },
    });
    expect(first.message.content).toContain("只做这一步");
    expect(first.message.content).toContain("只创建一个");

    // The continuation is queued against the already-pinned Conversation
    // runtime. Adapter execution itself is covered by the CLI orchestration
    // suite; this test owns the Proposal-to-continuation boundary.
    await expect(new PgRunRepository(db.pool).getRun(owner.spaceId, first.run_ids[0]!))
      .resolves.toMatchObject({ status: "queued", session_id: conversation.id });

    await expect(loadAuthorizedCurrentContextMessage(db.pool, {
      messageId: first.message.id,
      spaceId: owner.spaceId,
      sessionId: conversation.id,
      userId: owner.userId,
      runId: first.run_ids[0]!,
    })).resolves.toMatchObject({ role: "system", content: first.message.content });
    await expect(loadAuthorizedCurrentContextMessage(db.pool, {
      messageId: first.message.id,
      spaceId: owner.spaceId,
      sessionId: conversation.id,
      userId: "user-2",
      runId: first.run_ids[0]!,
    })).resolves.toBeUndefined();

    const repeated = await service.continueAfterProposal(owner, created.room.id, conversation.id, {
      proposal_id: proposalId,
    });
    expect(repeated.message.id).toBe(first.message.id);
    expect(repeated.run_ids).toEqual(first.run_ids);
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages
        WHERE session_id=$1 AND metadata_json->>'continuation_proposal_id'=$2`,
      [conversation.id, proposalId],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(service.listMessages(owner, created.room.id, conversation.id, {
      limit: 20,
      offset: 0,
    })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ content: "Define the Project.", role: "user" }),
      ]),
    });
    await dispatchQueuedRoomRuns(first.run_ids);
    await db.pool.query(
      "UPDATE runs SET status='failed', ended_at=now(), updated_at=now() WHERE id = ANY($1::varchar[])",
      [first.run_ids],
    );
    for (const runId of first.run_ids) await releaseConversationTurn(runId);
    const retried = await service.continueAfterProposal(owner, created.room.id, conversation.id, {
      proposal_id: proposalId,
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    expect(retried.message.id).toBe(first.message.id);
    expect(retried.run_ids).not.toEqual(first.run_ids);
    await dispatchQueuedRoomRuns(retried.run_ids);
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages
        WHERE session_id=$1 AND metadata_json->>'continuation_proposal_id'=$2`,
      [conversation.id, proposalId],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id = ANY($1::varchar[])",
      [retried.run_ids],
    );

    const otherConversation = await seedConversation(owner, created.room.id, "Other");
    await expect(service.continueAfterProposal(owner, created.room.id, otherConversation.id, {
      proposal_id: proposalId,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "Proposal belongs to a different conversation",
    });
  });

  it("provisions the Assistant and an explicit conversation draft, not on Room creation", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    await removeManagedAssistant();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "First-use Room" });
    // A channel nobody has spoken in has no manager and no conversation
    // (ADR 0018 decisions 4 and 5), so nothing empty is left behind if nobody
    // ever does.
    expect(created.agent_members).toHaveLength(0);
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE space_id = 'space-1' AND room_id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'",
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });

    const draft = await service.createConversationDraft(owner, created.room.id);
    expect(draft.room_id).toBe(created.room.id);
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE space_id = 'space-1' AND room_id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'",
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    const members = await new PgRoomRepository(db.pool).listAgentMembers("space-1", created.room.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: "manager", agent_kind: "system_assistant" });
  });

  it("keeps a managed Assistant managed when a Project Location is added later", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    await removeManagedAssistant();
    await db.pool.query("UPDATE model_provider_space_grants SET enabled = false WHERE space_id = 'space-1'");
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
       VALUES ('machine-owner', 'user-1', 'Owner laptop', 'desktop', $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO hosts (
         id, owner_user_id, machine_id, name, kind, environment_kind, status,
         capabilities_json, last_heartbeat_at, created_at, updated_at
       ) VALUES (
         'host-owner', 'user-1', 'machine-owner', 'Owner laptop', 'remote',
         'linux_native', 'online',
         '{"installations":{"claude_code":[{"id":"managed:1.0.0","version":"1.0.0","logged_in":true,"health_check_protocol":"acp"}]}}'::jsonb,
         $1, $1, $1
       )`,
      [now],
    );

    await service.createConversationDraft(
      { spaceId: "space-1", userId: "user-1" },
      "room-mainline",
    );
    await expect(db.pool.query<{ workspace_mode: string; workspace_location_id: string | null }>(
      `SELECT profile.workspace_mode, profile.workspace_location_id
         FROM agent_runtime_profiles profile
         JOIN agents agent ON agent.id = profile.agent_id
        WHERE profile.space_id = 'space-1' AND profile.is_default = true
          AND agent.project_id = 'project-1' AND agent.agent_kind = 'system_assistant'`,
    )).resolves.toMatchObject({ rows: [{ workspace_mode: "managed", workspace_location_id: null }] });

    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         display_path, execution_ready, status, created_at, updated_at
       ) VALUES (
         'location-owner', 'space-1', 'folder-1', 'host-owner', 'remote',
         '/home/user/Room-Project', true, 'stale', $1, $1
       )`,
      [now],
    );
    await service.createConversationDraft(
      { spaceId: "space-1", userId: "user-1" },
      "room-mainline",
    );
    await expect(db.pool.query<{ workspace_mode: string; workspace_location_id: string | null }>(
      `SELECT profile.workspace_mode, profile.workspace_location_id
         FROM agent_runtime_profiles profile
         JOIN agents agent ON agent.id = profile.agent_id
        WHERE profile.space_id = 'space-1' AND profile.is_default = true
          AND agent.project_id = 'project-1' AND agent.agent_kind = 'system_assistant'`,
    )).resolves.toMatchObject({ rows: [{ workspace_mode: "managed", workspace_location_id: null }] });
  });

  it("renames a placeholder conversation on its first message and queues cheap refinement", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Memory Room",
    });
    const conversation = await seedConversation(owner, created.room.id);
    expect(conversation.title).toBe("New conversation");

    const message = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1",
      "user-1",
      created.room.id,
      conversation.id,
      { content: "我想要做一个研究 agent memory 的项目。" },
    );
    expect(message).not.toBeNull();
    const renamed = await requestRoomConversationTitle(db.pool, {
      spaceId: "space-1",
      roomId: created.room.id,
      sessionId: conversation.id,
      sourceMessageId: message!.id,
      sourceUserId: "user-1",
      content: message!.content,
    });

    expect(renamed?.title).toBe("研究 agent memory 的项目");
    await expect(service.listMessages(owner, created.room.id, conversation.id, {
      limit: 20,
      offset: 0,
    })).resolves.toMatchObject({
      conversation: { title: "研究 agent memory 的项目" },
    });
    await expect(db.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM jobs
        WHERE space_id='space-1' AND job_type='room_conversation_title'
          AND payload_json->>'session_id'=$1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const providerStore = {
      getTaskChain: async () => [{ provider_id: "provider-1", model: "cheap-model" }],
    } as unknown as ProviderCommandStore;
    const result = await new RoomConversationTitleService(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot! }),
      db.pool,
      {
        resolveProviderStore: () => providerStore,
        completeProviderMessages: async () => ({
          text: "个人 Agent 记忆研究",
          provider: "openai",
          provider_id: "provider-1",
          model: "cheap-model",
          usage: {},
        }),
      },
    ).process({
      spaceId: "space-1",
      roomId: created.room.id,
      sessionId: conversation.id,
      sourceMessageId: message!.id,
      sourceUserId: "user-1",
      provisionalTitle: renamed!.title!,
    });
    expect(result).toMatchObject({ status: "renamed", title: "个人 Agent 记忆研究" });
  });

  it("lists Room conversations by creation time descending, independent of activity", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await openSpokenRoom(owner, {
      project_id: "project-1",
      title: "Ordered conversations",
    });
    const older = created.conversation;
    const newer = await seedConversation(owner, created.room.id, "Newer");
    await db.pool.query(
      `UPDATE sessions
          SET created_at = CASE id
            WHEN $1 THEN '2026-01-01T00:00:00.000Z'::timestamptz
            WHEN $2 THEN '2026-01-02T00:00:00.000Z'::timestamptz
          END,
              updated_at = CASE id
            WHEN $1 THEN '2026-01-03T00:00:00.000Z'::timestamptz
            WHEN $2 THEN '2026-01-02T00:00:00.000Z'::timestamptz
          END
        WHERE id IN ($1, $2)`,
      [older.id, newer.id],
    );

    await expect(service.listConversations(owner, created.room.id, {
      limit: 20,
      offset: 0,
    })).resolves.toMatchObject({
      items: [{ id: newer.id }, { id: older.id }],
    });
  });

  it("starts a further conversation through the explicit draft action", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await openSpokenRoom(owner, { project_id: "project-1", title: "Two threads" });
    const second = await service.createConversationDraft(owner, created.room.id);
    expect(second.id).not.toBe(created.conversation.id);
    const listed = await service.listConversations(owner, created.room.id, { limit: 20, offset: 0 });
    expect(listed.items).toHaveLength(2);
  });

  it("opens a Room with no paired backend and keeps its pending Server Assistant visible", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    await removeManagedAssistant();
    await db.pool.query("UPDATE model_provider_space_grants SET enabled = false WHERE space_id = 'space-1'");
    // There is no paired-Host backend or provider grant. The new Agent still
    // receives its default Server/OpenCode Profile; Phase 2 owns installing
    // that Server runtime and reporting readiness.
    await db.pool.query("UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = 'host-1'");
    const owner = { spaceId: "space-1", userId: "user-1" };
    // Room and draft creation remain independent of the Server runtime's
    // installation lifecycle.
    const created = await service.createRoom(owner, { project_id: "project-1", title: "No backend yet" });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM rooms WHERE space_id = 'space-1' AND id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const draft = await service.createConversationDraft(owner, created.room.id);
    expect(draft.room_id).toBe(created.room.id);
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'",
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(db.pool.query<{
      runtime_key: string;
      backend_mode: string;
      execution_host_id: string | null;
      runtime_installation: string | null;
      enabled: boolean;
      is_default: boolean;
    }>(
      `SELECT runtime_key, backend_mode, execution_host_id, runtime_installation, enabled, is_default
         FROM agent_runtime_profiles
        WHERE space_id = 'space-1'
          AND agent_id = (
            SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'
          )`,
    )).resolves.toMatchObject({ rows: [{
      runtime_key: "opencode",
      backend_mode: "runtime_native",
      execution_host_id: "host-1",
      runtime_installation: "managed:pending",
      enabled: true,
      is_default: true,
    }] });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE space_id = 'space-1' AND room_id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("serializes concurrent explicit drafts into one Assistant, and keeps Room creation idempotent", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    await removeManagedAssistant();
    const owner = { spaceId: "space-1", userId: "user-1" };
    // Provisioning is serialized by the explicit draft action: two people
    // opening a Room at once must not each mint an Assistant.
    const roomA = await service.createRoom(owner, { project_id: "project-1", title: "Concurrent A" });
    const roomB = await service.createRoom(owner, { project_id: "project-1", title: "Concurrent B" });
    await Promise.all([
      service.createConversationDraft(owner, roomA.room.id),
      service.createConversationDraft(owner, roomB.room.id),
    ]);
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'",
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_versions WHERE space_id = 'space-1' AND agent_id = (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active')",
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const retried = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Retry-safe",
      idempotency_key: "room-retry-1",
    });
    const replay = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Retry-safe",
      idempotency_key: "room-retry-1",
    });
    expect(replay.room.id).toBe(retried.room.id);
    await expect(service.createRoom(owner, {
      project_id: "project-1",
      title: "Different payload",
      idempotency_key: "room-retry-1",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enforces Project ACL when creating and continuing a Room", async (ctx) => {
    if (!db.available || !service || !groupService) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      project_folder_id: "folder-1",
      title: "ACL Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await seedConversation(member, created.room.id, "Before revocation");
    expect(conversation.project_folder_id).toBeNull();
    const sessions = new PgSessionRepository(db.pool);
    await expect(
      sessions.getConversationForBackendSelection(
        "space-1",
        "user-2",
        conversation.id,
      ),
    ).resolves.toMatchObject({ id: conversation.id, room_id: created.room.id });
    await expect(sessions.getSession("space-1", "user-2", conversation.id))
      .resolves.toBeNull();
    await expect(sessions.listMessages(
      "space-1",
      "user-2",
      conversation.id,
      20,
      0,
    )).resolves.toBeNull();
    await expect(sessions.addMessage(
      "space-1",
      "user-2",
      conversation.id,
      { role: "user", content: "Generic Session writes must reject Room." },
    )).resolves.toBeNull();
    await expect(sessions.reflectSession("space-1", "user-2", conversation.id))
      .resolves.toBeNull();
    const dispatched = await service.sendMessage(
      member,
      created.room.id,
      conversation.id,
      {
        content: "Create a member-owned task before revocation.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
        }],
      },
    );
    const groupId = dispatched.task_group_ids[0]!;
    const runId = dispatched.run_ids[0]!;
    await expect(db.pool.query<{ project_folder_id: string | null }>(
      "SELECT project_folder_id FROM runs WHERE id = $1",
      [runId],
    )).resolves.toMatchObject({
      rows: [{ project_folder_id: null }],
    });
    const runRepository = new PgRunRepository(db.pool);
    const queuedRun = await runRepository.getRun("space-1", runId);
    expect(queuedRun).not.toBeNull();
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toEqual({ allowed: true });
    await db.pool.query(
      `UPDATE project_folders
          SET status = 'archived', updated_at = now()
        WHERE space_id = 'space-1' AND id = 'folder-1'`,
    );
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toEqual({ allowed: true });
    await db.pool.query(
      `UPDATE project_folders
          SET status = 'active', updated_at = now()
        WHERE space_id = 'space-1' AND id = 'folder-1'`,
    );
    await db.pool.query(
      `UPDATE project_members
          SET status = 'revoked', updated_at = now()
        WHERE space_id = 'space-1'
          AND project_id = 'project-1'
          AND user_id = 'user-2'`,
    );

    await expect(service.getRoom(member, created.room.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(
      sessions.getConversationForBackendSelection(
        "space-1",
        "user-2",
        conversation.id,
      ),
    ).resolves.toBeNull();
    await expect(service.listRooms(member, { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ total: 0, items: [] });
    await expect(service.sendMessage(member, created.room.id, conversation.id, {
      content: "This must be rejected.",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.getTimeline(member, groupId, { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.updateGroup(member, {
      space_id: "space-1",
      group_id: groupId,
      title: "Must not update",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.changeStatus(member, groupId, "cancelled"))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.sendUserMessage(member, {
      space_id: "space-1",
      group_id: groupId,
      content: "Must not extend",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.listGroups(member, { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ items: [], total: 0 });
    await expect(new PgRunRepository(db.pool).getVisibleRun("space-1", "user-2", runId))
      .resolves.toBeNull();
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toMatchObject({
        allowed: false,
        error_code: "run_execution_authorization_revoked",
      });

    const finalizerConfig = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      RAINVER_HOME: testRoot,
    });
    const continuity = {
      async finalizeChatTurn() {
        return { space_id: "space-1", work_context_scope_id: runId } as never;
      },
      async runSemanticExtraction() { return null; },
    };
    await dispatchQueuedRoomRuns([runId]);
    await db.pool.query(
      `UPDATE runs
          SET status = 'waiting_for_review',
              error_json = $2::jsonb,
              error_message = 'Project file access requires approval.',
              updated_at = now()
        WHERE space_id = 'space-1' AND id = $1`,
      [
        runId,
        JSON.stringify({
          error_code: "authorization_request_pending",
          error_text: "Project file access requires approval.",
          authorization_request_id: "authorization-test",
        }),
      ],
    );
    const waitingRun = await runRepository.getRun("space-1", runId);
    await expect(finalizeChatTurn(
      finalizerConfig,
      runRepository,
      waitingRun!,
      { loadActionPreviews: async () => [], continuity },
    )).resolves.toBeNull();
    const reviewMessages = await service.listMessages(
      owner,
      created.room.id,
      conversation.id,
      { limit: 20, offset: 0 },
    );
    expect(reviewMessages.items.find((message) =>
      message.run_id === runId
    )).toMatchObject({
      content: expect.stringContaining("I need your approval before I can continue."),
      metadata_json: { attention_kind: "authorization" },
    });

    await db.pool.query(
      `UPDATE runs
          SET status = 'succeeded',
              output_json = $2::jsonb,
              error_json = NULL,
              error_message = NULL,
              ended_at = now(),
              updated_at = now()
        WHERE space_id = 'space-1' AND id = $1`,
      [
        runId,
        JSON.stringify({
          schema_version: "run_output.v1",
          status: "succeeded",
          summary: "Result persisted after speaker revocation.",
          result: {},
          output_manifest: [],
        }),
      ],
    );
    const terminalRun = await runRepository.getRun("space-1", runId);
    expect(terminalRun).not.toBeNull();
    await expect(finalizeChatTurn(
      finalizerConfig,
      runRepository,
      terminalRun!,
      {
        loadActionPreviews: async () => [],
        continuity,
      },
    )).resolves.toMatchObject({ ok: true });
    await expect(finalizeChatTurn(
      finalizerConfig,
      runRepository,
      terminalRun!,
      {
        loadActionPreviews: async () => [],
        continuity,
      },
    )).resolves.toBeNull();
    const ownerMessages = await service.listMessages(
      owner,
      created.room.id,
      conversation.id,
      { limit: 20, offset: 0 },
    );
    expect(ownerMessages.items.filter((message) =>
      message.run_id === runId
    )).toHaveLength(1);
    expect(ownerMessages.items.find((message) =>
      message.run_id === runId
    )).toMatchObject({
      content: "Result persisted after speaker revocation.",
      metadata_json: { status: "succeeded" },
    });
    await expect(service.listMessages(
      member,
      created.room.id,
      conversation.id,
      { limit: 20, offset: 0 },
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets Room members read another speaker's task but not manage or extend it", async (ctx) => {
    if (!db.available || !service || !groupService) return ctx.skip();
    const testPool = db.pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    // Not the mainline: this test removes a member, and mainline membership
    // follows Project membership by design.
    await service.createRoom(owner, { project_id: "project-1", title: "Mainline" });
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Task authority Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await seedConversation(owner, created.room.id, "Task ownership");
    const dispatched = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Owner task.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    await dispatchQueuedRoomRuns(dispatched.run_ids);
    const groupId = dispatched.task_group_ids[0]!;

    await expect(groupService.getTimeline(member, groupId, { limit: 20, offset: 0 }))
      .resolves.toMatchObject({ group: { id: groupId } });
    await expect(groupService.updateGroup(member, {
      space_id: "space-1",
      group_id: groupId,
      title: "Hijacked",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.changeStatus(member, groupId, "cancelled"))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(groupService.sendUserMessage(member, {
      space_id: "space-1",
      group_id: groupId,
      content: "Extend the old task.",
    })).rejects.toMatchObject({ statusCode: 404 });

    await service.removeUser(owner, created.room.id, "user-2");
    await expect(groupService.getTimeline(member, groupId, { limit: 20, offset: 0 }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(new PgRunRepository(testPool).getVisibleRun("space-1", member.userId, dispatched.run_ids[0]!))
      .resolves.toBeNull();
  });

  it("opens one auditable task per message while retaining one Conversation × Agent runtime pin", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Delivery Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await seedConversation(owner, created.room.id, "Main thread");
    const secondConversation = await seedConversation(member, created.room.id, "Follow-up");

    const first = await service.sendMessage(
      owner,
      created.room.id,
      conversation.id,
      {
        content: "Prepare the first result.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
        }],
      },
    );
    await dispatchQueuedRoomRuns(first.run_ids);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [first.run_ids[0]],
    );
    await releaseConversationTurn(first.run_ids[0]!);
    const second = await service.sendMessage(
      member,
      created.room.id,
      conversation.id,
      {
        content: "Review it from my account.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
        }],
      },
    );

    expect(first.task_group_ids).toHaveLength(1);
    expect(second.task_group_ids).toHaveLength(1);
    expect(second.task_group_ids[0]).not.toBe(first.task_group_ids[0]);
    expect(secondConversation.id).not.toBe(conversation.id);
    await expect(service.listRooms(member, { limit: 20, offset: 0 })).resolves
      .toMatchObject({ total: 1 });
    await expect(
      service.getRoom({ spaceId: "space-1", userId: "user-3" }, created.room.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const tasks = await db.pool.query<{
      id: string;
      manager_user_id: string;
      room_id: string;
      session_id: string;
      project_id: string;
      trigger_message_id: string;
    }>(
      `SELECT id, manager_user_id, room_id, session_id, project_id,
              trigger_message_id
         FROM agent_run_groups
        WHERE room_id = $1
        ORDER BY created_at ASC, id ASC`,
      [created.room.id],
    );
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows.map((row) => row.manager_user_id).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(tasks.rows.every((row) =>
      row.room_id === created.room.id &&
      row.session_id === conversation.id &&
      row.project_id === "project-1" &&
      Boolean(row.trigger_message_id)
    )).toBe(true);

    const runs = await db.pool.query<{
      instructed_by_user_id: string;
      session_id: string;
      project_id: string;
      run_group_id: string;
      required_outputs: unknown;
      message_cursor_id: string | null;
      visibility: string;
      agent_version_id: string | null;
    }>(
      `SELECT instructed_by_user_id, session_id, project_id, run_group_id,
              contract_snapshot_json->'required_outputs_json' AS required_outputs,
              model_override_json->'chat_turn'->>'user_message_id'
                AS message_cursor_id,
              model_override_json->'chat_turn'->>'agent_version_id'
                AS agent_version_id,
              visibility
         FROM runs
        WHERE run_group_id = ANY($1::varchar[])
        ORDER BY created_at ASC, id ASC`,
      [tasks.rows.map((row) => row.id)],
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.map((row) => row.instructed_by_user_id).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    // SpaceAssistantService's provisioning (triggered by Room creation for
    // agent-1, a system_assistant) can reconcile a fresh agent_version and
    // repoint agents.current_version_id once a real runtime tool is
    // installed — it no longer necessarily stays the fixture's original
    // 'version-1', so compare against whatever the current pointer actually
    // is rather than that hardcoded literal.
    const currentAgentVersion = await db.pool.query<{ current_version_id: string }>(
      `SELECT current_version_id FROM agents WHERE space_id='space-1' AND id='agent-1'`,
    );
    expect(runs.rows.every((row) =>
      row.session_id === conversation.id &&
      row.project_id === "project-1" &&
      row.visibility === "selected_users" &&
      row.agent_version_id === currentAgentVersion.rows[0]?.current_version_id &&
      Boolean(row.message_cursor_id) &&
      Array.isArray(row.required_outputs) &&
      row.required_outputs.some((output) =>
        typeof output === "object" &&
        output !== null &&
        (output as { name?: unknown }).name === "conversation_capture"
      )
    )).toBe(true);
    const runAccess = new PgRunRepository(db.pool);
    await expect(
      runAccess.getVisibleRun("space-1", "user-2", first.run_ids[0]!),
    ).resolves.toMatchObject({ id: first.run_ids[0] });
    await expect(
      runAccess.getVisibleRun("space-1", "user-3", first.run_ids[0]!),
    ).resolves.toBeNull();

    const bindings = await db.pool.query<{
      bound_by_user_id: string;
      agent_id: string;
    }>(
      `SELECT bound_by_user_id, agent_id
         FROM session_conversation_backends
        WHERE session_id = $1
        ORDER BY bound_by_user_id ASC`,
      [conversation.id],
    );
    expect(bindings.rows).toEqual([
      {
        bound_by_user_id: "user-1",
        agent_id: "agent-1",
      },
    ]);
  });

  it("prefixes a Room-dispatched run's prompt with Project state context (plan Phase A, decision 3)", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-api',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       now(),
       now()
     )`,
    );
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Context Room",
    });
    const conversation = await seedConversation(owner, created.room.id, "Main thread");
    // Something needs a person, so the prompt has attention to state. The
    // adapter that surfaces it registers at route-module init, which this
    // service-level test does not run.
    registerBuiltInAttentionAdapters();
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, progress_json, created_at, updated_at)
       VALUES ($1, 'space-1', 'project-1', 'custom', 'Approve the screening batch', 'waiting_review', '{}'::jsonb, now(), now())`,
      [randomUUID()],
    );

    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "What should I do next?",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });

    const run = await db.pool.query<{ prompt: string | null }>(
      `SELECT prompt FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    );
    const prompt = run.rows[0]?.prompt ?? "";
    expect(prompt).toContain("[Internal Project guidance");
    expect(prompt).toContain("still needs a formal goal/core problem");
    expect(prompt).toContain("one to three short sentences");
    expect(prompt).not.toContain("Project initialization: incomplete");
    // What the block carries now that the per-Mode projection is gone: the
    // definition status and what needs attention — nothing invented.
    expect(prompt).toContain("Items needing attention for internal reasoning:");
    expect(prompt).toContain("- Approve the screening batch");
    expect(prompt).not.toContain("Possible next actions");
    expect(prompt).toContain("[Room execution rules]");
    expect(prompt).toContain("invoke inquiry.create_thread once for each");
    expect(prompt).toContain("merely listing them in the reply does not create them");
    expect(prompt).toContain("treat that as an execution instruction");
    expect(prompt).toContain("whichever research-execution tool is available");
    expect(prompt).not.toContain("[Current turn execution mode]");
    expect(prompt).toContain("[Assigned task for this Room turn]");
    expect(prompt.endsWith("What should I do next?")).toBe(true);
    // Context precedes the assigned task, never the other way around.
    expect(prompt.indexOf("[Project state]")).toBeLessThan(prompt.indexOf("What should I do next?"));
  });

  it("states the Task the person is looking at, and stays silent about one they cannot read", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-focus',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       now(),
       now()
     )`,
    );
    const readable = randomUUID();
    const unreadable = randomUUID();
    const senderPrivate = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (
         id, space_id, project_id, title, status, created_by_user_id, owner_user_id,
         visibility, created_at, updated_at
       ) VALUES
         ($1,'space-1','project-1','Draft the memory chapter','in_progress','user-1','user-1','space_shared',now(),now()),
         ($2,'space-1','project-1','Someone else private note','inbox','user-2','user-2','private',now(),now()),
         ($3,'space-1','project-1','My own private note','inbox','user-1','user-1','private',now(),now())`,
      [readable, unreadable, senderPrivate],
    );
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Focus Room" });
    // One conversation per turn: a Room conversation holds a single turn at a
    // time, which is the behaviour under test elsewhere, not here.
    const [first, second, third, fourth] = await Promise.all([
      seedConversation(owner, created.room.id, "Focused"),
      seedConversation(owner, created.room.id, "Hidden focus"),
      seedConversation(owner, created.room.id, "No focus"),
      seedConversation(owner, created.room.id, "Own private focus"),
    ]);

    const backends = [{
      agent_id: "agent-1",
      runtime_profile_id: "runtime-cli",
    }];
    const focused = await service.sendMessage(owner, created.room.id, first.id, {
      content: "Is this done?",
      backends,
      focus_refs: [{ type: "task", id: readable }],
    });
    const promptOf = async (runId: string): Promise<string> => {
      const run = await db.pool!.query<{ prompt: string | null }>(
        `SELECT prompt FROM runs WHERE id = $1`,
        [runId],
      );
      return run.rows[0]?.prompt ?? "";
    };

    // The whole point of the sidecar: "this" resolves without the person
    // restating which Task they mean.
    const withFocus = await promptOf(focused.run_ids[0]!);
    // With its id: the Task a turn is most likely to act on arrives
    // addressable, without a task.list round trip.
    expect(withFocus).toContain(`"Draft the memory chapter" (in_progress, task_id: ${readable})`);
    expect(withFocus).toContain("hint, not a restriction");

    // Recorded, not only prompted: without this the sole trace of an injected
    // Task is free text inside `runs.prompt`, which cannot be queried back to
    // "which Task entered which turn".
    const injected = await db.pool.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT m.metadata_json
         FROM agent_run_messages m
         JOIN agent_run_groups g ON g.id = m.group_id
        WHERE g.session_id = $1 AND m.message_type = 'user_instruction'
        ORDER BY m.created_at DESC
        LIMIT 1`,
      [first.id],
    );
    expect(injected.rows[0]?.metadata_json?.injected_focus_task_ids).toEqual([readable]);

    // A focus the person cannot read produces nothing — naming it would leak
    // the title, which is the part worth reading.
    const hidden = await service.sendMessage(owner, created.room.id, second.id, {
      content: "And this one?",
      backends,
      focus_refs: [{ type: "task", id: unreadable }],
    });
    const withoutFocus = await promptOf(hidden.run_ids[0]!);
    expect(withoutFocus).not.toContain("Someone else private note");
    expect(withoutFocus).not.toContain("currently looking at");

    // The sender can read their own private Task, but the sentence is written
    // into a prompt whose Run output every Room member can read, and the focus
    // came from the route rather than from anything the person typed. Naming
    // it would disclose the title by navigation alone.
    const own = await service.sendMessage(owner, created.room.id, fourth.id, {
      content: "And mine?",
      backends,
      focus_refs: [{ type: "task", id: senderPrivate }],
    });
    const withOwnPrivate = await promptOf(own.run_ids[0]!);
    expect(withOwnPrivate).not.toContain("My own private note");
    expect(withOwnPrivate).not.toContain("currently looking at");

    // No focus at all is the ordinary case and must not change the turn.
    const plain = await service.sendMessage(owner, created.room.id, third.id, {
      content: "What next?",
      backends,
    });
    expect(await promptOf(plain.run_ids[0]!)).not.toContain("currently looking at");
  });

  it("guides research execution through prompt policy, not a server-side text match on the turn", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await new InquiryThreadService(db.pool).createThread(owner, "project-1", {
      kind: "question",
      statement: "Agent memory 应该如何分层？",
    });
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-api',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       now(),
       now()
     )`,
    );
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Research execution",
    });
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "开始研究",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    const runPrompt = await db.pool.query<{ prompt: string }>("SELECT prompt FROM runs WHERE id=$1", [sent.run_ids[0]]);
    // The research-execution rule is standing prompt guidance present on
    // every Room turn, not a server-side match on this turn's wording — a
    // prior fixed-phrasing regex classifier that injected a per-turn
    // override block was removed for exactly that brittleness.
    expect(runPrompt.rows[0]?.prompt).toContain("treat that as an execution instruction");
    expect(runPrompt.rows[0]?.prompt).not.toContain("[Current turn execution mode]");

    // Choosing whether to open another question is the model's own judgment;
    // the server no longer blocks it by pattern-matching the triggering
    // message text. The Thread service is reachable with no proposal in the
    // way — the bound, not a gate, is what limits it (covered in
    // inquiryDirectWritesDb.test.ts).
    await expect(new InquiryThreadService(db.pool).createThread(
      owner,
      "project-1",
      { kind: "question", statement: "把分层继续拆成四个问题" },
      { runId: sent.run_ids[0], agentId: "agent-1" },
    )).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("grants a Room-dispatched run the conversation scenario tools despite the Agent declaring none", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Allowance Room",
    });
    const conversation = await seedConversation(owner, created.room.id, "Main thread");

    // The Agent's own version declares no tools at all, which is the default
    // for every Agent created through the product: the permission comes from
    // the Room, not from the Agent.
    const agentTools = await db.pool.query<{ tool_permissions_json: unknown }>(
      `SELECT av.tool_permissions_json FROM agent_versions av
         JOIN agents a ON a.current_version_id = av.id
        WHERE a.id = 'agent-1' AND a.space_id = 'space-1'`,
    );
    expect(agentTools.rows[0]?.tool_permissions_json).toEqual({});

    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "This question is ready to conclude.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });

    // System Action ids authorize server-owned tools; they are not runtime
    // capabilities. A Room allowance must not eliminate the only otherwise
    // valid runtime before even a simple conversation can start.
    const runs = new PgRunRepository(db.pool);
    const queued = await runs.getAgentRun("space-1", sent.run_ids[0]!);
    expect(queued).not.toBeNull();
    const routed = await new PgRouteDecisionRepository(db.pool).routeRun(queued!);
    expect(routed.runtime_profile_id).toBe("runtime-cli");

    // Production execution binds the queued Run to its Work Context before
    // starting it. The Room-owned allowance must survive that recomputation.
    await runs.bindRunToWorkContext({
      run_id: sent.run_ids[0]!,
      space_id: "space-1",
      project_id: "project-1",
      project_folder_id: null,
      agent_id: "agent-1",
      runtime_profile_id: "runtime-cli",
    });
    const rebound = await db.pool.query<{ tool_grants: Array<{ action_id: string }> }>(
      `SELECT permission_snapshot_json->'tool_grants' AS tool_grants FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    );
    const granted = (rebound.rows[0]?.tool_grants ?? []).map((grant) => grant.action_id);
    expect(granted).toEqual(expect.arrayContaining([
        "project.propose_definition",
        "inquiry.create_thread",
        "inquiry.record_conclusion",
        "inquiry.promote_knowledge",
        "memory.remember",
        "memory.revise",
      ]));
    // Retrieval would run under the sender's identity and answer into a
    // conversation every Room member reads, so no retrieval action is in the
    // allowance — and listing one would also switch its domain on.
    expect(granted.some((id) => id.includes("retrieval"))).toBe(false);

    // The boundary itself: being dispatched into a Room is the *only* reason
    // these grants exist. The same Agent, same Project, outside a Room, is
    // still bound by its own (empty) AgentVersion allowance.
    await expect(new PgRunRepository(db.pool).createQueuedRun({
      execution_kind: "agent",
      agent_id: "agent-1",
      space_id: "space-1",
      user_id: "user-1",
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      project_id: "project-1",
      prompt: "Same agent, no Room.",
    })).rejects.toMatchObject({
      statusCode: 404,
      message: "The managed Assistant can only run through a Room conversation",
    });
  });

  /** A retry re-runs the persisted message, and the retried Run hydrates that
   *  message's frozen resources — so it must keep the tools that read them.
   *  A retry dispatches no new input parts, and deciding the allowance from
   *  those left the Run holding a prompt that named tools it did not have. */
  it("keeps the lazy resource tools when a turn with an attached file is retried", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Resource Room" });
    const conversation = await seedConversation(owner, created.room.id, "Main thread");
    const body = "export const answer = 42;\n";
    const bodySha = createHash("sha256").update(body, "utf8").digest("hex");
    await db.pool.query(
      `INSERT INTO project_file_drafts (
         id, space_id, project_id, project_folder_id, workspace_location_id, owner_user_id,
         target_kind, relative_path, base_exists, base_sha256, content, content_sha256,
         byte_size, version, source_encoding, preserve_bom, line_ending_mode,
         created_at, updated_at, expires_at
       ) VALUES ('draft-1','space-1','project-1','folder-1','location-1','user-1',
         'new','src/answer.ts',false,NULL,$1,$2,$3,1,'utf8',false,'lf',
         now(), now(), now() + interval '90 days')`,
      [body, bodySha, Buffer.byteLength(body, "utf8")],
    );
    await db.pool.query(
      `INSERT INTO conversation_folder_access_grants (
         id, space_id, session_id, project_folder_id, workspace_location_id,
         access_mode, status, granted_by_user_id, granted_at, updated_at
       ) VALUES (gen_random_uuid()::varchar,'space-1',$1,'folder-1','location-1',
         'read','active','user-1', now(), now())`,
      [conversation.id],
    );

    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Look at the file I have open.",
      input_parts: [{
        kind: "input_resource",
        source_state: "draft",
        draft_id: "draft-1",
        draft_version: 1,
        content_sha256: bodySha,
        display_name: "answer.ts",
        media_type: "text/plain",
        byte_size: Buffer.byteLength(body, "utf8"),
      }],
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
    });
    const runs = new PgRunRepository(db.pool);
    const first = await runs.getRun("space-1", sent.run_ids[0]!);
    expect(first?.capabilities_json).toEqual(
      expect.arrayContaining(["input_resource.read", "input_resource.search"]),
    );

    // The turn ends the way a failed one does in production: the Run is failed
    // and its Host thread is no longer claimed by it.
    await dispatchQueuedRoomRuns([sent.run_ids[0]!]);
    await db.pool.query(`UPDATE runs SET status = 'failed' WHERE id = $1`, [sent.run_ids[0]]);
    await db.pool.query(
      `UPDATE host_threads SET dispatch_lock_id = NULL, updated_at = now()
        WHERE space_id = 'space-1' AND session_id = $1 AND agent_id = 'agent-1'`,
      [conversation.id],
    );
    const retried = await service.retryMessage(owner, created.room.id, conversation.id, {
      run_id: sent.run_ids[0]!,
      idempotency_key: "retry-resource-turn",
    });

    expect(retried.reused).toBe(false);
    const retriedRun = await runs.getRun("space-1", retried.value.run_ids[0]!);
    expect(retriedRun?.capabilities_json).toEqual(
      expect.arrayContaining(["input_resource.read", "input_resource.search"]),
    );
    // The retry reuses the message's own frozen resource; it must not claim a
    // second one, and the draft it came from stays where it was.
    await expect(db.pool.query(
      `SELECT count(*)::int AS rows FROM conversation_input_resources WHERE space_id = 'space-1'`,
    )).resolves.toMatchObject({ rows: [{ rows: 1 }] });
    await expect(db.pool.query(
      `SELECT version FROM project_file_drafts WHERE id = 'draft-1'`,
    )).resolves.toMatchObject({ rows: [{ version: 1 }] });

    const resource = await db.pool.query<{ id: string; message_id: string }>(
      `SELECT id,message_id FROM conversation_input_resources WHERE space_id='space-1' LIMIT 1`,
    );
    const inputResource = new ConversationInputResourceService(db.pool);
    await expect(inputResource.read({
      spaceId: "space-1",
      runId: retried.value.run_ids[0]!,
      messageId: resource.rows[0]!.message_id,
      request: { resource_id: resource.rows[0]!.id, start_line: 1, line_count: 10 },
    })).resolves.toMatchObject({ content: body });

    await db.pool.query(
      `UPDATE room_user_members SET status='removed', updated_at=now()
        WHERE space_id='space-1' AND room_id=$1 AND user_id='user-1'`,
      [created.room.id],
    );
    await expect(inputResource.read({
      spaceId: "space-1",
      runId: retried.value.run_ids[0]!,
      messageId: resource.rows[0]!.message_id,
      request: { resource_id: resource.rows[0]!.id, start_line: 1, line_count: 10 },
    })).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("keeps healthy CLI state stable as bounded raw history advances", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Resume Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await seedConversation(owner, created.room.id, "Resume thread");
    const first = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Start the shared analysis.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    const firstRun = await db.pool.query<{
      id: string;
      context_fingerprint: string;
      binding_id: string;
      runtime_state_key: string;
    }>(
      `SELECT id,
              model_override_json->'conversation_runtime'->>'context_fingerprint'
                AS context_fingerprint,
              model_override_json->'conversation_runtime'->>'binding_id' AS binding_id,
              model_override_json->'conversation_runtime'->>'runtime_state_key'
                AS runtime_state_key
         FROM runs
        WHERE id = $1`,
      [first.run_ids[0]],
    );
    const firstRuntime = firstRun.rows[0]!;
    await dispatchQueuedRoomRuns([firstRuntime.id]);
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now()
        WHERE id = $1`,
      [firstRuntime.id],
    );
    await releaseConversationTurn(firstRuntime.id);
    await db.pool.query(
      `UPDATE messages
          SET created_at = '2026-01-01T00:00:00.000Z'
        WHERE id = $1`,
      [first.message.id],
    );
    await db.pool.query(
      `UPDATE session_conversation_backends
          SET runtime_session_id = 'vendor-session-1',
              runtime_context_fingerprint = $2,
              runtime_message_cursor_id = $3,
              runtime_session_updated_at = now(),
              updated_at = now()
        WHERE id = $1 AND runtime_state_key = $4`,
      [
        firstRuntime.binding_id,
        firstRuntime.context_fingerprint,
        first.message.id,
        firstRuntime.runtime_state_key,
      ],
    );
    await db.pool.query(
      `UPDATE host_threads
          SET vendor_session_id = 'vendor-session-1', updated_at = now()
        WHERE space_id = 'space-1' AND session_id = $1 AND agent_id = 'agent-1'
          AND container_kind = 'conversation'`,
      [conversation.id],
    );
    await seedConversationMessages(db.pool, {
      space: "space-1", session: conversation.id,
      messages: [{
        id: "agent-message-1", role: "assistant", senderAgentId: "agent-1",
        content: "My own prior answer.", metadata: {}, runId: firstRuntime.id,
        createdAt: "2026-01-01T00:00:01.000Z",
      }],
    });
    await seedConversationMessages(db.pool, {
      space: "space-1", session: conversation.id,
      messages: Array.from({ length: 85 }, (_unused, index) => ({
        id: `bulk-${String(index).padStart(3, "0")}`,
        role: "user",
        userId: "user-2",
        content: `Bulk Room context ${index}`,
        metadata: {},
        createdAt: new Date(Date.parse("2026-01-01T00:00:02.000Z") + index).toISOString(),
      })),
    });
    const memberTurn = await service.sendMessage(member, created.room.id, conversation.id, {
      content: "Add the member-specific constraint.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    await dispatchQueuedRoomRuns(memberTurn.run_ids);
    await seedConversationMessages(db.pool, {
      space: "space-1", session: conversation.id,
      messages: [{
        id: "agent-message-2", role: "assistant", senderAgentId: "agent-1",
        content: "Member-owned answer from the same agent.", metadata: {},
        runId: memberTurn.run_ids[0],
      }],
    });
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [memberTurn.run_ids[0]],
    );
    await releaseConversationTurn(memberTurn.run_ids[0]!);
    const resumed = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Continue with the new constraint.",
      recipient_segments: [{
        recipient_agent_ids: ["agent-1"],
        content: "Apply the owner-specific assigned constraint.",
      }],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    });
    const resumedRun = await db.pool.query<{
      prompt: string;
      runtime_session_id: string | null;
    }>(
      `SELECT prompt,
              model_override_json->'host_thread'->>'runtime_session_id'
                AS runtime_session_id
         FROM runs
        WHERE id = $1`,
      [resumed.run_ids[0]],
    );

    expect(resumedRun.rows[0]?.runtime_session_id).toBe("vendor-session-1");
    // A resumed Host thread receives only the increment after its last
    // completed turn; the older bounded history remains in the vendor
    // session. The assigned segment is still the exact tail of the prompt.
    expect(resumedRun.rows[0]?.prompt?.endsWith("Apply the owner-specific assigned constraint.")).toBe(true);
    expect(resumedRun.rows[0]?.prompt).toContain("Continue with the new constraint.");
    expect(resumedRun.rows[0]?.prompt).not.toContain("Bulk Room context 84");
    expect(resumedRun.rows[0]?.prompt).not.toContain("Member-owned answer from the same agent.");
    expect(resumedRun.rows[0]?.prompt).not.toContain("Start the shared analysis.");
  });

  it("opens a host-bound turn with the Agent's own identity, and only what this Room may hear", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    // The block itself is rendered and audience-tested elsewhere; what this
    // asserts is that the dispatch actually sends it — the call site, which is
    // the half a renderer test cannot reach.
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Identity Room" });
    const conversation = await seedConversation(owner, created.room.id, "Identity");
    await db.pool.query(
      `UPDATE agents SET role_instruction = 'Separate evidence from assumption.' WHERE id = 'agent-1'`,
    );
    const elsewhere = randomUUID();
    await db.pool.query(
      `INSERT INTO rooms (id, space_id, project_id, title, is_mainline, status, created_by_user_id, created_at, updated_at)
       VALUES ($1,'space-1','project-1','Elsewhere',false,'active','user-1',now(),now())`,
      [elsewhere],
    );
    await db.pool.query(
      `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,'space-1',$2,'user-2','member','active',now(),now())`,
      [randomUUID(), elsewhere],
    );
    for (const [content, originRoom] of [
      ["I answer briefly.", null],
      ["this Room wants the recommendation last", created.room.id],
      ["what the other Room said", elsewhere],
    ] as const) {
      await db.pool.query(
        `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                     owner_user_id, agent_id, origin_room_id, sensitivity_level, access_level,
                                     namespace, title, visibility, confidence, importance, version, access_count, created_by)
         VALUES ($1,'space-1','agent',$2,$3::text,'active',now(),now(),'user-1','agent-1',$4,'normal','full',
                 'agent.default',$3::text,'private',1,0.5,1,0,'agent:agent-1')`,
        [randomUUID(), originRoom === null ? "persona" : "note", content, originRoom],
      );
    }

    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "What do you make of this?",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli"}],
    });
    const prompt = (await db.pool.query<{ prompt: string }>(
      "SELECT prompt FROM runs WHERE id = $1", [sent.run_ids[0]],
    )).rows[0]?.prompt ?? "";

    expect(prompt).toContain("Separate evidence from assumption.");
    expect(prompt).toContain("I answer briefly.");
    expect(prompt).toContain("this Room wants the recommendation last");
    // The other Room seats someone this one does not, so what was learned
    // there never reaches this prompt.
    expect(prompt).not.toContain("what the other Room said");

    // And a sibling Agent waiting on this Run is shown the task, not the
    // prompt: one Agent's memory of itself is not another's to read.
    const assignedTask = (await db.pool.query<{ assigned_task: string | null }>(
      `SELECT model_override_json->'chat_turn'->>'assigned_task' AS assigned_task FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    )).rows[0]?.assigned_task;
    expect(assignedTask).toBe("What do you make of this?");
    expect(assignedTask).not.toContain("I answer briefly.");
  });

  it("sends the identity block and Room rules only when the vendor session does not already hold them", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Standing Room" });
    const conversation = await seedConversation(owner, created.room.id, "Standing");
    await db.pool.query(`UPDATE agents SET role_instruction = 'Separate evidence from assumption.' WHERE id = 'agent-1'`);
    const turn = async (content: string) => {
      const sent = await service!.sendMessage(owner, created.room.id, conversation.id, {
        content,
        backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
      });
      const runId = sent.run_ids[0]!;
      const row = (await db.pool.query<{
        prompt: string;
        thread_id: string;
        digest: string;
        sent: string;
      }>(
        `SELECT prompt, host_task_thread_id AS thread_id,
                model_override_json->'host_thread'->>'identity_digest' AS digest,
                model_override_json->'host_thread'->>'identity_sent' AS sent
           FROM runs WHERE id = $1`,
        [runId],
      )).rows[0]!;
      return { runId, ...row };
    };
    const finish = async (run: Awaited<ReturnType<typeof turn>>, landed: boolean) => {
      await dispatchQueuedRoomRuns([run.runId]);
      await db.pool.query(
        `UPDATE runs SET status = $2, ended_at = now(), updated_at = now() WHERE id = $1`,
        [run.runId, landed ? "succeeded" : "failed"],
      );
      await new PgHostThreadRepository(db.pool).recordRunOutcome(run.thread_id, {
        lastRunId: run.runId,
        vendorSessionId: "vendor-standing",
        sessionReset: false,
        landed,
        identity: { digest: run.digest, sent: run.sent === "true" },
      });
    };

    const first = await turn("First question.");
    expect(first.prompt).toContain("Separate evidence from assumption.");
    expect(first.prompt).toContain("[Room execution rules]");
    expect(first.sent).toBe("true");
    await finish(first, true);

    // The resumed session already holds exactly this block.
    const second = await turn("Second question.");
    expect(second.digest).toBe(first.digest);
    expect(second.sent).toBe("false");
    expect(second.prompt).not.toContain("Separate evidence from assumption.");
    expect(second.prompt).not.toContain("[Room execution rules]");
    expect(second.prompt.endsWith("Second question.")).toBe(true);
    await finish(second, true);

    // A revised role is a different block, sent again.
    await db.pool.query(`UPDATE agents SET role_instruction = 'Answer in French.' WHERE id = 'agent-1'`);
    const third = await turn("Third question.");
    expect(third.digest).not.toBe(first.digest);
    expect(third.prompt).toContain("Answer in French.");
    expect(third.prompt).toContain("[Room execution rules]");
    // It failed before it landed, so nothing says the session holds it.
    await finish(third, false);
    const fourth = await turn("Fourth question.");
    expect(fourth.sent).toBe("true");
    expect(fourth.prompt).toContain("Answer in French.");
  });

  describe("session rotation with a self-written handoff", () => {
    async function fullSessionTurn() {
      const owner = { spaceId: "space-1", userId: "user-1" };
      const created = await service!.createRoom(owner, { project_id: "project-1", title: "Rotation Room" });
      const conversation = await seedConversation(owner, created.room.id, "Rotation");
      const first = await service!.sendMessage(owner, created.room.id, conversation.id, {
        content: "Start the refactor.",
        backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
      });
      const firstRunId = first.run_ids[0]!;
      await dispatchQueuedRoomRuns([firstRunId]);
      await db.pool.query(`UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now() WHERE id = $1`, [firstRunId]);
      const thread = (await db.pool.query<{ id: string; digest: string }>(
        `SELECT host_task_thread_id AS id, model_override_json->'host_thread'->>'identity_digest' AS digest
           FROM runs WHERE id = $1`,
        [firstRunId],
      )).rows[0]!;
      // The runtime reported a session at 75 % of a 200k window.
      await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.id, {
        lastRunId: firstRunId,
        vendorSessionId: "vendor-full",
        sessionReset: false,
        landed: true,
        identity: { digest: thread.digest, sent: true },
        contextWindow: { used: 150_000, size: 200_000 },
      });
      const second = await service!.sendMessage(owner, created.room.id, conversation.id, {
        content: "Now the tests.",
        backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
      });
      const runs = await db.pool.query<RunRecord & { kind: string | null }>(
        `SELECT id, status, prompt, capabilities_json, model_override_json, output_json,
                model_override_json->'chat_turn'->>'kind' AS kind
           FROM runs WHERE run_group_id = $1 ORDER BY created_at, id`,
        [second.task_group_ids[0]],
      );
      const handoff = runs.rows.find((run) => run.kind === "handoff")!;
      const turn = runs.rows.find((run) => run.id === second.run_ids[0])!;
      return { owner, created, conversation, thread, handoff, turn, groupId: second.task_group_ids[0]! };
    }

    function projector() {
      return new AgentGroupRunLifecycleProjector(db.pool, loadConfig({
        SERVER_DATABASE_URL: db.connectionUri,
        RAINVER_HOME: testRoot,
      }));
    }

    async function finishHandoff(handoffRunId: string, status: "succeeded" | "failed") {
      await dispatchQueuedRoomRuns([handoffRunId]);
      await db.pool.query(`UPDATE runs SET status = $2, ended_at = now(), updated_at = now() WHERE id = $1`, [handoffRunId, status]);
      const run = await new PgRunRepository(db.pool).getRun("space-1", handoffRunId);
      await projector().markDelegatedRunTerminal(run!);
    }

    it("parks the person's turn behind a handoff turn once the session passes the rotation share", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { handoff, turn, thread } = await fullSessionTurn();
      expect(handoff).toBeDefined();
      expect(handoff.status).toBe("queued");
      expect(handoff.prompt).toContain("[Session handoff]");
      expect(handoff.capabilities_json).toEqual(["handoff.write"]);
      expect(recordOf(recordOf(handoff.model_override_json).host_thread)).toMatchObject({
        thread_id: thread.id,
        runtime_session_id: "vendor-full",
      });
      expect(recordOf(handoff.model_override_json).handoff).toMatchObject({ context_tokens: 150_000, budget_tokens: 8_000 });
      expect(turn.status).toBe("waiting_for_dependency");
      expect(recordOf(recordOf(turn.output_json).waiting_for_results).depends_on_run_ids).toEqual([handoff.id]);
      expect(recordOf(recordOf(turn.model_override_json).handoff_rotation).handoff_run_id).toBe(handoff.id);
      // Only the handoff runs now; the person's turn follows it.
      const jobs = await db.pool.query<{ run_id: string }>(
        `SELECT payload_json->>'run_id' AS run_id FROM jobs WHERE job_type = 'agent_run' AND payload_json->>'run_id' = ANY($1::varchar[])`,
        [[handoff.id, turn.id]],
      );
      expect(jobs.rows.map((row) => row.run_id)).toEqual([handoff.id]);
    });

    it("renews the session from the handoff the Agent wrote, and the late handoff outcome cannot undo it", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { handoff, turn, thread, conversation } = await fullSessionTurn();
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      const executors = new Map<SystemActionId, SystemActionExecutor>();
      const handoffRecord = (await new PgRunRepository(db.pool).getRun("space-1", handoff.id))!;
      registerAgentHandoffExecutors(executors, config, handoffRecord);
      const write = executors.get("handoff.write" as SystemActionId)!;
      const context = { actor: { type: "agent" as const, space_id: "space-1" }, visibility: "agent_tool" as const };
      const firstWrite = await write({ goal: "Refactor the parser.", decisions: "Keep the public API.", next_step: "Write the tests." }, context);
      // A second call in the same turn corrects the first rather than adding one.
      const secondWrite = await write({
        goal: "Refactor the parser.",
        decisions: "Keep the public API; drop the legacy flag.",
        files: "src/parser.ts — split into lexer and parser.",
        next_step: "Write the tests for the lexer.",
      }, context);
      expect(recordOf(recordOf(secondWrite).modelResult).artifact_id).toBe(recordOf(recordOf(firstWrite).modelResult).artifact_id);
      const artifacts = await db.pool.query<{ id: string; content: string; visibility: string }>(
        `SELECT id, content, visibility FROM artifacts WHERE artifact_type = 'agent_handoff' AND run_id = $1`,
        [handoff.id],
      );
      expect(artifacts.rows).toHaveLength(1);
      expect(artifacts.rows[0]!.content).toContain("drop the legacy flag");
      expect(artifacts.rows[0]!.visibility).toBe("selected_users");

      await finishHandoff(handoff.id, "succeeded");

      const renewed = (await new PgRunRepository(db.pool).getRun("space-1", turn.id))!;
      expect(renewed.status).toBe("queued");
      expect(renewed.prompt).toContain("[Handoff you wrote before this session was renewed]");
      expect(renewed.prompt).toContain("Write the tests for the lexer.");
      expect(renewed.prompt).toContain("[Room execution rules]");
      expect(renewed.prompt).toContain("You are now in");
      expect(renewed.prompt?.endsWith("Now the tests.")).toBe(true);
      expect(renewed.prompt).not.toContain("[Replies already given to this same message]");
      expect(recordOf(recordOf(renewed.model_override_json).host_thread)).toMatchObject({
        runtime_session_id: null,
        fresh: true,
        identity_sent: true,
      });
      const threadRow = async () => (await db.pool.query<{
        status: string; vendor_session_id: string | null; handoff_artifact_id: string | null; context_tokens: number | null;
      }>(
        `SELECT status, vendor_session_id, handoff_artifact_id, context_tokens FROM host_threads WHERE id = $1`,
        [thread.id],
      )).rows[0];
      expect(await threadRow()).toMatchObject({
        status: "session_reset",
        vendor_session_id: null,
        handoff_artifact_id: artifacts.rows[0]!.id,
        context_tokens: null,
      });
      const marker = await db.pool.query(
        `SELECT 1 FROM messages WHERE session_id = $1 AND metadata_json->>'room_display' = 'internal'
            AND metadata_json->>'continuation_event_kind' = 'session_handoff'`,
        [conversation.id],
      );
      expect(marker.rowCount).toBe(1);

      // The handoff Run's own outcome is recorded after its successor was
      // admitted; it must not write the retired session back.
      await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.id, {
        lastRunId: handoff.id,
        vendorSessionId: "vendor-full",
        sessionReset: false,
        landed: true,
        identity: null,
      });
      expect(await threadRow()).toMatchObject({ status: "session_reset", vendor_session_id: null });
    });

    it("keeps the old session when the handoff fails, and retries only once the session has grown", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { handoff, turn, thread, owner, created, conversation } = await fullSessionTurn();
      await finishHandoff(handoff.id, "failed");

      const resumed = (await new PgRunRepository(db.pool).getRun("space-1", turn.id))!;
      expect(resumed.status).toBe("queued");
      expect(resumed.prompt).not.toContain("[Handoff you wrote");
      expect(recordOf(recordOf(resumed.model_override_json).host_thread).runtime_session_id).toBe("vendor-full");
      const warning = await db.pool.query(
        `SELECT 1 FROM run_events WHERE run_id = $1 AND event_type = 'warning' AND metadata_json->>'handoff_run_id' = $2`,
        [turn.id, handoff.id],
      );
      expect(warning.rowCount).toBe(1);
      await expect(db.pool.query(`SELECT vendor_session_id FROM host_threads WHERE id = $1`, [thread.id]))
        .resolves.toMatchObject({ rows: [{ vendor_session_id: "vendor-full" }] });

      // Each turn grows the session a little; the failed handoff is not
      // retried until it has grown by a tenth of the window.
      const finishTurn = async (runId: string, used: number) => {
        await dispatchQueuedRoomRuns([runId]);
        await db.pool.query(`UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now() WHERE id = $1`, [runId]);
        await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.id, {
          lastRunId: runId, vendorSessionId: "vendor-full", sessionReset: false, landed: true, identity: null,
          contextWindow: { used, size: 200_000 },
        });
      };
      const nextKinds = async (content: string) => {
        const next = await service!.sendMessage(owner, created.room.id, conversation.id, {
          content,
          backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
        });
        const rows = await db.pool.query<{ id: string; kind: string | null }>(
          `SELECT id, model_override_json->'chat_turn'->>'kind' AS kind FROM runs WHERE run_group_id = $1 ORDER BY created_at, id`,
          [next.task_group_ids[0]],
        );
        return { runId: next.run_ids[0]!, kinds: rows.rows.map((row) => row.kind) };
      };
      await finishTurn(turn.id, 158_000);
      const quiet = await nextKinds("Keep going.");
      expect(quiet.kinds).toEqual([null]);
      await finishTurn(quiet.runId, 171_000);
      const retried = await nextKinds("And the docs.");
      expect([...retried.kinds].sort()).toEqual(["handoff", null]);
    });

    it("keeps a later recipient's handoff out of the replies and off the group timeline", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const owner = { spaceId: "space-1", userId: "user-1" };
      const now = new Date().toISOString();
      await seedSpecialist(now, "agent-2", "version-2", "Research Specialist");
      const created = await service.createRoom(owner, { project_id: "project-1", title: "Chain Room" });
      await db.pool.query(
        `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
         VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
        [randomUUID(), created.room.id, now],
      );
      const conversation = await seedConversation(owner, created.room.id, "Chain");
      const send = (content: string) => service!.sendMessage(owner, created.room.id, conversation.id, {
        content,
        recipient_segments: [{ recipient_agent_ids: ["agent-1", "agent-2"], content }],
        backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
      });
      const finish = async (runId: string, used: number | null) => {
        await dispatchQueuedRoomRuns([runId]);
        await db.pool.query(`UPDATE runs SET status = 'succeeded', output_json = $2::jsonb, ended_at = now(), updated_at = now() WHERE id = $1`,
          [runId, JSON.stringify({ schema_version: "run_output.v1", status: "succeeded", summary: `reply of ${runId}`, result: {}, output_manifest: [] })]);
        const run = (await new PgRunRepository(db.pool).getRun("space-1", runId))!;
        await new PgHostThreadRepository(db.pool).recordRunOutcome(run.host_task_thread_id!, {
          lastRunId: runId, vendorSessionId: `vendor-${run.agent_id}`, sessionReset: false, landed: true, identity: null,
          ...(used === null ? {} : { contextWindow: { used, size: 200_000 } }),
        });
        await projector().markDelegatedRunTerminal(run);
      };
      const first = await send("First round.");
      await finish(first.run_ids[0]!, 10_000);
      await finish(first.run_ids[1]!, 150_000);

      const second = await send("Second round.");
      const [lead, specialist] = second.run_ids as [string, string];
      const handoff = (await db.pool.query<{ id: string; prompt: string }>(
        `SELECT id, prompt FROM runs WHERE run_group_id = $1 AND model_override_json->'chat_turn'->>'kind' = 'handoff'`,
        [second.task_group_ids[0]],
      )).rows[0]!;
      expect(handoff).toBeDefined();
      await finish(lead, 12_000);
      const admittedHandoff = (await new PgRunRepository(db.pool).getRun("space-1", handoff.id))!;
      expect(admittedHandoff.status).toBe("queued");
      expect(admittedHandoff.prompt).toBe(handoff.prompt);

      await dispatchQueuedRoomRuns([handoff.id]);
      await db.pool.query(`UPDATE runs SET status = 'succeeded', output_json = $2::jsonb, ended_at = now(), updated_at = now() WHERE id = $1`,
        [handoff.id, JSON.stringify({ schema_version: "run_output.v1", status: "succeeded", summary: "handoff done", result: {}, output_manifest: [] })]);
      await projector().markDelegatedRunTerminal((await new PgRunRepository(db.pool).getRun("space-1", handoff.id))!);
      const admittedSpecialist = (await new PgRunRepository(db.pool).getRun("space-1", specialist))!;
      expect(admittedSpecialist.prompt).toContain(`reply of ${lead}`);
      expect(admittedSpecialist.prompt).not.toContain("handoff done");
      const timeline = await db.pool.query<{ run_id: string | null }>(
        `SELECT run_id FROM agent_run_messages WHERE group_id = $1`,
        [second.task_group_ids[0]],
      );
      expect(timeline.rows.map((row) => row.run_id)).not.toContain(handoff.id);
    });

    it("does not rotate a session that changed while its handoff ran", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { handoff, turn, thread } = await fullSessionTurn();
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      const executors = new Map<SystemActionId, SystemActionExecutor>();
      registerAgentHandoffExecutors(executors, config, (await new PgRunRepository(db.pool).getRun("space-1", handoff.id))!);
      await executors.get("handoff.write" as SystemActionId)!(
        { goal: "g", decisions: "d", next_step: "n" },
        { actor: { type: "agent", space_id: "space-1" }, visibility: "agent_tool" },
      );
      // The person reset the Agent's context while the handoff was running.
      await new PgHostThreadRepository(db.pool).resetConversationAgent(thread.id);
      await finishHandoff(handoff.id, "succeeded");
      const admitted = (await new PgRunRepository(db.pool).getRun("space-1", turn.id))!;
      expect(admitted.prompt).not.toContain("[Handoff you wrote");
      await expect(db.pool.query(`SELECT handoff_artifact_id FROM host_threads WHERE id = $1`, [thread.id]))
        .resolves.toMatchObject({ rows: [{ handoff_artifact_id: null }] });
    });

    it("replays from the handoff when the renewed session's first turn never started one", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { handoff, turn, thread, owner, created, conversation } = await fullSessionTurn();
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      const executors = new Map<SystemActionId, SystemActionExecutor>();
      registerAgentHandoffExecutors(executors, config, (await new PgRunRepository(db.pool).getRun("space-1", handoff.id))!);
      await executors.get("handoff.write" as SystemActionId)!(
        { goal: "Refactor the parser.", decisions: "Keep the API.", next_step: "Lexer tests." },
        { actor: { type: "agent", space_id: "space-1" }, visibility: "agent_tool" },
      );
      await finishHandoff(handoff.id, "succeeded");
      // The renewed turn fails before the runtime opened a session.
      await dispatchQueuedRoomRuns([turn.id]);
      await db.pool.query(`UPDATE runs SET status = 'failed', ended_at = now(), updated_at = now() WHERE id = $1`, [turn.id]);
      await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.id, {
        lastRunId: turn.id, vendorSessionId: null, sessionReset: false, landed: false, identity: null,
      });
      const next = await service!.sendMessage(owner, created.room.id, conversation.id, {
        content: "Try again.",
        backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
      });
      const prompt = (await db.pool.query<{ prompt: string }>(`SELECT prompt FROM runs WHERE id = $1`, [next.run_ids[0]])).rows[0]!.prompt;
      expect(prompt).toContain("You are now in");
      expect(prompt).toContain("[Handoff you wrote before this session was renewed]");
      expect(prompt).toContain("Lexer tests.");
      expect(prompt).toContain("[Room execution rules]");
    });
  });

  describe("bounded discussions among a conversation's Agents", () => {
    const finalizerDeps = {
      loadActionPreviews: async () => [],
      continuity: {
        async finalizeChatTurn() { return {} as never; },
        async runSemanticExtraction() { return null; },
      },
    };

    /**
     * Runs one queued turn to completion with `reply`, the way the job handler
     * would. `quotaSource` is what the projector's quota gate reads when it
     * admits the next Agent-triggered Run.
     */
    async function completeTurn(runId: string, reply: string, quotaSource?: QuotaSource) {
      const runs = new PgRunRepository(db.pool);
      await dispatchQueuedRoomRuns([runId]);
      await db.pool.query(
        `UPDATE runs SET status = 'succeeded', output_json = $2::jsonb, ended_at = now(), updated_at = now() WHERE id = $1`,
        [runId, JSON.stringify({ schema_version: "run_output.v1", status: "succeeded", summary: reply, result: {}, output_manifest: [] })],
      );
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      await new AgentGroupRunLifecycleProjector(db.pool, config, quotaSource).markDelegatedRunTerminal((await runs.getRun("space-1", runId))!);
      await releaseConversationTurn(runId);
      await finalizeChatTurn(config, runs, (await runs.getRun("space-1", runId))!, finalizerDeps);
    }

    /** Fails one queued turn the way a vendor CLI's refusal would. */
    async function failTurn(runId: string, errorCode: string, errorText: string) {
      const runs = new PgRunRepository(db.pool);
      await dispatchQueuedRoomRuns([runId]);
      await db.pool.query(
        `UPDATE runs SET status = 'failed', error_json = $2::jsonb, error_message = $3, ended_at = now(), updated_at = now() WHERE id = $1`,
        [runId, JSON.stringify({ error_code: errorCode, error_text: errorText }), errorText],
      );
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      await new AgentGroupRunLifecycleProjector(db.pool, config).markDelegatedRunTerminal((await runs.getRun("space-1", runId))!);
      await releaseConversationTurn(runId);
      await finalizeChatTurn(config, runs, (await runs.getRun("space-1", runId))!, finalizerDeps);
    }

    /** The conversation fixture's one CLI login (host-1's managed Claude Code) at `pct` of its 5-hour window, read now. */
    async function seedQuota(pct: number, resetsAt: string) {
      await db.pool.query(
        `INSERT INTO host_runtime_usage (host_id, runtime_key, installation, quota_json, checked_at)
         VALUES ('host-1', 'claude_code', 'managed:1.0.0', $1::jsonb, now())
         ON CONFLICT (host_id, runtime_key, installation) DO UPDATE SET quota_json = EXCLUDED.quota_json, checked_at = now()`,
        [JSON.stringify({ available: true, session_pct: pct, session_resets: `Resets ${resetsAt}`, week_pct: 10, week_resets: null, error: null })],
      );
    }

    async function hasRunJob(runId: string) {
      const jobs = await db.pool.query(`SELECT 1 FROM jobs WHERE job_type = 'agent_run' AND payload_json->>'run_id' = $1`, [runId]);
      return (jobs.rowCount ?? 0) > 0;
    }

    async function quotaMarker(runId: string) {
      return (await db.pool.query<{ marker: Record<string, unknown> | null }>(
        `SELECT output_json->'waiting_for_quota' AS marker FROM runs WHERE id = $1`,
        [runId],
      )).rows[0]!.marker;
    }

    function fixedQuota(utilization: number): QuotaSource {
      return { read: async () => ({ window: { kind: "session", utilization, resets_at: null }, checked_at: new Date().toISOString() }) };
    }

    async function queuedRunsFor(sessionId: string, agentId: string) {
      return (await db.pool.query<{ id: string; prompt: string; instructed_by_user_id: string; discussion_id: string | null; status: string }>(
        `SELECT run.id, run.prompt, run.instructed_by_user_id, grp.discussion_id, run.status
           FROM runs run JOIN agent_run_groups grp ON grp.id = run.run_group_id
          WHERE run.session_id = $1 AND run.agent_id = $2 AND run.status IN ('queued', 'waiting_for_dependency')
          ORDER BY run.created_at DESC`,
        [sessionId, agentId],
      )).rows;
    }

    async function discussionFor(sessionId: string) {
      return (await db.pool.query<{
        id: string; kind: string; status: string; stop_reason: string | null; rounds_used: number; round_cap: number; round_base: number;
        turns_used: number; held_mentions_json: Array<{ agent_id: string }>; conclusion_message_id: string | null; shape: string;
      }>(`SELECT * FROM room_discussions WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [sessionId])).rows[0];
    }

    async function roomWithSpecialist(title: string) {
      const owner = { spaceId: "space-1", userId: "user-1" };
      const now = new Date().toISOString();
      await seedSpecialist(now, "agent-2", "version-2", "Research Specialist");
      const created = await service!.createRoom(owner, { project_id: "project-1", title });
      await db.pool.query(
        `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
         VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
        [randomUUID(), created.room.id, now],
      );
      const conversation = await seedConversation(owner, created.room.id, title);
      const manager = (await db.pool.query<{ name: string }>(`SELECT name FROM agents WHERE id = 'agent-1'`)).rows[0]!.name;
      return { owner, created, conversation, manager };
    }

    it("turns an Agent's @ into a bounded emergent discussion that the Manager closes", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation, manager } = await roomWithSpecialist("Emergent");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "I will ask @Research Specialist to check the numbers first.");

      const emergent = await discussionFor(conversation.id);
      expect(emergent).toMatchObject({ kind: "emergent", status: "active", rounds_used: 2, round_cap: 2, turns_used: 1 });
      const [wave1] = await queuedRunsFor(conversation.id, "agent-2");
      // Executed as the person whose message is the container, with their authority.
      expect(wave1).toMatchObject({ instructed_by_user_id: "user-1", discussion_id: emergent!.id });
      expect(wave1!.prompt).toContain("addressed you");
      expect(wave1!.prompt).toContain("check the numbers first");
      const stamped = await db.pool.query<{ id: string; wave: string }>(
        `SELECT id, metadata_json->>'wave' AS wave FROM messages WHERE discussion_id = $1 ORDER BY path_depth`,
        [emergent!.id],
      );
      expect(stamped.rows.map((row) => row.wave)).toEqual(["0", "0", "1"]);
      expect(stamped.rows[0]!.id).toBe(first.message.id);

      // The second round addresses the Manager again: past the emergent cap.
      await completeTurn(wave1!.id, `Checked. @${manager} please review before we ship.`);
      const capped = await discussionFor(conversation.id);
      expect(capped).toMatchObject({ status: "cap_reached", stop_reason: "round_cap" });
      expect(capped!.held_mentions_json.map((held) => held.agent_id)).toEqual(["agent-1"]);
      const notice = await db.pool.query<{ content: string; kind: string }>(
        `SELECT content, metadata_json->'discussion_notice'->>'kind' AS kind FROM messages
          WHERE discussion_id = $1 AND metadata_json->>'room_display' = 'system_notice'`,
        [capped!.id],
      );
      expect(notice.rows).toEqual([expect.objectContaining({ kind: "cap_reached" })]);
      const [closing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(closing!.prompt).toContain("write the conclusion");
      await completeTurn(closing!.id, "Conclusion: the numbers hold; review is pending.");
      const concluded = await discussionFor(conversation.id);
      expect(concluded!.status).toBe("cap_reached");
      expect(concluded!.conclusion_message_id).toEqual(expect.any(String));

      // Opening it as a discussion dispatches the Agent it held back.
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const extended = await discussions.extend(owner, created.room.id, conversation.id, capped!.id, 2);
      expect(extended).toMatchObject({ kind: "explicit", status: "active", held_mentions: [] });
      const [review] = await queuedRunsFor(conversation.id, "agent-1");
      expect(review!.prompt).toContain("please review before we ship");

      // Stopped while that round runs: it finishes, and the Manager closes.
      await expect(discussions.stop(owner, created.room.id, conversation.id, capped!.id))
        .resolves.toMatchObject({ status: "stopped" });
      await completeTurn(review!.id, "Reviewed; ship it.");
      const [finalClosing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(finalClosing!.prompt).toContain("a person stopped it");
      await completeTurn(finalClosing!.id, "Conclusion: shipped after review.");
      await expect(discussionFor(conversation.id)).resolves.toMatchObject({ status: "closed" });
    });

    it("ends a turn on its runtime's own question as an awaiting-answer reply, and the discussion carries on", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Asked");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "I will ask @Research Specialist which build to ship.");
      const [asking] = await queuedRunsFor(conversation.id, "agent-2");

      // What the adapter reports when the runtime's own prompt ended the turn
      // (`modules/runtime-adapters.md`): a succeeded Run whose output carries the question.
      const runs = new PgRunRepository(db.pool);
      await dispatchQueuedRoomRuns([asking!.id]);
      await db.pool.query(
        `UPDATE runs SET status = 'succeeded', output_json = $2::jsonb, ended_at = now(), updated_at = now() WHERE id = $1`,
        [asking!.id, JSON.stringify({
          schema_version: "run_output.v1",
          status: "succeeded",
          summary: "Both builds pass.",
          result: { asked_user: { question: "Which build should ship?", options: ["Nightly", "Stable — last week's"] } },
          output_manifest: [],
        })],
      );
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      await new AgentGroupRunLifecycleProjector(db.pool, config).markDelegatedRunTerminal((await runs.getRun("space-1", asking!.id))!);
      await releaseConversationTurn(asking!.id);
      await expect(finalizeChatTurn(config, runs, (await runs.getRun("space-1", asking!.id))!, finalizerDeps))
        .resolves.toMatchObject({ ok: true, reply: expect.stringContaining("Which build should ship?") });

      const replies = await service.listMessages(owner, created.room.id, conversation.id, { limit: 50, offset: 0 });
      expect(replies.items.find((message) => message.run_id === asking!.id)).toMatchObject({
        content: "Both builds pass.\n\nWhich build should ship?\n\n- Nightly\n- Stable — last week's",
        metadata_json: { awaiting_answer: true, status: "succeeded" },
      });
      // A completed turn, not a failure: the wave ends and the Manager closes.
      const [closing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(closing?.prompt).toContain("Which build should ship?");
    });

    it("converges an explicit discussion when a round addresses nobody", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Explicit");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Which database should we use?",
        participant_agent_ids: ["agent-2"],
        shape: "open",
      });
      expect(opened.discussion).toMatchObject({ kind: "explicit", round_cap: 3, rounds_used: 1, spend_cap_usd: 2 });
      expect(opened.message).toMatchObject({ discussion_id: opened.discussion.id, content: "Which database should we use?" });
      // A second one cannot open while this one runs.
      await expect(discussions.open(owner, created.room.id, conversation.id, {
        topic: "Another", participant_agent_ids: ["agent-2"], shape: "open",
      })).rejects.toMatchObject({ statusCode: 409 });

      await completeTurn(opened.run_ids[0]!, "Postgres; nothing else is needed.");
      await expect(discussionFor(conversation.id)).resolves.toMatchObject({ status: "converged" });
      const [closing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(closing!.prompt).toContain("converged");
      await completeTurn(closing!.id, "Agreed: Postgres.");
      const closed = await discussionFor(conversation.id);
      expect(closed).toMatchObject({ status: "closed" });
      const detail = await discussions.get(owner, created.room.id, conversation.id, closed!.id);
      expect(detail.waves.map((wave) => [wave.wave, wave.closing])).toEqual([[0, false], [1, true]]);
    });

    it("keeps a debate's first round independent, then puts every answer in front of everyone", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Debate");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Monolith or services?",
        participant_agent_ids: ["agent-1", "agent-2"],
        shape: "debate",
      });
      expect(opened.discussion.round_cap).toBe(2);
      const [first, second] = opened.run_ids as [string, string];
      await completeTurn(first, "Monolith: one team, one deploy.");
      const admitted = (await new PgRunRepository(db.pool).getRun("space-1", second))!;
      expect(admitted.status).toBe("queued");
      expect(admitted.prompt).not.toContain("Replies already given");
      expect(admitted.prompt).not.toContain("one team, one deploy");
      await completeTurn(second, "Services: independent scaling.");
      const critique = await db.pool.query<{ id: string; prompt: string }>(
        `SELECT run.id, run.prompt FROM runs run JOIN agent_run_groups grp ON grp.id = run.run_group_id
          WHERE grp.discussion_id = $1 AND run.status IN ('queued', 'waiting_for_dependency') ORDER BY run.created_at`,
        [opened.discussion.id],
      );
      expect(critique.rows).toHaveLength(2);
      // Each is handed every answer of the first round, the one before its own included.
      for (const row of critique.rows) {
        expect(row.prompt).toContain("Critique the others");
        expect(row.prompt).toContain("one team, one deploy");
        expect(row.prompt).toContain("independent scaling");
      }
    });

    it("tells the person when an addressed Agent cannot be set working by them", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Private");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Who can help?" });
      // The specialist runs on user-2's own machine: only user-2 may set it working.
      await db.pool.query(
        `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, last_heartbeat_at,
                            capabilities_json, created_at, updated_at)
         VALUES ('host-user-2', 'user-2', 'machine-1', 'User 2 laptop', 'remote', 'linux_native', 'online', now(), '{}'::jsonb, now(), now())`,
      );
      const moved = await db.pool.query(
        `UPDATE host_threads SET execution_host_id = 'host-user-2'
          WHERE session_id = $1 AND agent_id = 'agent-2' AND container_kind = 'conversation'`,
        [conversation.id],
      );
      expect(moved.rowCount).toBe(1);
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist.");
      const discussion = await discussionFor(conversation.id);
      expect(await queuedRunsFor(conversation.id, "agent-2")).toEqual([]);
      const notice = await db.pool.query<{ kind: string }>(
        `SELECT metadata_json->'discussion_notice'->>'kind' AS kind FROM messages WHERE discussion_id = $1 AND role = 'system'
            AND metadata_json->>'room_display' = 'system_notice'`,
        [discussion!.id],
      );
      expect(notice.rows).toEqual([{ kind: "not_admitted" }]);
      // Nobody was set working, so there is nothing for the Manager to conclude.
      expect(discussion).toMatchObject({ status: "closed" });
      expect(await queuedRunsFor(conversation.id, "agent-1")).toEqual([]);
      const reason = (await db.pool.query<{ content: string }>(
        `SELECT content FROM messages WHERE discussion_id = $1 AND metadata_json ? 'discussion_notice'`,
        [discussion!.id],
      )).rows[0]!.content;
      expect(reason).toContain("only its owner can set it working");
    });

    it("ends a discussion visibly when its next wave cannot be dispatched", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Offline");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Who owns the migration?", participant_agent_ids: ["agent-2"], shape: "open",
      });
      // The conversation's Host drops off before the next wave goes out.
      await db.pool.query(`UPDATE hosts SET status = 'offline' WHERE id = 'host-1'`);
      const manager = (await db.pool.query<{ name: string }>(`SELECT name FROM agents WHERE id = 'agent-1'`)).rows[0]!.name;
      await completeTurn(opened.run_ids[0]!, `@${manager} can you decide?`);
      await db.pool.query(`UPDATE hosts SET status = 'online', last_heartbeat_at = now() WHERE id = 'host-1'`);
      const ended = await discussionFor(conversation.id);
      expect(ended).toMatchObject({ status: "closed", stop_reason: "dispatch_failed" });
      const notice = await db.pool.query<{ kind: string }>(
        `SELECT metadata_json->'discussion_notice'->>'kind' AS kind FROM messages WHERE discussion_id = $1 AND metadata_json ? 'discussion_notice'`,
        [ended!.id],
      );
      expect(notice.rows).toEqual([{ kind: "failed" }]);
      // The slot is free again.
      await expect(discussions.open(owner, created.room.id, conversation.id, {
        topic: "Try again", participant_agent_ids: ["agent-2"], shape: "open",
      })).resolves.toMatchObject({ discussion: { status: "active" } });
    });

    it("keeps a delegation result that arrives after a stop inside the ended discussion, delegating nothing", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Late result");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Audit the schema", participant_agent_ids: ["agent-2"], shape: "open",
      });
      await discussions.stop(owner, created.room.id, conversation.id, opened.discussion.id);
      const client = await db.pool.connect();
      try {
        const late = await agentOriginContinuation(client, "space-1", opened.task_group_ids[0]!);
        expect(late).toEqual({
          discussion: { id: opened.discussion.id, wave: 0 },
          delegation_budget: { max_depth: 1, max_fanout: 0 },
        });
      } finally {
        client.release();
      }
      // Nothing new opens: the conversation still has no second discussion.
      const rows = await db.pool.query(`SELECT id FROM room_discussions WHERE session_id = $1`, [conversation.id]);
      expect(rows.rowCount).toBe(1);
    });

    it("posts a discussion's notices even after the person it ran for left the Room", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Departed");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Plan the cutover", participant_agent_ids: ["agent-2"], shape: "open",
      });
      await db.pool.query(`UPDATE room_user_members SET status = 'removed' WHERE room_id = $1 AND user_id = 'user-1'`, [created.room.id]);
      const manager = (await db.pool.query<{ name: string }>(`SELECT name FROM agents WHERE id = 'agent-1'`)).rows[0]!.name;
      await completeTurn(opened.run_ids[0]!, `@${manager} please sign off.`);
      const ended = await discussionFor(conversation.id);
      expect(ended).toMatchObject({ status: "closed", stop_reason: "dispatch_failed" });
      const notice = await db.pool.query<{ kind: string; user_id: string | null }>(
        `SELECT metadata_json->'discussion_notice'->>'kind' AS kind, user_id FROM messages
          WHERE discussion_id = $1 AND metadata_json ? 'discussion_notice'`,
        [ended!.id],
      );
      expect(notice.rows).toEqual([{ kind: "failed", user_id: null }]);
    });

    it("queues a person's message during a turn and posts it at the next turn boundary", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Queue");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Start." });
      // Without queue the taken turn is refused, as before.
      await expect(service.sendMessage(owner, created.room.id, conversation.id, { content: "Also this." }))
        .rejects.toMatchObject({
          statusCode: 409,
          responseBody: { detail: expect.stringContaining("still in progress"), code: "conversation_turn_in_progress" },
        });
      const waiting = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Also this." });
      expect(waiting).toMatchObject({ queued: { status: "queued", content: "Also this." } });
      const withdrawn = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Never mind." });
      await service.withdrawQueuedMessage(owner, created.room.id, conversation.id, (withdrawn as { queued: { id: string } }).queued.id);
      const page = await service.listMessages(owner, created.room.id, conversation.id, { limit: 50, offset: 0 });
      // Waiting, not in the conversation yet: no prompt or replay can see it.
      expect(page.items.map((message) => message.content)).not.toContain("Also this.");
      expect(page.queued.map((item) => item.content)).toEqual(["Also this."]);

      await completeTurn(first.run_ids[0]!, "Started.");
      const after = await service.listMessages(owner, created.room.id, conversation.id, { limit: 50, offset: 0 });
      expect(after.queued).toEqual([]);
      const posted = after.items.find((message) => message.content === "Also this.");
      expect(posted).toMatchObject({ role: "user", user_id: "user-1" });
      expect(after.items.map((message) => message.content)).not.toContain("Never mind.");
      const [dispatched] = await queuedRunsFor(conversation.id, "agent-1");
      expect(dispatched).toMatchObject({ instructed_by_user_id: "user-1" });
    });

    it("admits a queued message between a discussion's waves as a new first round", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation, manager } = await roomWithSpecialist("Queue in discussion");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Plan the migration", participant_agent_ids: ["agent-2"], shape: "open", round_cap: 2,
      });
      const waiting = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, {
        content: "Keep it under a day of downtime.",
      });
      expect("queued" in waiting).toBe(true);
      // The specialist addressed the Manager; the person's message goes first.
      await completeTurn(opened.run_ids[0]!, `@${manager} can you size the downtime?`);
      const d1 = await discussionFor(conversation.id);
      expect(d1).toMatchObject({ status: "active", round_base: 1, rounds_used: 2 });
      expect(d1!.held_mentions_json.map((held) => held.agent_id)).toEqual(["agent-1"]);
      const personTurn = (await db.pool.query<{ id: string; wave: string }>(
        `SELECT id, metadata_json->>'wave' AS wave FROM messages WHERE session_id = $1 AND content = 'Keep it under a day of downtime.'`,
        [conversation.id],
      )).rows[0]!;
      expect(personTurn.wave).toBe("1");
      // Its reply addresses nobody, but the held Manager still follows it —
      // and the round cap counts from the person's message again.
      const [managerTurn] = await queuedRunsFor(conversation.id, "agent-1");
      await completeTurn(managerTurn!.id, "Noted.");
      const d2 = await discussionFor(conversation.id);
      expect(d2).toMatchObject({ status: "active", rounds_used: 3 });
      const [heldTurn] = await queuedRunsFor(conversation.id, "agent-1");
      expect(heldTurn!.prompt).toContain("size the downtime");
      expect(heldTurn!.prompt).toContain("round 2 of 2");
    });

    it("posts waiting messages in order, keeping one that cannot be posted visible without blocking the rest", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Queue failure");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Start." });
      const broken = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "To nobody." });
      await db.pool.query(
        `UPDATE room_queued_messages SET request_json = jsonb_set(request_json, '{recipient_segments}', $2::jsonb) WHERE id = $1`,
        [(broken as { queued: { id: string } }).queued.id, JSON.stringify([{ recipient_agent_ids: ["agent-missing"], content: "To nobody." }])],
      );
      await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Second." });
      // The turn frees without a boundary releasing anything: a new message
      // still goes behind the ones already waiting.
      await dispatchQueuedRoomRuns([first.run_ids[0]!]);
      await db.pool.query(`UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now() WHERE id = $1`, [first.run_ids[0]]);
      await releaseConversationTurn(first.run_ids[0]!);
      const third = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Third." });
      expect(third).toMatchObject({ queued: { status: "queued" } });

      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      expect(await discussions.releaseQueued("space-1", conversation.id)).toBe("released");
      const page = await service.listMessages(owner, created.room.id, conversation.id, { limit: 50, offset: 0 });
      expect(page.items.map((message) => message.content)).toContain("Second.");
      expect(page.items.map((message) => message.content)).not.toContain("Third.");
      expect(page.queued.map((item) => [item.content, item.status])).toEqual([["To nobody.", "failed"], ["Third.", "queued"]]);
      expect(page.queued[0]!.failure_reason).toBeTruthy();
      // Its sender dismisses the failed one.
      await service.withdrawQueuedMessage(owner, created.room.id, conversation.id, page.queued[0]!.id);
      const after = await service.listMessages(owner, created.room.id, conversation.id, { limit: 50, offset: 0 });
      expect(after.queued.map((item) => item.content)).toEqual(["Third."]);
      // A release job stands behind every queued message.
      const jobs = await db.pool.query(
        `SELECT 1 FROM jobs WHERE job_type = 'room_queued_message_release' AND payload_json->>'session_id' = $1`,
        [conversation.id],
      );
      expect(jobs.rowCount).toBe(3);
    });

    it("advances a discussion as usual when its waiting message was withdrawn before the wave ended", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation, manager } = await roomWithSpecialist("Queue withdrawn");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Plan the migration", participant_agent_ids: ["agent-2"], shape: "open", round_cap: 2,
      });
      const waiting = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Actually, wait." });
      await service.withdrawQueuedMessage(owner, created.room.id, conversation.id, (waiting as { queued: { id: string } }).queued.id);
      await completeTurn(opened.run_ids[0]!, `@${manager} can you size the downtime?`);
      expect(await discussionFor(conversation.id)).toMatchObject({ status: "active", round_base: 0, rounds_used: 2, held_mentions_json: [] });
      const [next] = await queuedRunsFor(conversation.id, "agent-1");
      expect(next!.prompt).toContain("size the downtime");
    });

    it("runs a discussion for the member whose waiting message restarted its rounds", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation, manager } = await roomWithSpecialist("Queue other member");
      await addRoomMember(created.room.id, "user-2");
      await db.pool.query(`UPDATE project_members SET role = 'member' WHERE project_id = 'project-1' AND user_id = 'user-2'`);
      const member = { spaceId: "space-1", userId: "user-2" };
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Plan the migration", participant_agent_ids: ["agent-2"], shape: "open", round_cap: 2,
      });
      await service.sendOrQueueMessage(member, created.room.id, conversation.id, { content: "Keep it cheap." });
      await completeTurn(opened.run_ids[0]!, `@${manager} can you size the downtime?`);
      const discussion = await db.pool.query<{ opened_by_user_id: string; round_base: number; spend_cap_usd: string | null }>(
        `SELECT opened_by_user_id, round_base, spend_cap_usd FROM room_discussions WHERE session_id = $1`,
        [conversation.id],
      );
      // Its new rounds are that member's decision: their authority, the same spend cap.
      expect(discussion.rows[0]).toMatchObject({ opened_by_user_id: "user-2", round_base: 1 });
      expect(Number(discussion.rows[0]!.spend_cap_usd)).toBe(2);
      const [personTurn] = await queuedRunsFor(conversation.id, "agent-1");
      expect(personTurn).toMatchObject({ instructed_by_user_id: "user-2" });
    });

    it("charges an Agent-started research result to the container of the turn that started it", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Research container");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Research this." });
      await completeTurn(first.run_ids[0]!, "I started the research.");
      const origin = first.task_group_ids[0]!;
      const registry = new JobHandlerRegistry();
      registerResearchOperationFailureNotifyHandler(registry, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }));
      await registry.dispatch({
        job_id: randomUUID(), space_id: "space-1", user_id: "user-1", job_type: RESEARCH_OPERATION_FAILURE_NOTIFY_JOB,
        attempts: 1, max_attempts: 3, worker_id: "test-worker",
        payload: { operation_id: randomUUID(), room_id: created.room.id, session_id: conversation.id, status: "failed", reason: "No sources.", origin_group_id: origin },
      });
      const result = (await db.pool.query<{ container: string | null }>(
        `SELECT budget_json->>'container_group_id' AS container FROM agent_run_groups WHERE session_id = $1 AND id <> $2`,
        [conversation.id, origin],
      )).rows;
      expect(result).toEqual([{ container: origin }]);
      const charged = (await db.pool.query<{ used: string | null }>(
        `SELECT budget_json->>'container_turns_used' AS used FROM agent_run_groups WHERE id = $1`,
        [origin],
      )).rows[0]!.used;
      expect(charged).toBe("1");
    });

    it("charges every branch of a delegation chain to one container", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Container");
      const sent = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Research this." });
      const groupId = sent.task_group_ids[0]!;
      const budgets = [];
      for (let branch = 0; branch < 6; branch += 1) {
        const client = await db.pool.connect();
        try {
          budgets.push((await agentOriginContinuation(client, "space-1", groupId)).delegation_budget);
        } finally {
          client.release();
        }
      }
      expect(budgets.map((budget) => budget.max_fanout)).toEqual([2, 2, 2, 1, 0, 0]);
      expect(budgets.every((budget) => budget.container_group_id === groupId)).toBe(true);
    });

    it("lets only whoever may spend a login continue a turn held on it", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Whose subscription");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const [wave] = await queuedRunsFor(conversation.id, "agent-2");
      const discussion = await discussionFor(conversation.id);
      {
        // The Specialist's login is on user-2's own machine: its subscription is theirs.
        await db.pool.query(
          `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
           VALUES ('machine-member', 'user-2', 'Member laptop', 'laptop', now(), now())`,
        );
        await db.pool.query(
          `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
           VALUES ('host-member', 'user-2', 'machine-member', 'Member laptop', 'remote', 'linux_native', 'online', '{}'::jsonb, now(), now())`,
        );
        await db.pool.query(
          `UPDATE runs SET output_json = jsonb_set(output_json, '{waiting_for_quota,login,host_id}', '"host-member"') WHERE id = $1`,
          [wave!.id],
        );
        expect((await conversationQuota(db.pool, "space-1", conversation.id, "user-1")).holds)
          .toEqual([expect.objectContaining({ run_ids: [wave!.id], can_continue: false })]);
        expect((await conversationQuota(db.pool, "space-1", conversation.id, "user-2")).holds)
          .toEqual([expect.objectContaining({ can_continue: true })]);

        // Another member continuing anyway spends nothing of it, and records nothing.
        const byOther = await withDbTransaction(db.pool, (client) =>
          continueHeldRuns(client, { spaceId: "space-1", sessionId: conversation.id, userId: "user-1" }));
        expect(byOther).toBe(0);
        expect(await quotaMarker(wave!.id)).not.toBeNull();
        const override = await db.pool.query<{ by: string | null }>(
          `SELECT quota_override_by_user_id AS by FROM room_discussions WHERE id = $1`, [discussion!.id]);
        expect(override.rows[0]!.by).toBeNull();

        const byOwner = await withDbTransaction(db.pool, (client) =>
          continueHeldRuns(client, { spaceId: "space-1", sessionId: conversation.id, userId: "user-2" }));
        expect(byOwner).toBe(1);
        expect(await hasRunJob(wave!.id)).toBe(true);
      }
    });

    it("lets a person speak while Agents wait for the window, and admits them once that turn is over", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Quota hold and a person");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const [wave] = await queuedRunsFor(conversation.id, "agent-2");
      expect(await quotaMarker(wave!.id)).not.toBeNull();

      // The held wave does not hold the conversation: the person's message goes now.
      const spoken = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Meanwhile, draft the notes." });
      expect("queued" in spoken).toBe(false);
      const personRun = (spoken as { run_ids: string[] }).run_ids[0]!;
      expect(await hasRunJob(personRun)).toBe(true);

      // Continuing anyway while that turn runs admits the wave once it is over, not beside it.
      const admittedNow = await withDbTransaction(db.pool, (client) =>
        continueHeldRuns(client, { spaceId: "space-1", sessionId: conversation.id, userId: "user-1" }));
      expect(admittedNow).toBe(0);
      expect(await releaseHeldRuns(db.pool, { source: fixedQuota(90) })).toBe(0);
      expect(await hasRunJob(wave!.id)).toBe(false);
      await completeTurn(personRun, "Drafted.");
      expect(await releaseHeldRuns(db.pool, { source: fixedQuota(90) })).toBe(1);
      expect(await hasRunJob(wave!.id)).toBe(true);
      expect(await quotaMarker(wave!.id)).toBeNull();
    });

    it("advances a wave once, however many completions and retries reach it", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Advance once");
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "I will ask @Research Specialist to check the numbers first.");
      const before = await discussionFor(conversation.id);
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      // A retry job, a queue release and a second finalization all reach the same wave.
      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(await discussions.advanceGroup("space-1", first.task_group_ids[0]!, { enqueueRetry: false })).toBe("advanced");
      }
      expect(await discussionFor(conversation.id)).toMatchObject({
        id: before!.id, rounds_used: before!.rounds_used, turns_used: before!.turns_used,
      });
      expect(await queuedRunsFor(conversation.id, "agent-2")).toHaveLength(1);
      const notices = await db.pool.query(
        `SELECT 1 FROM messages WHERE session_id = $1 AND metadata_json ? 'discussion_notice'`,
        [conversation.id],
      );
      expect(notices.rowCount).toBe(0);
    });

    it("parks a Run admitted while another group's turn holds the conversation, and admits it when that turn is over", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Parked for the turn");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const [held] = await queuedRunsFor(conversation.id, "agent-2");
      // The held wave gave the turn up; a person's turn took it.
      const spoken = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Meanwhile, draft the notes." });
      const personRun = (spoken as { run_ids: string[] }).run_ids[0]!;

      // Another Run of the held group comes up for admission now (its held
      // predecessor was cancelled, say): it must not run beside the person's turn.
      const sibling = randomUUID();
      await db.pool.query(
        `INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs, to_jsonb(run) || $2::jsonb)).* FROM runs run WHERE run.id = $1`,
        [held!.id, JSON.stringify({ id: sibling, status: "queued", output_json: {} })],
      );
      const job = { user_id: "user-1", agent_id: "agent-2", project_folder_id: null, payload: { run_id: sibling } };
      const outcome = await withDbTransaction(db.pool, (client) => enqueueWhenTurnFree(client, { spaceId: "space-1", runId: sibling, job }));
      expect(outcome).toBe("held");
      expect(await hasRunJob(sibling)).toBe(false);
      expect(await conversationTurnTaken(db.pool, "space-1", conversation.id)).toBe(true);

      await completeTurn(personRun, "Drafted.");
      expect(await hasRunJob(sibling)).toBe(true);
      const parked = await db.pool.query(`SELECT 1 FROM runs WHERE id = $1 AND output_json ? 'waiting_for_turn'`, [sibling]);
      expect(parked.rowCount).toBe(0);
    });

    it("runs the next recipient only after what the one before it delegated without waiting", async (ctx) => {
      if (!db.available || !service || !groupService) return ctx.skip();
      const owner = { spaceId: "space-1", userId: "user-1" };
      const now = new Date().toISOString();
      await seedSpecialist(now, "agent-2", "version-2", "Research Specialist");
      await seedSpecialist(now, "agent-3", "version-3", "Reviewer");
      const created = await service.createRoom(owner, { project_id: "project-1", title: "Serial behind a child" });
      for (const agentId of ["agent-2", "agent-3"]) {
        await db.pool.query(
          `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
           VALUES ($1, 'space-1', $2, $3, 'member', 'active', $4, $4)`,
          [randomUUID(), created.room.id, agentId, now],
        );
      }
      const conversation = await seedConversation(owner, created.room.id, "Serial behind a child");
      const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
        content: "Both of you, please.",
        recipient_segments: [{ recipient_agent_ids: ["agent-1", "agent-2"], content: "Both of you, please." }],
      });
      const [managerRun, specialistRun] = sent.run_ids as [string, string];
      const group = await new PgAgentGroupRepository(db.pool).getGroup("space-1", sent.task_group_ids[0]!);
      await dispatchQueuedRoomRuns([managerRun]);
      const spawned = await groupService.spawnChildRun(owner, {
        space_id: "space-1",
        group_id: group!.id,
        parent_run_id: managerRun,
        root_run_id: group!.root_run_id!,
        requesting_agent_id: "agent-1",
        target_agent_id: "agent-3",
        manager_user_id: "user-1",
        instruction: "Check the numbers.",
      });
      await completeTurn(managerRun, "Asked the Reviewer to check the numbers.");

      // The Reviewer runs; the Specialist waits for it, in the one directory.
      const status = async (id: string) => (await db.pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [id])).rows[0]!.status;
      expect(await hasRunJob(spawned.child_run_id!)).toBe(true);
      expect(await status(specialistRun)).toBe("waiting_for_dependency");
      expect(await hasRunJob(specialistRun)).toBe(false);

      await completeTurn(spawned.child_run_id!, "The numbers hold.");
      expect(await hasRunJob(specialistRun)).toBe(true);
    });

    it("lets a person address an Agent whose own turn waits for the window, and gives the Agent back to it afterwards", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Held Agent addressed");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const [held] = await queuedRunsFor(conversation.id, "agent-2");
      expect(await quotaMarker(held!.id)).not.toBeNull();

      // Not queued behind the held Run: the person's turn claims the Specialist's host thread now.
      const direct = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, {
        content: "Research Specialist, what is the current error rate?",
        recipient_segments: [{ recipient_agent_ids: ["agent-2"], content: "What is the current error rate?" }],
      });
      expect("queued" in direct).toBe(false);
      await completeTurn((direct as { run_ids: string[] }).run_ids[0]!, "About 0.4 %.");

      // Once the window reads low the held Run claims the thread back and runs.
      expect(await releaseHeldRuns(db.pool, { source: fixedQuota(12) })).toBe(1);
      expect(await hasRunJob(held!.id)).toBe(true);
      const lock = await db.pool.query<{ dispatch_lock_id: string | null }>(
        `SELECT thread.dispatch_lock_id FROM host_threads thread JOIN runs run ON run.host_task_thread_id = thread.id WHERE run.id = $1`,
        [held!.id],
      );
      expect(lock.rows[0]!.dispatch_lock_id).toBe(held!.id);
    });

    it("admits a handoff turn serialized behind an earlier recipient, under the lock of the recipient it prepares", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Serialized handoff");
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      const send = (content: string) => service!.sendMessage(owner, created.room.id, conversation.id, {
        content,
        recipient_segments: [{ recipient_agent_ids: ["agent-1", "agent-2"], content }],
      });
      // Finishes a Run as its host would report it, with the session's occupancy.
      const finish = async (runId: string, used: number) => {
        await dispatchQueuedRoomRuns([runId]);
        await db.pool.query(`UPDATE runs SET status = 'succeeded', output_json = $2::jsonb, ended_at = now(), updated_at = now() WHERE id = $1`,
          [runId, JSON.stringify({ schema_version: "run_output.v1", status: "succeeded", summary: `reply of ${runId}`, result: {}, output_manifest: [] })]);
        const run = (await new PgRunRepository(db.pool).getRun("space-1", runId))!;
        await new PgHostThreadRepository(db.pool).recordRunOutcome(run.host_task_thread_id!, {
          lastRunId: runId, vendorSessionId: `vendor-${run.agent_id}`, sessionReset: false, landed: true, identity: null,
          contextWindow: { used, size: 200_000 },
        });
        await new AgentGroupRunLifecycleProjector(db.pool, config, fixedQuota(10)).markDelegatedRunTerminal(run);
      };
      const first = await send("First round.");
      await finish(first.run_ids[0]!, 10_000);
      await finish(first.run_ids[1]!, 150_000);
      // The Specialist's session is past its rotation share: its turn comes behind a handoff.
      const second = await send("Second round.");
      const handoff = (await db.pool.query<{ id: string }>(
        `SELECT id FROM runs WHERE run_group_id = $1 AND model_override_json->'chat_turn'->>'kind' = 'handoff'`,
        [second.task_group_ids[0]],
      )).rows[0]!;
      await finish(second.run_ids[0]!, 12_000);
      expect(await hasRunJob(handoff.id)).toBe(true);
      const parked = await db.pool.query(`SELECT 1 FROM runs WHERE id = $1 AND output_json ? 'waiting_for_turn'`, [handoff.id]);
      expect(parked.rowCount).toBe(0);
    });

    it("admits an Agent-triggered wave whose recipient must first rotate its session", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Rotating wave");
      const direct = await service.sendMessage(owner, created.room.id, conversation.id, {
        content: "Research Specialist, hello.",
        recipient_segments: [{ recipient_agent_ids: ["agent-2"], content: "hello" }],
      });
      await completeTurn(direct.run_ids[0]!, "Hello.", fixedQuota(10));
      const run = (await new PgRunRepository(db.pool).getRun("space-1", direct.run_ids[0]!))!;
      await new PgHostThreadRepository(db.pool).recordRunOutcome(run.host_task_thread_id!, {
        lastRunId: run.id, vendorSessionId: "vendor-agent-2", sessionReset: false, landed: true, identity: null,
        contextWindow: { used: 150_000, size: 200_000 },
      });
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.", fixedQuota(10));
      const handoff = (await db.pool.query<{ id: string }>(
        `SELECT id FROM runs WHERE session_id = $1 AND agent_id = 'agent-2' AND model_override_json->'chat_turn'->>'kind' = 'handoff'
          AND status = 'queued'`,
        [conversation.id],
      )).rows[0]!;
      expect(await hasRunJob(handoff.id)).toBe(true);
    });

    it("does not queue a person behind a recipient that waits on a delegated child held for the window", async (ctx) => {
      if (!db.available || !service || !groupService) return ctx.skip();
      const owner = { spaceId: "space-1", userId: "user-1" };
      const now = new Date().toISOString();
      await seedSpecialist(now, "agent-2", "version-2", "Research Specialist");
      await seedSpecialist(now, "agent-3", "version-3", "Reviewer");
      const created = await service.createRoom(owner, { project_id: "project-1", title: "Serial behind a held child" });
      for (const agentId of ["agent-2", "agent-3"]) {
        await db.pool.query(
          `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
           VALUES ($1, 'space-1', $2, $3, 'member', 'active', $4, $4)`,
          [randomUUID(), created.room.id, agentId, now],
        );
      }
      const conversation = await seedConversation(owner, created.room.id, "Serial behind a held child");
      await seedQuota(90, new Date(Date.now() + 4 * 3600_000).toISOString());
      const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
        content: "Both of you, please.",
        recipient_segments: [{ recipient_agent_ids: ["agent-1", "agent-2"], content: "Both of you, please." }],
      });
      const [managerRun, specialistRun] = sent.run_ids as [string, string];
      const group = await new PgAgentGroupRepository(db.pool).getGroup("space-1", sent.task_group_ids[0]!);
      await dispatchQueuedRoomRuns([managerRun]);
      const spawned = await groupService.spawnChildRun(owner, {
        space_id: "space-1", group_id: group!.id, parent_run_id: managerRun, root_run_id: group!.root_run_id!,
        requesting_agent_id: "agent-1", target_agent_id: "agent-3", manager_user_id: "user-1", instruction: "Check the numbers.",
      });
      await completeTurn(managerRun, "Asked for a check.", fixedQuota(90));
      expect(await quotaMarker(spawned.child_run_id!)).not.toBeNull();
      expect(await conversationTurnTaken(db.pool, "space-1", conversation.id)).toBe(false);
      // A person addresses the waiting Specialist itself: its host thread is free too.
      const spoken = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, {
        content: "Research Specialist, a quick one.",
        recipient_segments: [{ recipient_agent_ids: ["agent-2"], content: "A quick one." }],
      });
      expect("queued" in spoken).toBe(false);
      const status = (await db.pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [specialistRun])).rows[0]!.status;
      expect(status).toBe("waiting_for_dependency");
    });

    it("clears a parked Run's marker when any path enqueues its job", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Stale park marker");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const [held] = await queuedRunsFor(conversation.id, "agent-2");
      const spoken = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Meanwhile, draft the notes." });
      const personRun = (spoken as { run_ids: string[] }).run_ids[0]!;
      const sibling = randomUUID();
      await db.pool.query(
        `INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs, to_jsonb(run) || $2::jsonb)).* FROM runs run WHERE run.id = $1`,
        [held!.id, JSON.stringify({ id: sibling, status: "queued", output_json: {}, host_task_thread_id: null })],
      );
      const job = { user_id: "user-1", agent_id: "agent-2", project_folder_id: null, payload: { run_id: sibling } };
      expect(await withDbTransaction(db.pool, (client) => enqueueWhenTurnFree(client, { spaceId: "space-1", runId: sibling, job }))).toBe("held");
      await dispatchQueuedRoomRuns([personRun]);
      await db.pool.query(`UPDATE runs SET status = 'succeeded', ended_at = now() WHERE id = $1`, [personRun]);
      await releaseConversationTurn(personRun);
      // A FIFO re-evaluating its head admits it: with its job it no longer reads as waiting.
      const outcome = await withDbTransaction(db.pool, (client) => admitAgentOriginRun(client, { spaceId: "space-1", runId: sibling, job, source: fixedQuota(10) }));
      expect(outcome).toBe("admitted");
      const parked = await db.pool.query(`SELECT 1 FROM runs WHERE id = $1 AND output_json ? 'waiting_for_turn'`, [sibling]);
      expect(parked.rowCount).toBe(0);
      expect(await conversationTurnTaken(db.pool, "space-1", conversation.id)).toBe(true);
    });

    it("adds rounds while the Manager's closing waits behind its own handoff for the window", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Closing behind handoff");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const direct = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Hello." });
      await completeTurn(direct.run_ids[0]!, "Hello.", fixedQuota(10));
      const manager = (await new PgRunRepository(db.pool).getRun("space-1", direct.run_ids[0]!))!;
      await new PgHostThreadRepository(db.pool).recordRunOutcome(manager.host_task_thread_id!, {
        lastRunId: manager.id, vendorSessionId: "vendor-agent-1", sessionReset: false, landed: true, identity: null,
        contextWindow: { used: 150_000, size: 200_000 },
      });
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Who owns the migration?", participant_agent_ids: ["agent-2"], shape: "open",
      });
      await seedQuota(40, new Date(Date.now() + 3600_000).toISOString());
      await failTurn(opened.run_ids[0]!, "subscription_quota_exhausted", "Claude AI usage limit reached|1790000000");
      await discussions.extend(owner, created.room.id, conversation.id, opened.discussion.id, 1);
      // The whole closing chain is gone, not just its held head.
      const closing = await db.pool.query(
        `SELECT run.status FROM runs run
           JOIN agent_run_groups grp ON grp.id = run.run_group_id
           JOIN messages trigger ON trigger.id = grp.trigger_message_id
          WHERE grp.discussion_id = $1 AND trigger.metadata_json->>'discussion_closing' = 'true'`,
        [opened.discussion.id],
      );
      expect(closing.rows.length).toBeGreaterThan(0);
      expect(closing.rows.every((row) => row.status === "cancelled")).toBe(true);
    });

    it("frees the turn only for a held Run and what waits on it, never for a Run about to run", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Turn beside a hold");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const [held] = await queuedRunsFor(conversation.id, "agent-2");
      const taken = () => conversationTurnTaken(db.pool, "space-1", conversation.id);
      expect(await taken()).toBe(false);

      // A sibling in the held Run's group, queued with its job: it is about to run.
      const copyOf = async (id: string, patch: Record<string, unknown>) => {
        const copy = randomUUID();
        await db.pool.query(
          `INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs, to_jsonb(run) || $2::jsonb)).* FROM runs run WHERE run.id = $1`,
          [id, JSON.stringify({ id: copy, ...patch })],
        );
        return copy;
      };
      const sibling = await copyOf(held!.id, { status: "queued", output_json: {} });
      // Queued with no job, it cannot run before the held Run either (one Run of a group at a time).
      expect(await taken()).toBe(false);
      await db.pool.query(
        `INSERT INTO jobs (id, space_id, user_id, job_type, status, priority, payload_json, attempts, max_attempts, scheduled_at, created_at, updated_at)
         VALUES ($1, 'space-1', 'user-1', 'agent_run', 'pending', 0, $2::jsonb, 0, 3, now(), now(), now())`,
        [randomUUID(), JSON.stringify({ run_id: sibling })],
      );
      expect(await taken()).toBe(true);
      await db.pool.query(`DELETE FROM jobs WHERE payload_json->>'run_id' = $1`, [sibling]);
      // Parked behind the held Run instead — and a parent parked behind that — it waits too.
      await db.pool.query(
        `UPDATE runs SET status = 'waiting_for_dependency',
                output_json = jsonb_build_object('waiting_for_results', jsonb_build_object('status', 'waiting', 'depends_on_run_ids', jsonb_build_array($2::text)))
          WHERE id = $1`,
        [sibling, held!.id],
      );
      await copyOf(held!.id, {
        status: "waiting_for_dependency",
        output_json: { waiting_for_results: { status: "waiting", depends_on_run_ids: [sibling] } },
      });
      expect(await taken()).toBe(false);
    });

    it("posts a message waiting behind a person's turn while a discussion's wave waits for the window, outside the discussion", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Queue past a hold");
      await seedQuota(90, new Date(Date.now() + 2 * 3600_000).toISOString());
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const held = await discussionFor(conversation.id);
      const [wave] = await queuedRunsFor(conversation.id, "agent-2");
      expect(await quotaMarker(wave!.id)).not.toBeNull();

      const spoken = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "Meanwhile, draft the notes." });
      const waiting = await service.sendOrQueueMessage(owner, created.room.id, conversation.id, { content: "And the changelog." });
      expect(waiting).toMatchObject({ queued: { status: "queued" } });
      // The person's turn addresses the Specialist too: it joins the discussion's waiting Agents.
      await completeTurn((spoken as { run_ids: string[] }).run_ids[0]!, "Drafted. @Research Specialist please double-check the dates.");

      const posted = (await db.pool.query<{ discussion_id: string | null }>(
        `SELECT discussion_id FROM messages WHERE session_id = $1 AND content = 'And the changelog.'`,
        [conversation.id],
      )).rows[0];
      expect(posted).toEqual({ discussion_id: null });
      const after = await discussionFor(conversation.id);
      expect(after).toMatchObject({ id: held!.id, status: "active", rounds_used: held!.rounds_used, round_base: held!.round_base });
      expect(after!.held_mentions_json.map((mention) => mention.agent_id)).toEqual(["agent-2"]);
    });

    it("opens a discussion through its route and answers 201 with a well-formed body", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { created, conversation } = await roomWithSpecialist("Open via route");
      const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), [roomsModule]);
      try {
        __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
        const opened = await app.inject({
          method: "POST",
          url: `/api/v1/rooms/${created.room.id}/conversations/${conversation.id}/discussions`,
          payload: { topic: "Pick a database", participant_agent_ids: ["agent-2"], shape: "open" },
        });
        expect(opened.statusCode).toBe(201);
        expect(opened.json()).toMatchObject({
          discussion: { status: "active", topic: "Pick a database" },
          conversation: { id: conversation.id, room_id: created.room.id },
          message: { content: "Pick a database" },
        });
        expect(opened.json().conversation).not.toHaveProperty("user_id");
      } finally {
        __setAuthIdentityForTests(null);
        await app.close();
      }
    });

    it("lets any member read a conversation's quota, a Project writer continue anyway, and only a Space admin move the lines", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { created, conversation } = await roomWithSpecialist("Quota routes");
      await addRoomMember(created.room.id, "user-2");
      const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), [roomsModule, providersModule]);
      try {
        const base = `/api/v1/rooms/${created.room.id}/conversations/${conversation.id}/quota`;
        // user-2 is a Room member and a Project viewer.
        __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-2" });
        expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(200);
        expect((await app.inject({ method: "POST", url: `${base}/continue` })).statusCode).toBe(403);
        expect((await app.inject({
          method: "PUT", url: "/api/v1/providers/subscription-quota-policy", payload: { warn_pct: 60, reserve_pct: 80 },
        })).statusCode).toBe(403);
        __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
        expect((await app.inject({ method: "POST", url: `${base}/continue` })).statusCode).toBe(200);
        const moved = await app.inject({
          method: "PUT", url: "/api/v1/providers/subscription-quota-policy", payload: { warn_pct: 60, reserve_pct: 80 },
        });
        expect(moved.statusCode).toBe(200);
        expect(moved.json()).toMatchObject({ warn_pct: 60, reserve_pct: 80 });
      } finally {
        __setAuthIdentityForTests(null);
        await app.close();
      }
    });

    it("holds Agent-triggered turns past the subscription reserve line until a person continues anyway", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Quota hold");
      const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
      await seedQuota(90, resetsAt);
      // A person's own message is never held.
      const first = await service.sendMessage(owner, created.room.id, conversation.id, { content: "Plan the release." });
      expect(await hasRunJob(first.run_ids[0]!)).toBe(true);
      expect(await quotaMarker(first.run_ids[0]!)).toBeNull();

      await completeTurn(first.run_ids[0]!, "Let me ask @Research Specialist to check the numbers.");
      const discussion = await discussionFor(conversation.id);
      const [wave] = await queuedRunsFor(conversation.id, "agent-2");
      expect(wave).toMatchObject({ status: "queued", discussion_id: discussion!.id });
      expect(await hasRunJob(wave!.id)).toBe(false);
      expect(await quotaMarker(wave!.id)).toMatchObject({ window: "session", resets_at: resetsAt, utilization: 90 });
      const notices = await db.pool.query<{ notice: { resets_at: string } }>(
        `SELECT metadata_json->'discussion_notice' AS notice FROM messages
          WHERE discussion_id = $1 AND metadata_json->'discussion_notice'->>'kind' = 'quota_hold'`,
        [discussion!.id],
      );
      expect(notices.rows).toHaveLength(1);
      expect(notices.rows[0]!.notice.resets_at).toBe(resetsAt);

      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
      const detail = await new RoomDiscussionService(config, db.pool).get(owner, created.room.id, conversation.id, discussion!.id);
      expect(detail.quota_hold).toMatchObject({ window: "session", resets_at: resetsAt, run_ids: [wave!.id] });
      expect(detail.usage).toEqual({
        priced_usd: 0,
        subscription: [{
          account_label: expect.stringContaining("Claude Code"),
          tokens: 0,
          window: { kind: "session", utilization: 90, resets_at: resetsAt },
        }],
      });
      // Still past the line at the minute's re-check: nothing moves.
      expect(await releaseHeldRuns(db.pool)).toBe(0);

      const admitted = await withDbTransaction(db.pool, (client) =>
        continueHeldRuns(client, { spaceId: "space-1", sessionId: conversation.id, userId: "user-1" }));
      expect(admitted).toBe(1);
      expect(await hasRunJob(wave!.id)).toBe(true);
      expect(await quotaMarker(wave!.id)).toBeNull();
      const overridden = await db.pool.query<{ quota_override_by_user_id: string | null }>(
        `SELECT quota_override_by_user_id FROM room_discussions WHERE id = $1`,
        [discussion!.id],
      );
      expect(overridden.rows[0]!.quota_override_by_user_id).toBe("user-1");

      // The discussion's later Agent-triggered turns are not held again.
      await completeTurn(wave!.id, "Checked; the numbers hold.");
      const [closing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(closing!.prompt).toContain("converged");
      expect(await hasRunJob(closing!.id)).toBe(true);
    });

    it("admits a held recipient of an Agent-triggered turn when the window resets", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Quota reset");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Monolith or services?", participant_agent_ids: ["agent-1", "agent-2"], shape: "debate",
      });
      const [first, second] = opened.run_ids as [string, string];
      // The person's topic: its second recipient is admitted whatever the window says.
      await completeTurn(first, "Monolith.", fixedQuota(99));
      expect(await hasRunJob(second)).toBe(true);
      await completeTurn(second, "Services.", fixedQuota(99));
      // The critique round is Agent-triggered: its second recipient waits.
      const critique = await db.pool.query<{ id: string }>(
        `SELECT run.id FROM runs run JOIN agent_run_groups grp ON grp.id = run.run_group_id
          WHERE grp.discussion_id = $1 AND run.status IN ('queued', 'waiting_for_dependency') ORDER BY run.created_at`,
        [opened.discussion.id],
      );
      const [critiqueFirst, critiqueSecond] = critique.rows.map((row) => row.id) as [string, string];
      await completeTurn(critiqueFirst, "Services still scale better.", fixedQuota(99));
      const held = (await new PgRunRepository(db.pool).getRun("space-1", critiqueSecond))!;
      expect(held.status).toBe("queued");
      expect(held.prompt).toContain("Services still scale better.");
      expect(await hasRunJob(critiqueSecond)).toBe(false);
      expect(await quotaMarker(critiqueSecond)).toMatchObject({ utilization: 99 });

      expect(await releaseHeldRuns(db.pool, { source: fixedQuota(99) })).toBe(0);
      expect(await releaseHeldRuns(db.pool, { source: fixedQuota(12) })).toBe(1);
      expect(await hasRunJob(critiqueSecond)).toBe(true);
      expect(await quotaMarker(critiqueSecond)).toBeNull();
    });

    it("ends a discussion stopped at its cap for good, its closing still waiting for the window included", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Stop at the cap");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Who owns the migration?", participant_agent_ids: ["agent-2"], shape: "open",
      });
      await seedQuota(40, new Date(Date.now() + 3600_000).toISOString());
      await failTurn(opened.run_ids[0]!, "subscription_quota_exhausted", "Claude AI usage limit reached|1790000000");
      const [closing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(await quotaMarker(closing!.id)).not.toBeNull();

      await discussions.stop(owner, created.room.id, conversation.id, opened.discussion.id);
      expect(await discussionFor(conversation.id)).toMatchObject({ status: "closed" });
      const status = (await db.pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [closing!.id])).rows[0]!.status;
      expect(status).toBe("cancelled");
      expect(await hasRunJob(closing!.id)).toBe(false);
    });

    it("stops a discussion at the cap when the CLI refuses for an exhausted subscription", async (ctx) => {
      if (!db.available || !service) return ctx.skip();
      const { owner, created, conversation } = await roomWithSpecialist("Quota exhausted");
      const discussions = new RoomDiscussionService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }), db.pool);
      const opened = await discussions.open(owner, created.room.id, conversation.id, {
        topic: "Who owns the migration?", participant_agent_ids: ["agent-2"], shape: "open",
      });
      // The last reading was well below the line; the refusal came after it.
      const resetsAt = new Date(Date.now() + 3600_000).toISOString();
      await seedQuota(40, resetsAt);
      await failTurn(opened.run_ids[0]!, "subscription_quota_exhausted", "Claude AI usage limit reached|1790000000");

      await expect(discussionFor(conversation.id)).resolves.toMatchObject({ status: "cap_reached", stop_reason: "quota_exhausted" });
      const notice = await db.pool.query<{ notice: { kind: string; reason: string; resets_at: string }; content: string }>(
        `SELECT content, metadata_json->'discussion_notice' AS notice FROM messages
          WHERE discussion_id = $1 AND metadata_json->'discussion_notice'->>'kind' = 'cap_reached'`,
        [opened.discussion.id],
      );
      expect(notice.rows).toHaveLength(1);
      expect(notice.rows[0]!.notice).toMatchObject({ reason: "quota_exhausted", resets_at: resetsAt });
      expect(notice.rows[0]!.content).toContain("usage limit is reached");
      // The Manager runs on the login that refused: its closing turn waits for the window.
      const [closing] = await queuedRunsFor(conversation.id, "agent-1");
      expect(closing!.prompt).toContain("write the conclusion");
      expect(await hasRunJob(closing!.id)).toBe(false);
      expect(await quotaMarker(closing!.id)).toMatchObject({ utilization: 100, resets_at: resetsAt });

      // The refused Specialist is what adding rounds continues with.
      expect((await discussionFor(conversation.id))!.held_mentions_json.map((held) => held.agent_id)).toEqual(["agent-2"]);
      // Adding rounds: that closing concludes nothing now, and never runs ahead of the new wave.
      await discussions.extend(owner, created.room.id, conversation.id, opened.discussion.id, 1);
      const cancelled = await db.pool.query<{ status: string; held: boolean }>(
        `SELECT status, output_json ? 'waiting_for_quota' AS held FROM runs WHERE id = $1`,
        [closing!.id],
      );
      expect(cancelled.rows[0]).toEqual({ status: "cancelled", held: false });
    });
  });

  it("rejects duplicate recipient runs before persisting a Room turn", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Single recipient Room",
    });
    const conversation = await seedConversation(owner, created.room.id, "Concurrent safety");

    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Run two overlapping segments.",
      recipient_segments: [
        { recipient_agent_ids: ["agent-1"], content: "First segment." },
        { recipient_agent_ids: ["agent-1"], content: "Second segment." },
      ],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
      }],
    })).rejects.toMatchObject({ statusCode: 422 });

    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM messages
        WHERE session_id = $1 AND role = 'user'`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_run_groups
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("parks every recipient after the first behind all preceding ones, so one Conversation runs one Run at a time", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await seedSpecialist(now, "agent-2", "version-2", "Research Specialist");
    await seedSpecialist(now, "agent-3", "version-3", "Coding Specialist");
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Fan-out Room" });
    for (const agentId of ["agent-2", "agent-3"]) {
      await db.pool.query(
        `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
         VALUES ($1, 'space-1', $2, $3, 'member', 'active', $4, $4)`,
        [randomUUID(), created.room.id, agentId, now],
      );
    }
    const conversation = await seedConversation(owner, created.room.id, "Fan-out");

    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "@Assistant @Research @Coding compare notes",
      recipient_segments: [{ recipient_agent_ids: ["agent-1", "agent-2", "agent-3"], content: "compare notes" }],
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
    });
    expect(sent.run_ids).toHaveLength(3);
    const [first, second, third] = sent.run_ids as [string, string, string];

    const runs = new PgRunRepository(db.pool);
    expect((await runs.getRun("space-1", first))?.status).toBe("queued");
    // Parked behind *every* earlier recipient, so the third is handed both
    // replies when admitted, not only the second's.
    expect(await runs.getRun("space-1", second)).toMatchObject({
      status: "waiting_for_dependency",
      output_json: { waiting_for_results: {
        status: "waiting", scope: "conversation_serialization", depends_on_run_ids: [first],
      } },
    });
    expect(await runs.getRun("space-1", third)).toMatchObject({
      status: "waiting_for_dependency",
      output_json: { waiting_for_results: {
        status: "waiting", scope: "conversation_serialization", depends_on_run_ids: [first, second],
      } },
    });
    // One execution directory: one job now; the projector enqueues the rest.
    const jobs = await db.pool.query<{ run_id: string }>(
      `SELECT payload_json->>'run_id' AS run_id FROM jobs
        WHERE space_id='space-1' AND job_type='agent_run' AND payload_json->>'run_group_id' = $1`,
      [sent.task_group_ids[0]],
    );
    expect(jobs.rows.map((row) => row.run_id)).toEqual([first]);
    // A parked recipient holds the turn: the next message waits for the chain.
    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "And another thing.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects task links that cross Room conversation aggregates", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const firstRoom = await service.createRoom(owner, {
      project_id: "project-1",
      title: "First aggregate",
    });
    const secondRoom = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Second aggregate",
    });
    const firstConversation = await seedConversation(owner, firstRoom.room.id, "First conversation");
    const secondConversation = await seedConversation(owner, secondRoom.room.id, "Second conversation");
    const firstTask = await service.sendMessage(
      owner,
      firstRoom.room.id,
      firstConversation.id,
      { content: "First task." },
    );
    const secondTask = await service.sendMessage(
      owner,
      secondRoom.room.id,
      secondConversation.id,
      { content: "Second task." },
    );

    await expect(db.pool.query(
      `UPDATE agent_run_groups SET room_id = $2 WHERE id = $1`,
      [firstTask.task_group_ids[0], secondRoom.room.id],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(db.pool.query(
      `UPDATE agent_run_groups SET trigger_message_id = $2 WHERE id = $1`,
      [firstTask.task_group_ids[0], secondTask.message.id],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(db.pool.query(
      `UPDATE runs SET session_id = $2 WHERE id = $1`,
      [firstTask.run_ids[0], secondConversation.id],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps private specialists Room-scoped while allowing Room dispatch visibility", async (ctx) => {
    if (!db.available || !service || !groupService) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await openSpokenRoom(owner, { project_id: "project-1", title: "Private roster" });
    await addRoomMember(created.room.id, "user-2");
    await expect(service.addAgentPreset(owner, created.room.id, {
      preset_id: "research-analyst",
      idempotency_key: "preset-confirmation-test",
    })).rejects.toMatchObject({
      responseBody: { code: "private_agent_share_confirmation_required" },
    });
    const preset = await service.addAgentPreset(owner, created.room.id, {
      preset_id: "research-analyst",
      idempotency_key: "preset-confirmation-test",
      confirm_room_share: true,
    });
    expect(preset.agent_members).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "member" }),
    ]));
    await db.pool.query(
      `INSERT INTO agents (
         id, space_id, owner_user_id, name, status, agent_kind,
         visibility, created_at, updated_at
       ) VALUES ('agent-private', 'space-1', 'user-1', 'Private Specialist', 'active',
         'standard', 'private', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO agents (
         id, space_id, owner_user_id, name, status, agent_kind,
         visibility, created_at, updated_at
       ) VALUES ('agent-public', 'space-1', 'user-1', 'Public Specialist', 'active',
         'standard', 'space_shared', now(), now())`,
    );
    await service.addAgent(owner, created.room.id, { agent_id: "agent-public" });

    const added = await service.addAgent(owner, created.room.id, {
      agent_id: "agent-private",
      share_private_with_member_ids: ["user-2"],
      confirm_room_share: true,
    });
    expect(added.agent_members).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "agent-private", role: "member" }),
    ]));

    const groups = new PgAgentGroupRepository(db.pool);
    await expect(groups.listAgentStatuses("space-1", "user-2", ["agent-private"]))
      .resolves.toEqual([]);
    await expect(groups.listAgentStatuses("space-1", "user-2", ["agent-private"], created.room.id))
      .resolves.toEqual([{ id: "agent-private", status: "active", agent_kind: "standard" }]);
    // Project/Space readability alone must not turn a Room roster member into
    // a generic Room execution principal; the human Room membership is also a
    // required predicate.
    await expect(groups.listAgentStatuses("space-1", "user-3", ["agent-public"], created.room.id))
      .resolves.toEqual([]);

    const presetSpecialist = preset.agent_members.find((row) => row.role === "member");
    expect(presetSpecialist).toBeDefined();
    // The preset specialist may also have a model API profile copied from the
    // managed Assistant. Select its CLI profile and bind it explicitly to the
    // Conversation's already-pinned Host and managed workspace.
    const runtimeProfile = await db.pool.query<{ id: string }>(
      `SELECT id FROM agent_runtime_profiles
        WHERE space_id='space-1' AND agent_id=$1 AND enabled=true
          AND runtime_key != 'opencode'
        ORDER BY is_default DESC, id ASC LIMIT 1`,
      [presetSpecialist!.agent_id],
    );
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET execution_host_id = 'host-1', workspace_mode = 'managed',
              workspace_location_id = NULL, runtime_installation = 'managed:1.0.0'
        WHERE id = $1`,
      [runtimeProfile.rows[0]!.id],
    );
    await new ConversationExecutionContextService(db.pool).initialize(
      owner,
      created.conversation.id,
      {
        selection: { execution_host_id: "host-1", primary: { kind: "managed" } },
        runtime: {
          agent_id: presetSpecialist!.agent_id,
          runtime_profile_id: runtimeProfile.rows[0]!.id,
          runtime_key: "claude_code",
          runtime_installation: "managed:1.0.0",
        },
      },
    );
    const roomDispatch = await service.sendMessage(member, created.room.id, created.conversation.id, {
      content: "Use the private specialist for this Room task.",
      recipient_segments: [{
        recipient_agent_ids: [presetSpecialist!.agent_id],
        content: "Analyze the Room task.",
      }],
      backends: [{
        agent_id: presetSpecialist!.agent_id,
        runtime_profile_id: runtimeProfile.rows[0]!.id,
      }],
    });
    expect(roomDispatch.run_ids).toHaveLength(1);

    const group = await groupService.createGroup(member, {
      space_id: "space-1",
      title: "Private specialist task",
      manager_agent_id: "agent-public",
      member_agent_ids: ["agent-private"],
      room_id: created.room.id,
      session_id: created.conversation.id,
      trigger_message_id: roomDispatch.message.id,
      project_id: "project-1",
    });
    expect(group.members.map((row) => row.agent_id)).toEqual(["agent-public", "agent-private"]);

    await db.pool.query(
      `UPDATE room_agent_access_grants
          SET revoked_at = now(), revoked_by_user_id = 'user-1'
        WHERE space_id = 'space-1' AND room_id = $1 AND agent_id = 'agent-private' AND grantee_user_id = 'user-2'`,
      [created.room.id],
    );
    await expect(groups.listAgentStatuses("space-1", "user-2", ["agent-private"], created.room.id))
      .resolves.toEqual([]);
  });

  it("dispatches a Room host-bound Agent only for its owner and manages its thread lifecycle", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Host conversation" });
    await addRoomMember(created.room.id, member.userId);

    await db.pool.query(
      `UPDATE machines SET owner_user_id = 'user-1' WHERE id = 'machine-1';
       INSERT INTO hosts (
         id, owner_user_id, machine_id, name, kind, environment_kind, status,
         last_heartbeat_at, capabilities_json, created_at, updated_at
       ) VALUES (
         'host-room-bound', 'user-1', 'machine-1', 'Room host', 'remote',
         'linux_native', 'online', now(),
         '{"installations":{"claude_code":[{"id":"managed:1.0.0","version":"1.0.0","logged_in":true,"health_check_protocol":"acp"}]}}'::jsonb,
         now(), now()
       );
       UPDATE workspace_locations
          SET execution_host_id = 'host-room-bound', execution_host_kind = 'remote', execution_ready = true
        WHERE id = 'location-1';
       UPDATE agent_runtime_profiles
          SET execution_host_id = 'host-room-bound', workspace_mode = 'location',
              workspace_location_id = 'location-1', runtime_installation = 'managed:1.0.0'
        WHERE id = 'runtime-cli'`,
    );
    const agentRepository = new PgAgentRepository(db.pool);
    const agent = await agentRepository.create({
        spaceId: owner.spaceId,
        projectId: "project-1",
        userId: owner.userId,
        ownerUserId: owner.userId,
        name: "Remote Researcher",
        visibility: "private",
        riskLevel: "low",
      });
    const [agentDefaultProfile] = await agentRepository.listRuntimeProfiles(owner.spaceId, agent.id);
    if (!agentDefaultProfile) throw new Error("new Agent has no default Runtime Profile");
    await agentRepository.updateRuntimeProfile(owner.spaceId, agent.id, agentDefaultProfile.id, {
      runtimeKey: "claude_code",
      executionHostId: "host-room-bound",
      workspaceLocationId: "location-1",
      workspaceMode: "location",
      runtimeInstallation: "managed:1.0.0",
    });
    await service.addAgent(owner, created.room.id, {
      agent_id: agent.id,
      share_private_with_member_ids: [member.userId],
      confirm_room_share: true,
    });
    const profile = await db.pool.query<{ id: string }>(
      `SELECT id FROM agent_runtime_profiles
        WHERE space_id = 'space-1' AND agent_id = $1 AND enabled = true
        ORDER BY is_default DESC, id ASC LIMIT 1`,
      [agent.id],
    );
    const alternativeProfile = await agentRepository.createRuntimeProfile(owner.spaceId, agent.id, {
      name: "Managed workspace alternative",
      runtimeKey: "claude_code",
      executionHostId: "host-room-bound",
      workspaceMode: "managed",
      runtimeInstallation: "managed:1.0.0",
      backendMode: "runtime_native",
      enabled: true,
      isDefault: false,
      actorUserId: owner.userId,
    });
    const delegatedAgent = await agentRepository.create({
        spaceId: owner.spaceId,
        projectId: "project-1",
        userId: owner.userId,
        ownerUserId: owner.userId,
        name: "Remote Delegate",
        visibility: "private",
        riskLevel: "low",
        roleInstruction: "Separate evidence from assumption.",
      });
    const [delegatedDefaultProfile] = await agentRepository.listRuntimeProfiles(owner.spaceId, delegatedAgent.id);
    if (!delegatedDefaultProfile) throw new Error("new delegated Agent has no default Runtime Profile");
    await agentRepository.updateRuntimeProfile(owner.spaceId, delegatedAgent.id, delegatedDefaultProfile.id, {
      runtimeKey: "claude_code",
      executionHostId: "host-room-bound",
      workspaceLocationId: "location-1",
      workspaceMode: "location",
      runtimeInstallation: "managed:1.0.0",
    });
    await service.addAgent(owner, created.room.id, {
      agent_id: delegatedAgent.id,
      share_private_with_member_ids: [member.userId],
      confirm_room_share: true,
    });
    const conversation = await seedConversation(owner, created.room.id, "Main", {
      hostId: "host-room-bound",
      primary: { kind: "location", workspace_location_id: "location-1" },
    });
    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Do not switch this specialist to the server.",
      recipient_segments: [{ recipient_agent_ids: [agent.id], content: "Use the server fallback." }],
      backends: [{ agent_id: agent.id, runtime_profile_id: alternativeProfile.id }],
    })).rejects.toMatchObject({ statusCode: 409 });
    const backend = {
      agent_id: agent.id,
      runtime_profile_id: profile.rows[0]!.id,
    };
    const segment = { recipient_agent_ids: [agent.id], content: "Research this remotely." };

    const first = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Please research this remotely.",
      recipient_segments: [segment],
      backends: [backend],
    });
    expect(first.run_ids).toHaveLength(1);
    const firstRun = await db.pool.query<{
      agent_id: string;
      workspace_location_id: string | null;
      trust_mode: string | null;
      prompt: string;
      capabilities_json: unknown;
      permission_snapshot_json: {
        tool_grants?: Array<{ action_id: string }>;
        scenario_tool_allowance?: string[];
      } | null;
    }>(
      `SELECT agent_id, workspace_location_id, trust_mode, prompt,
              capabilities_json, permission_snapshot_json
         FROM runs WHERE id = $1`,
      [first.run_ids[0]],
    );
    expect(firstRun.rows[0]).toMatchObject({
      agent_id: agent.id,
      workspace_location_id: "location-1",
      trust_mode: "trusted_host",
    });
    expect(firstRun.rows[0]!.prompt).toContain('You are now in "Main".');
    expect(firstRun.rows[0]!.prompt).toContain("Research this remotely.");
    expect(firstRun.rows[0]!.capabilities_json).toEqual(ROOM_CONVERSATION_TOOL_ALLOWANCE);
    expect(firstRun.rows[0]!.permission_snapshot_json?.scenario_tool_allowance)
      .toEqual(ROOM_CONVERSATION_TOOL_ALLOWANCE);
    expect(new Set(
      firstRun.rows[0]!.permission_snapshot_json?.tool_grants?.map((grant) => grant.action_id) ?? [],
    )).toEqual(new Set(["authorization.request", ...ROOM_CONVERSATION_TOOL_ALLOWANCE]));
    const firstRunRecord = await new PgRunRepository(db.pool).getAgentRun("space-1", first.run_ids[0]!);
    if (!firstRunRecord) throw new Error("host-bound Room Run was not persisted");
    await expect(new PgRouteDecisionRepository(db.pool).routeRun(firstRunRecord))
      .resolves.toMatchObject({ runtime_profile_id: profile.rows[0]!.id });
    await new PgRunRepository(db.pool).markRunRunning({
      run_id: first.run_ids[0]!,
      space_id: "space-1",
      started_at: new Date().toISOString(),
    });
    const thread = await db.pool.query<{
      id: string;
      last_run_id: string;
      last_session_id: string;
      status: string;
    }>(
      `SELECT id, last_run_id, last_session_id, status
         FROM host_threads
        WHERE session_id = $1 AND agent_id = $2 AND container_kind = 'conversation'`,
      [conversation.id, agent.id],
    );
    expect(thread.rows[0]).toMatchObject({
      last_run_id: first.run_ids[0],
      last_session_id: conversation.id,
      status: "active",
    });
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now() WHERE id = $1`,
      [first.run_ids[0]],
    );
    // The first turn opened the vendor session the second resumes; a thread
    // with no session is replayed from scratch instead.
    await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.rows[0]!.id, {
      lastRunId: first.run_ids[0]!,
      vendorSessionId: "vendor-room-1",
      sessionReset: false,
    });

    const roomGroup = await new PgAgentGroupRepository(db.pool).getGroup("space-1", first.task_group_ids[0]!);
    if (!roomGroup?.root_run_id || !groupService) throw new Error("host Room group was not created");
    const delegated = await groupService.spawnChildRun(owner, {
      space_id: "space-1",
      group_id: roomGroup.id,
      parent_run_id: first.run_ids[0]!,
      root_run_id: roomGroup.root_run_id,
      requesting_agent_id: agent.id,
      target_agent_id: delegatedAgent.id,
      manager_user_id: owner.userId,
      instruction: "Delegate this host-bound investigation.",
    });
    expect(delegated.child_run_id).toBeTruthy();
    const delegatedRun = await db.pool.query<{
      agent_id: string;
      workspace_location_id: string | null;
      trust_mode: string | null;
      host_task_thread_id: string | null;
      requested_runtime_profile_id: string | null;
      runtime_profile_selection_source: string | null;
      model_override_json: Record<string, unknown>;
      prompt: string | null;
    }>(
      `SELECT agent_id, workspace_location_id, trust_mode, host_task_thread_id,
              requested_runtime_profile_id, runtime_profile_selection_source, model_override_json, prompt
         FROM runs WHERE id = $1`,
      [delegated.child_run_id],
    );
    expect(delegatedRun.rows[0]).toMatchObject({
      agent_id: delegatedAgent.id,
      workspace_location_id: "location-1",
      trust_mode: "trusted_host",
      host_task_thread_id: expect.any(String),
      runtime_profile_selection_source: "explicit",
    });
    expect(delegatedRun.rows[0]?.model_override_json).toMatchObject({
      execution_mode: "room_conversation.v1",
      workspace: { kind: "location", workspace_location_id: "location-1" },
      host_thread: { schema_version: "host_thread.v1" },
    });
    // A delegated specialist runs in the same vendor session as one that was
    // @-mentioned, so its prompt opens with its own identity block — and a
    // sibling waiting on it is shown the instruction, never that prompt
    // (ADR 0003 §4, B68).
    expect(delegatedRun.rows[0]?.prompt).toContain("Separate evidence from assumption.");
    expect(runAssignedTask(delegatedRun.rows[0]!)).toBe("Delegate this host-bound investigation.");
    const delegatedThread = await db.pool.query<{ id: string; last_run_id: string; dispatch_lock_id: string | null }>(
      `SELECT id, last_run_id, dispatch_lock_id FROM host_threads
        WHERE session_id = $1 AND agent_id = $2 AND container_kind = 'conversation'`,
      [conversation.id, delegatedAgent.id],
    );
    expect(delegatedThread.rows[0]).toMatchObject({
      last_run_id: delegated.child_run_id,
      dispatch_lock_id: delegated.child_run_id,
    });
    await dispatchQueuedRoomRuns([delegated.child_run_id!]);
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now() WHERE id = $1`,
      [delegated.child_run_id],
    );
    await new PgHostThreadRepository(db.pool).recordRunOutcome(delegatedThread.rows[0]!.id, {
      lastRunId: delegated.child_run_id!,
      vendorSessionId: null,
      sessionReset: false,
    });

    const second = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Continue the remote research.",
      recipient_segments: [segment],
      backends: [backend],
    });
    expect(second.run_ids).toHaveLength(1);
    const secondRun = await db.pool.query<{ prompt: string }>(
      `SELECT prompt FROM runs WHERE id = $1`,
      [second.run_ids[0]],
    );
    expect(secondRun.rows[0]!.prompt).not.toContain("You are now in");
    // A direct chat pins the same host_thread override but carries the chat
    // path's execution_mode; routing must admit the host-bound profile on the
    // override itself, not on the surface's mode (the regression made every
    // direct chat fail with an empty candidate set).
    await db.pool.query(
      `UPDATE runs SET model_override_json = jsonb_set(model_override_json, '{execution_mode}', '"conversation_lightweight.v1"') WHERE id = $1`,
      [second.run_ids[0]],
    );
    const secondRunRecord = await new PgRunRepository(db.pool).getAgentRun("space-1", second.run_ids[0]!);
    if (!secondRunRecord) throw new Error("second host-bound Run was not persisted");
    await expect(new PgRouteDecisionRepository(db.pool).routeRun(secondRunRecord))
      .resolves.toMatchObject({ runtime_profile_id: profile.rows[0]!.id });
    await new PgRunRepository(db.pool).markRunRunning({
      run_id: second.run_ids[0]!,
      space_id: "space-1",
      started_at: new Date().toISOString(),
    });
    expect(secondRun.rows[0]!.prompt).not.toContain("[Internal Project guidance");
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now() WHERE id = $1`,
      [second.run_ids[0]],
    );
    await new PgHostThreadRepository(db.pool).recordRunOutcome(thread.rows[0]!.id, {
      lastRunId: second.run_ids[0]!,
      vendorSessionId: null,
      sessionReset: false,
    });

    await db.pool.query(
      `UPDATE hosts SET last_heartbeat_at = now() - interval '2 minutes' WHERE id = 'host-room-bound'`,
    );
    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "This must not queue while the host is offline.",
      recipient_segments: [segment],
      backends: [backend],
    })).rejects.toMatchObject({ statusCode: 409 });

    await db.pool.query("UPDATE hosts SET last_heartbeat_at = now() WHERE id = 'host-room-bound'");
    await expect(service.sendMessage(member, created.room.id, conversation.id, {
      content: "Try the remote researcher.",
      recipient_segments: [segment],
      backends: [backend],
    })).rejects.toMatchObject({ statusCode: 403 });

    await service.resetAgentContext(owner, created.room.id, agent.id);
    await expect(db.pool.query<{ status: string; vendor_session_id: string | null }>(
      `SELECT thread.status, thread.vendor_session_id
         FROM host_threads thread
         JOIN sessions conversation ON conversation.id = thread.session_id AND conversation.space_id = thread.space_id
        WHERE conversation.space_id = 'space-1' AND conversation.room_id = $1
          AND thread.agent_id = $2 AND thread.container_kind = 'conversation'
        ORDER BY conversation.updated_at DESC, conversation.id DESC
        LIMIT 1`,
      [created.room.id, agent.id],
    )).resolves.toMatchObject({ rows: [{ status: "session_reset", vendor_session_id: null }] });
    await service.removeAgent(owner, created.room.id, agent.id);
    await expect(db.pool.query<{ status: string }>(
      `SELECT thread.status
         FROM host_threads thread
         JOIN sessions conversation ON conversation.id = thread.session_id AND conversation.space_id = thread.space_id
        WHERE conversation.space_id = 'space-1' AND conversation.room_id = $1
          AND thread.agent_id = $2 AND thread.container_kind = 'conversation'
        ORDER BY conversation.updated_at DESC, conversation.id DESC
        LIMIT 1`,
      [created.room.id, agent.id],
    )).resolves.toMatchObject({ rows: [{ status: "closed" }] });
  });

  it("requires each private-Agent owner to approve a Room invitation and supports suspended-owner recovery", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    await db.pool.query(
      `UPDATE project_members
          SET role = 'member', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    const owner = { spaceId: "space-1", userId: "user-1" };
    const specialistOwner = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Invitation roster" });
    await addRoomMember(created.room.id, "user-2");
    await db.pool.query(
      `INSERT INTO agents (
         id, space_id, owner_user_id, name, status, agent_kind,
         visibility, created_at, updated_at
       ) VALUES ('agent-owned-by-member', 'space-1', 'user-2', 'Member Specialist', 'active',
         'standard', 'private', now(), now())`,
    );
    await service.addAgent(specialistOwner, created.room.id, {
      agent_id: "agent-owned-by-member",
      share_private_with_member_ids: ["user-1"],
      confirm_room_share: true,
    });

    // inviteUser requires the invitee (not the inviter) to already have
    // Project read access, so the Room invitation cannot become a side
    // door into Project-bound content the invitee couldn't otherwise see.
    await db.pool.query(
      `INSERT INTO project_members (
         id, space_id, project_id, user_id, role, status, created_at, updated_at
       ) VALUES ('project-member-3', 'space-1', 'project-1', 'user-3', 'viewer', 'active', now(), now())`,
    );

    const invitation = await service.inviteUser(owner, created.room.id, { user_id: "user-3" });
    expect(invitation.status).toBe("pending");
    expect(invitation.approvals).toEqual([
      expect.objectContaining({ agent_id: "agent-owned-by-member", owner_user_id: "user-2", status: "pending" }),
    ]);
    await expect(service.listPendingApprovals(specialistOwner, { limit: 50, offset: 0 }))
      .resolves.toMatchObject({
        items: [expect.objectContaining({
          invitation_id: invitation.id,
          room_id: created.room.id,
          project_id: "project-1",
          agent_id: "agent-owned-by-member",
        })],
      });
    await db.pool.query(
      `UPDATE project_members
          SET status = 'revoked', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    // Space membership gates the endpoint itself (404 if not an active
    // Space member); revoked Project access is a per-item visibility
    // filter, so it degrades the approval to invisible rather than erroring
    // the whole call — user-2 is still an active Space member here.
    await expect(service.listPendingApprovals(specialistOwner, { limit: 50, offset: 0 }))
      .resolves.toMatchObject({ items: [], total: 0 });
    await db.pool.query(
      `UPDATE project_members
          SET status = 'active', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    const decided = await service.decideInvitation(specialistOwner, created.room.id, invitation.id, {
      agent_id: "agent-owned-by-member",
      decision: "approved",
    });
    expect(decided.status).toBe("active");
    await expect(db.pool.query<{ status: string }>(
      `SELECT status FROM room_user_members
        WHERE space_id = 'space-1' AND room_id = $1 AND user_id = 'user-3'`,
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ status: "active" }] });
    await expect(db.pool.query<{ grantee_user_id: string }>(
      `SELECT grantee_user_id FROM room_agent_access_grants
        WHERE space_id = 'space-1' AND room_id = $1 AND agent_id = 'agent-owned-by-member'
          AND grantee_user_id = 'user-3' AND revoked_at IS NULL`,
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ grantee_user_id: "user-3" }] });

    await service.transferOwner(owner, created.room.id, "user-2");
    await db.pool.query(
      `UPDATE project_members
          SET status = 'revoked', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    const recovered = await service.claimOwner(owner, created.room.id);
    expect(recovered.user_members.find((member) => member.user_id === "user-1")?.role).toBe("owner");
    expect(recovered.user_members.filter((member) => member.role === "owner")).toHaveLength(1);
  });

  it("rejects a Room send after the Primary Git baseline changes before creating a message or Run", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET workspace_mode = 'location', workspace_location_id = 'location-1'
        WHERE id = 'runtime-cli'`,
    );
    await db.pool.query(
      `UPDATE workspace_locations
          SET branch = 'main', git_head = 'baseline', execution_ready = true
        WHERE id = 'location-1'`,
    );
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Git guard" });
    const conversation = await seedConversation(owner, created.room.id, "Git guard", {
      hostId: "host-1",
      primary: { kind: "location", workspace_location_id: "location-1" },
    });
    const before = await db.pool.query<{ messages: string; runs: string }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE session_id = $1) AS messages,
         (SELECT count(*) FROM runs WHERE session_id = $1) AS runs`,
      [conversation.id],
    );
    await db.pool.query(
      `UPDATE workspace_locations SET git_head = 'changed', updated_at = now() WHERE id = 'location-1'`,
    );

    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "This must not dispatch on the changed workspace.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
    })).rejects.toMatchObject({ statusCode: 409 });

    const after = await db.pool.query<{ messages: string; runs: string }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE session_id = $1) AS messages,
         (SELECT count(*) FROM runs WHERE session_id = $1) AS runs`,
      [conversation.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("advances the Git baseline when HEAD moved to where this Conversation's own last Run left it, and still refuses any other move", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET workspace_mode = 'location', workspace_location_id = 'location-1'
        WHERE id = 'runtime-cli'`,
    );
    await db.pool.query(
      `UPDATE workspace_locations
          SET branch = 'main', git_head = 'baseline', execution_ready = true
        WHERE id = 'location-1'`,
    );
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Git own run" });
    const conversation = await seedConversation(owner, created.room.id, "Git own run", {
      hostId: "host-1",
      primary: { kind: "location", workspace_location_id: "location-1" },
    });
    const backends = [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }];
    const first = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Commit the change.",
      backends,
    });
    const runId = first.run_ids[0]!;
    await dispatchQueuedRoomRuns(first.run_ids);
    // The host reports where the Run left the checkout, with its diff.
    const hosts = new PgHostRepository(db.pool);
    const uploadRun = await hosts.runOwnedByHost("host-1", runId);
    expect(uploadRun).not.toBeNull();
    await hosts.recordDiffArtifact(uploadRun!, "user-1", {
      diff: "diff --git a/x b/x\n+commit\n",
      truncated: false,
      git_before: { branch: "main", head: "baseline" },
      git_after: { branch: "main", head: "agent-commit" },
    });
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [runId],
    );
    await releaseConversationTurn(runId);
    // The next heartbeat carries the commit the Agent made.
    await db.pool.query(
      `UPDATE workspace_locations SET git_head = 'agent-commit', updated_at = now() WHERE id = 'location-1'`,
    );

    const second = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Continue from your commit.",
      backends,
    });
    expect(second.run_ids).toHaveLength(1);
    const advanced = await db.pool.query<{ git_branch: string; git_head: string }>(
      `SELECT git_branch, git_head FROM conversation_execution_contexts WHERE session_id = $1`,
      [conversation.id],
    );
    expect(advanced.rows[0]).toEqual({ git_branch: "main", git_head: "agent-commit" });
    // Advancing starts a new account: the old last-Run HEAD vouches for nothing.
    await expect(db.pool.query(
      `SELECT last_run_git_head FROM conversation_execution_contexts WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ last_run_git_head: null }] });

    await dispatchQueuedRoomRuns(second.run_ids);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [second.run_ids[0]],
    );
    await releaseConversationTurn(second.run_ids[0]!);
    // Somebody else commits on top; no Run of this Conversation left HEAD there.
    await db.pool.query(
      `UPDATE workspace_locations SET git_head = 'someone-else', updated_at = now() WHERE id = 'location-1'`,
    );
    const before = await db.pool.query<{ messages: string; runs: string }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE session_id = $1) AS messages,
         (SELECT count(*) FROM runs WHERE session_id = $1) AS runs`,
      [conversation.id],
    );
    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "This must not dispatch on a HEAD someone else moved.",
      backends,
    })).rejects.toMatchObject({ statusCode: 409 });
    const after = await db.pool.query<{ messages: string; runs: string }>(
      `SELECT
         (SELECT count(*) FROM messages WHERE session_id = $1) AS messages,
         (SELECT count(*) FROM runs WHERE session_id = $1) AS runs`,
      [conversation.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("does not honour a last-Run HEAD from before a refresh when somebody else later moves HEAD there", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET workspace_mode = 'location', workspace_location_id = 'location-1'
        WHERE id = 'runtime-cli'`,
    );
    await db.pool.query(
      `UPDATE workspace_locations SET branch = 'main', git_head = 'baseline', execution_ready = true WHERE id = 'location-1'`,
    );
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Git refresh" });
    const conversation = await seedConversation(owner, created.room.id, "Git refresh", {
      hostId: "host-1",
      primary: { kind: "location", workspace_location_id: "location-1" },
    });
    // This Conversation's Run once left HEAD at H1 …
    await db.pool.query(
      `UPDATE conversation_execution_contexts SET last_run_git_branch = 'main', last_run_git_head = 'h1' WHERE session_id = $1`,
      [conversation.id],
    );
    // … then the person moved it elsewhere and refreshed the baseline there.
    await db.pool.query(`UPDATE workspace_locations SET git_head = 'person-commit' WHERE id = 'location-1'`);
    await new ConversationExecutionContextService(db.pool).refreshGit(owner, conversation.id);
    // Somebody else now moves HEAD to H1: nothing of this Conversation's did.
    await db.pool.query(`UPDATE workspace_locations SET git_head = 'h1' WHERE id = 'location-1'`);
    await expect(service.sendMessage(owner, created.room.id, conversation.id, {
      content: "This must not dispatch.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("notifies the Room when a delegated child run completes with nobody waiting on it (room-advancement-reliability-plan Phase 3)", async (ctx) => {
    if (!db.available || !service || !groupService || !testRoot) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       risk_level,
       created_at
     ) VALUES (
       'version-2',
       'agent-2',
       'space-1',
       'v1',
       'Specialist.',
       '{}'::jsonb,
       '{}'::jsonb,
       '[]'::jsonb,
       '{}'::jsonb,
       'low',
       $1
     )`,
      [now],
    );
    await db.pool.query("UPDATE agents SET current_version_id = 'version-2' WHERE id = 'agent-2'");
    await db.pool.query(
      `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'agent', NULL, 'agent-2', NULL, 'Research Specialist', 'active', '{}'::jsonb, $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-cli-2',
       'space-1',
       'agent-2',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Subscription',
       'claude_code',
       'runtime_native',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       true,
       $1,
       $1
     )`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-api',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       $1,
       $1
     )`,
      [now],
    );

    const created = await service.createRoom(owner, { project_id: "project-1", title: "Delegation Room" });
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
      [randomUUID(), created.room.id, now],
    );
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Ask a specialist to look into this.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli"}],
    });
    const managerRunId = sent.run_ids[0]!;
    // The Manager's own turn must reach a terminal status before another
    // dispatch (this test's later delegation-completion continuation) can
    // claim the conversation's turn again — mirrors the pattern the
    // continueAfterProposal tests above already use.
    await dispatchQueuedRoomRuns([managerRunId]);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [managerRunId],
    );
    await releaseConversationTurn(managerRunId);
    const group = await new PgAgentGroupRepository(db.pool).getGroup("space-1", sent.task_group_ids[0]!);
    if (!group?.root_run_id) throw new Error("group or its root_run_id not found");

    const spawned = await groupService.spawnChildRun(owner, {
      space_id: "space-1",
      group_id: group.id,
      parent_run_id: managerRunId,
      root_run_id: group.root_run_id,
      requesting_agent_id: "agent-1",
      target_agent_id: "agent-2",
      manager_user_id: "user-1",
      instruction: "Investigate the working-memory question.",
    });
    expect(spawned.child_run_id).toBeTruthy();
    await expect(db.pool.query<{ trust_mode: string | null }>(
      "SELECT trust_mode FROM runs WHERE id = $1",
      [spawned.child_run_id],
    )).resolves.toMatchObject({ rows: [{ trust_mode: null }] });

    await dispatchQueuedRoomRuns([spawned.child_run_id!]);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', output_json=$2, ended_at=now(), updated_at=now() WHERE id=$1",
      [spawned.child_run_id, JSON.stringify({ summary: "Layered memory improves recall by 12%." })],
    );
    const runs = new PgRunRepository(db.pool);
    const childRun = await runs.getRun("space-1", spawned.child_run_id!);
    if (!childRun) throw new Error("child run not found");

    const projector = new AgentGroupRunLifecycleProjector(db.pool, loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      RAINVER_HOME: testRoot,
    }));
    await projector.markDelegatedRunTerminal(childRun);

    const posted = await db.pool.query<{ content: string; metadata_json: Record<string, unknown> }>(
      `SELECT content, metadata_json FROM messages
        WHERE space_id='space-1' AND session_id=$1 AND role='system'
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'
        ORDER BY created_at DESC LIMIT 1`,
      [conversation.id],
    );
    expect(posted.rows[0]).toBeTruthy();
    expect(posted.rows[0]?.metadata_json).toMatchObject({
      continuation_directive: "synthesize_delegation_result",
      continuation_event_key: spawned.delegation.id,
    });
    expect(posted.rows[0]?.content).toContain("Layered memory improves recall by 12%.");

    // Idempotent retry: reconciling the same terminal transition again (as
    // a reconciliation job retry would) must not post a second continuation.
    await projector.markDelegatedRunTerminal(childRun);
    const recount = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(recount.rows[0]?.total).toBe("1");
  });

  it("admits at most `max_fanout` delegations per turn and attributes each child to the specialist's own version", async (ctx) => {
    if (!db.available || !service || !groupService || !testRoot) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await seedSpecialist(now, "agent-2", "version-2", "Research Specialist");
    await seedSpecialist(now, "agent-3", "version-3", "Coding Specialist");

    const created = await service.createRoom(owner, { project_id: "project-1", title: "Budget Room" });
    for (const agentId of ["agent-2", "agent-3"]) {
      await db.pool.query(
        `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
         VALUES ($1, 'space-1', $2, $3, 'member', 'active', $4, $4)`,
        [randomUUID(), created.room.id, agentId, now],
      );
    }
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Split this between the specialists.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli" }],
    });
    const managerRunId = sent.run_ids[0]!;
    const group = await new PgAgentGroupRepository(db.pool).getGroup("space-1", sent.task_group_ids[0]!);
    if (!group?.root_run_id) throw new Error("group or its root_run_id not found");
    expect(group.budget_json).toEqual({ max_depth: 1, max_fanout: 2 });

    const spawn = (targetAgentId: string, instruction: string) => groupService!.spawnChildRun(owner, {
      space_id: "space-1",
      group_id: group.id,
      parent_run_id: managerRunId,
      root_run_id: group.root_run_id!,
      requesting_agent_id: "agent-1",
      target_agent_id: targetAgentId,
      manager_user_id: "user-1",
      instruction,
    });

    const first = await spawn("agent-2", "Investigate the question.");
    const second = await spawn("agent-3", "Prototype the fix.");
    expect(first.child_run_id).toBeTruthy();
    expect(second.child_run_id).toBeTruthy();

    // The child is the specialist's Run: its turn record names the
    // specialist's version, not the Manager's the parent turn was spread from.
    const runs = new PgRunRepository(db.pool);
    const firstChild = await runs.getRun("space-1", first.child_run_id!);
    expect(firstChild).toMatchObject({
      agent_id: "agent-2",
      agent_version_id: "version-2",
      model_override_json: expect.objectContaining({
        chat_turn: expect.objectContaining({ agent_id: "agent-2", agent_version_id: "version-2" }),
      }),
    });

    // `max_fanout: 2` means two: the third is refused, and counted as refused.
    const third = await spawn("agent-2", "One more thing.");
    expect(third.child_run_id).toBeNull();
    expect(third.delegation.status).toBe("policy_denied");
    const denied = await db.pool.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT metadata_json FROM run_events
        WHERE space_id='space-1' AND run_id=$1 AND event_type='delegation_policy_denied'`,
      [managerRunId],
    );
    expect(denied.rows.map((row) => row.metadata_json.reason_code)).toEqual(["run_spawn_child_capacity_limit"]);
  });

  it("does not duplicate the resume path when a Manager is already waiting on the completed delegation (room-advancement-reliability-plan Phase 3)", async (ctx) => {
    if (!db.available || !service || !groupService || !testRoot) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       risk_level,
       created_at
     ) VALUES (
       'version-2',
       'agent-2',
       'space-1',
       'v1',
       'Specialist.',
       '{}'::jsonb,
       '{}'::jsonb,
       '[]'::jsonb,
       '{}'::jsonb,
       'low',
       $1
     )`,
      [now],
    );
    await db.pool.query("UPDATE agents SET current_version_id = 'version-2' WHERE id = 'agent-2'");
    await db.pool.query(
      `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'agent', NULL, 'agent-2', NULL, 'Research Specialist', 'active', '{}'::jsonb, $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-api',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       $1,
       $1
     )`,
      [now],
    );

    const created = await service.createRoom(owner, { project_id: "project-1", title: "Delegation Room" });
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
      [randomUUID(), created.room.id, now],
    );
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Ask a specialist and wait for the result.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli"}],
    });
    const managerRunId = sent.run_ids[0]!;
    const group = await new PgAgentGroupRepository(db.pool).getGroup("space-1", sent.task_group_ids[0]!);
    if (!group?.root_run_id) throw new Error("group or its root_run_id not found");

    const spawned = await groupService.spawnChildRun(owner, {
      space_id: "space-1",
      group_id: group.id,
      parent_run_id: managerRunId,
      root_run_id: group.root_run_id,
      requesting_agent_id: "agent-1",
      target_agent_id: "agent-2",
      manager_user_id: "user-1",
      instruction: "Investigate the working-memory question.",
    });
    expect(spawned.child_run_id).toBeTruthy();

    // Simulate the Manager while its ACP invocation is active, including the
    // route snapshot and attempt that real dispatch persists before exposing
    // Agent tools.
    await dispatchQueuedRoomRuns([managerRunId]);
    const runs = new PgRunRepository(db.pool);
    const managerRun = await runs.getAgentRun("space-1", managerRunId);
    if (!managerRun) throw new Error("manager run not found");
    const binding = await resolveAgentDelegationToolBinding(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }),
      managerRun,
      { pool: db.pool },
    );
    if (!binding) throw new Error("agent room tool binding not found");
    const waitResult = await runAgentRoomToolCall({
      id: "wait-call-1",
      name: "agent.wait_for_results",
      arguments_json: JSON.stringify({
        scope: "own_delegations",
        reason: "Waiting on the specialist.",
      }),
    }, binding, managerRun);
    expect(waitResult.modelResult).toMatchObject({
      ok: true,
      status: "waiting",
      depends_on_run_ids: [spawned.child_run_id],
      pending_run_ids: [spawned.child_run_id],
    });

    const pausedManager = await runs.getRun("space-1", managerRunId);
    expect(pausedManager).toMatchObject({
      status: "waiting_for_dependency",
      output_json: {
        waiting_for_results: {
          status: "waiting",
          scope: "own_delegations",
          reason: "Waiting on the specialist.",
          depends_on_run_ids: [spawned.child_run_id],
        },
      },
    });
    await expect(db.pool.query<{ status: string }>(
      `SELECT status FROM run_attempts WHERE space_id='space-1' AND run_id=$1`,
      [managerRunId],
    )).resolves.toMatchObject({ rows: [{ status: "waiting_for_dependency" }] });
    await db.pool.query(
      `INSERT INTO run_execution_locks (run_id, locked_at, worker_id, job_id)
       VALUES ($1, $2, 'manager-worker', NULL)`,
      [managerRunId, now],
    );

    // The child was created queued with no job. Parking the Manager is the
    // yield that admits it — what the orchestrator does once the wait tool
    // has returned — and nothing else ever would, because the only other
    // admission is the Manager finishing, which it cannot do while it waits
    // on this very child.
    const projector = new AgentGroupRunLifecycleProjector(db.pool, loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      RAINVER_HOME: testRoot,
    }));
    const childJobs = () => db.pool.query<{ run_id: string; status: string }>(
      `SELECT payload_json->>'run_id' AS run_id, status FROM jobs
        WHERE space_id='space-1' AND job_type='agent_run' AND payload_json->>'run_id' = $1`,
      [spawned.child_run_id],
    );
    expect((await childJobs()).rows).toEqual([]);
    await projector.queueDelegatedChildren(pausedManager!);
    expect((await childJobs()).rows).toMatchObject([{ run_id: spawned.child_run_id, status: "pending" }]);
    // Idempotent: a second yield does not queue the child twice.
    await projector.queueDelegatedChildren(pausedManager!);
    expect((await childJobs()).rows).toHaveLength(1);

    await dispatchQueuedRoomRuns([spawned.child_run_id!]);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', output_json=$2, ended_at=now(), updated_at=now() WHERE id=$1",
      [spawned.child_run_id, JSON.stringify({ summary: "Layered memory improves recall by 12%." })],
    );
    const childRun = await runs.getRun("space-1", spawned.child_run_id!);
    if (!childRun) throw new Error("child run not found");

    await projector.markDelegatedRunTerminal(childRun);

    // The child projector sees the durable waiter but must not enqueue it while
    // the Manager's ACP invocation still owns its execution lock.
    expect((await runs.getRun("space-1", managerRunId))?.status).toBe("waiting_for_dependency");
    await db.pool.query("DELETE FROM run_execution_locks WHERE run_id=$1", [managerRunId]);
    await projector.reconcileWaitingRun(pausedManager!);

    // After the execution lock is released, recovery resumes the same Run and
    // attempt with the completed result in its continuation prompt.
    const resumedManager = await runs.getRun("space-1", managerRunId);
    expect(resumedManager).toMatchObject({
      id: managerRunId,
      status: "queued",
      prompt: expect.stringContaining("Layered memory improves recall by 12%"),
      output_json: {
        waiting_for_results: { status: "resumed" },
        waiting_for_results_resume: { resumed_at: expect.any(String) },
      },
    });
    await expect(db.pool.query<{ status: string }>(
      `SELECT status FROM run_attempts
        WHERE space_id='space-1' AND run_id=$1 AND attempt_number=1`,
      [managerRunId],
    )).resolves.toMatchObject({ rows: [{ status: "queued" }] });

    // The new domain-event continuation must not also have fired for this
    // completion — that would duplicate the resume path above.
    const posted = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(posted.rows[0]?.total).toBe("0");
  });

  it("retries the delegation-completion notification when the conversation turn is busy, and the retry succeeds once it frees up (integration-gate fix)", async (ctx) => {
    if (!db.available || !service || !groupService || !testRoot) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      RAINVER_HOME: testRoot,
    });
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       risk_level,
       created_at
     ) VALUES (
       'version-2',
       'agent-2',
       'space-1',
       'v1',
       'Specialist.',
       '{}'::jsonb,
       '{}'::jsonb,
       '[]'::jsonb,
       '{}'::jsonb,
       'low',
       $1
     )`,
      [now],
    );
    await db.pool.query("UPDATE agents SET current_version_id = 'version-2' WHERE id = 'agent-2'");
    await db.pool.query(
      `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'agent', NULL, 'agent-2', NULL, 'Research Specialist', 'active', '{}'::jsonb, $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       name,
       runtime_key,
       backend_mode,
       model_provider_id,
       model_name,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       'runtime-api',
       'space-1',
       'agent-1',
       'host-1',
       'managed',
       'managed:1.0.0',
       'Managed API',
       'opencode',
       'model_provider',
       'provider-1',
       'test-model',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       $1,
       $1
     )`,
      [now],
    );

    const created = await service.createRoom(owner, { project_id: "project-1", title: "Delegation Room" });
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
      [randomUUID(), created.room.id, now],
    );
    const conversation = await seedConversation(owner, created.room.id, "Main");
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Ask two specialists in parallel, no need to wait.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-cli"}],
    });
    const managerRunId = sent.run_ids[0]!;
    await dispatchQueuedRoomRuns([managerRunId]);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [managerRunId],
    );
    await releaseConversationTurn(managerRunId);
    const group = await new PgAgentGroupRepository(db.pool).getGroup("space-1", sent.task_group_ids[0]!);
    if (!group?.root_run_id) throw new Error("group or its root_run_id not found");

    const spawned = await groupService.spawnChildRun(owner, {
      space_id: "space-1",
      group_id: group.id,
      parent_run_id: managerRunId,
      root_run_id: group.root_run_id,
      requesting_agent_id: "agent-1",
      target_agent_id: "agent-2",
      manager_user_id: "user-1",
      instruction: "Investigate the working-memory question.",
    });
    expect(spawned.child_run_id).toBeTruthy();
    await dispatchQueuedRoomRuns([spawned.child_run_id!]);

    // Simulate what a first delegate's own completion notification leaves
    // behind while it is mid-dispatch: a fresh, non-terminal run in this
    // conversation carrying the same Manager identity's chat_turn — exactly
    // what claimTurn treats as an in-progress turn for that identity.
    const busyRunId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         session_id, created_at, updated_at, owner_user_id, visibility, access_level, model_override_json,
         execution_kind, requested_runtime_profile_id, runtime_profile_selection_source
       ) VALUES (
         $1,'space-1','agent-1','version-1','agent','manual','queued','live',
         $2,$3,$3,'user-1','private','full',$4::jsonb,
         'agent','runtime-cli','explicit')`,
      [busyRunId, conversation.id, now, JSON.stringify({ chat_turn: { schema_version: "chat_turn.v1", user_id: "user-1" } })],
    );
    await dispatchQueuedRoomRuns([busyRunId]);

    await db.pool.query(
      "UPDATE runs SET status='succeeded', output_json=$2, ended_at=now(), updated_at=now() WHERE id=$1",
      [spawned.child_run_id, JSON.stringify({ summary: "Layered memory improves recall by 12%." })],
    );
    const runs = new PgRunRepository(db.pool);
    const childRun = await runs.getRun("space-1", spawned.child_run_id!);
    if (!childRun) throw new Error("child run not found");

    const projector = new AgentGroupRunLifecycleProjector(db.pool, config);
    await projector.markDelegatedRunTerminal(childRun);

    // The turn was busy, so nothing posted yet.
    const beforeRetry = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(beforeRetry.rows[0]?.total).toBe("0");

    // A retry job was scheduled instead of the result being dropped.
    const jobs = await db.pool.query<{ payload_json: { delegation_id: string; child_run_id: string } }>(
      `SELECT payload_json FROM jobs WHERE space_id='space-1' AND job_type=$1`,
      [ROOM_DELEGATION_COMPLETION_RETRY_JOB],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload_json).toMatchObject({
      delegation_id: spawned.delegation.id,
      child_run_id: spawned.child_run_id,
    });

    // A third concurrent delegate finishing while the turn is still busy
    // must defer again through the job queue's own retry/backoff, not
    // silently drop or throw an unrecoverable error.
    const jobRegistry = new JobHandlerRegistry();
    registerRoomDelegationCompletionRetryHandler(jobRegistry, config);
    const containerTurns = async () => (await db.pool.query<{ used: string | null }>(
      `SELECT budget_json->>'container_turns_used' AS used FROM agent_run_groups WHERE id = $1`,
      [group.id],
    )).rows[0]?.used ?? null;
    const chargedBefore = await containerTurns();
    for (const attempt of ["retry-job-still-busy", "retry-job-still-busy-2"]) {
      await expect(jobRegistry.dispatch({
        job_id: attempt,
        space_id: "space-1",
        user_id: "user-1",
        job_type: ROOM_DELEGATION_COMPLETION_RETRY_JOB,
        attempts: 1,
        max_attempts: 3,
        worker_id: "test-worker",
        payload: jobs.rows[0]!.payload_json,
      })).rejects.toMatchObject({ name: "JobDeferredError" });
    }
    // A deferred retry spends nothing of the container's turns.
    expect(await containerTurns()).toBe(chargedBefore);
    const stillNotPosted = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(stillNotPosted.rows[0]?.total).toBe("0");

    // The turn frees up.
    await dispatchQueuedRoomRuns([busyRunId]);
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [busyRunId],
    );

    // Running the retry job now succeeds.
    await jobRegistry.dispatch({
      job_id: "retry-job-1",
      space_id: "space-1",
      user_id: "user-1",
      job_type: ROOM_DELEGATION_COMPLETION_RETRY_JOB,
      attempts: 1,
      max_attempts: 3,
      worker_id: "test-worker",
      payload: jobs.rows[0]!.payload_json,
    });

    const afterRetry = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(afterRetry.rows[0]?.total).toBe("1");
  });

  it("keeps an on-path message in the replay window when a reference is stamped ahead of it", async (ctx) => {
    if (!db.available || !service || !db.pool) return ctx.skip();
    const testPool = db.pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Replay Room" });
    const conversation = await seedConversation(owner, created.room.id, "Replay thread");

    // referenceService stamps an attached reference past the wall clock, so
    // the message written after it carries an earlier timestamp. A replay
    // window that bounded on the clock instead of the path would drop that
    // message from the Agent's prompt while the transcript still showed it.
    const ahead = new Date(Date.now() + 600_000).toISOString();
    await seedConversationMessages(testPool, {
      space: "space-1", session: conversation.id,
      messages: [
        { id: "replay-ref", role: "system", userId: "user-1", content: "Quoted material.",
          metadata: { room_display: "reference", reference: { kind: "thread", trust: "domain_approved" } },
          createdAt: ahead },
        { id: "replay-after", role: "user", userId: "user-1", content: "About that material." },
        { id: "replay-current", role: "user", userId: "user-1", content: "And the follow-up." },
      ],
    });
    // The summary covers through the reference, so the window starts after it.
    await testPool.query(
      `INSERT INTO room_conversation_summary_versions
         (id, space_id, room_id, session_id, version, status, summary_text,
          covered_through_message_id, covered_through_created_at, covered_message_count,
          source_token_estimate, summary_token_estimate, project_id, owner_user_id,
          system_prompt_version, schema_version, created_at)
       VALUES ('replay-sum', 'space-1', $1, $2, 1, 'active', 'Earlier material.',
               'replay-ref', $3, 1, 10, 5, 'project-1', 'user-1', 'v1', 'v1', now())`,
      [created.room.id, conversation.id, ahead],
    );

    const replay = await loadRoomConversationReplayThroughMessage(testPool, {
      spaceId: "space-1", sessionId: conversation.id, currentMessageId: "replay-current",
    });
    // The summary must actually be found, or the clock filter is never
    // reached and this proves nothing.
    expect(replay.summary?.covered_through_message_id).toBe("replay-ref");
    // `replay-after` is neither the boundary nor covered by the summary, so
    // nothing short-circuits the filter for it: it is in the window only if
    // the window bounds on the path rather than on the clock.
    expect(replay.messages.map((message) => message.id)).toContain("replay-after");
  });

  it("stops sweeping a conversation once its watermark reaches the head", async (ctx) => {
    if (!db.available || !service || !db.pool) return ctx.skip();
    const testPool = db.pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Sweep Room" });
    const conversation = await seedConversation(owner, created.room.id, "Sweep thread");

    // A reference stamped ahead of the wall clock (what referenceService's
    // `base = max(now, existing + 1)` produces), then a message after it on
    // the path but before it on the clock. Comparing the two by timestamp
    // instead of by position is what made the sweep re-select this
    // conversation forever, re-enqueueing a billed summary job every tick.
    const ahead = new Date(Date.now() + 600_000).toISOString();
    await seedConversationMessages(db.pool, {
      space: "space-1", session: conversation.id,
      messages: [
        { id: "sweep-ref", role: "system", userId: "user-1", content: "R".repeat(36_000),
          metadata: { room_display: "reference", reference: { kind: "thread", trust: "domain_approved" } },
          createdAt: ahead },
        { id: "sweep-after", role: "user", userId: "user-1", content: "A".repeat(36_000) },
      ],
    });

    // No provider stub: this exercises `reconcileMissingStates`, which only
    // selects and re-requests — it never reaches the summary provider.
    const summaries = new RoomConversationSummaryService(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot! }),
      testPool,
    );

    // Establish the watermark at the future-stamped reference first, so the
    // sweep below has to *advance* an existing row rather than insert a fresh
    // one — the ON CONFLICT branch is where the comparison lives.
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "sweep-ref", throughCreatedAt: ahead,
    });
    await expect(testPool.query<{ requested_through_message_id: string }>(
      "SELECT requested_through_message_id FROM room_conversation_summary_states WHERE session_id = $1",
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ requested_through_message_id: "sweep-ref" }] });

    // The sweep now has to move the watermark from the reference to the head,
    // which is deeper on the path but earlier on the clock.
    expect(await summaries.reconcileMissingStates()).toBe(1);
    await expect(testPool.query<{ requested_through_message_id: string }>(
      "SELECT requested_through_message_id FROM room_conversation_summary_states WHERE session_id = $1",
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ requested_through_message_id: "sweep-after" }] });

    // And having advanced, it finds nothing to do. A watermark compared on
    // the clock would still be sitting on the reference here, and this
    // conversation would be re-selected on every tick forever.
    expect(await summaries.reconcileMissingStates()).toBe(0);

    // A genuinely new message still triggers one.
    await seedConversationMessages(db.pool, {
      space: "space-1", session: conversation.id,
      messages: [{ id: "sweep-newer", role: "user", userId: "user-1", content: "N".repeat(28_000) }],
    });
    expect(await summaries.reconcileMissingStates()).toBe(1);
  });

  it("processes owner-funded summaries with strict output and preserves the active version on failure", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const testPool = db.pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Summary Room" });
    const conversation = await seedConversation(owner, created.room.id, "Summary thread");
    // After whatever the conversation already holds — the setup notice is a
    // real message on the path, and a fixture timestamped before its own
    // parent is a conversation that could not have happened.
    const firstMessageAt = new Date(Date.now() + 1000).toISOString();
    await seedConversationMessages(db.pool, {
      space: "space-1", session: conversation.id,
      messages: [
        { id: "summary-message-1", role: "user", userId: "user-1", content: "A".repeat(28_000), metadata: {}, createdAt: firstMessageAt },
        { id: "summary-message-2", role: "user", userId: "user-1", content: "A second constraint.", metadata: {},
          createdAt: new Date(Date.parse(firstMessageAt) + 1000).toISOString() },
      ],
    });

    let response = JSON.stringify({ summary: "Initial durable Room summary." });
    const providerStore = {
      authorizeCredentialSpend: async () => ({}) as never,
      // The summary chooses its provider from the database and resolves no
      // key before the spend is decided inside the completion.
      getInvocationTarget: async () => {
        throw new Error("the Room summary resolved a key before its spend was decided");
      },
    } as unknown as ProviderCommandStore;
    const summarySpends: CredentialSpendBasis[] = [];
    const dependencies: RoomConversationSummaryDependencies = {
      resolveProviderStore: () => providerStore,
      completeProviderMessages: async (_store, _spaceId, input) => {
        summarySpends.push(input.spend);
        return {
          text: response,
          provider: "openai",
          provider_id: "provider-1",
          model: "test-model",
          usage: { input_tokens: 10, output_tokens: 8 },
        };
      },
    };
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot! });
    const summaries = new RoomConversationSummaryService(config, testPool, dependencies);
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "summary-message-2", throughCreatedAt: new Date(Date.parse(firstMessageAt) + 1000).toISOString(),
    });
    await expect(testPool.query<{ status: string }>(
      `SELECT status FROM room_conversation_summary_states WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(summaries.process({ spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id }))
      .resolves.toMatchObject({ status: "published", version: 1 });
    // Nobody was present: the spend rested on the Room owner, re-read when it
    // is decided, so a Room its owner no longer holds spends nothing.
    const [ownerSetup] = summarySpends;
    if (ownerSetup?.kind !== "setup") throw new Error("the summary spent without naming its setup");
    expect(ownerSetup).toMatchObject({ setup: "room_summary", user_id: "user-1" });
    await expect(ownerSetup.still_authorized()).resolves.toBe(true);
    await testPool.query(`UPDATE rooms SET status = 'archived' WHERE id = $1`, [created.room.id]);
    await expect(ownerSetup.still_authorized()).resolves.toBe(false);
    await testPool.query(`UPDATE rooms SET status = 'active' WHERE id = $1`, [created.room.id]);
    const published = await testPool.query<{
      summary_text: string;
      project_id: string;
      owner_user_id: string;
      system_prompt_version: string;
      schema_version: string;
      summary_token_estimate: number;
    }>(
      `SELECT summary_text,project_id,owner_user_id,system_prompt_version,schema_version,summary_token_estimate
         FROM room_conversation_summary_versions
        WHERE session_id = $1 AND status = 'active'`,
      [conversation.id],
    );
    expect(published.rows[0]).toMatchObject({
      summary_text: "Initial durable Room summary.",
      project_id: "project-1",
      owner_user_id: "user-1",
      system_prompt_version: "room-summary-prompt.v1",
      schema_version: "room-summary-schema.v1",
    });
    expect(Number(published.rows[0]?.summary_token_estimate)).toBeGreaterThan(0);

    // The compaction batch retains the most-recent messages unsummarized
    // (kept for raw replay) rather than folding them into the summary —
    // summary-message-2 is tiny and the most recent of the two, so it is
    // retained rather than covered; the summary correctly stops at
    // summary-message-1, the older message that fell outside the retained
    // recent window.
    await expect(loadRoomContinuityForRunRequest(testPool, {
      spaceId: "space-1",
      sessionId: conversation.id,
    })).resolves.toMatchObject({
      room_summary: {
        summary_text: "Initial durable Room summary.",
        covered_through_message_id: "summary-message-1",
      },
    });
    await expect(loadRoomConversationReplayThroughMessage(testPool, {
      spaceId: "space-1",
      sessionId: conversation.id,
      currentMessageId: "summary-message-2",
    })).resolves.toMatchObject({
      summary: {
        summary_text: "Initial durable Room summary.",
        covered_through_message_id: "summary-message-1",
      },
      messages: [{ id: "summary-message-2" }],
    });

    await seedConversationMessages(testPool, {
      space: "space-1", session: conversation.id,
      messages: [{ id: "summary-message-3", role: "user", userId: "user-1",
        content: "B".repeat(28_000), metadata: {}, createdAt: new Date(Date.parse(firstMessageAt) + 2000).toISOString() }],
    });
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "summary-message-3", throughCreatedAt: new Date(Date.parse(firstMessageAt) + 2000).toISOString(),
    });
    await testPool.query(
      `UPDATE room_conversation_summary_states
          SET status='running', lease_token='expired-summary-lease',
              lease_expires_at=now() - interval '1 minute'
        WHERE session_id=$1`,
      [conversation.id],
    );
    await expect(summaries.recoverExpiredLeases()).resolves.toBe(1);
    response = JSON.stringify({ summary: "Second durable Room summary." });
    await expect(summaries.process({ spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id }))
      .resolves.toMatchObject({ status: "published", version: 2 });
    await expect(testPool.query<{ covered_through_message_id: string }>(
      `SELECT covered_through_message_id FROM room_conversation_summary_versions
        WHERE session_id = $1 AND status = 'active'`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ covered_through_message_id: "summary-message-3" }] });

    await seedConversationMessages(testPool, {
      space: "space-1", session: conversation.id,
      messages: [{ id: "summary-message-4", role: "user", userId: "user-1",
        content: "C".repeat(28_000), metadata: {}, createdAt: new Date(Date.parse(firstMessageAt) + 3000).toISOString() }],
    });
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "summary-message-4", throughCreatedAt: new Date(Date.parse(firstMessageAt) + 3000).toISOString(),
    });
    response = "provider refusal, not JSON";
    await expect(summaries.process({ spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id }))
      .resolves.toMatchObject({ status: "failed", reason: "empty_summary" });
    await expect(testPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM room_conversation_summary_versions
        WHERE session_id = $1 AND status = 'active'`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    // failLease always sanitizes the stored error through sanitizeSummaryError,
    // which only recognizes a real Error instance's name (timeout/abort/cancel);
    // a plain string message — what every call site here passes — falls
    // through to this generic text regardless of the specific message given.
    await expect(testPool.query<{ status: string; last_error: string }>(
      `SELECT status,last_error FROM room_conversation_summary_states WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ status: "retry_wait", last_error: "Summary provider request failed" }] });
    await expect(testPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages
        WHERE session_id=$1 AND sender_agent_id IS NOT NULL`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(testPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM proposals proposal
        JOIN runs run_row ON run_row.id=proposal.created_by_run_id
        WHERE run_row.session_id=$1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("gives each Project its own Assistant instance, following one seed until one is changed", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO projects (
         id, space_id, owner_user_id, name, status, created_at, updated_at
       ) VALUES ('project-2', 'space-1', 'user-1', 'Second Project', 'active', now(), now())`,
    );

    await seedProjectMainlineRoom(db.pool, {
      space: "space-1", project: "project-2", owner: "user-1", title: "Second Project",
    });
    // Provisioning follows the explicit Conversation draft now.
    const first = await service.createRoom(owner, { project_id: "project-1", title: "First" });
    const second = await service.createRoom(owner, { project_id: "project-2", title: "Second" });
    await service.createConversationDraft(owner, first.room.id);
    await service.createConversationDraft(owner, second.room.id);

    const assistants = await db.pool.query<{ id: string; project_id: string; name: string }>(
      `SELECT id, project_id, name
         FROM agents
        WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'
        ORDER BY project_id ASC`,
    );
    // Two Agents, one per Project, told apart by what they are for.
    expect(assistants.rows).toHaveLength(2);
    expect(assistants.rows.map((row) => row.project_id)).toEqual(["project-1", "project-2"]);
    // Both are named for what they are for, including the one that already
    // existed — reconciliation renames it, it is not only set at creation.
    expect(assistants.rows.map((row) => row.name))
      .toEqual(["Room Project Assistant", "Second Project Assistant"]);

    const managerOf = async (roomId: string): Promise<string> => {
      const row = await db.pool!.query<{ agent_id: string }>(
        `SELECT agent_id FROM room_agent_members
          WHERE room_id = $1 AND role = 'manager' AND status = 'active'`,
        [roomId],
      );
      return row.rows[0]!.agent_id;
    };
    const firstManager = await managerOf(first.room.id);
    const secondManager = await managerOf(second.room.id);
    expect(firstManager).not.toBe(secondManager);

    const promptOf = async (agentId: string): Promise<string> => {
      const row = await db.pool!.query<{ system_prompt: string | null }>(
        `SELECT v.system_prompt
           FROM agents a JOIN agent_versions v ON v.id = a.current_version_id
          WHERE a.id = $1`,
        [agentId],
      );
      return row.rows[0]?.system_prompt ?? "";
    };
    expect(await promptOf(firstManager)).toBe(await promptOf(secondManager));

    // Change the seed itself, then re-materialize: both instances follow it.
    // Asserting on the shipped prompt text instead would prove only that they
    // were created from the same thing, not that a change reaches them.
    await db.pool.query(
      `UPDATE evolvable_asset_versions
          SET content_json = jsonb_set(
                content_json, '{messages}',
                (SELECT jsonb_agg(
                          CASE WHEN message->>'role' = 'system'
                            THEN jsonb_set(
                                   message, '{content}',
                                   to_jsonb((message->>'content') || E'\nAlso mention the weather.'))
                            ELSE message END)
                   FROM jsonb_array_elements(content_json->'messages') AS message))
        WHERE id IN (
          SELECT d.version_id
            FROM prompt_deployment_refs d
            JOIN evolvable_assets asset ON asset.id = d.asset_id
           WHERE asset.asset_key = 'agent_template.personal_assistant.system'
             AND d.status = 'active'
        )`,
    );
    await speakInNewRoom(owner, "project-1", "First reseeded");
    await speakInNewRoom(owner, "project-2", "Second reseeded");
    expect(await promptOf(firstManager)).toContain("Also mention the weather.");
    expect(await promptOf(secondManager)).toContain("Also mention the weather.");

    // Give the second Project's instance a version of its own. Nothing else
    // marks it, so it is detached from the seed by that act alone.
    await db.pool.query(
      `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       system_prompt,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       created_at
     ) VALUES (
       $1,
       $2,
       'space-1',
       'v99',
       'A prompt somebody wrote by hand',
       '{}',
       '{}',
       '[]',
       '{}',
       now()
     )`,
      [randomUUID(), secondManager],
    );
    await db.pool.query(
      `UPDATE agents SET current_version_id = (
         SELECT id FROM agent_versions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1
       ) WHERE id = $1`,
      [secondManager],
    );

    // Re-materialize again. The following instance keeps tracking the seed;
    // the changed one is not overwritten — that work would be lost with
    // nothing recording it.
    await speakInNewRoom(owner, "project-1", "First again");
    await speakInNewRoom(owner, "project-2", "Second again");

    expect(await promptOf(firstManager)).toContain("Also mention the weather.");
    expect(await promptOf(secondManager)).toBe("A prompt somebody wrote by hand");

    // Reusing the Project's instance rather than making a third.
    const after = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agents
        WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'`,
    );
    expect(after.rows[0]!.count).toBe("2");
  });

  it("leaves the Space's own Assistant pointer alone when a Project provisions one", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const pointer = async (): Promise<unknown> => {
      const row = await db.pool!.query<{ settings_json: Record<string, unknown> }>(
        `SELECT settings_json FROM settings
          WHERE scope_type = 'space' AND settings_key = 'agent.default_assistant.settings'`,
      );
      return row.rows[0]?.settings_json?.assistant_agent_id ?? null;
    };
    const before = await pointer();
    const created = await speakInNewRoom(owner, "project-1", "Pointer Room");
    const manager = await db.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM room_agent_members
        WHERE room_id = $1 AND role = 'manager' AND status = 'active'`,
      [created.room.id],
    );
    // Assistant settings are Space-scoped preferences, not per-Project: a Room
    // created in a Project must never repoint them at that Project's instance.
    expect(await pointer()).toBe(before);
    expect(await pointer()).not.toBe(manager.rows[0]!.agent_id);

    // And on the create path too: a Project with no instance yet mints one,
    // which must not claim the Space pointer either. Only the reconcile path
    // was covered above, because project-1 already had an Assistant.
    await db.pool.query(
      `INSERT INTO projects (
         id, space_id, owner_user_id, name, status, created_at, updated_at
       ) VALUES ('project-4', 'space-1', 'user-1', 'Pointer Project', 'active', now(), now())`,
    );
    await seedProjectMainlineRoom(db.pool, {
      space: "space-1", project: "project-4", owner: "user-1", title: "Pointer Project",
    });
    const fresh = await speakInNewRoom(owner, "project-4", "Fresh Room");
    const freshManager = await db.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM room_agent_members
        WHERE room_id = $1 AND role = 'manager' AND status = 'active'`,
      [fresh.room.id],
    );
    expect(freshManager.rows[0]!.agent_id).not.toBe(manager.rows[0]!.agent_id);
    expect(await pointer()).toBe(before);
    expect(await pointer()).not.toBe(freshManager.rows[0]!.agent_id);
  });

  it("adopts an unmarked version it can prove nobody changed, and leaves a changed one alone", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO projects (
         id, space_id, owner_user_id, name, status, created_at, updated_at
       ) VALUES ('project-3', 'space-1', 'user-1', 'Adoption Project', 'active', now(), now())`,
    );
    await seedProjectMainlineRoom(db.pool, {
      space: "space-1", project: "project-3", owner: "user-1", title: "Adoption Project",
    });
    const first = await speakInNewRoom(owner, "project-3", "Adopt");
    const manager = await db.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM room_agent_members
        WHERE room_id = $1 AND role = 'manager' AND status = 'active'`,
      [first.room.id],
    );
    const agentId = manager.rows[0]!.agent_id;

    const markOf = async (): Promise<string | null> => {
      const row = await db.pool!.query<{ follows_seed_key: string | null }>(
        `SELECT v.follows_seed_key
           FROM agents a JOIN agent_versions v ON v.id = a.current_version_id
          WHERE a.id = $1`,
        [agentId],
      );
      return row.rows[0]?.follows_seed_key ?? null;
    };
    expect(await markOf()).toBe("agent_template.personal_assistant.system");

    // An instance provisioned before the mark existed: same content, no mark.
    // It is provably untouched, so it is adopted rather than treated as
    // somebody's work and abandoned.
    await db.pool.query(
      `UPDATE agent_versions SET follows_seed_key = NULL
        WHERE id = (SELECT current_version_id FROM agents WHERE id = $1)`,
      [agentId],
    );
    await speakInNewRoom(owner, "project-3", "Adopt again");
    expect(await markOf()).toBe("agent_template.personal_assistant.system");

    // An unmarked version whose content differs cannot be told apart from a
    // person's edit, so it is left alone. The unmarked column is itself the
    // record of that, which is why nothing else needs to write one.
    await db.pool.query(
      `UPDATE agent_versions SET follows_seed_key = NULL, system_prompt = 'Hand-written'
        WHERE id = (SELECT current_version_id FROM agents WHERE id = $1)`,
      [agentId],
    );
    await speakInNewRoom(owner, "project-3", "Adopt once more");
    expect(await markOf()).toBeNull();
    const kept = await db.pool.query<{ system_prompt: string | null }>(
      `SELECT v.system_prompt FROM agents a JOIN agent_versions v ON v.id = a.current_version_id
        WHERE a.id = $1`,
      [agentId],
    );
    expect(kept.rows[0]!.system_prompt).toBe("Hand-written");

    // The binding is repaired regardless: runtime profiles are reconciled
    // outside the version, and routing prefers them over the version's own
    // provider, so a left-alone instance does not also stop working.
    const profiles = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_runtime_profiles
        WHERE agent_id = $1 AND enabled = true`,
      [agentId],
    );
    expect(Number(profiles.rows[0]!.count)).toBeGreaterThan(0);
  });

  it("tells a Room's detail who may mutate its roster, and who else is in it", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const reader = { spaceId: "space-1", userId: "user-2" };
    const created = await openSpokenRoom(owner, { project_id: "project-1", title: "Detail" });
    // user-2 is a Space member and not on the Project: enrolled by the invite,
    // still without write authority. Every roster control is gated on this
    // flag, and an `undefined` here would be read as `false` — which is why
    // every `RoomDetail` producer is annotated to carry it.
    await service.inviteUser(owner, created.room.id, { user_id: "user-2" });
    const asOwner = await service.getRoom(owner, created.room.id);
    expect(asOwner).toMatchObject({ viewer_can_write: true, other_member_names: ["Room Member"], agent_count: 1 });
    // The same Room, described for the other person: they may not write, and
    // "who else is here" excludes the viewer.
    const asReader = await service.getRoom(reader, created.room.id);
    expect(asReader).toMatchObject({ viewer_can_write: false, other_member_names: ["Room Owner"], agent_count: 1 });
  });

  it("refuses a reference from another Project on either grain", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ('project-2', 'space-1', 'user-1', 'Second Project', 'active', now(), now())`,
    );
    await seedProjectMainlineRoom(db.pool, { space: "space-1", project: "project-2", owner: "user-1" });
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Here" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id, { content: "Stays here." },
    );
    const elsewhere = await openSpokenRoom(owner, { project_id: "project-2", title: "There" });

    // A non-goal made a rule: a reference never crosses a Project, however
    // readable both sides are to the same person.
    await expect(service.attachConversationReferences(owner, elsewhere.room.id, elsewhere.conversation.id, {
      references: [{ kind: "messages", id: source.conversation.id, item_ids: [said!.id] }],
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.attachConversationReferences(owner, elsewhere.room.id, elsewhere.conversation.id, {
      references: [{ kind: "thread", id: source.conversation.id }],
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses a message pick that names what the person cannot read, and says so by code", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Edges" });
    const sessions = new PgSessionRepository(db.pool);
    const said = await sessions.addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id, { content: "Visible." },
    );
    const internal = await sessions.addRoomInternalInstruction(
      "space-1", "user-1", source.room.id, source.conversation.id, { content: "Hidden instruction." },
    );
    const target = await seedConversation(owner, source.room.id, "Target");
    const attach = (item_ids: string[]) => service!.attachConversationReferences(owner, source.room.id, target.id, {
      references: [{ kind: "messages", id: source.conversation.id, item_ids }],
    });

    // A partial match is a refusal, never a quietly shorter copy — coded, so
    // the composer can drop the pick rather than retry it forever.
    await expect(attach([said!.id, randomUUID()]))
      .rejects.toMatchObject({ statusCode: 404, responseBody: { code: "reference_source_unavailable" } });
    // The pick surface is the transcript the person can read: an internal
    // instruction is not in it, so naming its id is naming nothing.
    await expect(attach([internal!.id]))
      .rejects.toMatchObject({ statusCode: 404, responseBody: { code: "reference_source_unavailable" } });
    await expect(attach([])).rejects.toMatchObject({ statusCode: 422 });
    // A thread with nothing summarized yet has no bounded whole to carry.
    await expect(service.attachConversationReferences(owner, source.room.id, target.id, {
      references: [{ kind: "thread", id: source.conversation.id }],
    })).rejects.toMatchObject({ statusCode: 409, responseBody: { code: "reference_summary_unavailable" } });
  });

  it("lets the database refuse a personal mainline and a second personal Room", async (ctx) => {
    if (!db.available) return ctx.skip();
    const insert = (id: string, mainline: boolean, personalFor: string | null) => db.pool.query(
      `INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status,
                          created_at, updated_at, is_mainline, personal_for_user_id)
       VALUES ($1, 'space-1', 'project-1', 'user-1', 'x', 'active', now(), now(), $2, $3)`,
      [id, mainline, personalFor],
    );
    // The constraints behind ADR 0018's shape, pinned at the row: the mainline
    // is everyone's, so it cannot be somebody's personal Room; and a person
    // has one personal Room per Project, so a second active one collides.
    await expect(insert(randomUUID(), true, "user-1")).rejects.toMatchObject({ code: "23514" });
    await insert(randomUUID(), false, "user-1");
    await expect(insert(randomUUID(), false, "user-1")).rejects.toMatchObject({ code: "23505" });
  });

  it("carries a whole thread as its summary, and inherits the thread's provenance", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Long-running" });
    const sessions = new PgSessionRepository(db.pool);
    const said = await sessions.addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id,
      { content: "A long discussion nobody wants copied whole." },
    );

    // A whole thread has no other bounded form, so it carries the summary.
    const versionId = randomUUID();
    await db.pool.query(
      `INSERT INTO room_conversation_summary_versions (
         id, space_id, room_id, session_id, version, status, summary_text,
         covered_through_message_id, covered_through_created_at, covered_message_count,
         source_token_estimate, summary_token_estimate, project_id, owner_user_id,
         system_prompt_version, schema_version, created_at
       ) VALUES ($1,'space-1',$2,$3,1,'active','They settled on arrow-free parsing.',
         $4, now(), 1, 100, 20, 'project-1', 'user-1', 'v1', 'v1', now())`,
      [versionId, source.room.id, source.conversation.id, said!.id],
    );
    await db.pool.query(
      `INSERT INTO room_conversation_summary_states (
         id, space_id, room_id, session_id, status, active_summary_id, updated_at
       ) VALUES ($1,'space-1',$2,$3,'idle',$4, now())`,
      [randomUUID(), source.room.id, source.conversation.id, versionId],
    );

    const target = await seedConversation(owner, source.room.id, "The new idea");
    await service.attachConversationReferences(owner, source.room.id, target.id, {
      references: [{ kind: "thread", id: source.conversation.id }],
    });

    const messages = await sessions.listRoomMessages("space-1", "user-1", source.room.id, target.id, 50, 0);
    const copied = (messages ?? []).find((message) => message.metadata_json?.room_display === "reference");
    expect(copied?.content).toContain("They settled on arrow-free parsing.");
    // The summary, not the transcript: the thing it is too long to carry.
    expect(copied?.content).not.toContain("A long discussion nobody wants copied whole.");
    expect(copied?.metadata_json).toMatchObject({
      reference: { kind: "thread", source_id: source.conversation.id, trust: "domain_approved" },
    });
  });

  it("carries outside-Rainver provenance forward, however many hops back it is", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Where it came in" });
    const sessions = new PgSessionRepository(db.pool);

    // Thread A holds a reference to vendor content, and then an Agent's reply
    // about it. Neither the reply nor a summary of the thread carries the
    // fence the original was wrapped in, so the label is all a later reader
    // has — and a rule that only looked at the picked rows would lose it.
    await seedConversationMessages(db.pool, {
      space: "space-1", session: source.conversation.id,
      messages: [{
        id: randomUUID(), role: "system", content: "Quoted transcript.",
        metadata: {
          room_display: "reference",
          reference: { kind: "imported_session", trust: "external_untrusted" },
        },
      }],
    });
    const reply = await sessions.addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id,
      { content: "So the transcript says the parser was rewritten." },
    );

    const target = await seedConversation(owner, source.room.id, "Following up");
    await service.attachConversationReferences(owner, source.room.id, target.id, {
      references: [{ kind: "messages", id: source.conversation.id, item_ids: [reply!.id] }],
    });

    const messages = await sessions.listRoomMessages("space-1", "user-1", source.room.id, target.id, 50, 0);
    const copied = (messages ?? []).find((message) => message.metadata_json?.room_display === "reference");
    expect(copied?.metadata_json).toMatchObject({
      reference: { kind: "messages", trust: "external_untrusted" },
    });
    // And it is fenced, because the label alone does not protect a prompt.
    expect(copied?.content).toContain("never");
    expect(copied?.content).toContain("begin quoted external transcript");
  });

  it("copies picked messages into another thread as a reference, and only content the picker can read", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Where it was discussed" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id,
      { content: "We ruled out polars because of the arrow dependency." },
    );
    // A second thread in the *same* Room: same audience, so no confirmation
    // is due. (Copying into the mainline would disclose — that is the next
    // test.)
    const targetConversation = await seedConversation(owner, source.room.id, "Elsewhere in the same Room");

    await service.attachConversationReferences(owner, source.room.id, targetConversation.id, {
      references: [{ kind: "messages", id: source.conversation.id, item_ids: [said!.id] }],
    });

    const messages = await new PgSessionRepository(db.pool)
      .listRoomMessages("space-1", "user-1", source.room.id, targetConversation.id, 50, 0);
    const reference = (messages ?? []).find((message) => message.metadata_json?.room_display === "reference");
    expect(reference?.content).toContain("ruled out polars");
    // Nothing the attach wrote reads as speech. The checkpoint extractor
    // derives `confirmed` from `role = 'user'` alone, so a reference written
    // as the attacher's turn would make every copied claim their word.
    expect((messages ?? []).some((message) => message.role === "user")).toBe(false);
    // It still records who brought it — that is provenance, and the extractor
    // reads it as `actorUserId` on an *observed* item, not as the person
    // having said it.
    expect(reference?.user_id).toBe("user-1");
    // Content, not a pointer: what it carries is in the message itself.
    expect(reference?.metadata_json).toMatchObject({
      room_display: "reference",
      reference: { kind: "messages", source_id: source.conversation.id, trust: "domain_approved" },
    });

    // A non-member of the source gets the same answer as for a conversation
    // that does not exist — no existence oracle (ADR 0018 decision 3). The
    // target is the mainline, which user-2 *can* reach, so the refusal comes
    // from the source-side gate and not from the target.
    const mainline = await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");
    const theirs = await seedConversation(owner, mainline.room.id, "Theirs");
    await expect(service.attachConversationReferences(
      { spaceId: "space-1", userId: "user-2" }, mainline.room.id, theirs.id,
      { references: [{ kind: "messages", id: source.conversation.id, item_ids: [said!.id] }] },
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to copy across an audience boundary until the person confirms it", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    // A limited Room holding only user-1, and the mainline, which user-2 is
    // in once they have opened the Project.
    const limited = await openSpokenRoom(owner, { project_id: "project-1", title: "Just me for now" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", limited.room.id, limited.conversation.id,
      { content: "Something I have not told the others." },
    );
    await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");
    const mainline = await service.getProjectMainline(owner, "project-1");
    const targetConversation = await seedConversation(owner, mainline.room.id);
    const pick = [{ kind: "messages" as const, id: limited.conversation.id, item_ids: [said!.id] }];

    // Refused, and it names who would gain access — a confirmation that
    // cannot say who is being let in is not informed consent.
    await expect(service.attachConversationReferences(owner, mainline.room.id, targetConversation.id, {
      references: pick,
    })).rejects.toMatchObject({
      statusCode: 409,
      responseBody: { code: "reference_disclosure_confirmation_required", gains_access_user_ids: ["user-2"] },
    });
    // Nothing was copied by the refusal.
    const before = await new PgSessionRepository(db.pool)
      .listRoomMessages("space-1", "user-1", mainline.room.id, targetConversation.id, 50, 0);
    expect((before ?? []).some((message) => message.metadata_json?.room_display === "reference")).toBe(false);

    await service.attachConversationReferences(owner, mainline.room.id, targetConversation.id, {
      references: pick,
      confirm_disclosure: true,
    });
    const after = await new PgSessionRepository(db.pool)
      .listRoomMessages("space-1", "user-1", mainline.room.id, targetConversation.id, 50, 0);
    expect((after ?? []).some((message) => message.content.includes("not told the others"))).toBe(true);
  });

  it("measures the mainline by who may read the Project, not by who has opened it", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const limited = await openSpokenRoom(owner, { project_id: "project-1", title: "Only mine" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", limited.room.id, limited.conversation.id,
      { content: "Not for everyone." },
    );
    const mainline = await service.getProjectMainline(owner, "project-1");
    const target = await seedConversation(owner, mainline.room.id);

    // user-2 is a Project member who has never opened the Project, so there
    // is no `room_user_members` row for them — mainline membership is written
    // on first open, not synced. Reading the roster would say the mainline's
    // audience is user-1 alone and let this copy land unconfirmed; user-2
    // would then read it the moment they first opened the Project.
    const roster = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM room_user_members
        WHERE space_id = 'space-1' AND room_id = $1 AND status = 'active'`,
      [mainline.room.id],
    );
    expect(roster.rows[0]!.count).toBe("1");

    await expect(service.attachConversationReferences(owner, mainline.room.id, target.id, {
      references: [{ kind: "messages", id: limited.conversation.id, item_ids: [said!.id] }],
    })).rejects.toMatchObject({
      statusCode: 409,
      responseBody: { gains_access_user_ids: ["user-2"] },
    });
  });

  it("takes the audience the refusal named, not a bare yes", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const limited = await openSpokenRoom(owner, { project_id: "project-1", title: "Only mine" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", limited.room.id, limited.conversation.id,
      { content: "Not for everyone." },
    );
    const mainline = await service.getProjectMainline(owner, "project-1");
    const target = await seedConversation(owner, mainline.room.id);
    const pick = [{ kind: "messages" as const, id: limited.conversation.id, item_ids: [said!.id] }];

    // Echoing back a set that no longer covers everyone who would gain access
    // is refused: a roster can grow between the refusal and the confirmation,
    // and consenting to a stale list is consenting to nobody in particular.
    await expect(service.attachConversationReferences(owner, mainline.room.id, target.id, {
      references: pick, confirm_disclosure: [],
    })).rejects.toMatchObject({ statusCode: 409 });

    await service.attachConversationReferences(owner, mainline.room.id, target.id, {
      references: pick, confirm_disclosure: ["user-2"],
    });
    const messages = await new PgSessionRepository(db.pool)
      .listRoomMessages("space-1", "user-1", mainline.room.id, target.id, 50, 0);
    expect((messages ?? []).some((message) => message.content.includes("Not for everyone"))).toBe(true);
  });

  it("reuses one personal Room per person per Project, and stops calling it personal once it is not", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    // Private continuation needs somewhere that is not the Project's shared
    // channel, and needs to land in the same place next time rather than
    // accumulating a Room per continuation.
    const first = await service.createRoom(owner, {
      project_id: "project-1", title: "Just me", personal: true,
    });
    const again = await service.createRoom(owner, {
      project_id: "project-1", title: "Just me, later", personal: true,
    });
    expect(again.room.id).toBe(first.room.id);
    expect(first.room.personal_for_user_id).toBe("user-1");
    expect(first.room.is_mainline).toBe(false);

    // Somebody else's personal Room in the same Project is a different Room.
    // A viewer cannot open one — creating a Room asserts writer authority —
    // which is why continuing a *private* session needs it while continuing a
    // shared one, which only speaks in the mainline that already exists, does
    // not.
    await db.pool.query(
      "UPDATE project_members SET role = 'member' WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'",
    );
    const other = await service.createRoom({ spaceId: "space-1", userId: "user-2" }, {
      project_id: "project-1", title: "Just me too", personal: true,
    });
    expect(other.room.id).not.toBe(first.room.id);

    // A Room with two people in it is not personal to either. Clearing the
    // marker rather than refusing the addition costs only that the next
    // private continuation opens a fresh Room.
    await service.inviteUser(owner, first.room.id, { user_id: "user-2" });
    const reopened = await service.createRoom(owner, {
      project_id: "project-1", title: "Just me again", personal: true,
    });
    expect(reopened.room.id).not.toBe(first.room.id);
    expect(reopened.room.personal_for_user_id).toBe("user-1");
  });

  it("keeps a limited Room's Runs out of the Run list, including from an oversight admin in the Project", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const limited = await openSpokenRoom(owner, { project_id: "project-1", title: "Just the two of us" });
    const dispatched = await service.sendMessage(owner, limited.room.id, limited.conversation.id, {
      content: "Work on this quietly.",
    });
    expect(dispatched.run_ids.length).toBeGreaterThan(0);

    // Something in the mainline, which the same people *may* see, so the
    // assertions below distinguish "the boundary held" from "this viewer sees
    // no Runs at all" — a predicate that excluded everything would otherwise
    // pass every negative check here.
    const mainline = await service.getProjectMainline(owner, "project-1");
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-1', 'manager', 'active', now(), now())`,
      [randomUUID(), mainline.room.id],
    );
    const sharedConversation = await seedConversation(owner, mainline.room.id);
    const shared = await service.sendMessage(owner, mainline.room.id, sharedConversation.id, { content: "Everyone can see this." });
    // Mainline membership follows Project membership but is written on first
    // open rather than synced, so open the Project as user-2 — which is what
    // the Project page does. Exempting the mainline from needing that row was
    // tried and reverted: `roomRunReadAccessSql` also gates Proposal accept
    // and reject, so the exemption widened a write authority nobody asked to
    // change. Not seeing a mainline Run until you have opened the Project once
    // is stricter, self-healing, and keeps this rule identical everywhere.
    await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");

    const runs = new PgRunRepository(db.pool);
    const seenBy = async (userId: string): Promise<Set<string>> => new Set(
      (await runs.listRuns({
        space_id: "space-1", user_id: userId, project_id: "project-1", limit: 50, offset: 0,
      })).map((run) => run.id),
    );
    const limitedRun = dispatched.run_ids[0]!;
    const sharedRun = shared.run_ids[0]!;
    expect([...(await seenBy("user-1"))]).toEqual(expect.arrayContaining([limitedRun, sharedRun]));

    // user-2 is a Project member who was never invited to the limited Room.
    // Without oversight the content predicate already excludes them, because a
    // Room's Runs are `selected_users` granted to its roster.
    expect((await seenBy("user-2")).has(limitedRun)).toBe(false);

    // With oversight they are admitted by the predicate's oversight branch,
    // and the Room boundary is the only thing left holding (ADR 0018 decision
    // 3). The detail path has always carried this rule; the list did not, so
    // it showed Runs the detail page then 404'd on.
    await db.pool.query("UPDATE spaces SET oversight_mode = 'full' WHERE id = 'space-1'");
    await db.pool.query(
      "UPDATE space_memberships SET role = 'admin' WHERE space_id = 'space-1' AND user_id = 'user-2'",
    );
    const asAdmin = await seenBy("user-2");
    expect(asAdmin.has(limitedRun)).toBe(false);
    // The positive control: oversight is live in this fixture, and the
    // predicate is not simply excluding everything.
    expect(asAdmin.has(sharedRun)).toBe(true);

    // Same answer from both paths, which is the point.
    await expect(runs.getVisibleRun("space-1", "user-2", limitedRun)).resolves.toBeNull();
    await expect(runs.getVisibleRun("space-1", "user-1", limitedRun)).resolves.toMatchObject({ id: limitedRun });

    // Not only the Run list: the Project Pulse count reads Runs too, and a
    // count that disagreed with the list would say "3 in progress" over a list
    // of two.
    const projects = new PgProjectRepository(db.pool);
    const pulse = async (userId: string) =>
      projects.summary({ spaceId: "space-1", userId }, "project-1");
    const ownerPulse = await pulse("user-1");
    const adminPulse = await pulse("user-2");
    expect(Number(adminPulse.active_run_count)).toBeLessThan(Number(ownerPulse.active_run_count));
    // Positive control: the count is filtered, not emptied — user-2 still
    // counts the mainline Run they may see.
    expect(Number(adminPulse.active_run_count)).toBeGreaterThan(0);

    // A Proposal and an Artifact from the limited Room's Run. Both inherit its
    // Room, and both are counted here — a count is an existence signal just as
    // much as a list is (ADR 0018 decision 3).
    await db.pool.query(
      `INSERT INTO proposals (id, space_id, project_id, proposal_type, status, risk_level, urgency,
                              title, payload_json, created_by_run_id, created_at, updated_at)
       VALUES ($1, 'space-1', 'project-1', 'memory_create', 'pending', 'low', 'normal',
               'From the limited Room', '{}'::jsonb, $2, now(), now())`,
      [randomUUID(), limitedRun],
    );
    await db.pool.query(
      `INSERT INTO artifacts (id, space_id, project_id, run_id, artifact_type, title,
                              surface_role, export_formats_json, created_at, updated_at)
       VALUES ($1, 'space-1', 'project-1', $2, 'document', 'From the limited Room',
               'user_output', '[]'::jsonb, now(), now())`,
      [randomUUID(), limitedRun],
    );
    const afterOwner = await pulse("user-1");
    const afterAdmin = await pulse("user-2");
    expect(Number(afterOwner.pending_proposal_count))
      .toBeGreaterThan(Number(afterAdmin.pending_proposal_count));
    expect(Number(afterOwner.artifact_count)).toBeGreaterThan(Number(afterAdmin.artifact_count));

    // And the Room itself, and its conversations, stay invisible to that same
    // admin — the other two clauses of the boundary.
    await expect(service.getRoom({ spaceId: "space-1", userId: "user-2" }, limited.room.id))
      .rejects.toMatchObject({ statusCode: 404 });
    const listed = await service.listProjectConversations(
      { spaceId: "space-1", userId: "user-2" }, "project-1", { limit: 50, offset: 0 },
    );
    expect(listed.items.map((item) => item.room_id)).not.toContain(limited.room.id);
    // And the Home page, which reads Runs through its own read model
    // (`frontendSupportReadModel.ts`): the boundary is one predicate, so a
    // third consumer of it must agree with the first two.
    const home = async (userId: string) =>
      (await new PgFrontendSupportService(db.pool).homeSummary({ spaceId: "space-1", userId }, {}))
        .recent_runs.map((run) => run.id);
    expect(await home("user-1")).toEqual(expect.arrayContaining([limitedRun, sharedRun]));
    const adminHome = await home("user-2");
    expect(adminHome).not.toContain(limitedRun);
    expect(adminHome).toContain(sharedRun);
  });

  it("keeps the mainline the Room the Project was created with, and never promotes a later one", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    // The mainline is a Project attribute (ADR 0018 decision 4), so a Room
    // opened afterwards is a second audience and never claims it — including
    // the first one somebody opens.
    const first = await service.createRoom(owner, { project_id: "project-1", title: "Daily" });
    const second = await service.createRoom(owner, { project_id: "project-1", title: "Tax season" });
    expect(first.room.is_mainline).toBe(false);
    expect(second.room.is_mainline).toBe(false);
    const mainline = await service.getProjectMainline(owner, "project-1");
    expect(mainline.room.is_mainline).toBe(true);
    expect(mainline.room.id).not.toBe(first.room.id);

    // A limited Room's roster is only who opened it. The mainline's is Project
    // membership: user-2 is a Project member nobody invited, and enrols on
    // first open rather than being synced in.
    const membership = async (roomId: string): Promise<string[]> => {
      const rows = await db.pool!.query<{ user_id: string }>(
        `SELECT user_id FROM room_user_members WHERE room_id = $1 AND status = 'active' ORDER BY user_id`,
        [roomId],
      );
      return rows.rows.map((row) => row.user_id);
    };
    expect(await membership(first.room.id)).toEqual(["user-1"]);
    await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");
    expect(await membership(mainline.room.id)).toEqual(["user-1", "user-2"]);
  });

  it("binds the chat panel to the mainline and enrols a member who joined the Project later", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.getProjectMainline(owner, "project-1");
    // A third person joins the Project after it exists.
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ('user-later', 'Later', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', 'user-later', 'member', 'active', now(), now())`, [randomUUID()]);
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', 'project-1', 'user-later', 'viewer', 'active', now(), now())`, [randomUUID()]);
    const later = { spaceId: "space-1", userId: "user-later" };

    // Before this the panel listed only Rooms the viewer was on the roster
    // of, so a member nobody had invited saw an empty panel — and as a
    // viewer could not start a Room either.
    const opened = await service.getProjectMainline(later, "project-1");
    expect(opened.room.id).toBe(created.room.id);
    expect(opened.joined).toBe(true);
    expect(opened.viewer_can_write).toBe(false);
    // Idempotent: opening again is not a second join.
    expect((await service.getProjectMainline(later, "project-1")).joined).toBe(false);
    // And now the ordinary Room reads work for them too.
    await expect(service.getRoom(later, created.room.id)).resolves.toMatchObject({ room: { id: created.room.id } });

    // Someone outside the Project gets nothing, not a join.
    await expect(service.getProjectMainline({ spaceId: "space-1", userId: "user-9" }, "project-1"))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("always has a mainline to answer with, and still says who may write in it", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    // "A Project with no Room" is no longer a state (ADR 0018 decision 4), so
    // the panel has nothing to branch on. `viewer_can_write` is still needed,
    // but not for speaking: user-2 is a Project viewer who may read *and*
    // speak — mainline membership follows Project membership and the send
    // path gates on that. What it answers is whether offering to open a
    // *limited* Room would be honest.
    const asViewer = await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");
    expect(asViewer.room.is_mainline).toBe(true);
    expect(asViewer.viewer_can_write).toBe(false);
    const asOwner = await service.getProjectMainline({ spaceId: "space-1", userId: "user-1" }, "project-1");
    expect(asOwner.room.id).toBe(asViewer.room.id);
    expect(asOwner.viewer_can_write).toBe(true);
  });

  it("refuses to remove a member from the mainline: that membership is the Project's", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.getProjectMainline(owner, "project-1");
    // user-2 is a Project member, so opening the Project enrols them.
    await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");
    await expect(service.removeUser(owner, created.room.id, "user-2"))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("brings an existing Assistant up to a changed seed at boot, not only on the next Room", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await openSpokenRoom(owner, { project_id: "project-1", title: "Daily" });
    const manager = await db.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM room_agent_members WHERE room_id = $1 AND role = 'manager' AND status = 'active'`,
      [created.room.id],
    );
    const agentId = manager.rows[0]!.agent_id;
    const promptOf = async (): Promise<string> => {
      const row = await db.pool!.query<{ system_prompt: string | null }>(
        `SELECT v.system_prompt FROM agents a JOIN agent_versions v ON v.id = a.current_version_id WHERE a.id = $1`,
        [agentId],
      );
      return row.rows[0]?.system_prompt ?? "";
    };
    // The seed changes — a release ships new rules.
    await db.pool.query(
      `UPDATE evolvable_asset_versions
          SET content_json = jsonb_set(
                content_json, '{messages}',
                (SELECT jsonb_agg(
                          CASE WHEN message->>'role' = 'system'
                            THEN jsonb_set(message, '{content}',
                                   to_jsonb((message->>'content') || E'\nNew rule from a release.'))
                            ELSE message END)
                   FROM jsonb_array_elements(content_json->'messages') AS message))
        WHERE id IN (
          SELECT d.version_id FROM prompt_deployment_refs d
            JOIN evolvable_assets asset ON asset.id = d.asset_id
           WHERE asset.asset_key = 'agent_template.personal_assistant.system' AND d.status = 'active')`,
    );
    expect(await promptOf()).not.toContain("New rule from a release.");

    const result = await SpaceAssistantService.reconcileSeedFollowersForAllSpaces(
      db.pool,
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }),
    );
    expect(result).toEqual({ reconciled: 1, skipped: 0 });
    expect(await promptOf()).toContain("New rule from a release.");
  });

  it("lists every conversation in the Project as one list, mainline first, and enrols the reader", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const mainline = await service.getProjectMainline(owner, "project-1");
    // Conversations are created by speaking, so give each Room one and say
    // something in the topic Room's second, so ordering has something to bite
    // on.
    await seedConversation(owner, mainline.room.id);
    const topic = await openSpokenRoom(owner, { project_id: "project-1", title: "Tax season" });
    const topicSecond = await seedConversation(owner, topic.room.id, "Receipts");
    await seedConversationMessages(db.pool, {
      space: "space-1", session: topicSecond.id,
      messages: [{ id: randomUUID(), role: "user", userId: "user-1",
        content: "Where are the March receipts?" }],
    });

    // user-2 was never invited to the topic Room. Reading the list enrols them
    // in the mainline — and only the mainline.
    const seen = await service.listProjectConversations({ spaceId: "space-1", userId: "user-2" }, "project-1", { limit: 50, offset: 0 });
    expect(seen.items.map((item) => item.room_id)).toEqual([mainline.room.id]);
    expect(seen.items[0]).toMatchObject({ room_is_mainline: true, room_title: "Room Project", message_count: 1 });

    // The owner sees all three: mainline first, then the topic Room's by last
    // activity, with what was last said.
    const all = await service.listProjectConversations(owner, "project-1", { limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((item) => [item.room_title, item.title])).toEqual([
      ["Room Project", "New conversation"],
      ["Tax season", "Receipts"],
      ["Tax season", "New conversation"],
    ]);
    // A Room is named by its audience, not by its title, so the list carries
    // the roster with the viewer excluded. user-2 read the list above, which
    // enrolled them in the mainline; the limited Room nobody was invited to
    // names nobody.
    expect(all.items[0]).toMatchObject({
      room_is_mainline: true,
      room_other_member_names: ["Room Member"],
    });
    const topicRow = all.items.find((item) => !item.room_is_mainline)!;
    expect(topicRow.room_other_member_names).toEqual([]);
    expect(topicRow.room_agent_count).toBe(1);
    // And from user-2's side the mainline names the owner, not themselves.
    expect(seen.items[0]!.room_other_member_names).toEqual(["Room Owner"]);

    // A Room nobody has spoken in holds no conversation, so a query over
    // conversations hides it — and a Room is reached through a conversation.
    // It comes back separately, under the same membership rule.
    const silent = await service.createRoom(owner, { project_id: "project-1", title: "Opened, not spoken in" });
    const withEmpty = await service.listProjectConversations(owner, "project-1", { limit: 50, offset: 0 });
    expect(withEmpty.items.map((item) => item.room_id)).not.toContain(silent.room.id);
    expect(withEmpty.empty_rooms.map((room) => room.room_id)).toContain(silent.room.id);
    // Not to a non-member: an empty Room is still a Room they must not learn
    // exists (ADR 0018 decision 3).
    const outsider = await service.listProjectConversations(
      { spaceId: "space-1", userId: "user-2" }, "project-1", { limit: 50, offset: 0 },
    );
    expect(outsider.empty_rooms.map((room) => room.room_id)).not.toContain(silent.room.id);

    expect(all.items[1]).toMatchObject({
      room_is_mainline: false,
      last_message_role: "user",
      last_message_preview: "Where are the March receipts?",
      message_count: 2,
    });
    expect(all.viewer_can_write).toBe(true);

    // Not in the Project: nothing, and no join.
    await expect(service.listProjectConversations({ spaceId: "space-1", userId: "user-9" }, "project-1", { limit: 50, offset: 0 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("decides, on the person's word, a proposal this conversation produced — and no other", async (ctx) => {
    if (!db.available || !service) return ctx.skip();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Daily" });
    const here = await seedConversation(owner, created.room.id, "Here");
    const elsewhere = await seedConversation(owner, created.room.id, "Elsewhere");

    const runIn = async (sessionId: string): Promise<string> => {
      const id = randomUUID();
      await db.pool!.query(
        `INSERT INTO runs (id, space_id, agent_id, agent_version_id, project_id, run_type, trigger_origin, status, mode, session_id, instructed_by_user_id, created_at, updated_at, owner_user_id, visibility, access_level, execution_kind, runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json) VALUES ($1, 'space-1', 'agent-1', 'version-1', 'project-1', 'agent', 'manual', 'succeeded', 'live', $2, 'user-1', now(), now(), 'user-1', 'space_shared', 'full', 'agent', (SELECT p.id FROM agent_runtime_profiles p WHERE p.space_id = 'space-1' AND p.agent_id = 'agent-1' AND p.is_default = TRUE), 'default', (SELECT p.runtime_key FROM agent_runtime_profiles p WHERE p.space_id = 'space-1' AND p.agent_id = 'agent-1' AND p.is_default = TRUE), (SELECT jsonb_build_object('id', p.id, 'runtime_key', p.runtime_key, 'backend_mode', p.backend_mode, 'model_provider_id', p.model_provider_id, 'model_name', p.model_name, 'runtime_config_json', p.runtime_config_json, 'runtime_policy_json', p.runtime_policy_json) FROM agent_runtime_profiles p WHERE p.space_id = 'space-1' AND p.agent_id = 'agent-1' AND p.is_default = TRUE))`,
        [id, sessionId],
      );
      return id;
    };
    const proposalBy = async (runId: string, statement: string): Promise<string> => {
      const id = randomUUID();
      await db.pool!.query(
        `INSERT INTO proposals (
           id,space_id,created_by_run_id,created_by_agent_id,owner_user_id,proposal_type,status,risk_level,urgency,
           preview,title,payload_json,created_at,updated_at,visibility,access_level,project_id
         ) VALUES ($1,'space-1',$2,'agent-1','user-1','project_brief_publish','pending','medium','normal',
                   false,$3,$4::jsonb,now(),now(),'space_shared','full','project-1')`,
        [id, runId, `确认项目定义：${statement}`, JSON.stringify({
          proposal_type: "project_brief_publish", action_id: "project.propose_definition",
          project_id: "project-1", goal: statement,
        })],
      );
      return id;
    };
    const hereRun = await runIn(here.id);
    const mine = await proposalBy(hereRun, "记忆如何分层？");
    const alsoMine = await proposalBy(hereRun, "记忆如何检索？");
    const theirs = await proposalBy(await runIn(elsewhere.id), "别处的问题");

    // Before deciding: every pending proposal is a decision waiting, on the
    // Project's own attention list, linking back to the conversation that
    // produced it rather than to the Space-level Review page.
    registerBuiltInAttentionAdapters();
    registerProposalsProjectIntegration();
    const attention = await new ProjectAttentionService(db.pool).listAttentionItems(owner, "project-1");
    const waiting = attention.find((item) => item.source_id === mine);
    expect(waiting).toMatchObject({
      source_type: "proposal",
      title: "确认项目定义：记忆如何分层？",
      reason: "project brief publish awaiting your decision",
      href: `/projects/project-1/rooms?room=${created.room.id}&conversation=${here.id}`,
    });

    const executors = new Map<SystemActionId, SystemActionExecutor>();
    registerProposalDecisionExecutor(
      executors,
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot }),
      {
        id: hereRun, space_id: "space-1", agent_id: "agent-1", project_id: "project-1",
        session_id: here.id, instructed_by_user_id: "user-1", trigger_origin: "manual", status: "running",
      } as never,
    );
    const decide = executors.get("proposal.decide" as SystemActionId)!;
    const dispatch = { actor: { type: "agent", id: "agent-1" }, visibility: "agent_tool", idempotency_key: randomUUID() } as never;

    // How the Agent learns which id to decide. Nothing in the rendered
    // conversation carries one, so without this read the id can only be
    // composed — and a composed id decides nothing.
    const pending = await executors.get("proposal.list_pending" as SystemActionId)!({}, dispatch) as { modelResult: Record<string, unknown>; summary: Record<string, unknown> };
    expect((pending.modelResult as { proposals: Array<{ proposal_id: string; title: string }> }).proposals)
      .toEqual([
        { proposal_id: mine, proposal_type: "project_brief_publish", title: "确认项目定义：记忆如何分层？" },
        { proposal_id: alsoMine, proposal_type: "project_brief_publish", title: "确认项目定义：记忆如何检索？" },
      ]);
    expect(pending.summary).toMatchObject({ tool_name: "proposal.list_pending", ok: true, count: 2 });

    // And an id it composed anyway is answered with the ones it may decide.
    await expect(decide({ proposal_id: "memory-layering", decision: "accept" }, dispatch))
      .rejects.toMatchObject({
        statusCode: 404,
        message: `No proposal in this conversation has id 'memory-layering'. Use one of these ids exactly: ${mine} — 确认项目定义：记忆如何分层？; ${alsoMine} — 确认项目定义：记忆如何检索？`,
      });

    // Reach: a proposal from another conversation is not this one's to decide.
    await expect(decide({ proposal_id: theirs, decision: "accept" }, dispatch))
      .rejects.toMatchObject({ statusCode: 404 });

    // The gateway validates every agent action's output as `{ modelResult,
    // summary }`; a flat object here made a decision that *was* applied read
    // back to the model as a failure.
    await expect(decide({ proposal_id: alsoMine, decision: "reject" }, dispatch))
      .resolves.toMatchObject({
        modelResult: { ok: true, status: "rejected", decided_by: "user-1" },
        summary: { tool_name: "proposal.decide", ok: true, status: "rejected" },
      });
    const accepted = await decide({ proposal_id: mine, decision: "accept" }, dispatch) as { modelResult: Record<string, unknown> };
    expect(accepted.modelResult).toMatchObject({ ok: true, status: "accepted", decided_by: "user-1", via: "room_instruction" });
    // The same continuation the Accept button dispatches, handed back in-turn:
    // a decision typed into the conversation unblocks the same work a click does.
    expect(typeof accepted.modelResult.next_step === "string" && accepted.modelResult.next_step.length > 0).toBe(true);

    // Applied through the same path as the button: the decision is the
    // person's, and the Brief version now exists.
    const rows = await db.pool.query<{ id: string; status: string; reviewed_by: string | null }>(
      `SELECT id, status, reviewed_by FROM proposals WHERE id = ANY ($1::varchar[]) ORDER BY status`,
      [[mine, alsoMine]],
    );
    expect(rows.rows.map((row) => [row.status, row.reviewed_by])).toEqual([["accepted", "user-1"], ["rejected", "user-1"]]);
    const brief = await db.pool.query(
      `SELECT 1 FROM project_brief_versions WHERE project_id = 'project-1' AND goal = '记忆如何分层？'`);
    expect(brief.rowCount).toBe(1);
    // Twice is once.
    await expect(decide({ proposal_id: mine, decision: "accept" }, dispatch))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
