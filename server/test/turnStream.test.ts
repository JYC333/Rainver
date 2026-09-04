import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun } from "./support/domainSeeds.js";
import { streamingModule } from "../src/modules/streaming/index.js";
import { runsModule } from "../src/modules/runs/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { publishChatTextDelta } from "../src/modules/streaming/conversationDeltaBus.js";
import type { RunTurn, TurnStreamFrame } from "@rainver/protocol";

const db = useTestDatabase(import.meta.filename, { max: 8 });

/**
 * Let the stream's poll run, at the interval this suite configures.
 *
 * Kept deliberately small and few: a test that needs several poll ticks to
 * line up is a test that races the suite's own load. The frame-ordering rules
 * are asserted in `turnStreamFrames.test.ts`, which drives the same emission
 * logic without a socket.
 */
function tick(times = 1): Promise<void> {
  return new Promise((done) => { setTimeout(done, 60 * times); });
}

const SPACE = "space-1";
const USER = "user-1";
let app: FastifyInstance | undefined;

beforeEach(async () => {
  if (!db.available || !db.pool) return;
  await resetTables(
    db.pool,
    ["run_events", "host_thread_events", "host_threads", "runs", "agent_versions", "agents",
     "messages", "sessions", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'M','personal',now(),now())`, [SPACE]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'u','active',now(),now()), ('user-2','u2','active',now(),now())`, [USER]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::text,$1,$2,'owner','active',now(),now()),
            (gen_random_uuid()::text,$1,'user-2','member','active',now(),now())`,
    [SPACE, USER]);
  __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
  app = await buildModuleServer(
    // The stream polls; the floor the config allows keeps this test driven by
    // the poll rather than by waiting on the wall clock.
    loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS: "100",
    }),
    [runsModule, streamingModule],
  );
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

async function seedManagedRun(runId: string): Promise<void> {
  await seedRun(db.pool!, { id: runId, space: SPACE, owner: USER, agent: `agent-${runId}`, version: `version-${runId}` });
}

async function appendRunEvent(runId: string, index: number, type: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.pool!.query(
    `INSERT INTO run_events (id, space_id, run_id, event_index, event_type, status, summary, metadata_json, created_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
    [SPACE, runId, index, type, (extra.status as string) ?? "succeeded",
      (extra.summary as string) ?? null, JSON.stringify(extra.metadata ?? {})],
  );
}

describe("run turn", () => {
  it("serves a managed Run's turn as parts, with the reply as its prose", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-1");
    await appendRunEvent("run-1", 0, "tool_call_started", { status: "running", metadata: { call_id: "c1", tool_name: "search" } });
    await appendRunEvent("run-1", 1, "tool_call_completed", { metadata: { call_id: "c1", tool_name: "search" } });
    await db.pool!.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ('sess',$1,$2,'active',now(),now())`, [SPACE, USER]);
    await db.pool!.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,run_id,path_depth,branch_path,created_at)
       VALUES ('m1',$1,'sess',$2,'assistant','Found three.','run-1',0,'/',now())`, [SPACE, USER]);
    await db.pool!.query("UPDATE sessions SET head_message_id='m1' WHERE id='sess'");
    await db.pool!.query("UPDATE runs SET status='succeeded' WHERE id='run-1'");

    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/turn" });
    expect(response.statusCode).toBe(200);
    const turn = response.json() as RunTurn;
    expect(turn.state).toBe("done");
    expect(turn.source).toBe("run_events");
    expect(turn.parts.map((part) => part.type)).toEqual(["tool_call", "text"]);
    // The managed backend reports no tool input or output; the part says so
    // rather than inventing them.
    expect(turn.parts[0]).toMatchObject({ name: "search", status: "succeeded", input: null, output: null });
    expect(turn.parts[1]).toMatchObject({ type: "text", text: "Found three." });
  });

  it("refuses a Run the viewer cannot see", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-2");
    // Owned by user-1 and private, so user-2 — a Space member — still cannot
    // read it. The turn route must not be a way around that.
    await db.pool!.query("UPDATE runs SET visibility='private' WHERE id='run-2'");
    __setAuthIdentityForTests({ spaceId: SPACE, userId: "user-2" });
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-2/turn" });
    expect(response.statusCode).toBe(404);
  });

  it("streams a snapshot, then a frame per change, and stops when the turn ends", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-4");
    await appendRunEvent("run-4", 0, "tool_call_started", { status: "running", metadata: { call_id: "c", tool_name: "grep" } });
    await db.pool!.query("UPDATE runs SET status='running' WHERE id='run-4'");
    await db.pool!.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ('sess4',$1,$2,'active',now(),now())`, [SPACE, USER]);

    const streaming = app.inject({ method: "GET", url: "/api/v1/runs/run-4/turn/stream" });
    await tick();

    // Prose arrives on the delta bus while the projection is still growing —
    // a second tool call lands after it. The streamed text must move aside
    // rather than fight the appended part for one index.
    publishChatTextDelta("run-4", "Found it.");
    await appendRunEvent("run-4", 1, "tool_call_started", { status: "running", metadata: { call_id: "d", tool_name: "read" } });
    await tick(3);
    await appendRunEvent("run-4", 2, "tool_call_completed", { metadata: { call_id: "c", tool_name: "grep" } });

    // The reply, then the terminal event that follows it.
    await db.pool!.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,run_id,path_depth,branch_path,created_at)
       VALUES ('m4',$1,'sess4',$2,'assistant','Found it.','run-4',0,'/',now())`, [SPACE, USER]);
    await db.pool!.query("UPDATE sessions SET head_message_id='m4' WHERE id='sess4'");
    await appendRunEvent("run-4", 3, "chat_completed", { status: "succeeded" });
    await db.pool!.query("UPDATE runs SET status='succeeded' WHERE id='run-4'");

    const body = (await streaming).body;
    const frames = body
      .split(/\n\n/)
      .filter((frame) => frame.includes("data:"))
      .map((frame) => JSON.parse(frame.split("data:")[1]!.trim()) as TurnStreamFrame);

    expect(frames.some((frame) => frame.type === "turn.snapshot")).toBe(true);

    // Replay the frames the way the client does. No part may ever be
    // overwritten by one of a different type: that is the index collision.
    const parts: Record<number, string> = {};
    for (const frame of frames) {
      if (frame.type === "turn.snapshot") {
        frame.turn.parts.forEach((part) => { parts[part.index] = part.type; });
      } else if (frame.type === "turn.part_appended" || frame.type === "turn.part_updated") {
        // The live text is kept out of the projection's index space on
        // purpose; everything else must stay put.
        if (frame.part.type === "text" && frame.part.streamed) continue;
        const held = parts[frame.part.index];
        expect(held === undefined || held === frame.part.type).toBe(true);
        parts[frame.part.index] = frame.part.type;
      }
    }

    // The tool that finished did so on the part it started as.
    expect(frames.some((frame) =>
      frame.type === "turn.part_updated" && frame.part.type === "tool_call"
      && frame.part.status === "succeeded")).toBe(true);
    // The managed Run's prose reached the client even though no log holds it.
    expect(frames.some((frame) =>
      (frame.type === "turn.part_updated" || frame.type === "turn.part_appended")
      && frame.part.type === "text" && frame.part.text === "Found it.")).toBe(true);
    expect(frames.some((frame) => frame.type === "turn.state_changed" && frame.state === "done")).toBe(true);
  }, 30000);

  it("stays working until the reply is written, then reports done", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-5");
    // The adapter has returned and the Run is terminal, but finalization has
    // not written the message yet. A client told `done` here would fetch a
    // reply that does not exist.
    await appendRunEvent("run-5", 0, "state_transition", { metadata: { state: "succeeded" } });
    await db.pool!.query("UPDATE runs SET status='succeeded' WHERE id='run-5'");
    await db.pool!.query(
      `UPDATE runs SET model_override_json = jsonb_build_object('chat_turn', jsonb_build_object('schema_version','chat_turn.v1'))
        WHERE id='run-5'`);

    const midway = (await app.inject({ method: "GET", url: "/api/v1/runs/run-5/turn" })).json() as RunTurn;
    expect(midway.state).toBe("working");

    await appendRunEvent("run-5", 1, "chat_completed", { status: "succeeded" });
    const finished = (await app.inject({ method: "GET", url: "/api/v1/runs/run-5/turn" })).json() as RunTurn;
    expect(finished.state).toBe("done");
  });

  it("keeps a host chat turn working until its reply is written, too", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-7");
    await db.pool!.query(
      // The `direct` shape: an Agent chat on a paired host, which is exactly
      // the surface this terminal ordering affects.
      `INSERT INTO host_threads (id, workspace_mode, adapter_type, runtime_installation,
                                 agent_id, container_kind, container_user_id,
                                 retired_vendor_session_ids, status, created_by_user_id, created_at, updated_at)
       VALUES ('thread-7', 'managed', 'claude_code', 'own', $1, 'direct', $2,
               '[]'::jsonb, 'active', $2, now(), now())`,
      ["agent-run-7", USER]);
    await db.pool!.query(
      `UPDATE runs SET status='succeeded', host_task_thread_id='thread-7',
              model_override_json = jsonb_build_object('chat_turn', jsonb_build_object('schema_version','chat_turn.v1'))
        WHERE id='run-7'`);
    // The host writes this from inside the adapter, before it returns — the
    // same "too early" as the managed side's `state_transition`.
    await db.pool!.query(
      `INSERT INTO host_thread_events (id, host_task_thread_id, run_id, event_index, event_type, status, created_at)
       VALUES (gen_random_uuid()::text, 'thread-7', 'run-7', 0, 'status', 'run_succeeded', now())`);

    const midway = (await app.inject({ method: "GET", url: "/api/v1/runs/run-7/turn" })).json() as RunTurn;
    expect(midway.source).toBe("host_thread_events");
    expect(midway.state).toBe("working");

    // `chat_completed` goes to `run_events` whichever host ran the turn, so
    // the host projection cannot see its own terminal — the read model reads
    // it separately.
    await appendRunEvent("run-7", 0, "chat_completed", { status: "succeeded" });
    const finished = (await app.inject({ method: "GET", url: "/api/v1/runs/run-7/turn" })).json() as RunTurn;
    expect(finished.state).toBe("done");
  });

  it("reports a paused turn as blocked, and says which kind of waiting it is", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    // Three paths pause a Run. An authorization request sets an id; a
    // supervisor hold sets a flag; a policy that requires approval on a run
    // action sets neither — and that third one is an approval, so the flag is
    // what tells them apart, not the presence of the id.
    for (const [runId, errorJson, expected] of [
      ["run-auth", { authorization_request_id: "authorization-1" }, "authorization"],
      ["run-supervisor", { supervisor_review: true }, "run_decision"],
      ["run-policy", { error_code: "policy_requires_approval" }, "authorization"],
    ] as const) {
      await seedManagedRun(runId);
      await db.pool!.query(
        "UPDATE runs SET status='waiting_for_review', error_json=$2::jsonb WHERE id=$1",
        [runId, JSON.stringify(errorJson)]);
      const turn = (await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/turn` })).json() as RunTurn;
      expect(turn.state).toBe("blocked");
      expect(turn.blocked_on).toBe(expected);
    }
  });

  it("fails a turn whose Run was reaped without writing any event, and says why", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-6");
    // The stale-run reaper marks `orphaned` in one statement that appends no
    // run event at all. A stream that waited for the log would poll forever,
    // and a turn with no diagnostic would leave the person with nothing but
    // a generic failure.
    await db.pool!.query("UPDATE runs SET status='orphaned' WHERE id='run-6'");
    const turn = (await app.inject({ method: "GET", url: "/api/v1/runs/run-6/turn" })).json() as RunTurn;
    expect(turn.state).toBe("failed");
    expect(turn.parts).toContainEqual(expect.objectContaining({
      type: "diagnostic", level: "error", text: expect.stringContaining("abandoned"),
    }));
  });

  it("carries the real reason a turn failed, not a generic message", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-8");
    // A preparation failure — no credential, denied by policy — never reaches
    // the runtime, so there is no runtime `error` event to describe it. The
    // reason lives on the terminal event and on the Run row, and the turn has
    // to carry it or the person is told only that "something" went wrong.
    await appendRunEvent("run-8", 0, "adapter_completed", {
      status: "failed", summary: "Adapter did not run.",
    });
    await db.pool!.query(
      `UPDATE run_events SET error_code='cli_credential_unavailable',
              error_message='No credential profile is available for this runtime.'
        WHERE run_id='run-8' AND event_type='adapter_completed'`);
    await db.pool!.query("UPDATE runs SET status='failed' WHERE id='run-8'");

    const turn = (await app.inject({ method: "GET", url: "/api/v1/runs/run-8/turn" })).json() as RunTurn;
    expect(turn.state).toBe("failed");
    expect(turn.parts).toContainEqual(expect.objectContaining({
      type: "diagnostic",
      level: "error",
      text: "No credential profile is available for this runtime.",
      error_code: "cli_credential_unavailable",
    }));
  });

  it("retracts the live prose once the persisted reply is in the projection", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await seedManagedRun("run-9");
    await db.pool!.query("UPDATE runs SET status='running' WHERE id='run-9'");
    await db.pool!.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ('sess9',$1,$2,'active',now(),now())`, [SPACE, USER]);

    const streaming = app.inject({ method: "GET", url: "/api/v1/runs/run-9/turn/stream" });
    await tick();
    publishChatTextDelta("run-9", "The answer.");
    await tick(2);
    await db.pool!.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,run_id,path_depth,branch_path,created_at)
       VALUES ('m9',$1,'sess9',$2,'assistant','The answer.','run-9',0,'/',now())`, [SPACE, USER]);
    await db.pool!.query("UPDATE sessions SET head_message_id='m9' WHERE id='sess9'");
    await appendRunEvent("run-9", 0, "chat_completed", { status: "succeeded" });
    await db.pool!.query("UPDATE runs SET status='succeeded' WHERE id='run-9'");

    const frames = (await streaming).body
      .split(/\n\n/)
      .filter((frame) => frame.includes("data:"))
      .map((frame) => JSON.parse(frame.split("data:")[1]!.trim()) as TurnStreamFrame);

    // The live copy is retracted with an empty text once its persisted twin
    // arrives, so a client that keeps it beside the list stops showing both.
    expect(frames.some((frame) =>
      frame.type === "turn.part_updated" && frame.part.type === "text"
      && frame.part.streamed === true && frame.part.text === "")).toBe(true);
  }, 30000);
});
