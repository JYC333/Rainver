import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

import { registerBuiltInAttentionAdapters } from "../src/modules/projects/attentionService.js";
import { SpaceAssistantService } from "../src/modules/agents/spaceAssistantService.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { seedProjectMainlineRoom, seedRoomManager } from "./support/domainSeeds.js";
import { PgRoomRepository, type RoomAgentMemberRecord } from "../src/modules/rooms/repository.js";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository.js";
import { AgentGroupRunService } from "../src/modules/agentGroups/service.js";
import { AgentGroupRunLifecycleProjector } from "../src/modules/agentGroups/lifecycleProjector.js";
import {
  ROOM_DELEGATION_COMPLETION_RETRY_JOB,
  registerRoomDelegationCompletionRetryHandler,
} from "../src/modules/agentGroups/delegationCompletionRetryJob.js";
import { PgAgentGroupRepository } from "../src/modules/agentGroups/repository.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { RuntimeToolRegistry, type RuntimeToolInstallRunner } from "../src/modules/runtimeTools/service.js";
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
import { RunOrchestrationService } from "../src/modules/runs/orchestrationService.js";

let service: RoomService | undefined;
let groupService: AgentGroupRunService | undefined;
let testRoot: string | undefined;
let credentialOne: string;
let credentialTwo: string;
const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");

const INSTALLED_CLAUDE_CODE_VERSION = "1.2.3";

/**
 * Fakes only what `RuntimeToolRegistry.install("claude_code", ...)` needs on
 * disk to consider the tool genuinely installed — mirrors the claude-only
 * path of `FakeInstaller` in runtimeToolsService.test.ts. This is orthogonal
 * to CLI login: `SpaceAssistantService`'s provisioning disables a Room's
 * runtime-cli profile whenever the tool isn't installed at all, independent
 * of whether any user has since logged in via it (the `.credentials.json`
 * fixtures below already fake login correctly on their own).
 */
class FakeClaudeCodeInstaller implements RuntimeToolInstallRunner {
  async run(input: { package_ref: string; prefix: string; cache_dir: string }): Promise<void> {
    if (input.package_ref.startsWith("@agentclientprotocol/claude-agent-acp@")) {
      const acpDir = join(input.prefix, "node_modules", "@agentclientprotocol", "claude-agent-acp");
      const sdkDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
      const sdkNativeDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
      await mkdir(acpDir, { recursive: true });
      await mkdir(sdkDir, { recursive: true });
      await mkdir(sdkNativeDir, { recursive: true });
      await writeFile(join(acpDir, "package.json"), JSON.stringify({ version: INSTALLED_CLAUDE_CODE_VERSION }));
      await writeFile(join(sdkDir, "package.json"), JSON.stringify({
        version: "0.3.232",
        optionalDependencies: {
          "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.232",
        },
      }));
      await writeFile(join(sdkNativeDir, "package.json"), JSON.stringify({ version: "0.3.232" }));
      await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
      const acpBin = join(input.prefix, "node_modules", ".bin", "claude-agent-acp");
      await writeFile(acpBin, "#!/bin/sh\nexit 0\n");
      await chmod(acpBin, 0o755);
      return;
    }
    const packageDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-code");
    const nativeDir = join(input.prefix, "node_modules", "@anthropic-ai", "claude-code-linux-x64");
    await mkdir(nativeDir, { recursive: true });
    await writeFile(join(nativeDir, "package.json"), JSON.stringify({ version: INSTALLED_CLAUDE_CODE_VERSION }));
    await writeFile(join(nativeDir, "claude"), "x".repeat(5000));
    await chmod(join(nativeDir, "claude"), 0o755);
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await writeFile(join(packageDir, "bin", "claude.exe"), "x".repeat(5000));
    await chmod(join(packageDir, "bin", "claude.exe"), 0o755);
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      version: INSTALLED_CLAUDE_CODE_VERSION,
      optionalDependencies: { "@anthropic-ai/claude-code-linux-x64": INSTALLED_CLAUDE_CODE_VERSION },
    }));
    await mkdir(join(input.prefix, "node_modules", ".bin"), { recursive: true });
    const bin = join(input.prefix, "node_modules", ".bin", "claude");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
  }
}

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
  credentialOne = join(testRoot, "credential-one");
  credentialTwo = join(testRoot, "credential-two");
  await Promise.all([
    mkdir(credentialOne, { recursive: true }),
    mkdir(credentialTwo, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(credentialOne, ".credentials.json"), "{}"),
    writeFile(join(credentialTwo, ".credentials.json"), "{}"),
  ]);
  service = new RoomService(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: testRoot,
  }), db.pool);
  groupService = new AgentGroupRunService(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    RAINVER_HOME: testRoot,
  }), db.pool);
  // Installs the fake claude_code tool once for the whole file: on-disk
  // state under testRoot, independent of the per-test DB fixtures below.
  await new RuntimeToolRegistry(
    loadConfig({ RAINVER_HOME: testRoot }),
    new FakeClaudeCodeInstaller(),
  ).install("claude_code", { version: INSTALLED_CLAUDE_CODE_VERSION });
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
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES
       ('user-1', 'Room Owner', 'active', $1, $1),
       ('user-2', 'Room Member', 'active', $1, $1),
       ('user-3', 'Outside Member', 'active', $1, $1)`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ('space-1', 'Room Space', 'team', 'user-1', $1, $1)`,
    [now],
  );
  // Enables the claude_code tool this file installed once in beforeAll
  // (on-disk state) for this fresh space (DB state, truncated per test) —
  // without this, SpaceAssistantService's provisioning disables the
  // fixture's runtime-cli profile regardless of the on-disk install.
  await db.pool.query(
    `INSERT INTO space_runtime_tool_policies (
       id, space_id, runtime, enabled, default_version, allowed_versions_json,
       updated_by_user_id, created_at, updated_at
     ) VALUES ($2, 'space-1', 'claude_code', true, $3, '[]'::jsonb, 'user-1', $1, $1)`,
    [now, randomUUID(), INSTALLED_CLAUDE_CODE_VERSION],
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
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ('host-1', NULL, 'machine-1', 'server', 'server', 'server', 'online', $1, $1)`,
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
       execution_ready, status, preferred, created_at, updated_at
     ) VALUES ('location-1','space-1','folder-1','host-1','server',true,'active',true,$1,$1)`,
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
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, follows_seed_key, created_at
     ) VALUES (
       'version-1', 'agent-1', 'space-1', 'v1', 'Coordinate the Room.',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
       'agent_template.personal_assistant.system', $1
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
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES (
       'runtime-cli', 'space-1', 'agent-1', 'Subscription',
       'claude_code', '{}'::jsonb, '{}'::jsonb, true, true, $1, $1
     )`,
    [now],
  );
  await db.pool.query(
    `INSERT INTO cli_credential_profiles (
       id, owner_user_id, runtime, name, source_path, target_path,
       readonly, notes, created_at, updated_at
     ) VALUES
       ('credential-user-1', 'user-1', 'claude_code', 'Owner login',
        $2, '.claude', true, '', $1, $1),
       ('credential-user-2', 'user-2', 'claude_code', 'Member login',
        $3, '.claude', true, '', $1, $1)`,
    [now, credentialOne, credentialTwo],
  );
  await db.pool.query(
    `INSERT INTO cli_credential_space_grants (
       id, profile_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES
       ('grant-user-1', 'credential-user-1', 'space-1', 'user-1', 'user-1',
        true, true, $1, $1),
       ('grant-user-2', 'credential-user-2', 'space-1', 'user-2', 'user-1',
        true, true, $1, $1)`,
    [now],
  );
});

/**
 * A conversation in a Room, as a fixture.
 *
 * Production has no such step — a conversation is created by the message that
 * fills it (ADR 0018 decision 5), and the endpoint that used to make an empty
 * one is retired. A test that starts from a later point in a conversation
 * seeds one directly rather than sending a message it does not want to assert
 * on.
 */
async function seedConversation(
  // Deliberately no identity: this writes the row directly and checks nothing,
  // so taking one would imply an authorization this fixture does not perform.
  scope: { spaceId: string },
  roomId: string,
  title?: string,
) {
  const room = await new PgRoomRepository(db.pool!).getRoomById(scope.spaceId, roomId);
  if (!room) throw new Error(`No such Room: ${roomId}`);
  return new PgSessionRepository(db.pool!).createRoomConversation({
    space_id: scope.spaceId,
    room_id: room.id,
    project_id: room.project_id,
    project_folder_id: room.project_folder_id,
    title: title ?? "New conversation",
    metadata: { conversation_kind: "room" },
  });
}

/**
 * A Room that has already been spoken in.
 *
 * Since ADR 0018 decisions 4 and 5, opening a Room creates neither a manager
 * Agent nor a conversation — both arrive with the first message. A test that
 * starts from a later point in a conversation seeds that state directly
 * rather than sending a message whose dispatch it does not want to assert on.
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
  await seedRoomManager(db.pool, { space: owner.spaceId, room: created.room.id, agent: "agent-1" });
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
  await service!.sendMessage(owner, created.room.id, null, { content: `Start ${title}.` });
  return created;
}

describe("Room workflow (real Postgres)", () => {
  it("keeps system continuations out of the visible transcript while retaining execution context", async () => {
    if (!db.available || !service) return;
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
      items: [{ id: visible!.id, content: "Define the Project." }],
    });
    const replay = await loadRoomConversationReplayThroughMessage(db.pool, {
      spaceId: owner.spaceId,
      sessionId: conversation.id,
      currentMessageId: internal!.id,
    });
    expect(replay.messages.map(message => message.content)).toEqual([
      "Define the Project.",
      "Continue after the accepted definition.",
    ]);
  });

  it("reports each research pipeline run, and each run only once", async () => {
    if (!db.available || !service) return;
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
        // The turn this continuation started must finish before the next one
        // may begin; the pipeline's own retries are minutes apart.
        await db.pool.query(
          "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id = ANY ($1::varchar[])",
          [result.run_ids],
        );
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

  it("validates and deduplicates server-owned Proposal continuations", async () => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Proposal continuation",
    });
    const conversation = await seedConversation(owner, created.room.id, "Main");
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-api','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,now(),now()
       )`,
    );
    const source = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Define the Project.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
      }],
    });
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [source.run_ids[0]],
    );
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
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
      }],
    });
    expect(first.message).toMatchObject({
      role: "system",
      user_id: null,
      metadata_json: {
        room_display: "internal",
        continuation: true,
        continuation_proposal_id: proposalId,
        // Typed directive from ConversationContinuationRegistry (plan Phase
        // 2), not a string the caller has to pattern-match.
        continuation_directive: "inquiry.create_thread",
      },
    });
    expect(first.message.content).toContain("不要只在回复里列清单");

    // And the continuation run actually executes. Deleting the retired
    // question-batch continuation took the only end-to-end execution of one
    // with it; a continuation that composes a message but cannot be run is
    // half a mechanism.
    const continuationPolicyId = randomUUID();
    await db.pool.query(
      `INSERT INTO runtime_context_policy_versions (
         id,space_id,scope_type,scope_id,version,policy_json,typed_diff_json,
         reason,created_by_user_id,created_at
       ) VALUES ($1,'space-1','space','space-1',1,'{"constraints":{},"preferences":{}}','{}',
                 'Room continuation test policy','user-1',now())`,
      [continuationPolicyId],
    );
    await db.pool.query(
      `INSERT INTO runtime_context_policy_bindings (
         space_id,scope_type,scope_id,active_version_id,updated_by_user_id,updated_at
       ) VALUES ('space-1','space','space-1',$1,'user-1',now())`,
      [continuationPolicyId],
    );
    const continuationExecution = await new RunOrchestrationService(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot! }),
      new PgRunRepository(db.pool),
      {
        usageRecorder: async () => {},
        managedApi: {
          executeRuntimeHost: async () => ({
            success: true,
            stdout: "",
            stderr: "",
            output_text: "已按确认的项目定义拆出研究问题。",
            output_json: { adapter_type: "ts_agent_host" },
            exit_code: 0,
            error_text: null,
            error_code: null,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            model: "test-model",
            usage: null,
            events: [],
            adapter_metadata: { adapter_type: "ts_agent_host" },
            adapter_log_json: null,
          }),
        },
      },
    ).executeRun({
      run_id: first.run_ids[0]!,
      space_id: owner.spaceId,
      worker_id: "room-continuation-test-worker",
      command_source: "job",
    });
    expect(continuationExecution, JSON.stringify(continuationExecution)).toMatchObject({ status: "succeeded" });

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
      items: [{ content: "Define the Project.", role: "user" }],
    });
    await db.pool.query(
      "UPDATE runs SET status='failed', ended_at=now(), updated_at=now() WHERE id = ANY($1::varchar[])",
      [first.run_ids],
    );
    const retried = await service.continueAfterProposal(owner, created.room.id, conversation.id, {
      proposal_id: proposalId,
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
      }],
    });
    expect(retried.message.id).toBe(first.message.id);
    expect(retried.run_ids).not.toEqual(first.run_ids);
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

  it("provisions the Assistant and the first conversation on the first message, not on Room creation", async () => {
    if (!db.available || !service) return;
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

    const sent = await service.sendMessage(owner, created.room.id, null, {
      content: "Start here.",
    });
    // The conversation the message created comes back on the response; there
    // is no separate step that could have left an empty one behind.
    expect(sent.conversation.room_id).toBe(created.room.id);
    expect(sent.message.content).toBe("Start here.");
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

  it("renames a placeholder conversation on its first message and queues cheap refinement", async () => {
    if (!db.available || !service) return;
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

  it("lists Room conversations by creation time descending, independent of activity", async () => {
    if (!db.available || !service) return;
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

  it("starts a further conversation by speaking, rather than continuing the newest", async () => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await openSpokenRoom(owner, { project_id: "project-1", title: "Two threads" });
    // A send with no conversation id means "start one" — including in a Room
    // that already has conversations, which is what the surfaces behind
    // "start a separate thread" rely on. An earlier version of this endpoint
    // reused the newest and made that button silently append to it.
    const second = await service.sendMessage(owner, created.room.id, null, { content: "A separate topic." });
    expect(second.conversation.id).not.toBe(created.conversation.id);
    const listed = await service.listConversations(owner, created.room.id, { limit: 20, offset: 0 });
    expect(listed.items).toHaveLength(2);
  });

  it("opens a Room with no eligible backend, and reports it on the first message", async () => {
    if (!db.available || !service) return;
    await removeManagedAssistant();
    await db.pool.query("UPDATE model_provider_space_grants SET enabled = false WHERE space_id = 'space-1'");
    await db.pool.query("UPDATE cli_credential_space_grants SET enabled = false WHERE space_id = 'space-1'");
    const owner = { spaceId: "space-1", userId: "user-1" };
    // Provisioning can fail, so it belongs on the action that needs it. Making
    // it fail Room creation — and, once the mainline is created with the
    // Project, Project creation — would put a Space's backend configuration in
    // the way of making a Project at all.
    const created = await service.createRoom(owner, { project_id: "project-1", title: "No backend yet" });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM rooms WHERE space_id = 'space-1' AND id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    await expect(service.sendMessage(owner, created.room.id, null, {
      content: "Anyone there?",
    })).rejects.toMatchObject({
      statusCode: 409,
      responseBody: { code: "conversation_backend_required" },
    });
    // The failed message left nothing behind: no Assistant, and no
    // conversation whose only content would have been a message never sent.
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'",
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE space_id = 'space-1' AND room_id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("serializes concurrent first messages into one Assistant, and keeps Room creation idempotent", async () => {
    if (!db.available || !service) return;
    await removeManagedAssistant();
    const owner = { spaceId: "space-1", userId: "user-1" };
    // Provisioning is now a first-message race rather than a Room-creation
    // one: two people speaking at once must not each mint an Assistant, and
    // `room_agent_members` has a unique manager per Room, so a lost race would
    // surface as a constraint violation rather than a second Agent.
    const roomA = await service.createRoom(owner, { project_id: "project-1", title: "Concurrent A" });
    const roomB = await service.createRoom(owner, { project_id: "project-1", title: "Concurrent B" });
    await Promise.all([
      service.sendMessage(owner, roomA.room.id, null, { content: "A speaks." }),
      service.sendMessage(owner, roomB.room.id, null, { content: "B speaks." }),
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

  it("enforces Project ACL when creating and continuing a Room", async () => {
    if (!db.available || !service || !groupService) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      project_folder_id: "folder-1",
      title: "ACL Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await seedConversation(member, created.room.id, "Before revocation");
    expect(conversation.project_folder_id).toBe("folder-1");
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
          credential_profile_id: "credential-user-2",
        }],
      },
    );
    const groupId = dispatched.task_group_ids[0]!;
    const runId = dispatched.run_ids[0]!;
    await expect(db.pool.query<{ project_folder_id: string | null }>(
      "SELECT project_folder_id FROM runs WHERE id = $1",
      [runId],
    )).resolves.toMatchObject({
      rows: [{ project_folder_id: "folder-1" }],
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
      .resolves.toMatchObject({
        allowed: false,
        error_code: "run_execution_authorization_revoked",
      });
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
      message.metadata_json?.run_id === runId
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
      message.metadata_json?.run_id === runId
    )).toHaveLength(1);
    expect(ownerMessages.items.find((message) =>
      message.metadata_json?.run_id === runId
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

  it("lets Room members read another speaker's task but not manage or extend it", async () => {
    if (!db.available || !service || !groupService) return;
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
        credential_profile_id: "credential-user-1",
      }],
    });
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

  it("opens one auditable task per message under the speaking user's CLI identity", async () => {
    if (!db.available || !service) return;
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
          credential_profile_id: "credential-user-1",
        }],
      },
    );
    const second = await service.sendMessage(
      member,
      created.room.id,
      conversation.id,
      {
        content: "Review it from my account.",
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-cli",
          credential_profile_id: "credential-user-2",
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
              model_override_json->'conversation_runtime'->>'message_cursor_id'
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
      user_id: string;
      credential_profile_id: string;
      agent_id: string;
    }>(
      `SELECT user_id, credential_profile_id, agent_id
         FROM session_conversation_backends
        WHERE session_id = $1
        ORDER BY user_id ASC`,
      [conversation.id],
    );
    expect(bindings.rows).toEqual([
      {
        user_id: "user-1",
        credential_profile_id: "credential-user-1",
        agent_id: "agent-1",
      },
      {
        user_id: "user-2",
        credential_profile_id: "credential-user-2",
        agent_id: "agent-1",
      },
    ]);
  });

  it("prefixes a Room-dispatched run's prompt with Project state context (plan Phase A, decision 3)", async () => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-api','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,now(),now()
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
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
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

  it("states the Task the person is looking at, and stays silent about one they cannot read", async () => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-focus','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,now(),now()
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
      runtime_profile_id: "runtime-focus",
      credential_profile_id: null,
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

  it("guides research execution through prompt policy, not a server-side text match on the turn", async () => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    await new InquiryThreadService(db.pool).createThread(owner, "project-1", {
      kind: "question",
      statement: "Agent memory 应该如何分层？",
    });
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-api','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,now(),now()
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
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
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

  it("grants a Room-dispatched run the conversation scenario tools despite the Agent declaring none", async () => {
    if (!db.available || !service) return;
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
        credential_profile_id: "credential-user-1",
      }],
    });

    const run = await db.pool.query<{ tool_grants: Array<{ action_id: string }> }>(
      `SELECT permission_snapshot_json->'tool_grants' AS tool_grants FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    );
    const granted = (run.rows[0]?.tool_grants ?? []).map((grant) => grant.action_id);
    expect(granted).toContain("project.propose_definition");
    expect(granted).toContain("inquiry.create_thread");
    expect(granted).toContain("inquiry.record_conclusion");
    expect(granted).toContain("inquiry.promote_knowledge");
    // The Room allowance is the Project write surface plus what belongs to
    // any conversation; a Room must not lose the second half by holding the
    // first (ADR 0003 §2).
    expect(granted).toContain("memory.remember");
    expect(granted).toContain("memory.revise");
    // Retrieval would run under the sender's identity and answer into a
    // conversation every Room member reads, so no retrieval action is in the
    // allowance — and listing one would also switch its domain on.
    expect(granted.some((id) => id.includes("retrieval"))).toBe(false);

    // System Action ids authorize server-owned tools; they are not runtime
    // capabilities. A Room allowance must not eliminate the only otherwise
    // valid runtime before even a simple conversation can start.
    const runs = new PgRunRepository(db.pool);
    const queued = await runs.getRun("space-1", sent.run_ids[0]!);
    expect(queued).not.toBeNull();
    const routed = await new PgRouteDecisionRepository(db.pool, undefined, {
      availableProfiles: async () => [
        { id: "credential-user-1", logged_in: true },
      ],
    }).routeRun(queued!);
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
    expect((rebound.rows[0]?.tool_grants ?? []).map((grant) => grant.action_id))
      .toEqual(expect.arrayContaining([
        "project.propose_definition",
        "inquiry.create_thread",
        "inquiry.record_conclusion",
        "inquiry.promote_knowledge",
      ]));

    // The boundary itself: being dispatched into a Room is the *only* reason
    // these grants exist. The same Agent, same Project, outside a Room, is
    // still bound by its own (empty) AgentVersion allowance.
    await expect(new PgRunRepository(db.pool).createQueuedRun({
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

  it("keeps healthy CLI state stable as bounded raw history advances", async () => {
    if (!db.available || !service) return;
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
        credential_profile_id: "credential-user-1",
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
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now()
        WHERE id = $1`,
      [firstRuntime.id],
    );
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
      `INSERT INTO messages (
         id, space_id, session_id, user_id, sender_agent_id, role,
         content, metadata_json, created_at
       ) VALUES (
         'agent-message-1', 'space-1', $1, NULL, 'agent-1', 'assistant',
         'My own prior answer.', jsonb_build_object('run_id', $2::text),
         '2026-01-01T00:00:01.000Z'
       )`,
      [conversation.id, firstRuntime.id],
    );
    await db.pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, sender_agent_id, role,
         content, metadata_json, created_at
       )
       SELECT 'bulk-' || lpad(value::text, 3, '0'),
              'space-1', $1, 'user-2', NULL, 'user',
              'Bulk Room context ' || value::text,
              '{}'::jsonb,
              '2026-01-01T00:00:02.000Z'::timestamptz
                + value * interval '1 millisecond'
         FROM generate_series(0, 84) value`,
      [conversation.id],
    );
    const memberTurn = await service.sendMessage(member, created.room.id, conversation.id, {
      content: "Add the member-specific constraint.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-2",
      }],
    });
    await db.pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, sender_agent_id, role,
         content, metadata_json, created_at
       ) VALUES (
         'agent-message-2', 'space-1', $1, NULL, 'agent-1', 'assistant',
         'Member-owned answer from the same agent.',
         jsonb_build_object('run_id', $2::text), now()
       )`,
      [conversation.id, memberTurn.run_ids[0]],
    );
    const resumed = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Continue with the new constraint.",
      recipient_segments: [{
        recipient_agent_ids: ["agent-1"],
        content: "Apply the owner-specific assigned constraint.",
      }],
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    });
    const resumedRun = await db.pool.query<{
      prompt: string;
      runtime_session_id: string | null;
      replay_prompt: string;
      context_fingerprint: string;
    }>(
      `SELECT prompt,
              model_override_json->'conversation_runtime'->>'runtime_session_id'
                AS runtime_session_id,
              model_override_json->'conversation_runtime'->>'replay_prompt'
                AS replay_prompt,
              model_override_json->'conversation_runtime'->>'context_fingerprint'
                AS context_fingerprint
         FROM runs
        WHERE id = $1`,
      [resumed.run_ids[0]],
    );

    expect(resumedRun.rows[0]?.runtime_session_id).toBe("vendor-session-1");
    expect(resumedRun.rows[0]?.context_fingerprint)
      .toBe(firstRuntime.context_fingerprint);
    // Prompt now carries a Project state prefix ahead of the assigned
    // segment content (plan Phase A, decision 3) — the segment content
    // itself is still the exact tail of the prompt.
    expect(resumedRun.rows[0]?.prompt?.endsWith("Apply the owner-specific assigned constraint.")).toBe(true);
    expect(resumedRun.rows[0]?.replay_prompt).toContain("Bulk Room context 84");
    expect(resumedRun.rows[0]?.replay_prompt).toContain("Member-owned answer from the same agent.");
    expect(resumedRun.rows[0]?.replay_prompt).toContain("Continue with the new constraint.");
    expect(resumedRun.rows[0]?.replay_prompt).not.toContain("Start the shared analysis.");
    expect(resumedRun.rows[0]?.replay_prompt)
      .toContain("Apply the owner-specific assigned constraint.");
  });

  it("rejects duplicate recipient runs before persisting a Room turn", async () => {
    if (!db.available || !service) return;
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
        credential_profile_id: "credential-user-1",
      }],
    })).rejects.toMatchObject({ statusCode: 422 });

    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM messages
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_run_groups
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rejects task links that cross Room conversation aggregates", async () => {
    if (!db.available || !service) return;
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

  it("keeps private specialists Room-scoped while allowing Room dispatch visibility", async () => {
    if (!db.available || !service || !groupService) return;
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
    // This scenario dispatches with an explicit credential_profile_id, which
    // is only valid against a CLI conversation backend — the preset
    // specialist's model_api profile (copied from the managed assistant's
    // own default) is not eligible here, so select its CLI profile.
    const runtimeProfile = await db.pool.query<{ id: string }>(
      `SELECT id FROM agent_runtime_profiles
        WHERE space_id='space-1' AND agent_id=$1 AND enabled=true
          AND adapter_type != 'model_api'
        ORDER BY is_default DESC, id ASC LIMIT 1`,
      [presetSpecialist!.agent_id],
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
        credential_profile_id: "credential-user-2",
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

  it("requires each private-Agent owner to approve a Room invitation and supports suspended-owner recovery", async () => {
    if (!db.available || !service) return;
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

  it("notifies the Room when a delegated child run completes with nobody waiting on it (room-advancement-reliability-plan Phase 3)", async () => {
    if (!db.available || !service || !groupService || !testRoot) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, system_prompt, model_config_json,
         runtime_config_json, context_policy_json, memory_policy_json, capabilities_json,
         tool_permissions_json, runtime_policy_json, created_at
       ) VALUES (
         'version-2', 'agent-2', 'space-1', 'v1', 'Specialist.',
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb, $1
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
         id, space_id, agent_id, name, adapter_type, runtime_config_json,
         runtime_policy_json, enabled, is_default, created_at, updated_at
       ) VALUES (
         'runtime-cli-2', 'space-1', 'agent-2', 'Subscription', 'claude_code',
         '{}'::jsonb, '{}'::jsonb, true, true, $1, $1
       )`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-api','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,$1,$1
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
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-api", credential_profile_id: null }],
    });
    const managerRunId = sent.run_ids[0]!;
    // The Manager's own turn must reach a terminal status before another
    // dispatch (this test's later delegation-completion continuation) can
    // claim the conversation's turn again — mirrors the pattern the
    // continueAfterProposal tests above already use.
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [managerRunId],
    );
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

  it("does not duplicate the resume path when a Manager is already waiting on the completed delegation (room-advancement-reliability-plan Phase 3)", async () => {
    if (!db.available || !service || !groupService || !testRoot) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions (
         id, agent_id, space_id, version_label, system_prompt, model_config_json,
         runtime_config_json, context_policy_json, memory_policy_json, capabilities_json,
         tool_permissions_json, runtime_policy_json, created_at
       ) VALUES (
         'version-2', 'agent-2', 'space-1', 'v1', 'Specialist.',
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb, $1
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
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-api','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,$1,$1
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
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-api", credential_profile_id: null }],
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

    // The Manager explicitly waited on this delegation (agent.wait_for_results),
    // unlike the sibling test above where it already replied and ended its turn.
    await db.pool.query(
      `UPDATE runs SET status='waiting_for_dependency', output_json=$2, updated_at=now() WHERE id=$1`,
      [managerRunId, JSON.stringify({
        waiting_for_results: {
          status: "waiting",
          scope: "run_ids",
          reason: "Waiting on the specialist.",
          resume_instruction: null,
          depends_on_run_ids: [spawned.child_run_id],
        },
      })],
    );

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

    // The pre-existing dependency-wait path resumed the Manager run instead.
    const resumedManager = await runs.getRun("space-1", managerRunId);
    expect(resumedManager?.status).toBe("queued");

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

  it("retries the delegation-completion notification when the conversation turn is busy, and the retry succeeds once it frees up (integration-gate fix)", async () => {
    if (!db.available || !service || !groupService || !testRoot) return;
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
         id, agent_id, space_id, version_label, system_prompt, model_config_json,
         runtime_config_json, context_policy_json, memory_policy_json, capabilities_json,
         tool_permissions_json, runtime_policy_json, created_at
       ) VALUES (
         'version-2', 'agent-2', 'space-1', 'v1', 'Specialist.',
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb, $1
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
         id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,
         runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES (
         'runtime-api','space-1','agent-1','Managed API','model_api','provider-1','test-model',
         '{}'::jsonb,'{}'::jsonb,true,false,$1,$1
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
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-api", credential_profile_id: null }],
    });
    const managerRunId = sent.run_ids[0]!;
    await db.pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [managerRunId],
    );
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

    // Simulate what a first delegate's own completion notification leaves
    // behind while it is mid-dispatch: a fresh, non-terminal run in this
    // conversation carrying the same Manager identity's chat_turn — exactly
    // what claimTurn treats as an in-progress turn for that identity.
    const busyRunId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         session_id, created_at, updated_at, owner_user_id, visibility, access_level, model_override_json
       ) VALUES (
         $1,'space-1','agent-1','version-1','agent','manual','queued','live',
         $2,$3,$3,'user-1','private','full',$4::jsonb
       )`,
      [busyRunId, conversation.id, now, JSON.stringify({ chat_turn: { schema_version: "chat_turn.v1", user_id: "user-1" } })],
    );

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
    await expect(jobRegistry.dispatch({
      job_id: "retry-job-still-busy",
      space_id: "space-1",
      user_id: "user-1",
      job_type: ROOM_DELEGATION_COMPLETION_RETRY_JOB,
      attempts: 1,
      max_attempts: 3,
      worker_id: "test-worker",
      payload: jobs.rows[0]!.payload_json,
    })).rejects.toMatchObject({ name: "JobDeferredError" });
    const stillNotPosted = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(stillNotPosted.rows[0]?.total).toBe("0");

    // The turn frees up.
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

  it("processes owner-funded summaries with strict output and preserves the active version on failure", async () => {
    if (!db.available || !service) return;
    const testPool = db.pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Summary Room" });
    const conversation = await seedConversation(owner, created.room.id, "Summary thread");
    const firstMessageAt = "2026-01-01T00:00:00.000Z";
    await db.pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, role, content, metadata_json, created_at
       ) VALUES
         ('summary-message-1', 'space-1', $1, 'user-1', 'user', repeat('A', 7000), '{}'::jsonb, $2),
         ('summary-message-2', 'space-1', $1, 'user-1', 'user', 'A second constraint.', '{}'::jsonb, $2::timestamptz + interval '1 second')`,
      [conversation.id, firstMessageAt],
    );

    let response = JSON.stringify({ summary: "Initial durable Room summary." });
    const invocationTarget = {
      provider: {
        id: "provider-1", space_id: "space-1", owner_user_id: "user-1", name: "Test API",
        provider_type: "openai", base_url: null, network_profile_id: null,
        default_model: "test-model", available_models: ["test-model"], enabled: true, is_default: true,
      },
      network_profile: null,
      rotation_strategy: "fill_first" as const,
      fallback_provider_ids: [],
      candidates: [],
    };
    const providerStore = {
      getInvocationTarget: async () => invocationTarget,
    } as unknown as ProviderCommandStore;
    const dependencies: RoomConversationSummaryDependencies = {
      resolveProviderStore: () => providerStore,
      completeProviderMessages: async () => ({
        text: response,
        provider: "openai",
        provider_id: "provider-1",
        model: "test-model",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
    };
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot! });
    const summaries = new RoomConversationSummaryService(config, testPool, dependencies);
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "summary-message-2", throughCreatedAt: "2026-01-01T00:00:01.000Z",
    });
    await expect(testPool.query<{ status: string }>(
      `SELECT status FROM room_conversation_summary_states WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(summaries.process({ spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id }))
      .resolves.toMatchObject({ status: "published", version: 1 });
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

    await testPool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, role, content, metadata_json, created_at
       ) VALUES ('summary-message-3', 'space-1', $1, 'user-1', 'user', repeat('B', 7000), '{}'::jsonb, $2)`,
      [conversation.id, "2026-01-01T00:00:02.000Z"],
    );
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "summary-message-3", throughCreatedAt: "2026-01-01T00:00:02.000Z",
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

    await testPool.query(
      `INSERT INTO messages (
         id, space_id, session_id, user_id, role, content, metadata_json, created_at
       ) VALUES ('summary-message-4', 'space-1', $1, 'user-1', 'user', repeat('C', 7000), '{}'::jsonb, $2)`,
      [conversation.id, "2026-01-01T00:00:03.000Z"],
    );
    await requestRoomConversationSummary(testPool, {
      spaceId: "space-1", roomId: created.room.id, sessionId: conversation.id,
      throughMessageId: "summary-message-4", throughCreatedAt: "2026-01-01T00:00:03.000Z",
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
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    await db.pool.query(
      `INSERT INTO projects (
         id, space_id, owner_user_id, name, status, created_at, updated_at
       ) VALUES ('project-2', 'space-1', 'user-1', 'Second Project', 'active', now(), now())`,
    );

    await seedProjectMainlineRoom(db.pool, {
      space: "space-1", project: "project-2", owner: "user-1", title: "Second Project",
    });
    // Provisioning follows the first message now, so speak in each.
    const first = await service.createRoom(owner, { project_id: "project-1", title: "First" });
    const second = await service.createRoom(owner, { project_id: "project-2", title: "Second" });
    await service.sendMessage(owner, first.room.id, null, { content: "Start the first." });
    await service.sendMessage(owner, second.room.id, null, { content: "Start the second." });

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
         id, agent_id, space_id, version_label, system_prompt, model_config_json,
         runtime_config_json, context_policy_json, memory_policy_json,
         capabilities_json, tool_permissions_json, runtime_policy_json, created_at
       ) VALUES ($1, $2, 'space-1', 'v99', 'A prompt somebody wrote by hand',
         '{}', '{}', '{}', '{}', '[]', '{}', '{}', now())`,
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
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
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
    if (!db.available) return;
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
    if (!db.available || !service) return;
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
    const copied = (messages ?? []).find((message) => message.role === "system");
    expect(copied?.content).toContain("They settled on arrow-free parsing.");
    // The summary, not the transcript: the thing it is too long to carry.
    expect(copied?.content).not.toContain("A long discussion nobody wants copied whole.");
    expect(copied?.metadata_json).toMatchObject({
      reference: { kind: "thread", source_id: source.conversation.id, trust: "domain_approved" },
    });
  });

  it("carries outside-Rainver provenance forward, however many hops back it is", async (ctx) => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Where it came in" });
    const sessions = new PgSessionRepository(db.pool);

    // Thread A holds a reference to vendor content, and then an Agent's reply
    // about it. Neither the reply nor a summary of the thread carries the
    // fence the original was wrapped in, so the label is all a later reader
    // has — and a rule that only looked at the picked rows would lose it.
    await db.pool.query(
      `INSERT INTO messages (id, space_id, session_id, role, content, metadata_json, created_at)
       VALUES ($1, 'space-1', $2, 'system', 'Quoted transcript.', $3::jsonb, now())`,
      [randomUUID(), source.conversation.id, JSON.stringify({
        room_display: "reference",
        reference: { kind: "imported_session", trust: "external_untrusted" },
      })],
    );
    const reply = await sessions.addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id,
      { content: "So the transcript says the parser was rewritten." },
    );

    const target = await seedConversation(owner, source.room.id, "Following up");
    await service.attachConversationReferences(owner, source.room.id, target.id, {
      references: [{ kind: "messages", id: source.conversation.id, item_ids: [reply!.id] }],
    });

    const messages = await sessions.listRoomMessages("space-1", "user-1", source.room.id, target.id, 50, 0);
    const copied = (messages ?? []).find((message) => message.role === "system");
    expect(copied?.metadata_json).toMatchObject({
      reference: { kind: "messages", trust: "external_untrusted" },
    });
    // And it is fenced, because the label alone does not protect a prompt.
    expect(copied?.content).toContain("never");
    expect(copied?.content).toContain("begin quoted external transcript");
  });

  it("copies picked messages into another thread as a reference, and only content the picker can read", async (ctx) => {
    if (!db.available || !service) return;
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
    const reference = (messages ?? []).find((message) => message.role === "system");
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
    if (!db.available || !service) return;
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
    expect((before ?? []).some((message) => message.role === "system")).toBe(false);

    await service.attachConversationReferences(owner, mainline.room.id, targetConversation.id, {
      references: pick,
      confirm_disclosure: true,
    });
    const after = await new PgSessionRepository(db.pool)
      .listRoomMessages("space-1", "user-1", mainline.room.id, targetConversation.id, 50, 0);
    expect((after ?? []).some((message) => message.content.includes("not told the others"))).toBe(true);
  });

  it("measures the mainline by who may read the Project, not by who has opened it", async (ctx) => {
    if (!db.available || !service) return;
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

  it("refuses references on a send that names its conversation, rather than dropping them", async (ctx) => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const room = await openSpokenRoom(owner, { project_id: "project-1", title: "Addressed" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", room.room.id, room.conversation.id, { content: "Something." },
    );
    // An addressed send names a thread that exists, and that thread has its
    // own endpoint for this. Answering 201 with nothing attached would be the
    // silent success the attach path exists to avoid.
    await expect(service.sendMessage(owner, room.room.id, room.conversation.id, {
      content: "And this.",
      references: [{ kind: "messages", id: room.conversation.id, item_ids: [said!.id] }],
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("takes the audience the refusal named, not a bare yes", async (ctx) => {
    if (!db.available || !service) return;
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

  it("carries references in with the message that creates the thread, or not at all", async (ctx) => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const source = await openSpokenRoom(owner, { project_id: "project-1", title: "Source" });
    const said = await new PgSessionRepository(db.pool).addRoomUserMessage(
      "space-1", "user-1", source.room.id, source.conversation.id,
      { content: "The bit worth carrying over." },
    );
    const target = await openSpokenRoom(owner, { project_id: "project-1", title: "Target" });

    // A thread does not exist until its first message (ADR 0018 decision 5),
    // so a pick made for a new thread rides that message.
    const sent = await service.sendMessage(owner, target.room.id, null, {
      content: "Picking this up.",
      references: [{ kind: "messages", id: source.conversation.id, item_ids: [said!.id] }],
    });
    const messages = await new PgSessionRepository(db.pool)
      .listRoomMessages("space-1", "user-1", target.room.id, sent.conversation.id, 50, 0);
    // The reference opens the thread; the message that carried it follows.
    expect((messages ?? []).map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages![0]!.content).toContain("bit worth carrying over");
  });

  it("returns the first send's result on a retry rather than starting a second thread", async (ctx) => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const room = await openSpokenRoom(owner, { project_id: "project-1", title: "Retry" });
    const send = () => service!.sendMessage(owner, room.room.id, null, {
      content: "Only once, please.",
      idempotency_key: "send-retry-1",
    });
    const first = await send();
    const replay = await send();
    expect(replay.conversation.id).toBe(first.conversation.id);
    expect(replay.message.id).toBe(first.message.id);
    // The same key with different content is a different request, not a retry.
    await expect(service.sendMessage(owner, room.room.id, null, {
      content: "Something else entirely.",
      idempotency_key: "send-retry-1",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reuses one personal Room per person per Project, and stops calling it personal once it is not", async (ctx) => {
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
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
    const shared = await service.sendMessage(owner, mainline.room.id, null, { content: "Everyone can see this." });
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
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.getProjectMainline(owner, "project-1");
    // A third person joins the Project after it exists.
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ('user-later', 'Later', 'active', now(), now())`);
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
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.getProjectMainline(owner, "project-1");
    // user-2 is a Project member, so opening the Project enrols them.
    await service.getProjectMainline({ spaceId: "space-1", userId: "user-2" }, "project-1");
    await expect(service.removeUser(owner, created.room.id, "user-2"))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("brings an existing Assistant up to a changed seed at boot, not only on the next Room", async (ctx) => {
    if (!db.available || !service) return;
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
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const mainline = await service.getProjectMainline(owner, "project-1");
    // Conversations are created by speaking, so give each Room one and say
    // something in the topic Room's second, so ordering has something to bite
    // on.
    await seedConversation(owner, mainline.room.id);
    const topic = await openSpokenRoom(owner, { project_id: "project-1", title: "Tax season" });
    const topicSecond = await seedConversation(owner, topic.room.id, "Receipts");
    await db.pool.query(
      `INSERT INTO messages (id, space_id, session_id, user_id, role, content, created_at)
       VALUES ($1, 'space-1', $2, 'user-1', 'user', 'Where are the March receipts?', now())`,
      [randomUUID(), topicSecond.id],
    );

    // user-2 was never invited to the topic Room. Reading the list enrols them
    // in the mainline — and only the mainline.
    const seen = await service.listProjectConversations({ spaceId: "space-1", userId: "user-2" }, "project-1", { limit: 50, offset: 0 });
    expect(seen.items.map((item) => item.room_id)).toEqual([mainline.room.id]);
    expect(seen.items[0]).toMatchObject({ room_is_mainline: true, room_title: "Room Project", message_count: 0 });

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
      message_count: 1,
    });
    expect(all.viewer_can_write).toBe(true);

    // Not in the Project: nothing, and no join.
    await expect(service.listProjectConversations({ spaceId: "space-1", userId: "user-9" }, "project-1", { limit: 50, offset: 0 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("decides, on the person's word, a proposal this conversation produced — and no other", async (ctx) => {
    if (!db.available || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Daily" });
    const here = await seedConversation(owner, created.room.id, "Here");
    const elsewhere = await seedConversation(owner, created.room.id, "Elsewhere");

    const runIn = async (sessionId: string): Promise<string> => {
      const id = randomUUID();
      await db.pool!.query(
        `INSERT INTO runs (
           id, space_id, agent_id, agent_version_id, project_id, run_type, trigger_origin, status, mode,
           session_id, instructed_by_user_id, created_at, updated_at, owner_user_id, visibility, access_level
         ) VALUES ($1,'space-1','agent-1','version-1','project-1','agent','manual','succeeded','live',
                   $2,'user-1',now(),now(),'user-1','space_shared','full')`,
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

    await expect(decide({ proposal_id: alsoMine, decision: "reject" }, dispatch))
      .resolves.toMatchObject({ status: "rejected", decided_by: "user-1" });
    const accepted = await decide({ proposal_id: mine, decision: "accept" }, dispatch);
    expect(accepted).toMatchObject({ status: "accepted", decided_by: "user-1", via: "room_instruction" });

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
