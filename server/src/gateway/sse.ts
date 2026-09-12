/**
 * The response headers every server-sent-event stream writes.
 *
 * All three write their header block straight to the socket with
 * `reply.raw.writeHead`, so nothing Fastify adds afterwards can reach it —
 * whether or not the route also `reply.hijack()`s (only `turnStream` does; for
 * the other two the `onSend` hook runs and simply has no headers left to set).
 * Each had hand-written its own set and each had drifted: all three said
 * `cache-control: no-cache`, which forbids *reuse* without revalidation but
 * explicitly permits a shared cache to **store** the body. One of them carries
 * live conversation turns.
 */
import { NO_STORE_CACHE_CONTROL } from "./cacheControl.js";
import { REQUEST_ID_HEADER, SERVER_MARKER_HEADER, SERVER_MARKER_VALUE } from "./requestContext.js";

export function sseResponseHeaders(requestId?: string): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    // `no-transform` on top of the shared directive: an intermediary that
    // re-encodes or re-buffers a response is harmless on a JSON body and fatal
    // on a stream, because the events stop arriving until it ends.
    "cache-control": `${NO_STORE_CACHE_CONTROL}, no-transform`,
    connection: "keep-alive",
    // nginx buffers a proxied response by default, which holds every event
    // until the stream ends — that is, until the thing being watched is over.
    "x-accel-buffering": "no",
    [SERVER_MARKER_HEADER]: SERVER_MARKER_VALUE,
    ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
  };
}
