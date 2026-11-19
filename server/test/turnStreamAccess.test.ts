import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRun, seedSpaceMember } from "./support/domainSeeds.js";
import { streamingModule } from "../src/modules/streaming/index.js";
import { authModule } from "../src/modules/auth/index.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { __setAuthIdentityForTests, sessionCookieName } from "../src/modules/auth/identity.js";
import { MAX_BUFFERED_CHARACTERS, chatTextDeltaSubscriberCount, publishChatTextDelta } from "../src/modules/streaming/conversationDeltaBus.js";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/**
 * A Run turn stream outlives the request that authorized it. These drive the
 * real HTTP stream with real session cookies against real PostgreSQL and
 * change access the way production does (logout, session revocation, account
 * disable, Space/Project removal, private/summary downgrade), asserting that
 * nothing produced after the change — streamed text, parts, keepalives —
 * reaches the old viewer, and that the stream ends instead of polling forever.
 */
const db = useTestDatabase(import.meta.filename, { max: 8 });

const SPACE = "space-turn-access";
const PROJECT = "project-turn-access";
const OWNER = "owner-turn-access";
const VIEWER = "viewer-turn-access";
const SECRET = "betterauth-secret-for-turn-stream-access";
let app: FastifyInstance | undefined;
let baseUrl = "";
let config: ServerConfig;

beforeEach(async () => {
  if (!db.available || !db.pool) return;
  await resetTables(db.pool,
    ["messages", "sessions", "run_events", "runs", "agent_versions", "agents", "project_members", "projects", "user_sessions",
     "space_memberships", "users", "spaces"], { cascade: true });
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Team','team',now(),now())`, [SPACE]);
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER, role: "owner" });
  await seedSpaceMember(db.pool, { space: SPACE, user: VIEWER, role: "member" });
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'P','active',now(),now())`, [PROJECT, SPACE, OWNER]);
  await db.pool.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES (gen_random_uuid()::text,$1,$2,$3,'member','active',now(),now())`, [SPACE, PROJECT, VIEWER]);
  // Poll at 1s so live text flushes on its own 250ms cadence between polls.
  config = { ...loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_RUN_EVENT_STREAM_POLL_INTERVAL_MS: "1000" }), betterAuthSecret: SECRET };
  app = await buildModuleServer(config, [streamingModule, authModule]);
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
});

// A failed assertion must not leave a stream holding the server open.
const opened: Array<() => void> = [];

afterEach(async () => {
  __setAuthIdentityForTests(null);
  for (const abort of opened.splice(0)) abort();
  await app?.close();
  app = undefined;
});

async function seedViewerSession(user = VIEWER): Promise<{ cookie: string; sessionId: string }> {
  const raw = randomUUID(), sessionId = randomUUID();
  await db.pool!.query(
    `INSERT INTO user_sessions (id,user_id,token_hash,created_at,expires_at,updated_at) VALUES ($1,$2,$3,now(),now()+interval '1 day',now())`,
    [sessionId, user, createHash("sha256").update(raw).digest("hex")]);
  const value = encodeURIComponent(`${raw}.${createHmac("sha256", SECRET).update(raw).digest("base64")}`);
  return { cookie: `${sessionCookieName(config)}=${value}`, sessionId };
}

async function seedRunningRun(runId: string, status = "running"): Promise<void> {
  await seedRun(db.pool!, { id: runId, space: SPACE, owner: OWNER, agent: `agent-${runId}`, version: `version-${runId}` });
  await db.pool!.query("UPDATE runs SET status=$2, project_id=$3 WHERE id=$1", [runId, status, PROJECT]);
}

type Frame = { event?: string; data?: unknown; comment?: string };

/** The real SSE transport, read incrementally so a test can act mid-stream. */
function openStream(runId: string, cookie?: string) {
  const controller = new AbortController();
  opened.push(() => controller.abort());
  const frames: Frame[] = [];
  let raw = "";
  let ended = false;
  const done = (async () => {
    const response = await fetch(`${baseUrl}/api/v1/runs/${runId}/turn/stream`, {
      headers: cookie ? { cookie, "x-rainver-space-id": SPACE } : { "x-rainver-space-id": SPACE },
      signal: controller.signal,
    });
    if (!response.ok) { ended = true; return response.status; }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        raw += decoder.decode(chunk.value, { stream: true });
        const blocks = raw.split("\n\n");
        raw = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.startsWith(":")) { frames.push({ comment: block.slice(1).trim() }); continue; }
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          frames.push({ event, data: data ? JSON.parse(data) : undefined });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    ended = true;
    return 200;
  })();
  return {
    frames, done, abort: () => controller.abort(), get ended() { return ended; },
    text: () => JSON.stringify(frames),
    async until(predicate: () => boolean, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`stream condition not reached: ${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

const liveTexts = (frames: Frame[]) => frames
  .filter((frame) => frame.event === "turn.part_updated")
  .map((frame) => (frame.data as { part: { text?: string; streamed?: boolean } }).part)
  .filter((part) => part.streamed)
  .map((part) => part.text);

const errorOf = (frames: Frame[]) => frames.find((frame) => frame.event === "server.error")?.data as { status?: number; error?: string } | undefined;

/** Publishes `before`, waits for it to reach the viewer (a check just passed), then revokes and publishes `after`. */
async function revokeMidStream(stream: ReturnType<typeof openStream>, runId: string, revoke: () => Promise<unknown>) {
  publishChatTextDelta(runId, "visible ");
  await stream.until(() => liveTexts(stream.frames).some((text) => text?.includes("visible")));
  // Buffered before the revocation and not yet flushed: it must never leave.
  publishChatTextDelta(runId, "BUFFERED-SECRET ");
  await revoke();
  publishChatTextDelta(runId, "AFTER-SECRET");
  await db.pool!.query(
    `INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,summary,metadata_json,created_at)
     VALUES (gen_random_uuid()::text,$1,$2,0,'tool_call_started','running',NULL,$3::jsonb,now())`,
    [SPACE, runId, JSON.stringify({ call_id: "c-secret", tool_name: "PART-SECRET" })]);
  await stream.until(() => stream.ended);
  expect(stream.text()).not.toContain("SECRET");
  // The error is the last frame: no keepalive or part rides after it.
  expect(stream.frames.at(-1)?.event).toBe("server.error");
  return errorOf(stream.frames);
}

describe("run turn stream access is re-checked while the stream is open", () => {
  it("keeps streaming a valid viewer through blocked and back to done, coalescing text", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-valid");
    const stream = openStream("run-valid", cookie);
    await stream.until(() => stream.frames.some((frame) => frame.event === "turn.snapshot"));
    for (let index = 0; index < 200; index += 1) publishChatTextDelta("run-valid", "x");
    await stream.until(() => liveTexts(stream.frames).at(-1) === "x".repeat(200));
    // 200 deltas, a handful of writes: each write follows one access check.
    expect(liveTexts(stream.frames).length).toBeLessThanOrEqual(4);
    await db.pool!.query(`UPDATE runs SET status='waiting_for_review', error_json='{"authorization_request_id":"a-1"}'::jsonb WHERE id='run-valid'`);
    await stream.until(() => stream.frames.some((frame) => (frame.data as { state?: string })?.state === "blocked"));
    // Blocked stays open and keeps its heartbeat while the viewer may read.
    const keepalives = stream.frames.filter((frame) => frame.comment === "keepalive").length;
    await stream.until(() => stream.frames.filter((frame) => frame.comment === "keepalive").length > keepalives);
    expect(stream.ended).toBe(false);
    await db.pool!.query("UPDATE runs SET status='running', error_json=NULL WHERE id='run-valid'");
    await stream.until(() => (stream.frames.at(-1)?.data as { state?: string })?.state === "working");
    await db.pool!.query("UPDATE runs SET status='failed' WHERE id='run-valid'");
    await stream.until(() => stream.ended);
    expect(errorOf(stream.frames)).toBeUndefined();
    expect((stream.frames.at(-1)?.data as { state?: string }).state).toBe("failed");
  });

  it("ends with 401 and leaks nothing after logout", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-logout");
    const stream = openStream("run-logout", cookie);
    const error = await revokeMidStream(stream, "run-logout", async () => {
      const response = await app!.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, origin: config.frontendUrl } });
      expect(response.statusCode).toBeLessThan(300);
    });
    expect(error).toMatchObject({ status: 401, error: "authentication_required" });
  });

  it("ends with 401 when the session is revoked or the account disabled", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    for (const [runId, revoke] of [
      ["run-revoked", (sessionId: string) => db.pool!.query("DELETE FROM user_sessions WHERE id=$1", [sessionId])],
      ["run-disabled", () => db.pool!.query("UPDATE users SET status='disabled' WHERE id=$1", [VIEWER])],
    ] as const) {
      await db.pool!.query("UPDATE users SET status='active' WHERE id=$1", [VIEWER]);
      const { cookie, sessionId } = await seedViewerSession();
      await seedRunningRun(runId);
      const stream = openStream(runId, cookie);
      expect(await revokeMidStream(stream, runId, () => revoke(sessionId))).toMatchObject({ status: 401 });
    }
  });

  it("ends with 404, not a sign-out, on Space or Project removal and on private or summary downgrade", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const changes: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["run-space", () => db.pool!.query("UPDATE space_memberships SET status='removed' WHERE user_id=$1 AND space_id=$2", [VIEWER, SPACE]),
        () => db.pool!.query("UPDATE space_memberships SET status='active' WHERE user_id=$1 AND space_id=$2", [VIEWER, SPACE])],
      ["run-project", () => db.pool!.query("UPDATE project_members SET status='revoked' WHERE user_id=$1", [VIEWER]),
        () => db.pool!.query("UPDATE project_members SET status='active' WHERE user_id=$1", [VIEWER])],
      ["run-private", () => db.pool!.query("UPDATE runs SET visibility='private' WHERE id='run-private'"), async () => undefined],
      ["run-summary", () => db.pool!.query("UPDATE runs SET access_level='summary' WHERE id='run-summary'"), async () => undefined],
    ];
    const { cookie } = await seedViewerSession();
    for (const [runId, revoke, restore] of changes) {
      await seedRunningRun(runId);
      const stream = openStream(runId, cookie);
      expect(await revokeMidStream(stream, runId, revoke)).toMatchObject({ status: 404, error: "run_not_found" });
      await restore();
    }
    // The session itself was never touched: the same cookie still opens a stream.
    await seedRunningRun("run-after");
    const after = openStream("run-after", cookie);
    await after.until(() => after.frames.some((frame) => frame.event === "turn.snapshot"));
    after.abort();
    await after.done;
  });

  it("ends a blocked turn's stream on revocation instead of waiting on it forever", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie, sessionId } = await seedViewerSession();
    await seedRunningRun("run-blocked", "waiting_for_review");
    await db.pool!.query(`UPDATE runs SET error_json='{"supervisor_review":true}'::jsonb WHERE id='run-blocked'`);
    const stream = openStream("run-blocked", cookie);
    await stream.until(() => stream.frames.some((frame) => frame.event === "turn.snapshot"));
    await db.pool!.query("DELETE FROM user_sessions WHERE id=$1", [sessionId]);
    await stream.until(() => stream.ended, 3000);
    expect(errorOf(stream.frames)).toMatchObject({ status: 401 });
  });

  it("ends with 401 when a different person is behind the request", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    let actor = VIEWER;
    __setAuthIdentityForTests(() => ({ spaceId: SPACE, userId: actor }));
    await seedRunningRun("run-actor");
    const stream = openStream("run-actor");
    expect(await revokeMidStream(stream, "run-actor", async () => { actor = OWNER; })).toMatchObject({ status: 401 });
  });

  it("refuses at connect exactly as before, and stops its subscription when the client leaves", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-connect");
    await db.pool!.query("UPDATE runs SET access_level='summary' WHERE id='run-connect'");
    expect(await openStream("run-connect", cookie).done).toBe(404);
    expect(await openStream("run-connect").done).toBe(401);
    await db.pool!.query("UPDATE runs SET access_level='full' WHERE id='run-connect'");
    const stream = openStream("run-connect", cookie);
    await stream.until(() => stream.frames.some((frame) => frame.event === "turn.snapshot"));
    stream.abort();
    await stream.done;
    // The server's own loop notices the disconnect and releases its subscription.
    const deadline = Date.now() + 2000;
    while (chatTextDeltaSubscriberCount("run-connect") > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chatTextDeltaSubscriberCount("run-connect")).toBe(0);
  });
});

/** The persisted reply for a Run, as the poll reads it. */
async function persistReply(runId: string, content: string): Promise<void> {
  const session = `sess-${runId}`;
  await db.pool!.query(`INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`, [session, SPACE, OWNER]);
  await db.pool!.query(
    `INSERT INTO messages (id,space_id,session_id,user_id,role,content,run_id,path_depth,branch_path,created_at)
     VALUES ($1,$2,$3,$4,'assistant',$5,$6,0,'/',now())`, [`m-${runId}`, SPACE, session, OWNER, content, runId]);
  await db.pool!.query("UPDATE sessions SET head_message_id=$2 WHERE id=$1", [session, `m-${runId}`]);
}

const persistedTexts = (frames: Frame[]) => frames
  .filter((frame) => frame.event === "turn.part_appended" || frame.event === "turn.part_updated")
  .map((frame) => (frame.data as { part: { type: string; text?: string; streamed?: boolean } }).part)
  .filter((part) => part.type === "text" && !part.streamed)
  .map((part) => part.text);

describe("run turn stream live text is bounded per stream", () => {
  it("shows long Unicode prose exactly while it fits the bus limit", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-unicode");
    const stream = openStream("run-unicode", cookie);
    await stream.until(() => stream.frames.some((frame) => frame.event === "turn.snapshot"));
    // Surrogate pairs and combining marks, split across deltas mid-sequence.
    const piece = "汉字😀e\u0301";
    let expected = "";
    while (expected.length + piece.length * 64 <= MAX_BUFFERED_CHARACTERS) {
      const chunk = piece.repeat(64);
      publishChatTextDelta("run-unicode", chunk.slice(0, 3));
      publishChatTextDelta("run-unicode", chunk.slice(3));
      expected += chunk;
    }
    await stream.until(() => liveTexts(stream.frames).at(-1) === expected, 8000);
    expect(errorOf(stream.frames)).toBeUndefined();
  });

  it("withdraws live text past the limit instead of cutting it, and the persisted reply still arrives", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-long");
    const stream = openStream("run-long", cookie);
    await stream.until(() => stream.frames.some((frame) => frame.event === "turn.snapshot"));
    publishChatTextDelta("run-long", "head ");
    await stream.until(() => liveTexts(stream.frames).at(-1) === "head ");
    publishChatTextDelta("run-long", "y".repeat(MAX_BUFFERED_CHARACTERS));
    publishChatTextDelta("run-long", "TAIL-AFTER-WITHDRAW");
    await stream.until(() => liveTexts(stream.frames).at(-1) === "");
    // Persistence is slow: the stream stays open, shows no cut copy and keeps polling.
    const keepalives = stream.frames.filter((frame) => frame.comment === "keepalive").length;
    await stream.until(() => stream.frames.filter((frame) => frame.comment === "keepalive").length > keepalives + 1, 4000);
    expect(liveTexts(stream.frames).every((text) => text === "" || text === "head ")).toBe(true);
    expect(stream.ended).toBe(false);
    const full = `head ${"y".repeat(MAX_BUFFERED_CHARACTERS)}TAIL-AFTER-WITHDRAW`;
    await persistReply("run-long", full);
    await stream.until(() => persistedTexts(stream.frames).includes(full), 4000);
    await db.pool!.query("UPDATE runs SET status='succeeded' WHERE id='run-long'");
    await stream.until(() => stream.ended);
    expect(errorOf(stream.frames)).toBeUndefined();
  });

  it("shows nothing live when the bus replay has already dropped the head", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-late");
    publishChatTextDelta("run-late", "LOST-HEAD ");
    publishChatTextDelta("run-late", "z".repeat(MAX_BUFFERED_CHARACTERS));
    publishChatTextDelta("run-late", "tail");
    const stream = openStream("run-late", cookie);
    await stream.until(() => stream.frames.filter((frame) => frame.comment === "keepalive").length >= 2, 4000);
    expect(liveTexts(stream.frames).every((text) => text === "")).toBe(true);
    stream.abort();
    await stream.done;
  });

  it("never sends text buffered before a revocation, even past the limit", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie, sessionId } = await seedViewerSession();
    await seedRunningRun("run-revoke-long");
    const stream = openStream("run-revoke-long", cookie);
    const error = await revokeMidStream(stream, "run-revoke-long", async () => {
      publishChatTextDelta("run-revoke-long", "SECRET".repeat(MAX_BUFFERED_CHARACTERS / 6 + 1));
      await db.pool!.query("DELETE FROM user_sessions WHERE id=$1", [sessionId]);
    });
    expect(error).toMatchObject({ status: 401 });
  });

  it("skips live flushes to a reader that is not draining rather than queueing whole copies", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedRunningRun("run-slow");
    let socket: Socket | undefined;
    app.server.once("connection", (accepted: Socket) => { socket = accepted; });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`${baseUrl}/api/v1/runs/run-slow/turn/stream`, { headers: { cookie, "x-rainver-space-id": SPACE } }, resolve);
      req.on("error", reject);
      req.end();
      opened.push(() => req.destroy());
    });
    response.pause();
    // About 0.75 MB per whole-text frame: three UTF-8 bytes per character.
    const frameBytes = (MAX_BUFFERED_CHARACTERS - 4096) * 3;
    publishChatTextDelta("run-slow", "界".repeat(MAX_BUFFERED_CHARACTERS - 4096));
    let peak = 0;
    for (let flush = 0; flush < 24; flush += 1) {
      publishChatTextDelta("run-slow", "。");
      await new Promise((resolve) => setTimeout(resolve, 260));
      peak = Math.max(peak, socket?.writableLength ?? 0);
    }
    // Without the skip, ~24 whole copies (~18 MB) would queue in the server.
    expect(socket).toBeDefined();
    expect(peak).toBeLessThan(frameBytes * 3);
    // Once it drains, the latest whole text still reaches it.
    response.setEncoding("utf8");
    let received = "";
    const done = new Promise<void>((resolve) => {
      response.on("data", (chunk: string) => {
        received += chunk;
        if (received.includes(`${"界".repeat(8)}${"。".repeat(24)}\"`)) resolve();
      });
    });
    response.resume();
    publishChatTextDelta("run-slow", "");
    await done;
    response.destroy();
  }, 20000);
});

describe("run turn stream opening snapshot is checked after it is read", () => {
  /**
   * Holds the snapshot read itself: the reply-text query waits on a real
   * table lock, so a revocation commits after the opening checks passed and
   * before the snapshot is sent.
   */
  async function openWhileSnapshotHeld(runId: string, cookie: string, revoke: () => Promise<unknown>) {
    const holder = await db.pool!.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE messages IN ACCESS EXCLUSIVE MODE");
      const response = fetch(`${baseUrl}/api/v1/runs/${runId}/turn/stream`, { headers: { cookie, "x-rainver-space-id": SPACE } });
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await db.pool!.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT content FROM messages%'`);
        if (waiting.rowCount) break;
        if (Date.now() > deadline) throw new Error("snapshot read never reached the barrier");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await revoke();
      await holder.query("COMMIT");
      const opened = await response;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1500);
      let body = "";
      const reader = opened.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await Promise.race([reader.read(), new Promise<{ done: true }>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve({ done: true })))]);
          if (chunk.done) break;
          body += decoder.decode((chunk as { value: Uint8Array }).value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return { status: opened.status, contentType: opened.headers.get("content-type") ?? "", body };
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }

  async function seedSecretRun(runId: string): Promise<void> {
    await seedRunningRun(runId);
    await db.pool!.query(
      `INSERT INTO run_events (id,space_id,run_id,event_index,event_type,status,summary,metadata_json,created_at)
       VALUES (gen_random_uuid()::text,$1,$2,0,'tool_call_started','running',NULL,$3::jsonb,now())`,
      [SPACE, runId, JSON.stringify({ call_id: "c-snap", tool_name: "SNAPSHOT-SECRET" })]);
  }

  it("refuses with no stream body when access is revoked during the snapshot read", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const cases: Array<[string, number, (sessionId: string) => Promise<unknown>]> = [
      ["run-snap-session", 401, (sessionId) => db.pool!.query("DELETE FROM user_sessions WHERE id=$1", [sessionId])],
      ["run-snap-project", 404, () => db.pool!.query("UPDATE project_members SET status='revoked' WHERE user_id=$1", [VIEWER])],
      ["run-snap-summary", 404, () => db.pool!.query("UPDATE runs SET access_level='summary' WHERE id='run-snap-summary'")],
    ];
    for (const [runId, status, revoke] of cases) {
      await db.pool!.query("UPDATE project_members SET status='active' WHERE user_id=$1", [VIEWER]);
      const { cookie, sessionId } = await seedViewerSession();
      await seedSecretRun(runId);
      const result = await openWhileSnapshotHeld(runId, cookie, () => revoke(sessionId));
      // Soft, so one run reports every case rather than stopping at the first.
      expect.soft(result.status, runId).toBe(status);
      expect.soft(result.contentType, runId).not.toContain("text/event-stream");
      expect.soft(result.body, runId).not.toContain("SNAPSHOT-SECRET");
      expect.soft(result.body, runId).not.toContain("turn.snapshot");
      expect.soft(result.body, runId).toContain(`"error":"${status === 401 ? "authentication_required" : "run_not_found"}"`);
    }
  });

  it("still sends the opening snapshot when nothing changed during the read, including a finished turn", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { cookie } = await seedViewerSession();
    await seedSecretRun("run-snap-kept");
    const kept = await openWhileSnapshotHeld("run-snap-kept", cookie, async () => undefined);
    expect(kept.status).toBe(200);
    expect(kept.body).toContain("event: turn.snapshot");
    expect(kept.body).toContain("SNAPSHOT-SECRET");
    await seedRunningRun("run-snap-final", "succeeded");
    const final = openStream("run-snap-final", cookie);
    await final.until(() => final.ended);
    expect(final.frames.some((frame) => frame.event === "turn.snapshot")).toBe(true);
    expect(errorOf(final.frames)).toBeUndefined();
  });
});
