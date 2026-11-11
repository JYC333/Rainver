import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { agentsModule } from "../src/modules/agents/index.js";
import { runsModule } from "../src/modules/runs/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { registerAgentRunHandler } from "../src/modules/runs/agentRunHandler.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { ConversationInputService } from "../src/modules/sessions/conversationInputService.js";
import { ConversationExecutionContextService } from "../src/modules/sessions/executionContextService.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { RoomService } from "../src/modules/rooms/service.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { resolveAgentDelegationToolBinding, runAgentRoomToolCall } from "../src/modules/runs/managedAgentDelegationTools.js";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { ensureDefaultRuntimeProfile, seedAgentWithVersion, seedRoomManager, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { joinedInvocation, occurrences } from "./support/promptProvenance.js";
import { SyntheticAcpHost } from "./support/syntheticAcpHost.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

/**
 * Joined prompt-provenance acceptance: each conversation path is driven
 * through production — the chat route or Room service writes the message and
 * Run, the `agent_run` job handler executes it (Gateway Delivery, Invocation
 * Snapshot, ACP adapter, post-run settlement), and a synthetic Host daemon on
 * the connection registry records the ACP prompt it was actually sent.
 * `joinedInvocation` then checks one invocation's canonical current input,
 * Snapshot and prompt against each other.
 */
const db = useTestDatabase(import.meta.filename, { max: 4 });
const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");
const MANAGER_INSTRUCTION = "Answer as the provenance Agent.";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const imageBlock = { type: "image", data: PNG.toString("base64"), mimeType: "image/png" };
let home: string;
let config: ServerConfig;
let app: FastifyInstance | undefined;
let host: SyntheticAcpHost | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "rainver-prompt-provenance-"));
});
beforeEach(async () => {
  // One built-in Host per instance (uq_hosts_single_server).
  await resetTables(db.pool, ["spaces", "users", "hosts", "machines", "jobs"], { cascade: true });
});
afterEach(async () => {
  __setAuthIdentityForTests(null);
  host?.disconnect();
  host = undefined;
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

/**
 * A Space with a Project, its owner, and an Agent running opencode on one
 * Host — the built-in one, or the owner's paired machine — whose installation
 * reports ACP image input, so an image is an authorized attachment.
 */
async function world(hostKind: "server" | "remote") {
  const space = randomUUID();
  const owner = randomUUID();
  const project = randomUUID();
  const agent = randomUUID();
  const hostId = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner, project });
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Provenance machine', $3, now(), now())`,
    [hostId, hostKind === "remote" ? owner : null, hostKind === "remote" ? "desktop" : "server"],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status,
       capabilities_json, last_heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, $1, 'Provenance host', $3, $4, 'online', $5::jsonb, now(), now(), now())`,
    [hostId, hostKind === "remote" ? owner : null, hostKind, hostKind === "remote" ? "linux_native" : "server",
      JSON.stringify({ execution_workspaces:{version:2},runtimes: [], versions: {}, installations: { opencode: [{
        id: "managed:1.0.0", version: "1.0.0", logged_in: true, health_check_protocol: "acp",
        options: { config_options: [], prompt_capabilities: { image: true, embedded_context: false, resource_link: true } },
      }] } })],
  );
  const profileFor = (agentId: string) => ensureDefaultRuntimeProfile(db.pool, {
    agent: agentId, space, runtimeKey: "opencode", executionHostId: hostId,
    runtimeInstallation: "managed:1.0.0", workspaceMode: "managed",
  });
  await seedAgentWithVersion(db.pool, { space, owner, agent, version: randomUUID(), systemPrompt: MANAGER_INSTRUCTION, seedDefaultRuntimeProfile: false });
  const profile = await profileFor(agent);
  await new RuntimeContextPolicyRepository(db.pool).write({ spaceId: space, userId: owner }, "space", space, {
    base_version_id: null, policy: { constraints: {}, preferences: {} }, reason: "Synthetic acceptance policy",
  });
  config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "internal-token", RAINVER_HOME: home });
  host = new SyntheticAcpHost(sharedHostConnectionRegistry, hostId).connect();
  const upload = async () => {
    const media = await new ConversationInputService(db.pool, config).uploadImage({
      spaceId: space, userId: owner, filename: "diagram.png", mediaType: "image/png", stream: Readable.from([PNG]),
    });
    return { kind: "image" as const, media_id: media.media_id, filename: media.filename, media_type: "image/png" as const, byte_size: media.byte_size };
  };
  const handlers = new JobHandlerRegistry();
  registerAgentRunHandler(handlers, config);
  const worker = new JobWorker(new PgJobQueueRepository(db.pool), handlers, "prompt-provenance", ["agent_run"], 0);
  /** Works the queued `agent_run` jobs, oldest first, until this Run has executed. */
  const execute = async (runId: string) => {
    for (let job = 0; job < 5 && !host!.promptsFor(runId).length; job += 1) {
      expect(await worker.processOne()).toMatchObject({ status: "completed" });
    }
    return (await db.pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId])).rows[0]!;
  };
  return { space, owner, project, agent, profile, hostId, identity: { spaceId: space, userId: owner }, profileFor, upload, execute };
}

async function directChatWorld() {
  const w = await world("server");
  app = buildModuleServer(config, [agentsModule, runsModule]);
  __setAuthIdentityForTests(w.identity);
  const send = async (payload: Record<string, unknown>) => {
    const response = await app!.inject({ method: "POST", url: `/api/v1/agents/${w.agent}/chat`, payload, headers: { "idempotency-key": randomUUID() } });
    expect(response.statusCode, response.body).toBe(202);
    return response.json().data as { run_id: string; session_id: string; user_message_id: string };
  };
  return { ...w, send };
}

/**
 * The Project's mainline Room with the Agent as its manager and a specialist
 * on the roster, and one Conversation initialized on the world's Host. The
 * manager is seated with `seedRoomManager` rather than provisioning the
 * system Assistant: the subject here is what the turn delivers, not who the
 * Room's manager is.
 */
async function roomWorld(hostKind: "server" | "remote") {
  const w = await world(hostKind);
  await syncBuiltinPrompts(db.pool, CATALOG_ROOT);
  const specialist = randomUUID();
  await seedAgentWithVersion(db.pool, { space: w.space, owner: w.owner, agent: specialist, version: randomUUID(), name: "Reviewer", systemPrompt: "Review what you are asked to.", seedDefaultRuntimeProfile: false });
  await w.profileFor(specialist);
  const room = (await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE project_id = $1 AND is_mainline`, [w.project])).rows[0]!.id;
  await seedRoomManager(db.pool, { space: w.space, room, agent: w.agent });
  await db.pool.query(
    `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
    [randomUUID(), w.space, room, specialist],
  );
  const conversation = await new PgSessionRepository(db.pool).createRoomConversation({
    space_id: w.space, room_id: room, project_id: w.project, project_folder_id: null, title: "Provenance", metadata: {},
  });
  await new ConversationExecutionContextService(db.pool).initialize(w.identity, conversation.id, {
    selection: { execution_host_id: w.hostId, primary: { kind: "managed" } },
    runtime: { agent_id: w.agent, runtime_profile_id: w.profile, runtime_key: "opencode", runtime_installation: "managed:1.0.0" },
  });
  const rooms = new RoomService(config, db.pool);
  const send = (input: Parameters<RoomService["sendMessage"]>[3]) => rooms.sendMessage(w.identity, room, conversation.id, input);
  /**
   * A Project Folder on the Host, attached to the Conversation, holding the
   * person's unsaved draft of one file: the attachable text resource.
   */
  const draftResource = async (relativePath: string, content: string) => {
    const folder = randomUUID();
    const location = randomUUID();
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, name, status, created_by_user_id, kind, is_primary, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, 'Release notes', 'active', $4, 'code', false, false, false, now(), now())`,
      [folder, w.space, w.project, w.owner],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, 'active', now(), now())`,
      [location, w.space, folder, w.hostId, hostKind],
    );
    await new ConversationExecutionContextService(db.pool).mutateAttachment(w.identity, conversation.id, {
      action: "attach", mutation_id: randomUUID(), project_folder_id: folder, workspace_location_id: location, access_mode: "read",
    });
    const draft = randomUUID();
    const sha256 = createHash("sha256").update(content).digest("hex");
    const byteSize = Buffer.byteLength(content);
    await db.pool.query(
      `INSERT INTO project_file_drafts (id, space_id, project_id, project_folder_id, workspace_location_id, owner_user_id,
         target_kind, relative_path, base_exists, base_sha256, content, content_sha256, byte_size, version, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'existing', $7, true, NULL, $8, $9, $10, 1, now(), now(), now() + interval '1 day')`,
      [draft, w.space, w.project, folder, location, w.owner, relativePath, content, sha256, byteSize],
    );
    return {
      kind: "input_resource" as const, source_state: "draft" as const, draft_id: draft, draft_version: 1,
      content_sha256: sha256, display_name: relativePath, media_type: "text/markdown", byte_size: byteSize,
    };
  };
  return { ...w, specialist, room, conversation, rooms, send, draftResource };
}

describe("joined prompt provenance: direct chat", () => {
  it("delivers a fresh turn and its authorized image once, then resumes the session with only the next message", async () => {
    const w = await directChatWorld();
    const first = await w.send({ message: "Describe the attached diagram.", input_parts: [await w.upload()] });
    expect(await w.execute(first.run_id)).toMatchObject({ status: "succeeded" });

    const opened = await joinedInvocation(db.pool, host!, first.run_id);
    expect(opened.current.ref).toEqual({ type: "message", id: first.user_message_id });
    expect(opened.acp.sessionMethod).toBe("session/new");
    // A fresh session opens with the Agent's standing instruction, once, before the message.
    expect(opened.deliveredContents.filter((content) => content === MANAGER_INSTRUCTION)).toHaveLength(1);
    expect(opened.snapshot.sourceRefs.filter((ref) => ref.type === "agent_version")).toHaveLength(1);
    // The image is hydrated at the ACP edge, once, and never described as text.
    expect(opened.attachments).toEqual([imageBlock]);
    expect(occurrences(opened.text, PNG.toString("base64"))).toBe(0);

    const second = await w.send({ message: "Now list its labels.", session_id: first.session_id });
    expect(await w.execute(second.run_id)).toMatchObject({ status: "succeeded" });

    const resumed = await joinedInvocation(db.pool, host!, second.run_id);
    expect(resumed.current.ref).toEqual({ type: "message", id: second.user_message_id });
    // The vendor session holds the conversation: it is resumed, and sent the
    // new message verbatim — no standing items, no earlier turn, no earlier image.
    expect(resumed.acp).toMatchObject({ sessionMethod: "session/resume", sessionId: opened.acp.sessionId });
    expect(resumed.delivery.blocks).toHaveLength(1);
    expect(resumed.currentUserContent).toBe("Now list its labels.");
    expect(occurrences(resumed.text, "Describe the attached diagram.")).toBe(0);
    expect(resumed.attachments).toEqual([]);
    expect(resumed.snapshot.sourceRefs).not.toContainEqual({ type: "message", id: first.user_message_id });
    expect(resumed.snapshot.sourceRefs.filter((ref) => ref.type === "agent_version")).toHaveLength(0);
  });

  it("retries a failed turn with its own message and attachment once, as the same canonical input", async () => {
    const w = await directChatWorld();
    host!.answer = () => ({ error: "Synthetic runtime failure" });
    const failed = await w.send({ message: "Summarize this screenshot.", input_parts: [await w.upload()] });
    expect(await w.execute(failed.run_id)).toMatchObject({ status: "failed" });
    const original = await joinedInvocation(db.pool, host!, failed.run_id);

    host!.answer = () => ({ text: "Done." });
    const response = await app!.inject({
      method: "POST", url: `/api/v1/agents/${w.agent}/chat/retry`,
      headers: { "idempotency-key": randomUUID() }, payload: { run_id: failed.run_id },
    });
    expect(response.statusCode, response.body).toBe(202);
    const retry = response.json().data as { run_id: string; user_message_id: string; retry_of_run_id: string };
    expect(retry).toMatchObject({ user_message_id: failed.user_message_id, retry_of_run_id: failed.run_id });
    expect(await w.execute(retry.run_id)).toMatchObject({ status: "succeeded" });

    const retried = await joinedInvocation(db.pool, host!, retry.run_id);
    // The same canonical message is the retry's own current input — its own
    // Delivery and Snapshot, the message once, its image hydrated once.
    expect(retried.current.ref).toEqual({ type: "message", id: failed.user_message_id });
    expect(retried.delivery.id).not.toBe(original.delivery.id);
    expect(retried.snapshot.sourceRefs.filter((ref) => ref.type === "message")).toEqual([{ type: "message", id: failed.user_message_id }]);
    expect(retried.attachments).toEqual([imageBlock]);
    // It continues the session the failed turn opened. That turn never landed,
    // so the session is not known to hold the standing items: they are sent
    // again, once — and the failed prompt itself is not replayed.
    expect(retried.acp).toMatchObject({ sessionMethod: "session/resume", sessionId: original.acp.sessionId });
    expect(retried.deliveredContents.filter((content) => content === MANAGER_INSTRUCTION)).toHaveLength(1);
    expect(retried.delivery.blocks).toHaveLength(original.delivery.blocks.length);
  });
});

describe("joined prompt provenance: Room", () => {
  it("delivers a Room turn's message, image and file descriptor once, after the recipient's instruction", async () => {
    const w = await roomWorld("server");
    const draftBody = "# Release notes\nDraft body the runtime reads lazily.\n";
    const sent = await w.send({
      content: "Plan the release from this board.",
      input_parts: [await w.upload(), await w.draftResource("NOTES.md", draftBody)],
    });
    const runId = sent.run_ids[0]!;
    expect(await w.execute(runId)).toMatchObject({ status: "succeeded" });

    const turn = await joinedInvocation(db.pool, host!, runId);
    expect(turn.current.ref).toEqual({ type: "message", id: sent.message.id });
    expect(turn.acp.sessionMethod).toBe("session/new");
    // A fresh session gets the standing items once — the Agent's instruction
    // and its Room identity — then the recipient instruction, then the
    // message itself, last; the image is hydrated once.
    const kinds = (type: string) => turn.snapshot.sourceRefs.filter((ref) => ref.type === type);
    expect(kinds("agent_version")).toHaveLength(1);
    expect(kinds("run_group_agent_identity")).toHaveLength(1);
    expect(kinds("room_recipient_instruction")).toHaveLength(1);
    expect(turn.deliveredContents.filter((content) => content === MANAGER_INSTRUCTION)).toHaveLength(1);
    expect(turn.delivery.blocks.map((block) => block.semantic_role).slice(-2)).toEqual(["user_input", "user_input"]);
    // The draft's immutable descriptor is part of the canonical current input
    // and reaches the runtime once, in the current block; the ACP edge adds
    // its resource link but no second descriptor, and never the draft body.
    const resource = (await db.pool.query<{ id: string }>(
      `SELECT id FROM conversation_input_resources WHERE message_id = $1`, [sent.message.id],
    )).rows[0]!.id;
    expect(turn.currentUserContent.startsWith("Plan the release from this board.\n\n[Attached immutable input resources]")).toBe(true);
    expect(occurrences(turn.text, "[Attached immutable input resources]")).toBe(1);
    expect(occurrences(turn.text, `"resource_id":"${resource}"`)).toBe(1);
    expect(occurrences(turn.text, "Draft body the runtime reads lazily.")).toBe(0);
    expect(turn.attachments).toEqual([imageBlock, {
      type: "resource_link", uri: `rainver:conversation-input-resource:${resource}`,
      name: "NOTES.md", mimeType: "text/markdown", size: Buffer.byteLength(draftBody),
    }]);

    const next = await w.send({ content: "Which step is riskiest?" });
    expect(await w.execute(next.run_ids[0]!)).toMatchObject({ status: "succeeded" });
    const resumed = await joinedInvocation(db.pool, host!, next.run_ids[0]!);
    // The resumed session already holds the standing items and the earlier
    // turn: it is sent this message alone, verbatim, without the earlier image.
    expect(resumed.acp).toMatchObject({ sessionMethod: "session/resume", sessionId: turn.acp.sessionId });
    expect(resumed.snapshot.sourceRefs).toEqual([{ type: "message", id: next.message.id }]);
    expect(resumed.deliveredContents).toEqual(["Which step is riskiest?"]);
    expect(occurrences(resumed.text, "Plan the release from this board.")).toBe(0);
    expect(resumed.attachments).toEqual([]);
  });

  it("retries a failed Room turn with the same message and image once", async () => {
    const w = await roomWorld("server");
    host!.answer = () => ({ error: "Synthetic runtime failure" });
    const sent = await w.send({ content: "Draft the launch email from this mockup.", input_parts: [await w.upload()] });
    expect(await w.execute(sent.run_ids[0]!)).toMatchObject({ status: "failed" });
    const original = await joinedInvocation(db.pool, host!, sent.run_ids[0]!);

    host!.answer = () => ({ text: "Drafted." });
    const retried = await w.rooms.retryMessage(w.identity, w.room, w.conversation.id, { run_id: sent.run_ids[0]! });
    const retryRunId = retried.run_ids[0]!;
    expect(await w.execute(retryRunId)).toMatchObject({ status: "succeeded" });
    const retry = await joinedInvocation(db.pool, host!, retryRunId);
    // The retry reuses the person's message rather than posting a new one: it
    // is the retry's current input, delivered once with its image once, and
    // the session the failed turn opened is continued.
    expect(retried.user_message_id).toBe(sent.message.id);
    expect(retry.current.ref).toEqual({ type: "message", id: sent.message.id });
    expect(retry.delivery.id).not.toBe(original.delivery.id);
    expect(retry.snapshot.sourceRefs.filter((ref) => ref.type === "message")).toEqual([{ type: "message", id: sent.message.id }]);
    expect(retry.currentUserContent).toBe("Draft the launch email from this mockup.");
    expect(retry.attachments).toEqual([imageBlock]);
    expect(retry.acp).toMatchObject({ sessionMethod: "session/resume", sessionId: original.acp.sessionId });
    expect(retry.deliveredContents.filter((content) => content === MANAGER_INSTRUCTION)).toHaveLength(1);
  });

  it("delegates with the child's own request, never the parent's message or attachment", async () => {
    const w = await roomWorld("server");
    let childRunId: string | null = null;
    host!.answer = async (prompt) => {
      const caller = await new PgRunRepository(db.pool).getAgentRun(w.space, prompt.runId);
      if (caller?.agent_id !== w.agent || caller.delegation_id) return { text: "Reviewed." };
      // The manager calls `agent.delegate` mid-turn, as its work surface would.
      const binding = (await resolveAgentDelegationToolBinding(config, caller, { pool: db.pool }))!;
      const delegated = (await runAgentRoomToolCall({
        id: randomUUID(), name: "agent.delegate",
        arguments_json: JSON.stringify({ workspace_access: "read", target_agent_id: w.specialist, instruction: "Check the release checklist for gaps." }),
      }, binding, caller)).modelResult as { ok: boolean; child_run_id: string };
      expect(delegated.ok).toBe(true);
      childRunId = delegated.child_run_id;
      return { text: "I asked the Reviewer." };
    };
    const sent = await w.send({ content: "Get the release checklist reviewed.", input_parts: [await w.upload()] });
    expect(await w.execute(sent.run_ids[0]!)).toMatchObject({ status: "succeeded" });
    const parent = await joinedInvocation(db.pool, host!, sent.run_ids[0]!);
    expect(parent.current.ref).toEqual({ type: "message", id: sent.message.id });
    expect(parent.attachments).toEqual([imageBlock]);
    expect(childRunId).not.toBeNull();
    expect(await w.execute(childRunId!)).toMatchObject({ status: "succeeded" });

    const child = await joinedInvocation(db.pool, host!, childRunId!);
    // The child inherits the parent's chat-turn record but answers its own
    // Run request: the person's message is not its input, is not delivered,
    // and its image is not hydrated into the child's prompt.
    expect(recordOf(recordOf(child.run.model_override_json).chat_turn).user_message_id).toBe(sent.message.id);
    expect(child.current.ref).toEqual({ type: "run_request", id: childRunId });
    expect(child.snapshot.sourceRefs.filter((ref) => ref.type === "message")).toEqual([]);
    expect(occurrences(child.text, "Get the release checklist reviewed.")).toBe(0);
    expect(child.attachments).toEqual([]);
    // Its own instruction once: the Run request already carries it, so it is
    // not acquired again as a separate task instruction.
    expect(occurrences(child.text, "Check the release checklist for gaps.")).toBe(1);
    expect(child.acp.sessionMethod).toBe("session/new");
    expect(child.deliveredContents.filter((content) => content === "Review what you are asked to.")).toHaveLength(1);
    expect(child.deliveredContents.filter((content) => content === MANAGER_INSTRUCTION)).toHaveLength(0);
  });

  it("writes a summary handoff from its own request into the live session", async () => {
    const w = await roomWorld("remote");
    const sent = await w.send({ content: "Start the refactor from this sketch.", input_parts: [await w.upload()] });
    expect(await w.execute(sent.run_ids[0]!)).toMatchObject({ status: "succeeded" });
    const turn = await joinedInvocation(db.pool, host!, sent.run_ids[0]!);
    await w.rooms.summarizeAgentContext(w.identity, w.room, w.agent);
    const handoffRun = (await db.pool.query<{ id: string }>(
      `SELECT id FROM runs WHERE session_id = $1 AND model_override_json->'chat_turn'->>'kind' = 'handoff'`, [w.conversation.id],
    )).rows[0]!.id;
    expect(await w.execute(handoffRun)).toMatchObject({ status: "succeeded" });
    const handoff = await joinedInvocation(db.pool, host!, handoffRun);
    // The handoff names the Conversation's summary-request message as its
    // chat turn, but its current input is its own Run request: no message is
    // delivered or hydrated, and the earlier turn's image is not replayed.
    const requestMessage = recordOf(recordOf(handoff.run.model_override_json).chat_turn).user_message_id;
    expect(typeof requestMessage).toBe("string");
    expect(handoff.current.ref).toEqual({ type: "run_request", id: handoffRun });
    expect(handoff.snapshot.sourceRefs).toEqual([{ type: "run_request", id: handoffRun }]);
    expect(handoff.deliveredContents).toEqual([handoff.run.prompt]);
    expect(handoff.attachments).toEqual([]);
    expect(occurrences(handoff.text, "Start the refactor from this sketch.")).toBe(0);
    // Into the live session, which already holds the standing items.
    expect(handoff.acp).toMatchObject({ sessionMethod: "session/resume", sessionId: turn.acp.sessionId });
  });
});

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
