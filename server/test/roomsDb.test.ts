import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { RoomService } from "../src/modules/rooms/service";
import { PgRunRepository } from "../src/modules/runs/repository";
import { RunOrchestrationService } from "../src/modules/runs/orchestrationService";
import { PgRouteDecisionRepository } from "../src/modules/routing/repository";
import { AgentGroupRunService } from "../src/modules/agentGroups/service";
import { AgentGroupRunLifecycleProjector } from "../src/modules/agentGroups/lifecycleProjector";
import {
  ROOM_DELEGATION_COMPLETION_RETRY_JOB,
  registerRoomDelegationCompletionRetryHandler,
} from "../src/modules/agentGroups/delegationCompletionRetryJob";
import { PgAgentGroupRepository } from "../src/modules/agentGroups/repository";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry";
import { PgSessionRepository } from "../src/modules/sessions/repository";
import {
  RuntimeToolRegistry,
  type RuntimeToolInstallRunner,
} from "../src/modules/runtimeTools";
import { finalizeChatTurn } from "../src/modules/runs/chatTurnFinalizer";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins";
import {
  RoomConversationSummaryService,
  requestRoomConversationSummary,
  type RoomConversationSummaryDependencies,
} from "../src/modules/rooms/conversationSummaryService";
import {
  requestRoomConversationTitle,
  RoomConversationTitleService,
} from "../src/modules/rooms/conversationTitleService";
import { InquiryThreadProposalService } from "../src/modules/inquiry/inquiryThreadProposalService";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import {
  loadRoomContinuityForRunRequest,
  loadRoomConversationReplayThroughMessage,
} from "../src/modules/runtimeContext/conversationContinuity";
import { loadAuthorizedCurrentContextMessage } from "../src/modules/runtimeContext/productionAcquisition";
import type { ProviderCommandStore } from "../src/modules/providers/commands/store";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let service: RoomService | undefined;
let groupService: AgentGroupRunService | undefined;
let available = false;
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
  if (!pool) throw new Error("test pool unavailable");
  await pool.query(
    `INSERT INTO room_user_members (
       id, space_id, room_id, user_id, role, status, created_at, updated_at
     ) VALUES ($1, 'space-1', $2, $3, 'member', 'active', now(), now())`,
    [randomUUID(), roomId, userId],
  );
}

async function removeManagedAssistant(): Promise<void> {
  if (!pool) throw new Error("test pool unavailable");
  await pool.query("UPDATE agents SET current_version_id = NULL WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'");
  await pool.query("DELETE FROM actors WHERE space_id = 'space-1' AND agent_id IN (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant')");
  await pool.query("DELETE FROM agent_runtime_profiles WHERE space_id = 'space-1' AND agent_id IN (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant')");
  await pool.query("DELETE FROM agent_versions WHERE space_id = 'space-1' AND agent_id IN (SELECT id FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant')");
  await pool.query("DELETE FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'");
}

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    const databaseUrl = database.getConnectionUri();
    pool = new Pool({ connectionString: databaseUrl });
    testRoot = await mkdtemp(join(tmpdir(), "agent-space-room-db-"));
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
      SERVER_DATABASE_URL: databaseUrl,
      AGENT_SPACE_HOME: testRoot,
    }), pool);
    groupService = new AgentGroupRunService(loadConfig({
      SERVER_DATABASE_URL: databaseUrl,
      AGENT_SPACE_HOME: testRoot,
    }), pool);
    // Installs the fake claude_code tool once for the whole file: on-disk
    // state under testRoot, independent of the per-test DB fixtures below.
    await new RuntimeToolRegistry(
      loadConfig({ AGENT_SPACE_HOME: testRoot }),
      new FakeClaudeCodeInstaller(),
    ).install("claude_code", { version: INSTALLED_CLAUDE_CODE_VERSION });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(
      `[rooms-db] skipped — Docker/Postgres unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!available || !pool) return;
  const now = new Date().toISOString();
  await resetTables(
    pool,
    ["workspace_locations", "spaces", "users", "hosts", "machines"],
    { cascade: true },
  );
  await syncBuiltinPrompts(pool, CATALOG_ROOT);
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES
       ('user-1', 'Room Owner', 'active', $1, $1),
       ('user-2', 'Room Member', 'active', $1, $1),
       ('user-3', 'Outside Member', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ('space-1', 'Room Space', 'team', 'user-1', $1, $1)`,
    [now],
  );
  // Enables the claude_code tool this file installed once in beforeAll
  // (on-disk state) for this fresh space (DB state, truncated per test) —
  // without this, SpaceAssistantService's provisioning disables the
  // fixture's runtime-cli profile regardless of the on-disk install.
  await pool.query(
    `INSERT INTO space_runtime_tool_policies (
       id, space_id, runtime, enabled, default_version, allowed_versions_json,
       updated_by_user_id, created_at, updated_at
     ) VALUES ($2, 'space-1', 'claude_code', true, $3, '[]'::jsonb, 'user-1', $1, $1)`,
    [now, randomUUID(), INSTALLED_CLAUDE_CODE_VERSION],
  );
  await pool.query(
    `INSERT INTO space_memberships (
       id, space_id, user_id, role, status, created_at, updated_at
     ) VALUES
       ('membership-1', 'space-1', 'user-1', 'owner', 'active', $1, $1),
       ('membership-2', 'space-1', 'user-2', 'member', 'active', $1, $1),
       ('membership-3', 'space-1', 'user-3', 'member', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO credentials (
       id, space_id, owner_user_id, name, credential_type, secret_ref,
       scopes_json, metadata_json, created_at, updated_at
     ) VALUES ('provider-credential-1', 'space-1', 'user-1', 'Test API key',
       'api_key', 'test-secret-ref', '{}'::jsonb, '{}'::jsonb, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO model_providers (
       id, space_id, owner_user_id, name, provider_type, default_model,
       enabled, credential_id, capabilities_json, config_json, created_at, updated_at
     ) VALUES ('provider-1', 'space-1', 'user-1', 'Test API', 'openai',
       'test-model', true, 'provider-credential-1', '{}'::jsonb, '{}'::jsonb, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO model_provider_space_grants (
       id, provider_id, space_id, owner_user_id, granted_by_user_id,
       enabled, is_default, created_at, updated_at
     ) VALUES ('provider-grant-1', 'provider-1', 'space-1', 'user-1', 'user-1',
       true, true, $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO projects (
       id, space_id, owner_user_id, name, status, created_at, updated_at
     ) VALUES ('project-1', 'space-1', 'user-1', 'Room Project', 'active', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO project_members (
       id, space_id, project_id, user_id, role, status, created_at, updated_at
     ) VALUES (
       'project-member-2', 'space-1', 'project-1', 'user-2',
       'viewer', 'active', $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ('machine-1', NULL, 'Test server', 'server', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ('host-1', NULL, 'machine-1', 'server', 'server', 'server', 'online', $1, $1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, name, status, created_by_user_id, kind,
       is_primary, protected, system_managed, created_at, updated_at
     ) VALUES (
       'folder-1', 'space-1', 'project-1', 'Room Folder', 'active', 'user-1',
       'code', true, false, false, $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       execution_ready, status, preferred, created_at, updated_at
     ) VALUES ('location-1','space-1','folder-1','host-1','server',true,'active',true,$1,$1)`,
    [now],
  );
  await pool.query(
    `INSERT INTO agents (
       id, space_id, owner_user_id, name, status, agent_kind,
       current_version_id, visibility, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', NULL, 'Space Assistant', 'active',
       'system_assistant', NULL, 'space_shared', $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES (
       'version-1', 'agent-1', 'space-1', 'v1', 'Coordinate the Room.',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $1
     )`,
    [now],
  );
  await pool.query(
    "UPDATE agents SET current_version_id = 'version-1' WHERE id = 'agent-1'",
  );
  await pool.query(
    `INSERT INTO actors (
       id, space_id, actor_type, user_id, agent_id, service_name,
       display_name, status, metadata_json, created_at, updated_at
     ) VALUES (
       'agent-1', 'space-1', 'agent', NULL, 'agent-1', NULL,
       'Room Manager', 'active', '{}'::jsonb, $1, $1
     )`,
    [now],
  );
  await pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, adapter_type, runtime_config_json,
       runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES (
       'runtime-cli', 'space-1', 'agent-1', 'Subscription',
       'claude_code', '{}'::jsonb, '{}'::jsonb, true, true, $1, $1
     )`,
    [now],
  );
  await pool.query(
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
  await pool.query(
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

describe("Room workflow (real Postgres)", () => {
  it("keeps system continuations out of the visible transcript while retaining execution context", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Continuation Room",
    });
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main" });
    const sessions = new PgSessionRepository(pool);
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
    const replay = await loadRoomConversationReplayThroughMessage(pool, {
      spaceId: owner.spaceId,
      sessionId: conversation.id,
      currentMessageId: internal!.id,
    });
    expect(replay.messages.map(message => message.content)).toEqual([
      "Define the Project.",
      "Continue after the accepted definition.",
    ]);
  });

  it("validates and deduplicates server-owned Proposal continuations", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Proposal continuation",
    });
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main" });
    await pool.query(
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
    await pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [source.run_ids[0]],
    );
    const proposalId = randomUUID();
    await pool.query(
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
        continuation_directive: "inquiry.propose_thread",
      },
    });
    expect(first.message.content).toContain("不要只在回复里列清单");

    await expect(loadAuthorizedCurrentContextMessage(pool, {
      messageId: first.message.id,
      spaceId: owner.spaceId,
      sessionId: conversation.id,
      userId: owner.userId,
      runId: first.run_ids[0]!,
    })).resolves.toMatchObject({ role: "system", content: first.message.content });
    await expect(loadAuthorizedCurrentContextMessage(pool, {
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
    await expect(pool.query<{ count: string }>(
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
    await pool.query(
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
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM messages
        WHERE session_id=$1 AND metadata_json->>'continuation_proposal_id'=$2`,
      [conversation.id, proposalId],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id = ANY($1::varchar[])",
      [retried.run_ids],
    );

    const otherConversation = await service.createConversation(owner, created.room.id, { title: "Other" });
    await expect(service.continueAfterProposal(owner, created.room.id, otherConversation.id, {
      proposal_id: proposalId,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "Proposal belongs to a different conversation",
    });

    const acceptedQuestionId = randomUUID();
    const pendingSiblingId = randomUUID();
    await pool.query(
      `INSERT INTO proposals (
         id,space_id,created_by_run_id,proposal_type,status,risk_level,urgency,
         preview,title,payload_json,created_at,updated_at,reviewed_at,reviewed_by,
         visibility,access_level,project_id
       ) VALUES
       ($1,'space-1',$3,'inquiry_thread_create','accepted','medium','normal',false,
        '创建研究问题：记忆如何分层？',$4::jsonb,now(),now(),now(),'user-1','space_shared','full','project-1'),
       ($2,'space-1',$3,'inquiry_thread_create','pending','medium','normal',false,
        '创建研究问题：记忆如何检索？',$5::jsonb,now(),now(),NULL,NULL,'space_shared','full','project-1')`,
      [
        acceptedQuestionId,
        pendingSiblingId,
        source.run_ids[0],
        JSON.stringify({ proposal_type: "inquiry_thread_create", action_id: "inquiry.propose_thread", project_id: "project-1", kind: "question", statement: "记忆如何分层？" }),
        JSON.stringify({ proposal_type: "inquiry_thread_create", action_id: "inquiry.propose_thread", project_id: "project-1", kind: "question", statement: "记忆如何检索？" }),
      ],
    );
    const questionContinuation = await service.continueAfterProposal(
      owner,
      created.room.id,
      conversation.id,
      {
        proposal_id: acceptedQuestionId,
        backends: [{
          agent_id: "agent-1",
          runtime_profile_id: "runtime-api",
          credential_profile_id: null,
        }],
      },
    );
    expect(questionContinuation.message.content).toContain("仍有 1 个研究问题提案等待确认");
    expect(questionContinuation.message.content).toContain("不要创建、改写或重新提交任何研究问题");
    expect(questionContinuation.message.metadata_json).toMatchObject({
      continuation_directive: "advance_accepted_thread",
      continuation_context: { pending_sibling_count: 1 },
    });
    const continuationPolicyId = randomUUID();
    await pool.query(
      `INSERT INTO runtime_context_policy_versions (
         id,space_id,scope_type,scope_id,version,policy_json,typed_diff_json,
         reason,created_by_user_id,created_at
       ) VALUES ($1,'space-1','space','space-1',1,'{"constraints":{},"preferences":{}}','{}',
                 'Room continuation test policy','user-1',now())`,
      [continuationPolicyId],
    );
    await pool.query(
      `INSERT INTO runtime_context_policy_bindings (
         space_id,scope_type,scope_id,active_version_id,updated_by_user_id,updated_at
       ) VALUES ('space-1','space','space-1',$1,'user-1',now())`,
      [continuationPolicyId],
    );
    const continuationExecution = await new RunOrchestrationService(
      loadConfig({ SERVER_DATABASE_URL: database!.getConnectionUri(), AGENT_SPACE_HOME: testRoot! }),
      new PgRunRepository(pool),
      {
        usageRecorder: async () => {},
        managedApi: {
          executeRuntimeHost: async () => ({
            success: true,
            stdout: "",
            stderr: "",
            output_text: "已开始推进确认的研究问题。",
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
      run_id: questionContinuation.run_ids[0]!,
      space_id: owner.spaceId,
      worker_id: "room-continuation-test-worker",
      command_source: "job",
    });
    expect(continuationExecution, JSON.stringify(continuationExecution)).toMatchObject({ status: "succeeded" });
    await expect(new InquiryThreadProposalService(pool).proposeThread(
      owner,
      "project-1",
      { statement: "不应由自动 continuation 重复创建的问题" },
      {
        agentId: "agent-1",
        runId: questionContinuation.run_ids[0],
        idempotencyKey: "duplicate-question-call",
      },
    )).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lazily provisions exactly one managed Assistant and the initial conversation", async () => {
    if (!available || !pool || !service) return;
    await removeManagedAssistant();
    const created = await service.createRoom(
      { spaceId: "space-1", userId: "user-1" },
      { project_id: "project-1", title: "First-use Room" },
    );
    expect(created.conversation.room_id).toBe(created.room.id);
    expect(created.agent_members).toHaveLength(1);
    expect(created.agent_members[0]).toMatchObject({
      role: "manager",
      agent_kind: "system_assistant",
    });
    await expect(pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'",
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE space_id = 'space-1' AND room_id = $1",
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("renames a placeholder conversation on its first message and queues cheap refinement", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Memory Room",
    });
    const conversation = await service.createConversation(owner, created.room.id, {});
    expect(conversation.title).toBe("New conversation");

    const message = await new PgSessionRepository(pool).addRoomUserMessage(
      "space-1",
      "user-1",
      created.room.id,
      conversation.id,
      { content: "我想要做一个研究 agent memory 的项目。" },
    );
    expect(message).not.toBeNull();
    const renamed = await requestRoomConversationTitle(pool, {
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
    await expect(pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM jobs
        WHERE space_id='space-1' AND job_type='room_conversation_title'
          AND payload_json->>'session_id'=$1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    const providerStore = {
      getTaskChain: async () => [{ provider_id: "provider-1", model: "cheap-model" }],
    } as unknown as ProviderCommandStore;
    const result = await new RoomConversationTitleService(
      loadConfig({ SERVER_DATABASE_URL: database!.getConnectionUri(), AGENT_SPACE_HOME: testRoot! }),
      pool,
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
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Ordered conversations",
    });
    const older = created.conversation;
    const newer = await service.createConversation(owner, created.room.id, {
      title: "Newer",
    });
    await pool.query(
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

  it("rolls back the managed Assistant and Room when no backend is eligible", async () => {
    if (!available || !pool || !service) return;
    await removeManagedAssistant();
    await pool.query("UPDATE model_provider_space_grants SET enabled = false WHERE space_id = 'space-1'");
    await pool.query("UPDATE cli_credential_space_grants SET enabled = false WHERE space_id = 'space-1'");
    await expect(service.createRoom(
      { spaceId: "space-1", userId: "user-1" },
      { project_id: "project-1", title: "Should roll back" },
    )).rejects.toMatchObject({
      statusCode: 409,
      responseBody: { code: "conversation_backend_required" },
    });
    await expect(pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM rooms WHERE space_id = 'space-1'",
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant'",
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("serializes concurrent first-use provisioning and supports idempotent retries", async () => {
    if (!available || !pool || !service) return;
    await removeManagedAssistant();
    const owner = { spaceId: "space-1", userId: "user-1" };
    const [first, second] = await Promise.all([
      service.createRoom(owner, { project_id: "project-1", title: "Concurrent A" }),
      service.createRoom(owner, { project_id: "project-1", title: "Concurrent B" }),
    ]);
    expect(new Set([first.agent_members[0]?.agent_id, second.agent_members[0]?.agent_id]).size).toBe(1);
    await expect(pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agents WHERE space_id = 'space-1' AND agent_kind = 'system_assistant' AND status = 'active'",
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(pool.query<{ count: string }>(
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
    expect(replay.conversation.id).toBe(retried.conversation.id);
    await expect(service.createRoom(owner, {
      project_id: "project-1",
      title: "Different payload",
      idempotency_key: "room-retry-1",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enforces Project ACL when creating and continuing a Room", async () => {
    if (!available || !pool || !service || !groupService) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      project_folder_id: "folder-1",
      title: "ACL Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await service.createConversation(
      member,
      created.room.id,
      { title: "Before revocation" },
    );
    expect(conversation.project_folder_id).toBe("folder-1");
    const sessions = new PgSessionRepository(pool);
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
    await expect(pool.query<{ project_folder_id: string | null }>(
      "SELECT project_folder_id FROM runs WHERE id = $1",
      [runId],
    )).resolves.toMatchObject({
      rows: [{ project_folder_id: "folder-1" }],
    });
    const runRepository = new PgRunRepository(pool);
    const queuedRun = await runRepository.getRun("space-1", runId);
    expect(queuedRun).not.toBeNull();
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toEqual({ allowed: true });
    await pool.query(
      `UPDATE project_folders
          SET status = 'archived', updated_at = now()
        WHERE space_id = 'space-1' AND id = 'folder-1'`,
    );
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toMatchObject({
        allowed: false,
        error_code: "run_execution_authorization_revoked",
      });
    await pool.query(
      `UPDATE project_folders
          SET status = 'active', updated_at = now()
        WHERE space_id = 'space-1' AND id = 'folder-1'`,
    );
    await pool.query(
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
    await expect(new PgRunRepository(pool).getVisibleRun("space-1", "user-2", runId))
      .resolves.toBeNull();
    await expect(runRepository.checkRunExecutionAuthorization(queuedRun!))
      .resolves.toMatchObject({
        allowed: false,
        error_code: "run_execution_authorization_revoked",
      });

    const finalizerConfig = loadConfig({
      SERVER_DATABASE_URL: database!.getConnectionUri(),
      AGENT_SPACE_HOME: testRoot,
    });
    const continuity = {
      async finalizeChatTurn() {
        return { space_id: "space-1", work_context_scope_id: runId } as never;
      },
      async runSemanticExtraction() { return null; },
    };
    await pool.query(
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

    await pool.query(
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
    if (!available || !pool || !service || !groupService) return;
    const testPool = pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Task authority Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Task ownership" },
    );
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
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Delivery Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Main thread" },
    );
    const secondConversation = await service.createConversation(
      member,
      created.room.id,
      { title: "Follow-up" },
    );

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

    const tasks = await pool.query<{
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

    const runs = await pool.query<{
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
    const currentAgentVersion = await pool.query<{ current_version_id: string }>(
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
    const runAccess = new PgRunRepository(pool);
    await expect(
      runAccess.getVisibleRun("space-1", "user-2", first.run_ids[0]!),
    ).resolves.toMatchObject({ id: first.run_ids[0] });
    await expect(
      runAccess.getVisibleRun("space-1", "user-3", first.run_ids[0]!),
    ).resolves.toBeNull();

    const bindings = await pool.query<{
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
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    await pool.query(
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
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main thread" });

    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "What should I do next?",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
      }],
    });

    const run = await pool.query<{ prompt: string | null }>(
      `SELECT prompt FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    );
    const prompt = run.rows[0]?.prompt ?? "";
    expect(prompt).toContain("[Internal Project guidance");
    expect(prompt).toContain("still needs a formal goal/core problem");
    expect(prompt).toContain("one to three short sentences");
    expect(prompt).not.toContain("Project initialization: incomplete");
    expect(prompt).toContain("[Room execution rules]");
    expect(prompt).toContain("invoke inquiry.propose_thread exactly once for each question");
    expect(prompt).toContain("Merely listing questions in the reply does not create them");
    expect(prompt).toContain("treat that as an execution instruction");
    expect(prompt).toContain("whichever research-execution tool is available");
    expect(prompt).not.toContain("[Current turn execution mode]");
    expect(prompt).toContain("[Assigned task for this Room turn]");
    expect(prompt.endsWith("What should I do next?")).toBe(true);
    // Context precedes the assigned task, never the other way around.
    expect(prompt.indexOf("[Project state]")).toBeLessThan(prompt.indexOf("What should I do next?"));
  });

  it("guides research execution through prompt policy, not a server-side text match on the turn", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    await new InquiryThreadService(pool).createThread(owner, "project-1", {
      kind: "question",
      statement: "Agent memory 应该如何分层？",
    });
    await pool.query(
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
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main" });
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "开始研究",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-api",
        credential_profile_id: null,
      }],
    });
    const runPrompt = await pool.query<{ prompt: string }>("SELECT prompt FROM runs WHERE id=$1", [sent.run_ids[0]]);
    // The research-execution rule is standing prompt guidance present on
    // every Room turn, not a server-side match on this turn's wording — a
    // prior fixed-phrasing regex classifier that injected a per-turn
    // override block was removed for exactly that brittleness.
    expect(runPrompt.rows[0]?.prompt).toContain("treat that as an execution instruction");
    expect(runPrompt.rows[0]?.prompt).not.toContain("[Current turn execution mode]");

    // Choosing whether to call inquiry.propose_thread is the model's own
    // judgment; the server no longer blocks it by pattern-matching the
    // triggering message text (a genuine duplicate is still coalesced —
    // covered separately by the propose_thread dedupe test).
    await expect(new InquiryThreadProposalService(pool).proposeThread(
      owner,
      "project-1",
      { statement: "把分层继续拆成四个问题" },
      {
        agentId: "agent-1",
        runId: sent.run_ids[0],
        idempotencyKey: "must-execute-not-decompose",
      },
    )).resolves.toMatchObject({ proposal: expect.objectContaining({ id: expect.any(String) }) });
  });

  it("grants a Room-dispatched run the conversation scenario tools despite the Agent declaring none", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Allowance Room",
    });
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main thread" });

    // The Agent's own version declares no tools at all, which is the default
    // for every Agent created through the product: the permission comes from
    // the Room, not from the Agent.
    const agentTools = await pool.query<{ tool_permissions_json: unknown }>(
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

    const run = await pool.query<{ tool_grants: Array<{ action_id: string }> }>(
      `SELECT permission_snapshot_json->'tool_grants' AS tool_grants FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    );
    const granted = (run.rows[0]?.tool_grants ?? []).map((grant) => grant.action_id);
    expect(granted).toContain("project.propose_definition");
    expect(granted).toContain("inquiry.propose_thread");
    expect(granted).toContain("inquiry.record_conclusion");
    expect(granted).toContain("inquiry.promote_knowledge");
    // Retrieval would run under the sender's identity and answer into a
    // conversation every Room member reads, so no retrieval action is in the
    // allowance — and listing one would also switch its domain on.
    expect(granted.some((id) => id.includes("retrieval"))).toBe(false);

    // System Action ids authorize server-owned tools; they are not runtime
    // capabilities. A Room allowance must not eliminate the only otherwise
    // valid runtime before even a simple conversation can start.
    const runs = new PgRunRepository(pool);
    const queued = await runs.getRun("space-1", sent.run_ids[0]!);
    expect(queued).not.toBeNull();
    const routed = await new PgRouteDecisionRepository(pool, undefined, {
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
    const rebound = await pool.query<{ tool_grants: Array<{ action_id: string }> }>(
      `SELECT permission_snapshot_json->'tool_grants' AS tool_grants FROM runs WHERE id = $1`,
      [sent.run_ids[0]],
    );
    expect((rebound.rows[0]?.tool_grants ?? []).map((grant) => grant.action_id))
      .toEqual(expect.arrayContaining([
        "project.propose_definition",
        "inquiry.propose_thread",
        "inquiry.record_conclusion",
        "inquiry.promote_knowledge",
      ]));

    // The boundary itself: being dispatched into a Room is the *only* reason
    // these grants exist. The same Agent, same Project, outside a Room, is
    // still bound by its own (empty) AgentVersion allowance.
    await expect(new PgRunRepository(pool).createQueuedRun({
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
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Resume Room",
    });
    await addRoomMember(created.room.id, "user-2");
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Resume thread" },
    );
    const first = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Start the shared analysis.",
      backends: [{
        agent_id: "agent-1",
        runtime_profile_id: "runtime-cli",
        credential_profile_id: "credential-user-1",
      }],
    });
    const firstRun = await pool.query<{
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
    await pool.query(
      `UPDATE runs SET status = 'succeeded', ended_at = now(), updated_at = now()
        WHERE id = $1`,
      [firstRuntime.id],
    );
    await pool.query(
      `UPDATE messages
          SET created_at = '2026-01-01T00:00:00.000Z'
        WHERE id = $1`,
      [first.message.id],
    );
    await pool.query(
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
    await pool.query(
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
    await pool.query(
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
    await pool.query(
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
    const resumedRun = await pool.query<{
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
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Single recipient Room",
    });
    const conversation = await service.createConversation(
      owner,
      created.room.id,
      { title: "Concurrent safety" },
    );

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

    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM messages
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_run_groups
        WHERE session_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rejects task links that cross Room conversation aggregates", async () => {
    if (!available || !pool || !service) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const firstRoom = await service.createRoom(owner, {
      project_id: "project-1",
      title: "First aggregate",
    });
    const secondRoom = await service.createRoom(owner, {
      project_id: "project-1",
      title: "Second aggregate",
    });
    const firstConversation = await service.createConversation(
      owner,
      firstRoom.room.id,
      { title: "First conversation" },
    );
    const secondConversation = await service.createConversation(
      owner,
      secondRoom.room.id,
      { title: "Second conversation" },
    );
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

    await expect(pool.query(
      `UPDATE agent_run_groups SET room_id = $2 WHERE id = $1`,
      [firstTask.task_group_ids[0], secondRoom.room.id],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `UPDATE agent_run_groups SET trigger_message_id = $2 WHERE id = $1`,
      [firstTask.task_group_ids[0], secondTask.message.id],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      `UPDATE runs SET session_id = $2 WHERE id = $1`,
      [firstTask.run_ids[0], secondConversation.id],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps private specialists Room-scoped while allowing Room dispatch visibility", async () => {
    if (!available || !pool || !service || !groupService) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const member = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Private roster" });
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
    await pool.query(
      `INSERT INTO agents (
         id, space_id, owner_user_id, name, status, agent_kind,
         visibility, created_at, updated_at
       ) VALUES ('agent-private', 'space-1', 'user-1', 'Private Specialist', 'active',
         'standard', 'private', now(), now())`,
    );
    await pool.query(
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

    const groups = new PgAgentGroupRepository(pool);
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
    const runtimeProfile = await pool.query<{ id: string }>(
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

    await pool.query(
      `UPDATE room_agent_access_grants
          SET revoked_at = now(), revoked_by_user_id = 'user-1'
        WHERE space_id = 'space-1' AND room_id = $1 AND agent_id = 'agent-private' AND grantee_user_id = 'user-2'`,
      [created.room.id],
    );
    await expect(groups.listAgentStatuses("space-1", "user-2", ["agent-private"], created.room.id))
      .resolves.toEqual([]);
  });

  it("requires each private-Agent owner to approve a Room invitation and supports suspended-owner recovery", async () => {
    if (!available || !pool || !service) return;
    await pool.query(
      `UPDATE project_members
          SET role = 'member', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    const owner = { spaceId: "space-1", userId: "user-1" };
    const specialistOwner = { spaceId: "space-1", userId: "user-2" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Invitation roster" });
    await addRoomMember(created.room.id, "user-2");
    await pool.query(
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
    await pool.query(
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
    await pool.query(
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
    await pool.query(
      `UPDATE project_members
          SET status = 'active', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    const decided = await service.decideInvitation(specialistOwner, created.room.id, invitation.id, {
      agent_id: "agent-owned-by-member",
      decision: "approved",
    });
    expect(decided.status).toBe("active");
    await expect(pool.query<{ status: string }>(
      `SELECT status FROM room_user_members
        WHERE space_id = 'space-1' AND room_id = $1 AND user_id = 'user-3'`,
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ status: "active" }] });
    await expect(pool.query<{ grantee_user_id: string }>(
      `SELECT grantee_user_id FROM room_agent_access_grants
        WHERE space_id = 'space-1' AND room_id = $1 AND agent_id = 'agent-owned-by-member'
          AND grantee_user_id = 'user-3' AND revoked_at IS NULL`,
      [created.room.id],
    )).resolves.toMatchObject({ rows: [{ grantee_user_id: "user-3" }] });

    await service.transferOwner(owner, created.room.id, "user-2");
    await pool.query(
      `UPDATE project_members
          SET status = 'revoked', updated_at = now()
        WHERE space_id = 'space-1' AND project_id = 'project-1' AND user_id = 'user-2'`,
    );
    const recovered = await service.claimOwner(owner, created.room.id);
    expect(recovered.user_members.find((member) => member.user_id === "user-1")?.role).toBe("owner");
    expect(recovered.user_members.filter((member) => member.role === "owner")).toHaveLength(1);
  });

  it("notifies the Room when a delegated child run completes with nobody waiting on it (room-advancement-reliability-plan Phase 3)", async () => {
    if (!available || !pool || !service || !groupService || !testRoot || !database) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await pool.query(
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
    await pool.query("UPDATE agents SET current_version_id = 'version-2' WHERE id = 'agent-2'");
    await pool.query(
      `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'agent', NULL, 'agent-2', NULL, 'Research Specialist', 'active', '{}'::jsonb, $1, $1)`,
      [now],
    );
    await pool.query(
      `INSERT INTO agent_runtime_profiles (
         id, space_id, agent_id, name, adapter_type, runtime_config_json,
         runtime_policy_json, enabled, is_default, created_at, updated_at
       ) VALUES (
         'runtime-cli-2', 'space-1', 'agent-2', 'Subscription', 'claude_code',
         '{}'::jsonb, '{}'::jsonb, true, true, $1, $1
       )`,
      [now],
    );
    await pool.query(
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
    await pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
      [randomUUID(), created.room.id, now],
    );
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main" });
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Ask a specialist to look into this.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-api", credential_profile_id: null }],
    });
    const managerRunId = sent.run_ids[0]!;
    // The Manager's own turn must reach a terminal status before another
    // dispatch (this test's later delegation-completion continuation) can
    // claim the conversation's turn again — mirrors the pattern the
    // continueAfterProposal tests above already use.
    await pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [managerRunId],
    );
    const group = await new PgAgentGroupRepository(pool).getGroup("space-1", sent.task_group_ids[0]!);
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

    await pool.query(
      "UPDATE runs SET status='succeeded', output_json=$2, ended_at=now(), updated_at=now() WHERE id=$1",
      [spawned.child_run_id, JSON.stringify({ summary: "Layered memory improves recall by 12%." })],
    );
    const runs = new PgRunRepository(pool);
    const childRun = await runs.getRun("space-1", spawned.child_run_id!);
    if (!childRun) throw new Error("child run not found");

    const projector = new AgentGroupRunLifecycleProjector(pool, loadConfig({
      SERVER_DATABASE_URL: database.getConnectionUri(),
      AGENT_SPACE_HOME: testRoot,
    }));
    await projector.markDelegatedRunTerminal(childRun);

    const posted = await pool.query<{ content: string; metadata_json: Record<string, unknown> }>(
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
    const recount = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(recount.rows[0]?.total).toBe("1");
  });

  it("does not duplicate the resume path when a Manager is already waiting on the completed delegation (room-advancement-reliability-plan Phase 3)", async () => {
    if (!available || !pool || !service || !groupService || !testRoot || !database) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await pool.query(
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
    await pool.query("UPDATE agents SET current_version_id = 'version-2' WHERE id = 'agent-2'");
    await pool.query(
      `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'agent', NULL, 'agent-2', NULL, 'Research Specialist', 'active', '{}'::jsonb, $1, $1)`,
      [now],
    );
    await pool.query(
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
    await pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
      [randomUUID(), created.room.id, now],
    );
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main" });
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Ask a specialist and wait for the result.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-api", credential_profile_id: null }],
    });
    const managerRunId = sent.run_ids[0]!;
    const group = await new PgAgentGroupRepository(pool).getGroup("space-1", sent.task_group_ids[0]!);
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
    await pool.query(
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

    await pool.query(
      "UPDATE runs SET status='succeeded', output_json=$2, ended_at=now(), updated_at=now() WHERE id=$1",
      [spawned.child_run_id, JSON.stringify({ summary: "Layered memory improves recall by 12%." })],
    );
    const runs = new PgRunRepository(pool);
    const childRun = await runs.getRun("space-1", spawned.child_run_id!);
    if (!childRun) throw new Error("child run not found");

    const projector = new AgentGroupRunLifecycleProjector(pool, loadConfig({
      SERVER_DATABASE_URL: database.getConnectionUri(),
      AGENT_SPACE_HOME: testRoot,
    }));
    await projector.markDelegatedRunTerminal(childRun);

    // The pre-existing dependency-wait path resumed the Manager run instead.
    const resumedManager = await runs.getRun("space-1", managerRunId);
    expect(resumedManager?.status).toBe("queued");

    // The new domain-event continuation must not also have fired for this
    // completion — that would duplicate the resume path above.
    const posted = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(posted.rows[0]?.total).toBe("0");
  });

  it("retries the delegation-completion notification when the conversation turn is busy, and the retry succeeds once it frees up (integration-gate fix)", async () => {
    if (!available || !pool || !service || !groupService || !testRoot || !database) return;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const now = new Date().toISOString();
    const config = loadConfig({
      SERVER_DATABASE_URL: database.getConnectionUri(),
      AGENT_SPACE_HOME: testRoot,
    });
    await pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'user-1', 'Research Specialist', 'active', 'standard', NULL, 'space_shared', $1, $1)`,
      [now],
    );
    await pool.query(
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
    await pool.query("UPDATE agents SET current_version_id = 'version-2' WHERE id = 'agent-2'");
    await pool.query(
      `INSERT INTO actors (id, space_id, actor_type, user_id, agent_id, service_name, display_name, status, metadata_json, created_at, updated_at)
       VALUES ('agent-2', 'space-1', 'agent', NULL, 'agent-2', NULL, 'Research Specialist', 'active', '{}'::jsonb, $1, $1)`,
      [now],
    );
    await pool.query(
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
    await pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, 'space-1', $2, 'agent-2', 'member', 'active', $3, $3)`,
      [randomUUID(), created.room.id, now],
    );
    const conversation = await service.createConversation(owner, created.room.id, { title: "Main" });
    const sent = await service.sendMessage(owner, created.room.id, conversation.id, {
      content: "Ask two specialists in parallel, no need to wait.",
      backends: [{ agent_id: "agent-1", runtime_profile_id: "runtime-api", credential_profile_id: null }],
    });
    const managerRunId = sent.run_ids[0]!;
    await pool.query(
      "UPDATE runs SET status='succeeded', ended_at=now(), updated_at=now() WHERE id=$1",
      [managerRunId],
    );
    const group = await new PgAgentGroupRepository(pool).getGroup("space-1", sent.task_group_ids[0]!);
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
    await pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         session_id, created_at, updated_at, owner_user_id, visibility, access_level, model_override_json
       ) VALUES (
         $1,'space-1','agent-1','version-1','agent','manual','queued','live',
         $2,$3,$3,'user-1','private','full',$4::jsonb
       )`,
      [busyRunId, conversation.id, now, JSON.stringify({ chat_turn: { schema_version: "chat_turn.v1", user_id: "user-1" } })],
    );

    await pool.query(
      "UPDATE runs SET status='succeeded', output_json=$2, ended_at=now(), updated_at=now() WHERE id=$1",
      [spawned.child_run_id, JSON.stringify({ summary: "Layered memory improves recall by 12%." })],
    );
    const runs = new PgRunRepository(pool);
    const childRun = await runs.getRun("space-1", spawned.child_run_id!);
    if (!childRun) throw new Error("child run not found");

    const projector = new AgentGroupRunLifecycleProjector(pool, config);
    await projector.markDelegatedRunTerminal(childRun);

    // The turn was busy, so nothing posted yet.
    const beforeRetry = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(beforeRetry.rows[0]?.total).toBe("0");

    // A retry job was scheduled instead of the result being dropped.
    const jobs = await pool.query<{ payload_json: { delegation_id: string; child_run_id: string } }>(
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
    const stillNotPosted = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(stillNotPosted.rows[0]?.total).toBe("0");

    // The turn frees up.
    await pool.query(
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

    const afterRetry = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM messages
        WHERE space_id='space-1' AND session_id=$1
          AND metadata_json->>'continuation_event_kind'='agent_delegation_result'`,
      [conversation.id],
    );
    expect(afterRetry.rows[0]?.total).toBe("1");
  });

  it("processes owner-funded summaries with strict output and preserves the active version on failure", async () => {
    if (!available || !pool || !service) return;
    const testPool = pool;
    const owner = { spaceId: "space-1", userId: "user-1" };
    const created = await service.createRoom(owner, { project_id: "project-1", title: "Summary Room" });
    const conversation = await service.createConversation(owner, created.room.id, { title: "Summary thread" });
    const firstMessageAt = "2026-01-01T00:00:00.000Z";
    await pool.query(
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
    const config = loadConfig({ SERVER_DATABASE_URL: database!.getConnectionUri(), AGENT_SPACE_HOME: testRoot! });
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
});
