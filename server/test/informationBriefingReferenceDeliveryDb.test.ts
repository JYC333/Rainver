import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRoomManager } from "./support/domainSeeds.js";
import { AGENT, CONNECTION, HOST, NEWCOMER, OWNER, PROFILE, PROJECT, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { personalBriefingScope } from "../src/modules/informationDigest/briefing/personalScope.js";
import { PERSONAL_BRIEFING_LABEL } from "../src/modules/informationDigest/briefing/routes.js";
import { SourceGoalService } from "../src/modules/sources/goals/service.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { loadConfig } from "../src/config.js";
import { settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { RoomService } from "../src/modules/rooms/service.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { ConversationExecutionContextService } from "../src/modules/sessions/executionContextService.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { ExecutionControlSnapshotRepository } from "../src/modules/policy/executionControlSnapshots.js";
import { WorkContextService } from "../src/modules/runtimeContext/workContextService.js";
import { createProductionRuntimeContextPlanningService } from "../src/modules/runtimeContext/productionAcquisition.js";
import { createProductionRuntimeContextInvocationGateway } from "../src/modules/runtimeContext/gateway.js";
import { buildRunOrchestration } from "../src/modules/runs/orchestrationFactory.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { withDbTransaction, type Pool } from "../src/modules/routeUtils/common.js";

// A briefing highlight attached to a Room conversation, followed through the
// production chain to the accepted Invocation Delivery: Room send, execution
// control snapshot, Work Context Setup, planner and gateway. Synthetic data
// and no model: the Delivery is prepared, never dispatched.
const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
const { material, finishRun, runOf, inputsOf, service, adapter, age, count } = w;
const owner = { spaceId: SPACE, userId: OWNER };
const LOCAL_PROFILE = "bd999999-9999-4999-8999-999999999999";
const LOCAL_PROVIDER = "be999999-9999-4999-8999-999999999999";
const DENY_ALL = `'{"allow_external_model_egress":false,"allow_local_provider_egress":false}'::jsonb`;
const LOCAL_ONLY = `'{"allow_external_model_egress":false,"allow_local_provider_egress":true}'::jsonb`;
const ALLOW_ALL = `'{"allow_external_model_egress":true,"allow_local_provider_egress":true}'::jsonb`;
let home: string;
let rooms: RoomService;

beforeAll(async () => { home = await mkdtemp(join(tmpdir(), "rainver-briefing-delivery-")); });
afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }); });
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["invocation_snapshots", "invocation_deliveries", "activity_records", "project_work_events", "settings", "messages", "sessions", "room_agent_members", "model_provider_space_grants", "model_providers"], { cascade: true });
  await w.seed();
  rooms = new RoomService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home }), db.pool);
  await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER]);
  await new RuntimeContextPolicyRepository(db.pool).write(owner, "space", SPACE, { base_version_id: null, policy: { constraints: {}, preferences: {} }, reason: "Isolated synthetic default policy" });
});

/** A published delta whose one highlight cites a fresh item with a distinctive fact. */
async function publishedHighlight(personal = false) {
  const scope = personal ? personalBriefingScope(SPACE, OWNER) : adapter();
  const request = personal ? { ...manual, label: PERSONAL_BRIEFING_LABEL } : manual;
  await material("First report");
  const first = await service().request(scope, OWNER, request);
  await settleBriefingRun(db.pool, await finishRun((await runOf(first.briefing.id)).id, output({})));
  await age(1);
  const fresh = await material("Fresh report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
  const next = await service().request(scope, OWNER, request);
  const ref = (await inputsOf(next.briefing.id)).find((input) => input.source_item_id === fresh).ref_key as string;
  const value = outputValue({}, "new");
  value.overview = { text: "Overview", refs: [ref] };
  value.highlights[0] = { ...value.highlights[0]!, novelty: "new", title: "FRESH_HIGHLIGHT", what_changed: "FRESH_TEXT", refs: [ref], statements: [{ kind: "fact", text: "FRESH_FACT", refs: [ref] }] };
  await settleBriefingRun(db.pool, await finishRun((await runOf(next.briefing.id)).id, output(value)));
  return next.briefing.id;
}

async function conversationOnHost() {
  const room = (await db.pool.query(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [PROJECT])).rows[0].id as string;
  await seedRoomManager(db.pool, { space: SPACE, room, agent: AGENT });
  const conversation = (await new PgSessionRepository(db.pool).createRoomConversation({ space_id: SPACE, room_id: room, project_id: PROJECT, project_folder_id: null, title: "Follow-up", metadata: {} })).id as string;
  await new ConversationExecutionContextService(db.pool).initialize(owner, conversation, {
    selection: { execution_host_id: HOST, primary: { kind: "managed" } },
    runtime: { agent_id: AGENT, runtime_profile_id: PROFILE, runtime_key: "claude_code", runtime_installation: "own" },
  });
  return { room, conversation };
}

const attach = (room: string, conversation: string, briefing: string) =>
  rooms.attachConversationReferences(owner, room, conversation, { references: [{ kind: "briefing_highlight", id: briefing, highlight: 0 }] });

/** A second, enabled Profile of the same Agent on a trusted local model server: a local-provider destination. */
async function addLocalProfile() {
  await db.pool.query(
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Local','openai','http://127.0.0.1:11434/v1','llama3',true,'{}'::jsonb,$4::jsonb,now(),now())`,
    [LOCAL_PROVIDER, SPACE, OWNER, JSON.stringify({ deployment: "trusted_local", openai_compatible_base_url: "http://127.0.0.1:11434/v1" })],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,true,now(),now())`,
    [randomUUID(), LOCAL_PROVIDER, SPACE, OWNER],
  );
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (id,space_id,agent_id,execution_host_id,workspace_mode,runtime_installation,name,runtime_key,backend_mode,model_provider_id,model_name,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'managed','own','Local','opencode','model_provider',$5,'llama3','{}'::jsonb,'{}'::jsonb,true,false,now(),now())`,
    [LOCAL_PROFILE, SPACE, AGENT, HOST, LOCAL_PROVIDER],
  );
}

/** Where orchestration routes the Run: its Profile and the binding persisted on the Run. */
interface Route { profile: string; runtimeKey: string; providerId: string | null; backendMode: "runtime_native" | "model_provider"; hostDaemon: boolean }
/** The native CLI on the host: an external destination (the runtime owner's account). */
const NATIVE: Route = { profile: PROFILE, runtimeKey: "claude_code", providerId: null, backendMode: "runtime_native", hostDaemon: true };
/** Bound to the trusted local ModelProvider, which the Delivery itself calls: a local-provider destination. */
const LOCAL: Route = { profile: LOCAL_PROFILE, runtimeKey: "opencode", providerId: LOCAL_PROVIDER, backendMode: "model_provider", hostDaemon: false };

/**
 * Sends a message and takes its Run through the production chain up to the
 * point of Delivery: routed onto a Profile (as orchestration would), control
 * snapshot and Setup. `plan()` and `deliver()` then run the production
 * planner and gateway; a refusal is returned, not swallowed.
 */
async function sendAndPrepare(room: string, conversation: string, content: string, route: Route = NATIVE) {
  const sent = await rooms.sendMessage(owner, room, conversation, { content, backends: [{ agent_id: AGENT, runtime_profile_id: PROFILE }] });
  expect(sent.run_ids).toHaveLength(1);
  const runId = sent.run_ids[0]!;
  await db.pool.query(
    `UPDATE runs SET runtime_profile_id=$2,runtime_profile_selection_source='explicit',runtime_key=$3,model_provider_id=$4,runtime_profile_snapshot_json=$5::jsonb WHERE id=$1`,
    [runId, route.profile, route.runtimeKey, route.providerId, JSON.stringify({ backend_mode: route.backendMode, model_provider_id: route.providerId, model_name: route.providerId ? "llama3" : null })],
  );
  const routed = (await w.runs().getRun(SPACE, runId))!;
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home });
  const orchestration = buildRunOrchestration(config).orchestration as unknown as { executionControlSnapshotWriter: (run: unknown, inputs: unknown) => Promise<{ id: string; work_context_setup_ref: { id: string } }> };
  const bindings = await new ExecutionControlSnapshotRepository(db.pool).resolveEffectiveBindingsForRun(routed);
  await new WorkContextService(db.pool).ensureForInvocation(owner, bindings.workContextScopeId, { agentId: AGENT, runtimeProfileId: route.profile });
  const control = await orchestration.executionControlSnapshotWriter(routed, { dispatchesToHostDaemon: route.hostDaemon });
  const setup = (await db.pool.query(`SELECT * FROM work_context_setups WHERE id=$1`, [control.work_context_setup_ref.id])).rows[0];
  const turn = { work_context_scope_id: setup.work_context_scope_id, expected_setup_version: Number(setup.version), current_message_ref: { type: "message" as const, id: sent.message.id as string }, one_off_refs: [], invocation_purpose: "agent_task" as const };
  const settle = <T,>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  return {
    runId,
    plan: () => settle(createProductionRuntimeContextPlanningService(db.pool, config).planExecution({ identity: owner, invocationId: runId, deliveryId: randomUUID(), turn } as never)),
    deliver: (pool: Pool = db.pool) => settle(createProductionRuntimeContextInvocationGateway(pool)
      .prepareInvocation({ identity: owner, invocationId: runId, executionControlSnapshotId: control.id, runtimeKey: route.runtimeKey, providerId: route.providerId, usageSourceId: `run:${runId}:native`, turn })),
    accepted: () => count(`invocation_deliveries WHERE invocation_id='${runId}'`),
    prompt: async () => ((await db.pool.query(`SELECT prompt FROM runs WHERE id=$1`, [runId])).rows[0].prompt as string | null) ?? "",
  };
}

/** The whole chain in one go: plan, then deliver. */
async function sendAndDeliver(room: string, conversation: string, content: string, route: Route = NATIVE) {
  const turn = await sendAndPrepare(room, conversation, content, route);
  const plan = await turn.plan();
  const delivery = await turn.deliver();
  return { runId: turn.runId, plan, delivery, prompt: await turn.prompt(), accepted: await turn.accepted() };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** The Agent's turn landed in a vendor session that the next turn resumes, and its reply is in the conversation. */
async function landTurn(conversation: string, runId: string) {
  const run = await finishRun(runId, "Synthetic fixture reply");
  await db.pool.query(
    `INSERT INTO run_events (id, space_id, run_id, event_index, event_type, status, summary, metadata_json, created_at)
     VALUES ($1, $2, $3, 1000, 'chat_completed', 'succeeded', 'fixture', '{}'::jsonb, now())`,
    [randomUUID(), SPACE, runId],
  );
  await withDbTransaction(db.pool, (tx) => new PgHostThreadRepository(tx).settleRunOutcome(run.host_task_thread_id!, { lastRunId: run.id, vendorSessionId: "fixture-vendor-session", sessionReset: false, landed: true }));
  await new PgSessionRepository(db.pool).addRoomAgentMessageForRun({ space_id: SPACE, session_id: conversation, sender_agent_id: AGENT, run_id: run.id, content: "Synthetic fixture reply" });
}

describe("A briefing reference reaches the Agent's actual Delivery, gated on the execution it runs on", () => {
  it("delivers the attached highlight into a fresh session's first turn once, and a later one in the resumed session's increment once", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    await attach(room, conversation, briefing);

    const first = await sendAndDeliver(room, conversation, "Please explain this highlight");
    expect(first.plan.ok && first.delivery.ok).toBe(true);
    if (!first.delivery.ok || !first.plan.ok) return;
    // Fresh: the transcript is not replayed, so the recipient instruction does not carry it; the reference is its own item.
    expect(first.prompt).not.toContain("FRESH_FACT");
    const firstItems = first.plan.value.envelope.items.filter((item) => item.source_ref.type === "room_briefing_reference");
    expect(firstItems).toHaveLength(1);
    expect(firstItems[0]).toMatchObject({ semantic_role: "reference_data", trust: "external_untrusted" });
    const firstBlocks = JSON.stringify(first.delivery.value.message_blocks);
    expect(occurrences(firstBlocks, "FRESH_FACT")).toBe(1);
    expect(firstBlocks).toContain("instructions to follow");
    expect(first.accepted).toBe(1);

    // The Agent replied in a session the next turn resumes; a new attach after that reply.
    await landTurn(conversation, first.runId);
    await attach(room, conversation, briefing);
    const second = await sendAndDeliver(room, conversation, "And what about the second outlet?");
    expect(second.plan.ok && second.delivery.ok).toBe(true);
    if (!second.delivery.ok || !second.plan.ok) return;
    // Resumed: the Room increment in the recipient instruction carries it; no second copy as an item.
    expect(occurrences(second.prompt, "FRESH_FACT")).toBe(1);
    expect(second.plan.value.envelope.items.filter((item) => item.source_ref.type === "room_briefing_reference")).toEqual([]);
    expect(occurrences(JSON.stringify(second.delivery.value.message_blocks), "FRESH_FACT")).toBe(1);

    // A turn with nothing newly attached: the session already holds it; nothing is re-sent.
    await landTurn(conversation, second.runId);
    const third = await sendAndDeliver(room, conversation, "Thanks");
    expect(third.delivery.ok).toBe(true);
    if (third.delivery.ok) expect(JSON.stringify(third.delivery.value.message_blocks)).not.toContain("FRESH_FACT");
  });

  it.for(["fresh", "resumed"] as const)("refuses a %s turn whose Source no longer consents to the Run's runtime before any Delivery is accepted", async (mode, ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    if (mode === "resumed") {
      const warm = await sendAndDeliver(room, conversation, "Synthetic earlier turn");
      await landTurn(conversation, warm.runId);
    }
    await attach(room, conversation, briefing);
    await db.pool.query(`UPDATE source_connections SET consent_json=${DENY_ALL} WHERE id=$1`, [CONNECTION]);
    const turn = await sendAndDeliver(room, conversation, "Please explain this highlight");
    expect(turn.plan).toMatchObject({ ok: false, error: { statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) } });
    expect(turn.delivery).toMatchObject({ ok: false, error: { statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) } });
    expect(turn.accepted).toBe(0);
    // The person's own copy in the conversation is unchanged; only the model egress is refused.
    const copy = (await db.pool.query(`SELECT content FROM messages WHERE session_id=$1 AND metadata_json ? 'reference'`, [conversation])).rows;
    expect(copy).toHaveLength(1);
    expect(copy[0].content).toContain("FRESH_FACT");
  });

  it("checks the Profile the Run actually executes on: refuses an Agent with no enabled Profile at attach, and a switch to a Profile the Source refuses at Delivery", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    const before = await count(`messages WHERE session_id='${conversation}'`);
    // The Agent's only Profile disabled: its execution is unknown, so the attach fails closed.
    await db.pool.query(`UPDATE agent_runtime_profiles SET enabled=false, is_default=false WHERE id=$1`, [PROFILE]);
    await db.pool.query(`UPDATE source_connections SET consent_json=${DENY_ALL} WHERE id=$1`, [CONNECTION]);
    await expect(attach(room, conversation, briefing)).rejects.toMatchObject({ statusCode: 409, responseBody: expect.objectContaining({ code: "briefing_reference_execution_unresolved" }) });
    expect(await count(`messages WHERE session_id='${conversation}'`)).toBe(before);

    // A local Profile the Source consents to: the attach is legitimate for it.
    await addLocalProfile();
    await db.pool.query(`UPDATE source_connections SET consent_json=${LOCAL_ONLY} WHERE id=$1`, [CONNECTION]);
    await attach(room, conversation, briefing);
    // Then the native Profile is enabled again and the Run executes on it: refused at planning and at Delivery.
    await db.pool.query(`UPDATE agent_runtime_profiles SET enabled=true, is_default=true WHERE id=$1`, [PROFILE]);
    const switched = await sendAndDeliver(room, conversation, "Please explain this highlight");
    const withheld = { ok: false, error: { statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) } };
    expect(switched.plan).toMatchObject(withheld);
    expect(switched.delivery).toMatchObject(withheld);
    expect(switched.accepted).toBe(0);

    // Control: the same turn once the Source consents to that runtime too is delivered.
    // (The refused Run fails, as orchestration fails a Run whose Delivery cannot be prepared.)
    const refused = await finishRun(switched.runId, "Delivery refused", "failed");
    await withDbTransaction(db.pool, (tx) => new PgHostThreadRepository(tx).settleRunOutcome(refused.host_task_thread_id!, { lastRunId: refused.id, vendorSessionId: null, sessionReset: false, landed: false }));
    await db.pool.query(`UPDATE source_connections SET consent_json=${ALLOW_ALL} WHERE id=$1`, [CONNECTION]);
    const allowed = await sendAndDeliver(room, conversation, "Please explain this highlight");
    expect(allowed.delivery.ok).toBe(true);
    if (allowed.delivery.ok) expect(JSON.stringify(allowed.delivery.value.message_blocks)).toContain("FRESH_FACT");
  });

  it("attaches into a Room with no Agent as a draft only people read", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const room = (await db.pool.query(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [PROJECT])).rows[0].id as string;
    const conversation = (await new PgSessionRepository(db.pool).createRoomConversation({ space_id: SPACE, room_id: room, project_id: PROJECT, project_folder_id: null, title: "Draft", metadata: {} })).id as string;
    await db.pool.query(`UPDATE source_connections SET consent_json=${DENY_ALL} WHERE id=$1`, [CONNECTION]);
    await attach(room, conversation, briefing);
    expect((await db.pool.query(`SELECT metadata_json FROM messages WHERE session_id=$1`, [conversation])).rows[0].metadata_json.reference).toMatchObject({ kind: "briefing_highlight", source_id: briefing, highlight: 0 });
  });
});

describe("The reference's egress follows the Delivery's fixed destination, not the live Profile", () => {
  it("delivers to a Run legitimately bound to a trusted local provider, and refuses an external Run whose Profile row was edited to look local", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    await addLocalProfile();
    await attach(room, conversation, briefing);
    await db.pool.query(`UPDATE source_connections SET consent_json=${LOCAL_ONLY} WHERE id=$1`, [CONNECTION]);

    // A Run routed onto the local Profile: its persisted binding is the local provider, which the Source allows.
    const local = await sendAndDeliver(room, conversation, "Explain this highlight", LOCAL);
    expect(local.plan.ok).toBe(true);
    expect(local.delivery.ok).toBe(true);
    if (local.delivery.ok) expect(JSON.stringify(local.delivery.value.message_blocks)).toContain("FRESH_FACT");
    expect(local.accepted).toBe(1);
    const done = await finishRun(local.runId, "Synthetic fixture reply", "failed");
    await withDbTransaction(db.pool, (tx) => new PgHostThreadRepository(tx).settleRunOutcome(done.host_task_thread_id!, { lastRunId: done.id, vendorSessionId: null, sessionReset: false, landed: false }));

    // A Run routed onto the native external CLI; then the same Profile row is edited to a local provider.
    const external = await sendAndPrepare(room, conversation, "Explain this highlight", NATIVE);
    await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key='opencode', backend_mode='model_provider', model_provider_id=$2, model_name='llama3' WHERE id=$1`, [PROFILE, LOCAL_PROVIDER]);
    const withheld = { ok: false, error: { statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) } };
    expect(await external.plan()).toMatchObject(withheld);
    expect(await external.deliver()).toMatchObject(withheld);
    expect(await external.accepted()).toBe(0);
  });
});

/**
 * A pool whose transaction connection pauses just before it sends the first
 * query matching `pause` (its earlier statements done, their locks held),
 * until released. Only the timing changes: every query is the real one,
 * against the real database.
 */
function pausingAt(pause: (sql: string) => boolean) {
  let reached!: (pid: number) => void;
  let release!: () => void;
  const atPause = new Promise<number>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  const pool = new Proxy(db.pool, {
    get(target, key) {
      if (key === "connect") {
        return async () => {
          const client = await target.connect();
          const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          return new Proxy(client, {
            get(real, name) {
              if (name === "query") {
                return async (...args: unknown[]) => {
                  if (!paused && typeof args[0] === "string" && pause(args[0])) {
                    paused = true;
                    reached(pid);
                    await released;
                  }
                  return (real.query as (...a: unknown[]) => unknown)(...args);
                };
              }
              const value = Reflect.get(real, name);
              return typeof value === "function" ? value.bind(real) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { pool: pool as Pool, atPause, release };
}

/** Pauses a Delivery once every authorization is done and its locks are held, before it persists. */
function pausingBeforeDeliveryInsert() {
  const hook = pausingAt((sql) => sql.includes("INSERT INTO invocation_deliveries"));
  return { pool: hook.pool, atInsert: hook.atPause, release: hook.release };
}

/** Pauses a writer's own transaction just before it commits, its writes and locks held. */
const pausingBeforeCommit = () => pausingAt((sql) => /^\s*COMMIT\b/i.test(sql));

/** The backend PostgreSQL reports as waiting on `blocker`, once it does: a lock wait, not a timer. */
async function waitingOn(blocker: number): Promise<number> {
  for (;;) {
    const pid = (await db.pool.query(`SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, [blocker])).rows[0]?.pid;
    if (pid !== undefined) return Number(pid);
  }
}

/** Waits until the backend `pid` is blocked by `blocker`, by asking PostgreSQL: a lock wait, not a timer. */
async function blockedBy(pid: number, blocker: number) {
  for (;;) {
    const row = (await db.pool.query(`SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked, state FROM pg_stat_activity WHERE pid = $1::int`, [pid, blocker])).rows[0];
    if (!row || row.state === "idle") return false;
    if (row.blocked) return true;
  }
}

describe("A Source revocation and a Delivery carrying its text are linearized", () => {
  it("makes a revocation wait for a Delivery that already holds its locks, and commits it only after", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    await attach(room, conversation, briefing);
    const turn = await sendAndPrepare(room, conversation, "Explain this highlight");
    const order: string[] = [];
    const hook = pausingBeforeDeliveryInsert();
    const delivering = turn.deliver(hook.pool as Pool);
    const deliveryPid = await hook.atInsert;
    const revoker = await db.pool.connect();
    try {
      const revokerPid = Number((await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const revoking = revoker.query(`UPDATE source_connections SET consent_json=${DENY_ALL} WHERE id=$1`, [CONNECTION])
        .then(async () => { order.push(`revocation committed, ${await turn.accepted()} Delivery already committed`); });
      expect(await blockedBy(revokerPid, deliveryPid)).toBe(true);
      hook.release();
      const delivered = await delivering;
      await revoking;
      // Read from the database when the writer returned: the Delivery had already committed.
      expect(order).toEqual(["revocation committed, 1 Delivery already committed"]);
      expect(delivered.ok).toBe(true);
      expect(await turn.accepted()).toBe(1);
    } finally {
      hook.release();
      revoker.release();
    }
    // After the revocation, the next Delivery of the same text is refused.
    expect(await turn.deliver()).toMatchObject({ ok: false, error: { statusCode: 403 } });
    expect(await turn.accepted()).toBe(1);
  });

  it("refuses a Delivery once a revocation that took the Source first has committed, with nothing accepted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    await attach(room, conversation, briefing);
    const turn = await sendAndPrepare(room, conversation, "Explain this highlight");
    expect((await turn.plan()).ok).toBe(true);
    const revoker = await db.pool.connect();
    try {
      const revokerPid = Number((await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await revoker.query("BEGIN");
      await revoker.query(`UPDATE source_connections SET consent_json=${DENY_ALL} WHERE id=$1`, [CONNECTION]);
      const delivering = turn.deliver();
      // The Delivery's transaction waits on the revocation's row lock.
      let waiting: number | undefined;
      while (waiting === undefined) {
        waiting = (await db.pool.query(`SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, [revokerPid])).rows[0]?.pid;
      }
      await revoker.query("COMMIT");
      expect(await delivering).toMatchObject({ ok: false, error: { statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) } });
      expect(await turn.accepted()).toBe(0);
    } finally {
      revoker.release();
    }
  });
});

/** A personal Following topic with no binding and nothing running: the personal briefing's only context. */
async function personalFocus() {
  const goal = randomUUID();
  await db.pool.query(
    `INSERT INTO source_goals (id, space_id, owner_user_id, agent_id, runtime_profile_id, intent_json, budget_json)
     VALUES ($1, $2, $3, $4, $5, '{"intent":"PRIVATE_FOCUS_CONTEXT"}', '{}')`,
    [goal, SPACE, OWNER, AGENT, PROFILE],
  );
  return goal;
}

/** A personal briefing whose highlight cites that topic, attached to a conversation only its owner reads. */
async function personalReference() {
  // The mainline Room then has the owner alone as audience, as a personal reference requires.
  await db.pool.query(`DELETE FROM project_members WHERE project_id = $1`, [PROJECT]);
  const goal = await personalFocus();
  const briefing = await publishedHighlight(true);
  const { room, conversation } = await conversationOnHost();
  await attach(room, conversation, briefing);
  return { goal, turn: await sendAndPrepare(room, conversation, "Explain this highlight") };
}

const stopGoal = (pool: Pool, goal: string) =>
  new SourceGoalService(pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home }), { execute: async () => { throw new Error("no executor in this test"); } } as never)
    .stop(owner, goal, true);
const joinProject = (pool: Pool) => new PgProjectRepository(pool).addMember(owner, PROJECT, { user_id: NEWCOMER, role: "viewer" });
const withheldNow = { ok: false, error: { statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) } };

describe("A Delivery's whole context and audience are linearized with their canonical writers", () => {
  it("a personal Following topic deleted first: the Delivery waits for it, then is refused with nothing accepted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { goal, turn } = await personalReference();
    expect((await turn.plan()).ok).toBe(true);
    const writer = pausingBeforeCommit();
    const stopping = stopGoal(writer.pool, goal);
    const writerPid = await writer.atPause;
    const delivering = turn.deliver();
    await waitingOn(writerPid);
    writer.release();
    await stopping;
    expect(await delivering).toMatchObject(withheldNow);
    expect(await turn.accepted()).toBe(0);
  });

  it("a Delivery that holds the topic first: the canonical deletion waits for its commit, and the next Delivery is refused", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { goal, turn } = await personalReference();
    const order: string[] = [];
    const hook = pausingBeforeDeliveryInsert();
    const delivering = turn.deliver(hook.pool);
    const deliveryPid = await hook.atInsert;
    const stopping = stopGoal(db.pool, goal).then(async () => { order.push(`goal deleted, ${await turn.accepted()} Delivery already committed`); });
    await waitingOn(deliveryPid);
    hook.release();
    const delivered = await delivering;
    await stopping;
    expect(order).toEqual(["goal deleted, 1 Delivery already committed"]);
    expect(delivered.ok).toBe(true);
    if (delivered.ok) expect(JSON.stringify(delivered.value.message_blocks)).toContain("PRIVATE_FOCUS_CONTEXT");
    expect(await turn.accepted()).toBe(1);
    expect(await turn.deliver()).toMatchObject(withheldNow);
    expect(await turn.accepted()).toBe(1);
  });

  it("a Project reader the Source does not admit added first: the Delivery waits for the membership, then is refused with nothing accepted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    await attach(room, conversation, briefing);
    const turn = await sendAndPrepare(room, conversation, "Explain this highlight");
    expect((await turn.plan()).ok).toBe(true);
    const writer = pausingBeforeCommit();
    const joining = joinProject(writer.pool);
    const writerPid = await writer.atPause;
    const delivering = turn.deliver();
    await waitingOn(writerPid);
    writer.release();
    await joining;
    expect(await delivering).toMatchObject(withheldNow);
    expect(await turn.accepted()).toBe(0);
  });

  it("a Delivery that holds the Project audience first: the canonical addMember waits for its commit, and the next Delivery is refused", async (ctx) => {
    if (!db.available) return ctx.skip();
    const briefing = await publishedHighlight();
    const { room, conversation } = await conversationOnHost();
    await attach(room, conversation, briefing);
    const turn = await sendAndPrepare(room, conversation, "Explain this highlight");
    const order: string[] = [];
    const hook = pausingBeforeDeliveryInsert();
    const delivering = turn.deliver(hook.pool);
    const deliveryPid = await hook.atInsert;
    const joining = joinProject(db.pool).then(async () => { order.push(`member added, ${await turn.accepted()} Delivery already committed`); });
    await waitingOn(deliveryPid);
    hook.release();
    const delivered = await delivering;
    await joining;
    expect(order).toEqual(["member added, 1 Delivery already committed"]);
    expect(delivered.ok).toBe(true);
    expect(await turn.accepted()).toBe(1);
    expect(await turn.deliver()).toMatchObject(withheldNow);
    expect(await turn.accepted()).toBe(1);
  });
});
