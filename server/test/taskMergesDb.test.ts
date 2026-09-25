import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostServerFrame } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedServerHost, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig } from "../src/config.js";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import {
  refreshBuiltinMergeLocations,
  registerTaskMergeHandler,
  TASK_MERGE_JOB,
  wakeTaskMergesForLocations,
  type TaskMergeConflictResolver,
} from "../src/modules/hosts/taskMerges.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { JobWorker } from "../src/modules/jobs/worker.js";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
import { taskRunAhead } from "../src/modules/runs/agentRunHandler.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { headMovedByConversationRun } from "../src/modules/sessions/conversationGitGate.js";
import type { WorkspaceVerificationOutcome } from "../src/modules/runs/verification/engine.js";
import { TaskMergeResolutionDispatcher } from "../src/modules/tasks/mergeResolution.js";
import { PgTaskRunSettler } from "../src/modules/runs/taskRunSettlement.js";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";

/**
 * A done Task's branch reaching the main branch (ADR 0016 §11, P2/P3 of the
 * Task branch plan), driven through the real `task_merge` job, the real
 * `done` writes and — for a conflict — the real admission of the Agent's
 * resolution Run, against a host that answers each merge step as scripted.
 */
const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOLDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const CONVERSATION = "88888888-8888-4888-8888-888888888888";
const PROFILE = "aaaa1111-1111-4111-8111-111111111111";
const MAIN = "a".repeat(40);
const TASK_COMMIT = "b".repeat(40);
const MOVED_MAIN = "c".repeat(40);
const TASK_COMMIT_2 = "d".repeat(40);

const db = useTestDatabase(import.meta.filename);
const owner = { spaceId: SPACE, userId: OWNER };
const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test" });
let executionRunId = "";
let threadId = "";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["task_merges", "conversation_execution_contexts", "jobs", "task_runs", "runs", "host_threads", "agent_runtime_profiles", "sessions", "workspace_locations", "project_folders", "tasks", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces", "project_work_events"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT, ownerDisplayName: "Jin" });
  const room = await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`, [SPACE]);
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [CONVERSATION, SPACE, PROJECT, room.rows[0]!.id, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'Test machine', 'desktop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, last_heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'Test host', 'remote', 'linux_native', 'online',
       '{"installations":{"claude_code":[{"id":"own","version":"1.0.0","logged_in":true}]}}'::jsonb, now(), $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       display_path, execution_ready, status, git_head, dirty, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $6, false, $5, $5)`,
    [LOCATION, SPACE, FOLDER, HOST, now, MAIN],
  );
  await db.pool.query(
    `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, description, status, created_by_user_id, created_at, updated_at, visibility)
     VALUES ($1, $2, $3, $4, 'Fix the parser', 'Handle nested quotes.', 'ready', $5, $6, $6, 'space_shared')`,
    [TASK, SPACE, PROJECT, FOLDER, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, name: "Builder", now });
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id, space_id, agent_id, name, runtime_key, backend_mode, execution_host_id,
       workspace_location_id, workspace_mode, runtime_installation,
       runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
     ) VALUES ($1,$2,$3,'Task dispatch','claude_code','runtime_native',$4,$5,'location','own',
       '{}'::jsonb,'{}'::jsonb,true,false,now(),now())`,
    [PROFILE, SPACE, AGENT, HOST, LOCATION],
  );
  threadId = (await new PgHostThreadRepository(db.pool).create({
    executionHostId: HOST, workspaceLocationId: LOCATION, taskId: TASK,
    runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER,
  })).id;
  // The Task's execution Run, admitted as a person's dispatch is, then ended
  // and settled onto the Task branch.
  const run = await new PgTaskRepository(db.pool).createTaskRun(owner, TASK, {
    workspace_location_id: LOCATION, prompt: "go", thread_id: threadId, agent_id: AGENT, runtime_profile_id: PROFILE,
  });
  executionRunId = String(run.id);
  await db.pool.query(`DELETE FROM jobs`);
  await db.pool.query(
    `UPDATE runs SET status = 'succeeded', session_id = $2,
       runtime_profile_id = COALESCE(runtime_profile_id, requested_runtime_profile_id),
       runtime_profile_selection_source = COALESCE(runtime_profile_selection_source, 'explicit'),
       runtime_key = 'claude_code', runtime_profile_snapshot_json = COALESCE(runtime_profile_snapshot_json, '{}'::jsonb),
       output_json = '{"schema_version":"run_output.v1","result":{"task_branch":{"branch":"rainver/task-${TASK}","commit":"${"e".repeat(40)}","error":null}}}'::jsonb
     WHERE id = $1`,
    [executionRunId, CONVERSATION],
  );
  // The Task came from that conversation, so its merge is told there.
  await db.pool.query(`UPDATE tasks SET source_run_id = $2 WHERE id = $1`, [TASK, executionRunId]);
  registerTasksProjectIntegration();
});

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
});

type Scripted = Partial<Record<HostServerFrame["type"], Array<Record<string, unknown>>>>;

/** A host answering each merge step from a script, and recording what it was asked. */
function scriptedHost(script: Scripted) {
  const registry = new HostConnectionRegistry();
  const sent: HostServerFrame[] = [];
  const replyTypes: Record<string, "task_merge_step_result" | "task_merge_abort_result" | "task_merge_finish_result" | "task_branch_delete_result"> = {
    task_merge_prepare: "task_merge_step_result",
    task_merge_continue: "task_merge_step_result",
    task_merge_abort: "task_merge_abort_result",
    task_merge_finish: "task_merge_finish_result",
    task_branch_delete: "task_branch_delete_result",
  };
  registry.registerConnection(HOST, {
    send(frame) {
      sent.push(frame);
      const replyType = replyTypes[frame.type];
      if (!replyType || !("request_id" in frame)) return;
      const reply = script[frame.type]?.shift() ?? { ok: true, deleted: true, error: null };
      queueMicrotask(() => registry.receiveTaskBranchResult(HOST, replyType, frame.request_id, reply as never));
    },
    close() {},
  });
  return { registry, sent };
}

const rebased = (onto = MAIN, task = TASK_COMMIT) => ({
  ok: true, outcome: "rebased", main_branch: "main", onto_commit: onto, task_commit: task, conflicted_files: [], error: null,
});
const conflict = (files: string[], onto = MAIN) => ({
  ok: true, outcome: "conflict", main_branch: "main", onto_commit: onto, task_commit: null, conflicted_files: files, error: null,
});
const finished = (outcome: string, extra: Record<string, unknown> = {}) => ({
  ok: true, outcome, merged_commit: outcome === "merged" ? TASK_COMMIT : null, overlapping_files: [], error: null, ...extra,
});
const passes = async (): Promise<WorkspaceVerificationOutcome> => ({ status: "passed", checks: [] });

function worker(host: HostConnectionRegistry, options: { verify?: () => Promise<WorkspaceVerificationOutcome>; resolver?: TaskMergeConflictResolver } = {}) {
  const registry = new JobHandlerRegistry();
  registerTaskMergeHandler(registry, config(), {
    hosts: host,
    verify: options.verify ?? passes,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });
  return new JobWorker(new PgJobQueueRepository(db.pool), registry, "test-worker", [TASK_MERGE_JOB]);
}

async function dueNow() {
  await db.pool.query(`UPDATE jobs SET scheduled_at = now() - interval '1 second' WHERE job_type = $1 AND status = 'pending'`, [TASK_MERGE_JOB]);
}

async function mergeRow() {
  return (await db.pool.query<{ id: string; status: string; merged_commit: string | null; detail_json: Record<string, unknown>; resolution_run_id: string | null }>(
    `SELECT id, status, merged_commit, detail_json, resolution_run_id FROM task_merges WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [TASK],
  )).rows[0];
}

async function events(kind: string) {
  return (await db.pool.query<{ data_json: Record<string, unknown> }>(
    `SELECT data_json FROM project_work_events WHERE subject_id = $1 AND event_kind = $2 ORDER BY occurred_at`,
    [TASK, kind],
  )).rows;
}

async function notices() {
  return (await db.pool.query<{ content: string }>(
    `SELECT content FROM messages WHERE session_id = $1 AND metadata_json->>'execution_event' = 'task_merge' ORDER BY created_at`,
    [CONVERSATION],
  )).rows.map((row) => row.content);
}

async function attention() {
  const adapter = projectAttentionRegistry.list()[0]!;
  return (await adapter.listAttentionItems(db.pool, owner, PROJECT)).filter((item) => item.source_type === "task_merge");
}

async function markDone() {
  await new PgTaskRepository(db.pool).updateTask(owner, TASK, { status: "done" });
}

/** What the Location's checkout reports: a paired host's heartbeat. */
async function checkoutAt(branch: string, head: string) {
  return new PgWorkspaceLocationRepository(db.pool).recordDaemonHeartbeat(HOST, [
    { location_id: LOCATION, branch, git_head: head, dirty: false, execution_ready: true },
  ]);
}

async function pendingMergeJobs() {
  return (await db.pool.query(`SELECT 1 FROM jobs WHERE job_type = $1 AND status = 'pending'`, [TASK_MERGE_JOB])).rows.length;
}

/** An initialized Room conversation working in the Location, its Git baseline accepted at `head` on main. */
async function conversationOnLocation(sessionId: string, head: string) {
  if (sessionId !== CONVERSATION) {
    const room = await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`, [SPACE]);
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [sessionId, SPACE, PROJECT, room.rows[0]!.id],
    );
  }
  await db.pool.query(
    `INSERT INTO conversation_execution_contexts (id, space_id, session_id, execution_host_id, primary_workspace_mode,
       primary_project_folder_id, primary_workspace_location_id, state, initialized_at, initialized_by_user_id,
       git_branch, git_head, git_dirty, git_execution_ready, git_observed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'location', $5, $6, 'initialized', now(), $7, 'main', $8, false, true, now(), now(), now())`,
    [randomUUID(), SPACE, sessionId, HOST, FOLDER, LOCATION, OWNER, head],
  );
}

async function conversationGit(sessionId: string) {
  return (await db.pool.query<{ last_run_git_branch: string | null; last_run_git_head: string | null }>(
    `SELECT last_run_git_branch, last_run_git_head FROM conversation_execution_contexts WHERE session_id = $1`,
    [sessionId],
  )).rows[0]!;
}

describe("merging a done Task", () => {
  it("squashes, rebases, verifies and fast-forwards, then says so on the timeline and in the conversation", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_finish: [finished("merged")] });

    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });

    expect(await mergeRow()).toMatchObject({ status: "merged", merged_commit: TASK_COMMIT });
    const prepare = host.sent.find((frame) => frame.type === "task_merge_prepare") as Extract<HostServerFrame, { type: "task_merge_prepare" }>;
    expect(prepare.workspace).toEqual({ kind: "location", workspace_location_id: LOCATION, worktree: { task_id: TASK } });
    expect(prepare.author).toEqual({ name: "Builder", email: `${AGENT}@agents.rainver.invalid` });
    expect(prepare.message).toContain("Fix the parser\n\nHandle nested quotes.");
    expect(prepare.message).toContain(`Rainver-Task: ${TASK}`);
    expect(prepare.message).toContain("Requested-by: Jin");
    expect(host.sent.find((frame) => frame.type === "task_merge_finish")).toMatchObject({
      main_branch: "main", onto_commit: MAIN, task_commit: TASK_COMMIT,
    });
    expect(await events("task.merged")).toEqual([expect.objectContaining({ data_json: expect.objectContaining({ main_branch: "main", commit: TASK_COMMIT }) })]);
    expect(await notices()).toEqual([`Task "Fix the parser" is merged into main.`]);
    expect(await attention()).toEqual([]);
  });

  it("lets the conversation the Task came from take the merge's move of its checkout, and no other", async (ctx) => {
    if (!db.available) return ctx.skip();
    const neighbour = randomUUID();
    await conversationOnLocation(CONVERSATION, MAIN);
    await conversationOnLocation(neighbour, MAIN);
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_finish: [finished("merged")] });

    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });

    const checkout = { branch: "main", commit_sha: TASK_COMMIT };
    expect(await conversationGit(CONVERSATION)).toEqual({ last_run_git_branch: "main", last_run_git_head: TASK_COMMIT });
    expect(headMovedByConversationRun(await conversationGit(CONVERSATION), checkout)).toBe(true);
    expect(headMovedByConversationRun(await conversationGit(neighbour), checkout)).toBe(false);
  });

  it("leaves the origin conversation's gate alone when it had not accepted the commit the merge moved from", async (ctx) => {
    if (!db.available) return ctx.skip();
    await conversationOnLocation(CONVERSATION, MOVED_MAIN);
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_finish: [finished("merged")] });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await conversationGit(CONVERSATION)).toEqual({ last_run_git_branch: null, last_run_git_head: null });
  });

  it("asks once per done write, and a Task closed again replaces only a merge that stopped", async (ctx) => {
    if (!db.available) return ctx.skip();
    const tasks = new PgTaskRepository(db.pool);
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["src/parser.ts"])] });
    await expect(worker(host.registry, { resolver: { dispatch: async () => null } }).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "conflict" });

    await tasks.updateTask(owner, TASK, { status: "in_progress" });
    await markDone();
    const statuses = (await db.pool.query<{ status: string }>(`SELECT status FROM task_merges ORDER BY created_at`)).rows.map((row) => row.status);
    expect(statuses).toEqual(["superseded", "queued"]);
  });

  it("asks for nothing more when the Task is closed again while its merge is under way", async (ctx) => {
    if (!db.available) return ctx.skip();
    const tasks = new PgTaskRepository(db.pool);
    await markDone();
    await tasks.updateTask(owner, TASK, { status: "in_progress" });
    await markDone();
    expect((await db.pool.query(`SELECT status FROM task_merges`)).rows).toEqual([{ status: "queued" }]);
    expect(await pendingMergeJobs()).toBe(1);
  });

  it("keeps the merge, and its Agent's resolution Run, when the Task is closed again while the conflict is being resolved", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["src/parser.ts"])] });
    const merges = worker(host.registry, { resolver: new TaskMergeResolutionDispatcher(config()) });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    const resolutionRunId = (await mergeRow())!.resolution_run_id!;

    // Reopened and closed again before the merge's job ran to give it back:
    // the Agent's work is not thrown away to be asked for a second time.
    const tasks = new PgTaskRepository(db.pool);
    await tasks.updateTask(owner, TASK, { status: "in_progress" });
    await markDone();
    expect((await db.pool.query(`SELECT status, resolution_run_id FROM task_merges`)).rows).toEqual([{ status: "resolving", resolution_run_id: resolutionRunId }]);
    expect((await new PgRunRepository(db.pool).getRun(SPACE, resolutionRunId))?.status).toBe("queued");

    // The merge's job, brought forward by the reopen, finds the Task done and waits on as before.
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(await mergeRow()).toMatchObject({ status: "resolving" });
  });

  it("waits for the person's overlapping edits, keeps trying, and merges once the checkout changes", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({
      task_merge_prepare: [rebased()],
      task_merge_finish: [finished("waiting_local_changes", { overlapping_files: ["src/parser.ts"] }), finished("merged")],
    });
    const merges = worker(host.registry);

    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(await mergeRow()).toMatchObject({ status: "waiting_local_changes" });
    expect(await attention()).toEqual([expect.objectContaining({ reason: "merge_waiting_local_changes", severity: "normal" })]);
    expect((await events("task.merge_blocked")).map((event) => event.data_json.reason)).toEqual(["waiting_local_changes"]);
    expect((await notices())[0]).toContain("src/parser.ts");

    // The person commits: the heartbeat reports a new HEAD and the merge runs now.
    const { changed, headMoved } = await new PgWorkspaceLocationRepository(db.pool).recordDaemonHeartbeat(HOST, [
      { location_id: LOCATION, branch: "main", git_head: MOVED_MAIN, dirty: false, execution_ready: true },
    ]);
    expect({ changed, headMoved }).toEqual({ changed: [LOCATION], headMoved: [LOCATION] });
    await wakeTaskMergesForLocations(db.pool, changed, headMoved);
    // The claim compares against a millisecond JS clock; `now()` is finer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
    expect(await attention()).toEqual([]);
  });

  it("rebases again when the main branch moved after its rebase", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({
      task_merge_prepare: [rebased(), rebased(MOVED_MAIN, TASK_COMMIT_2)],
      task_merge_finish: [finished("main_moved"), finished("merged", { merged_commit: TASK_COMMIT_2 })],
    });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged", merged_commit: TASK_COMMIT_2 });
    expect(host.sent.filter((frame) => frame.type === "task_merge_finish").at(-1)).toMatchObject({ onto_commit: MOVED_MAIN });
  });

  it("stops on failed checks without moving the main branch", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()] });
    const failing = async (): Promise<WorkspaceVerificationOutcome> => ({
      status: "failed", checks: [{ verifier_type: "test", key: "test:npm test", status: "failed", summary: "2 failing" }],
    });
    await expect(worker(host.registry, { verify: failing }).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "verification_failed" });
    expect(host.sent.some((frame) => frame.type === "task_merge_finish")).toBe(false);
    expect((await events("task.merge_blocked"))[0]!.data_json).toMatchObject({
      reason: "verification_failed", failed_checks: [expect.objectContaining({ key: "test:npm test" })],
    });
    expect(await attention()).toEqual([expect.objectContaining({ reason: "merge_verification_failed", severity: "high" })]);
  });

  it("gives a conflict nobody can resolve to the person, with the branch given back, and tries again when the checkout changes", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["src/parser.ts"]), rebased()], task_merge_finish: [finished("merged")] });
    const noAgent: TaskMergeConflictResolver = { dispatch: async () => null };
    const merges = worker(host.registry, { resolver: noAgent });

    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "conflict", detail_json: expect.objectContaining({ conflicted_files: ["src/parser.ts"] }) });
    expect(host.sent.map((frame) => frame.type)).toContain("task_merge_abort");
    expect((await notices())[0]).toContain("kept for you to merge by hand");

    // A commit on another branch changes nothing the conflict depends on.
    await checkoutAt("feature", MOVED_MAIN);
    await wakeTaskMergesForLocations(db.pool, [LOCATION]);
    expect(await pendingMergeJobs()).toBe(0);

    // The person merged main into shape by hand: main moved in the checkout.
    await checkoutAt("main", MOVED_MAIN);
    await wakeTaskMergesForLocations(db.pool, [LOCATION]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
  });

  it("gives a conflict to the Task's Agent first, holds the Task's other Runs meanwhile, and finishes after the resolution", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({
      task_merge_prepare: [conflict(["src/parser.ts"])],
      task_merge_continue: [rebased()],
      task_merge_finish: [finished("merged")],
    });
    const merges = worker(host.registry, { resolver: new TaskMergeResolutionDispatcher(config()) });

    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    const merge = await mergeRow();
    expect(merge).toMatchObject({ status: "resolving" });
    const resolution = await db.pool.query<{ id: string; trigger_origin: string; host_task_thread_id: string; contract_snapshot_json: Record<string, unknown>; role: string; prompt: string }>(
      `SELECT r.id, r.trigger_origin, r.host_task_thread_id, r.contract_snapshot_json, tr.role, r.prompt
         FROM runs r JOIN task_runs tr ON tr.run_id = r.id WHERE r.id = $1`,
      [merge!.resolution_run_id],
    );
    expect(resolution.rows[0]).toMatchObject({
      trigger_origin: "system",
      role: "merge",
      host_task_thread_id: threadId,
      contract_snapshot_json: expect.objectContaining({ task_merge_id: merge!.id }),
    });
    expect(resolution.rows[0]!.prompt).toContain("src/parser.ts");
    // The Task stays done; its resolution Run is admitted and queued.
    expect((await db.pool.query(`SELECT status FROM tasks WHERE id = $1`, [TASK])).rows[0]).toEqual({ status: "done" });
    expect((await db.pool.query(`SELECT 1 FROM jobs WHERE job_type = 'agent_run' AND payload_json->>'run_id' = $1`, [merge!.resolution_run_id])).rows).toHaveLength(1);

    // While the merge holds the worktree, only its own resolution Run may run there.
    const resolutionRun = (await new PgRunRepository(db.pool).getRun(SPACE, merge!.resolution_run_id!))!;
    await expect(taskRunAhead(db.pool, resolutionRun)).resolves.toBe(false);
    const other = await new PgRunRepository(db.pool).getRun(SPACE, executionRunId);
    await db.pool.query(`UPDATE runs SET status = 'queued' WHERE id = $1`, [executionRunId]);
    await expect(taskRunAhead(db.pool, { ...other!, status: "queued" })).resolves.toBe(true);
    await db.pool.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [executionRunId]);

    // Not until the resolution Run ends.
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    await db.pool.query(
      `UPDATE runs SET status = 'succeeded', runtime_key = 'claude_code',
         runtime_profile_id = COALESCE(runtime_profile_id, requested_runtime_profile_id),
         runtime_profile_selection_source = COALESCE(runtime_profile_selection_source, 'explicit'),
         runtime_profile_snapshot_json = COALESCE(runtime_profile_snapshot_json, '{}'::jsonb) WHERE id = $1`,
      [merge!.resolution_run_id],
    );
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
    expect(host.sent.map((frame) => frame.type)).toEqual(["task_merge_prepare", "task_merge_continue", "task_merge_finish"]);
  });

  it("gives an unresolved conflict to the person after the Agent's one try", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({
      task_merge_prepare: [conflict(["src/parser.ts"])],
      task_merge_continue: [{ ...conflict(["src/parser.ts"]), outcome: "unresolved" }],
    });
    const runId = randomUUID();
    const resolver: TaskMergeConflictResolver = {
      dispatch: async () => {
        await db.pool.query(
          `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
             runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json,
             owner_user_id, visibility, created_at, updated_at, execution_kind)
           VALUES ($1,$2,$3,$4,'agent','system','succeeded','live',$5,'default','claude_code','{}'::jsonb,$6,'space_shared',now(),now(),'agent')`,
          [runId, SPACE, AGENT, VERSION, PROFILE, OWNER],
        );
        return runId;
      },
    };
    const merges = worker(host.registry, { resolver });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "conflict", detail_json: expect.objectContaining({ conflict_reason: "resolution_incomplete" }) });
    expect(host.sent.map((frame) => frame.type)).toEqual(["task_merge_prepare", "task_merge_continue", "task_merge_abort"]);
  });

  it("merges a Task its own Run closed before that Run was settled, once the settle lands", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `task.complete` mid-Run: the Run is still running and has no task_branch yet.
    await db.pool.query(`UPDATE runs SET status = 'running', output_json = NULL WHERE id = $1`, [executionRunId]);
    await markDone();
    expect(await mergeRow()).toMatchObject({ status: "queued" });
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_finish: [finished("merged")] });
    const merges = worker(host.registry);
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(host.sent).toEqual([]);
    await db.pool.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [executionRunId]);
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
  });

  it("waits for a host that is away, telling nobody", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    await expect(worker(new HostConnectionRegistry()).processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(await mergeRow()).toMatchObject({ status: "rebasing" });
    expect(await events("task.merge_blocked")).toEqual([]);
  });

  it("says a repeated conflict once, however often the main branch moves under it", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["src/parser.ts"]), conflict(["src/parser.ts"], MOVED_MAIN)] });
    const merges = worker(host.registry, { resolver: { dispatch: async () => null } });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    await checkoutAt("main", MOVED_MAIN);
    await wakeTaskMergesForLocations(db.pool, [LOCATION]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "conflict" });
    expect(await events("task.merge_blocked")).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it("gives back a blocked merge when its Task is reopened, and keeps asking while the host is busy", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const failing = async (): Promise<WorkspaceVerificationOutcome> => ({ status: "failed", checks: [{ verifier_type: "test", key: "t", status: "failed", summary: "no" }] });
    const host = scriptedHost({
      task_merge_prepare: [rebased()],
      // The block's own best-effort abort, then the Task's reopen: busy, then done.
      task_merge_abort: [{ ok: false, error: "task_busy" }, { ok: false, error: "task_busy" }, { ok: true, error: null }],
    });
    const merges = worker(host.registry, { verify: failing });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "verification_failed" });
    expect(await attention()).toHaveLength(1);

    await new PgTaskRepository(db.pool).updateTask(owner, TASK, { status: "in_progress" });
    expect(await attention()).toEqual([]);
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(await mergeRow()).toMatchObject({ status: "verification_failed" });
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "superseded" });
  });

  it("continues after a failed resolution Run a supervisor holds for review", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["a.ts"])], task_merge_continue: [rebased()], task_merge_finish: [finished("merged")] });
    const runId = randomUUID();
    const resolver: TaskMergeConflictResolver = {
      dispatch: async (client) => {
        await client.query(
          `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
             runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json,
             owner_user_id, visibility, created_at, updated_at, execution_kind, error_json)
           VALUES ($1,$2,$3,$4,'agent','system','waiting_for_review','live',$5,'default','claude_code','{}'::jsonb,$6,'space_shared',now(),now(),'agent','{"supervisor_review":true}'::jsonb)`,
          [runId, SPACE, AGENT, VERSION, PROFILE, OWNER],
        );
        return runId;
      },
    };
    const merges = worker(host.registry, { resolver });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
  });

  it("goes ahead of a Run of the Task still queued, which waits for it instead", async (ctx) => {
    if (!db.available) return ctx.skip();
    const queued = await new PgTaskRepository(db.pool).createTaskRun(owner, TASK, {
      workspace_location_id: LOCATION, prompt: "more", thread_id: threadId, agent_id: AGENT, runtime_profile_id: PROFILE,
    });
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_finish: [finished("merged")] });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
    const run = (await new PgRunRepository(db.pool).getRun(SPACE, String(queued.id)))!;
    await expect(taskRunAhead(db.pool, run)).resolves.toBe(false);
  });

  it("gives the conflict to the person when the Task's budget refuses the resolution Run, and names the main branch", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(`UPDATE tasks SET max_runs = 1 WHERE id = $1`, [TASK]);
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [{ ...conflict(["src/parser.ts"]), onto_commit: MAIN }] });
    const merges = worker(host.registry, { resolver: new TaskMergeResolutionDispatcher(config()) });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "conflict" });
    expect(host.sent.map((frame) => frame.type)).toEqual(["task_merge_prepare", "task_merge_abort"]);
    expect((await db.pool.query(`SELECT main_branch, onto_commit FROM task_merges WHERE task_id = $1`, [TASK])).rows[0])
      .toEqual({ main_branch: "main", onto_commit: MAIN });
    expect((await notices())[0]).toContain("could not be merged into main");
  });

  it("tells the resolution Run which branch is the other side", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [{ ...conflict(["src/parser.ts"]), main_branch: "trunk", onto_commit: MAIN }] });
    await expect(worker(host.registry, { resolver: new TaskMergeResolutionDispatcher(config()) }).processOne())
      .resolves.toMatchObject({ status: "deferred" });
    const merge = await mergeRow();
    const prompt = (await db.pool.query<{ prompt: string }>(`SELECT prompt FROM runs WHERE id = $1`, [merge!.resolution_run_id])).rows[0]!.prompt;
    expect(prompt).toContain("git log --oneline -20 trunk");
  });

  it("does not move the main branch for a Task reopened while its merge verified", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_abort: [{ ok: true, error: null }] });
    const reopenDuringChecks = async (): Promise<WorkspaceVerificationOutcome> => {
      await db.pool.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [TASK]);
      return { status: "passed", checks: [] };
    };
    await expect(worker(host.registry, { verify: reopenDuringChecks }).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "superseded" });
    expect(host.sent.map((frame) => frame.type)).toEqual(["task_merge_prepare", "task_merge_abort"]);
  });

  it("does not let a queued Run of the Task and the merge's resolution Run wait on each other", async (ctx) => {
    if (!db.available) return ctx.skip();
    const queued = await new PgTaskRepository(db.pool).createTaskRun(owner, TASK, {
      workspace_location_id: LOCATION, prompt: "more", thread_id: threadId, agent_id: AGENT, runtime_profile_id: PROFILE,
    });
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["a.ts"])] });
    await expect(worker(host.registry, { resolver: new TaskMergeResolutionDispatcher(config()) }).processOne())
      .resolves.toMatchObject({ status: "deferred" });
    const merge = await mergeRow();
    const runs = new PgRunRepository(db.pool);
    await expect(taskRunAhead(db.pool, (await runs.getRun(SPACE, merge!.resolution_run_id!))!)).resolves.toBe(false);
    await expect(taskRunAhead(db.pool, (await runs.getRun(SPACE, String(queued.id)))!)).resolves.toBe(true);
  });

  it("waits for a Run that started and is resuming, rather than merging its half-done work", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    // Parked on a delegated Agent, now requeued: started, not ended.
    await db.pool.query(`UPDATE runs SET status = 'queued', started_at = now() WHERE id = $1`, [executionRunId]);
    const host = scriptedHost({});
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "deferred" });
    expect(host.sent).toEqual([]);
    const resumed = (await new PgRunRepository(db.pool).getRun(SPACE, executionRunId))!;
    await expect(taskRunAhead(db.pool, resumed)).resolves.toBe(false);
  });

  it("does not hand the person a conflict the host could not give back", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [conflict(["a.ts"])], task_merge_abort: [{ ok: false, error: "git read-tree failed" }] });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "failed" });
  });

  it("merges the work of a Run that settles after its Task is done", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({ task_merge_prepare: [rebased()], task_merge_finish: [finished("merged")] });
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    // A Run queued before the Task closed now settles a commit onto a new branch.
    const late = new HostConnectionRegistry();
    late.registerConnection(HOST, {
      send(frame) {
        if (frame.type !== "task_run_settle") return;
        queueMicrotask(() => late.receiveTaskBranchResult(HOST, "task_run_settle_result", frame.request_id, {
          ok: true, branch: `rainver/task-${TASK}`, commit: TASK_COMMIT_2, error: null,
        }));
      },
      close() {},
    });
    await new PgTaskRunSettler(db.pool, late).settle({
      run: { id: executionRunId, space_id: SPACE, agent_id: AGENT, instructed_by_user_id: OWNER },
      taskId: TASK, hostId: HOST,
      workspace: { kind: "location", workspace_location_id: LOCATION, worktree: { task_id: TASK } },
      outcome: "succeeded", summary: "More.",
    });
    expect(await mergeRow()).toMatchObject({ status: "queued" });
    expect((await db.pool.query(`SELECT basis FROM task_merges WHERE status = 'queued'`)).rows[0]).toEqual({ basis: `late:${executionRunId}` });
  });

  it("scopes a late merge to its Run's Location and leaves another Location's merge under way alone", async (ctx) => {
    if (!db.available) return ctx.skip();
    const other = randomUUID();
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         display_path, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'remote', '/workspace/other', true, 'stale', now(), now())`,
      [other, SPACE, FOLDER, HOST],
    );
    await db.pool.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [TASK]);
    const resolving = randomUUID();
    await db.pool.query(
      `INSERT INTO task_merges (id, space_id, task_id, workspace_location_id, basis, status, requested_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'user:x', 'resolving', $5, now(), now())`,
      [resolving, SPACE, TASK, other, OWNER],
    );
    const settle = (reply: { commit: string }) => {
      const late = new HostConnectionRegistry();
      late.registerConnection(HOST, {
        send(frame) {
          if (frame.type !== "task_run_settle") return;
          queueMicrotask(() => late.receiveTaskBranchResult(HOST, "task_run_settle_result", frame.request_id, {
            ok: true, branch: `rainver/task-${TASK}`, commit: reply.commit, error: null,
          }));
        },
        close() {},
      });
      return new PgTaskRunSettler(db.pool, late).settle({
        run: { id: executionRunId, space_id: SPACE, agent_id: AGENT, instructed_by_user_id: OWNER },
        taskId: TASK, hostId: HOST,
        workspace: { kind: "location", workspace_location_id: LOCATION, worktree: { task_id: TASK } },
        outcome: "succeeded", summary: "More.",
      });
    };
    await settle({ commit: TASK_COMMIT_2 });
    const rows = (await db.pool.query<{ workspace_location_id: string; status: string; basis: string }>(
      `SELECT workspace_location_id, status, basis FROM task_merges ORDER BY created_at`,
    )).rows;
    expect(rows).toEqual([
      { workspace_location_id: other, status: "resolving", basis: "user:x" },
      { workspace_location_id: LOCATION, status: "queued", basis: `late:${executionRunId}` },
    ]);
    // A merge of the Run's own Location not yet under way takes the commit: no second one.
    await settle({ commit: MOVED_MAIN });
    expect((await db.pool.query(`SELECT 1 FROM task_merges`)).rows).toHaveLength(2);
  });

  it("wakes a built-in host Location's blocked merge when the server sees its checkout change", async (ctx) => {
    if (!db.available) return ctx.skip();
    const root = await mkdtemp(join(tmpdir(), "rainver-builtin-merge-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["-c", "user.email=p@e", "-c", "user.name=P", "commit", "-q", "--allow-empty", "-m", "one"], { cwd: root });
      const builtinHost = randomUUID();
      const builtinLocation = randomUUID();
      await seedServerHost(db.pool, { id: builtinHost });
      await db.pool.query(
        `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
           root_path, execution_ready, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'server', $5, true, 'stale', now(), now())`,
        [builtinLocation, SPACE, FOLDER, builtinHost, root],
      );
      await db.pool.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [TASK]);
      await db.pool.query(
        `INSERT INTO task_merges (id, space_id, task_id, workspace_location_id, basis, status, requested_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'user:x', 'conflict', $5, now(), now())`,
        [randomUUID(), SPACE, TASK, builtinLocation, OWNER],
      );
      await expect(refreshBuiltinMergeLocations(db.pool, root)).resolves.toBe(1);
      expect((await db.pool.query(`SELECT 1 FROM jobs WHERE job_type = $1 AND status = 'pending'`, [TASK_MERGE_JOB])).rows).toHaveLength(1);
      // Nothing changed since: nothing to wake.
      await db.pool.query(`DELETE FROM jobs WHERE job_type = $1`, [TASK_MERGE_JOB]);
      await expect(refreshBuiltinMergeLocations(db.pool, root)).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops a merge whose Task was reopened, giving its rebase back", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    await db.pool.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [TASK]);
    const host = scriptedHost({});
    await expect(worker(host.registry).processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "superseded" });
    expect(host.sent.map((frame) => frame.type)).toEqual(["task_merge_abort"]);
  });

  it("stops and tells the person after the main branch moved under it five times in a row, then tries again when it next moves", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    const host = scriptedHost({
      task_merge_prepare: Array.from({ length: 6 }, () => rebased()),
      task_merge_finish: [...Array.from({ length: 5 }, () => finished("main_moved")), finished("merged")],
    });
    let verified = 0;
    const merges = worker(host.registry, { verify: async () => { verified += 1; return passes(); } });
    // Four moves within one job run, the fifth on the next.
    await expect(merges.processOne()).resolves.toMatchObject({ status: "deferred" });
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });

    expect(await mergeRow()).toMatchObject({ status: "failed", detail_json: { error: "main_kept_moving" } });
    expect(verified).toBe(5);
    expect((await notices()).at(-1)).toContain("moved under it 5 times in a row");
    expect(host.sent.map((frame) => frame.type)).toContain("task_merge_abort");

    // The next move of the main branch tries it once more, from a clean count.
    await checkoutAt("main", MOVED_MAIN);
    await wakeTaskMergesForLocations(db.pool, [LOCATION]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(merges.processOne()).resolves.toMatchObject({ status: "completed" });
    expect(await mergeRow()).toMatchObject({ status: "merged" });
  });

  it("stops a merge whose job keeps failing the same way any other stop is made: the rebase given back, the person told", async (ctx) => {
    if (!db.available) return ctx.skip();
    await markDone();
    await db.pool.query(`UPDATE jobs SET max_attempts = 2 WHERE job_type = $1`, [TASK_MERGE_JOB]);
    const host = scriptedHost({ task_merge_prepare: [rebased(), rebased()] });
    const merges = worker(host.registry, { verify: async () => { throw new Error("the verification engine is down"); } });
    await expect(merges.processOne()).resolves.toMatchObject({ status: "failed" });
    expect(await mergeRow()).toMatchObject({ status: "verifying" });
    await dueNow();
    await expect(merges.processOne()).resolves.toMatchObject({ status: "failed" });

    expect(await mergeRow()).toMatchObject({ status: "failed", detail_json: { error: "the verification engine is down" } });
    expect(host.sent.map((frame) => frame.type).at(-1)).toBe("task_merge_abort");
    expect(await events("task.merge_blocked")).toEqual([expect.objectContaining({ data_json: expect.objectContaining({ reason: "failed" }) })]);
    expect((await notices()).at(-1)).toContain("could not be merged into main");
    expect(await attention()).toEqual([expect.objectContaining({ reason: "merge_failed" })]);
  });
});
