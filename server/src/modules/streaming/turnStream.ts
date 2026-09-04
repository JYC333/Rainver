import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import type { RunTurn, TurnPart, TurnStreamFrame } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { errorEnvelope, sendErrorEnvelope } from "../../gateway/errorEnvelope.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../../gateway/requestContext.js";
import { resolveIdentity } from "../routeUtils/common.js";
import { PgRunRepository } from "../runs/repository.js";
import { loadRunTurn } from "../runs/turnReadModel.js";
import { subscribeChatTextDeltas } from "./conversationDeltaBus.js";

/**
 * The live turn, as parts.
 *
 * A client gets one snapshot of everything so far, then a frame per change.
 * It never sees run events or host thread events — which of those a turn was
 * recorded in is a fact about the backend, not about the conversation.
 *
 * Text is the one part that arrives two ways. A managed Run streams its prose
 * as deltas that are never persisted, so they are folded into a trailing
 * `text` part here and republished as updates; a host Run persists its text,
 * so the same part arrives through the poll. Either way the client sees one
 * growing `text` part.
 */

const SNAPSHOT_EVENT = "turn.snapshot";
const APPENDED_EVENT = "turn.part_appended";
const UPDATED_EVENT = "turn.part_updated";
const STATE_EVENT = "turn.state_changed";
const STREAM_ERROR_EVENT = "server.error";

/**
 * Where the live text sits: past any index the projection can produce.
 *
 * The projection's parts are `0..n`, so this cannot collide with one. It is
 * an identity rather than a position — a client renders it after the parts
 * and replaces it with the persisted reply.
 */
const STREAMED_TEXT_INDEX = Number.MAX_SAFE_INTEGER;

export async function streamRunTurn(
  config: ServerConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const runId = (request.params as { runId?: string }).runId;
  const requestId = resolveRequestId(request);
  if (!runId) {
    return sendErrorEnvelope(reply, 400, errorEnvelope("missing_run_id", "Missing run id", requestId));
  }
  if (!config.databaseUrl) {
    return sendErrorEnvelope(reply, 502, errorEnvelope("turn_stream_unavailable", "Run turn stream is unavailable", requestId));
  }
  const identity = await resolveIdentity(config, request, reply);
  if (!identity) return reply;

  const db = getDbPool(config.databaseUrl);
  const repository = new PgRunRepository(db);
  const run = await repository.getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run) {
    return sendErrorEnvelope(reply, 404, errorEnvelope("run_not_found", "Run not found", requestId));
  }

  const snapshot = await loadRunTurn(db, { spaceId: identity.spaceId, runId });
  if (!snapshot) {
    return sendErrorEnvelope(reply, 404, errorEnvelope("run_not_found", "Run not found", requestId));
  }

  let closed = false;
  request.raw.on("close", () => { closed = true; });

  const raw = startSse(reply, requestId);
  send(raw, SNAPSHOT_EVENT, { type: "turn.snapshot", turn: snapshot } satisfies TurnStreamFrame);

  // Everything the snapshot already showed, so the poll below only reports
  // what is new. `emitted` is keyed by part index because a part changes in
  // place — a tool call finishing does not append a second one.
  let emitted = snapshot.parts.map(fingerprint);
  let state = snapshot.state;
  let cursor = snapshot.cursor;

  // A managed Run's prose exists only here: its log never holds the text, so
  // the deltas are accumulated into one part rather than one part per delta.
  //
  // It is marked `streamed` and sent past the end of the projection, because
  // it does not have a place in it. Giving it a position inside the indexed
  // list would mean fighting the poll for that index — the next tool call to
  // arrive claims it, the next delta claims it back, once per second — and
  // the client would see the reply flicker in and out. A client keeps a
  // `streamed` part beside the list and drops it when the persisted reply
  // arrives.
  let streamedText = "";
  const unsubscribe = subscribeChatTextDeltas(runId, (event) => {
    if (!event.delta || closed || raw.destroyed) return;
    streamedText += event.delta;
    send(raw, UPDATED_EVENT, {
      type: "turn.part_updated",
      run_id: runId,
      cursor,
      part: {
        type: "text",
        index: STREAMED_TEXT_INDEX,
        text: streamedText,
        streamed: true,
      } satisfies TurnPart,
    } satisfies TurnStreamFrame);
  });

  try {
    while (!closed) {
      await sleep(config.runEventStreamPollIntervalMs);
      if (closed) break;

      let turn;
      try {
        turn = await loadRunTurn(db, { spaceId: identity.spaceId, runId });
      } catch {
        send(raw, STREAM_ERROR_EVENT, {
          error: "turn_stream_unavailable",
          message: "Run turn stream is unavailable",
        });
        break;
      }
      if (!turn) break;
      cursor = turn.cursor;

      for (const frame of turnDiffFrames(emitted, turn, runId, cursor)) {
        send(raw, frameEvent(frame), frame);
      }
      emitted = turn.parts.map(fingerprint);

      // The persisted prose has arrived, so the live copy is now a duplicate
      // of it. Stop sending it and tell the client to drop what it holds —
      // the client cannot work this out for itself, because after the opening
      // snapshot it only ever receives per-part frames.
      if (streamedText && turn.parts.some((part) => part.type === "text")) {
        streamedText = "";
        send(raw, UPDATED_EVENT, {
          type: "turn.part_updated",
          run_id: runId,
          cursor,
          part: { type: "text", index: STREAMED_TEXT_INDEX, text: "", streamed: true } satisfies TurnPart,
        } satisfies TurnStreamFrame);
      }

      if (turn.state !== state) {
        state = turn.state;
        send(raw, STATE_EVENT, {
          type: "turn.state_changed", run_id: runId, state,
          blocked_on: turn.blocked_on,
        } satisfies TurnStreamFrame);
      }
      // A finished turn has nothing further to say. The client keeps the
      // snapshot it has; the durable read is the route.
      //
      // A blocked turn is not finished — it is waiting on a person and
      // resumes where it stopped once they decide. Closing here would leave
      // the rest of the turn unstreamed and, on a chat surface, send the
      // client to read a reply that does not exist yet.
      if (state !== "working" && state !== "blocked") break;
    }
  } finally {
    unsubscribe();
    raw.end();
  }
}


/**
 * What changed between the turn a client last saw and the turn as it now
 * stands, as the frames that say so.
 *
 * Separated from the socket so the ordering rules are testable without one:
 * this is where a client's view can be corrupted, and the failure mode is a
 * frame sequence, not a network condition.
 *
 * A part that changed *type* at its index means the list was reindexed rather
 * than extended — Proposals are appended after the projection, so a tool call
 * arriving later pushes them along. Sending that as per-part updates asks a
 * client to reconstruct an order it cannot see; another snapshot is smaller
 * to reason about and correct by construction.
 */
export function turnDiffFrames(
  seen: readonly string[],
  turn: RunTurn,
  runId: string,
  cursor: number,
): TurnStreamFrame[] {
  const reindexed = turn.parts.some((part, index) =>
    seen[index] !== undefined && partType(seen[index]!) !== part.type);
  if (reindexed) return [{ type: "turn.snapshot", turn }];
  const frames: TurnStreamFrame[] = [];
  for (const [index, part] of turn.parts.entries()) {
    const before = seen[index];
    if (before === fingerprint(part)) continue;
    frames.push({
      type: before === undefined ? "turn.part_appended" : "turn.part_updated",
      run_id: runId,
      cursor,
      part,
    });
  }
  return frames;
}

/** The SSE event name a frame is sent under. */
export function frameEvent(frame: TurnStreamFrame): string {
  switch (frame.type) {
    case "turn.snapshot": return SNAPSHOT_EVENT;
    case "turn.part_appended": return APPENDED_EVENT;
    case "turn.part_updated": return UPDATED_EVENT;
    case "turn.state_changed": return STATE_EVENT;
  }
}

/** The fingerprint of a part, for `turnDiffFrames`. */
export function fingerprintPart(part: TurnPart): string {
  return fingerprint(part);
}

/**
 * What "this part changed" means.
 *
 * Serializing the whole part is the honest comparison: a tool call's status,
 * its output, a plan's entries and a text part's length all matter, and a
 * cheaper key would miss one of them the first time a backend starts
 * reporting it.
 */
function fingerprint(part: TurnPart): string {
  return JSON.stringify(part);
}

/** The `type` of a fingerprinted part, without parsing the whole thing. */
function partType(printed: string): string {
  return (JSON.parse(printed) as TurnPart).type;
}

function startSse(reply: FastifyReply, requestId: string): ServerResponse {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    [REQUEST_ID_HEADER]: requestId,
  });
  reply.raw.write(": connected\n\n");
  return reply.raw;
}

function send(raw: ServerResponse, event: string, data: unknown): void {
  if (raw.destroyed) return;
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
