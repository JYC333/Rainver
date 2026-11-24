import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AgentAttentionStreamFrame } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import { dbPool, resolveIdentity } from '../routeUtils/common.js';
import { introspectIdentity } from '../auth/identity.js';
import { readAttentionSnapshot, attentionBaseline, type AttentionSnapshot } from '../agentAttention/index.js';
import { sseResponseHeaders } from '../../gateway/sse.js';
import { resolveRequestId } from '../../gateway/requestContext.js';
import { errorEnvelope, sendErrorEnvelope } from '../../gateway/errorEnvelope.js';

export const ATTENTION_POLL_MS = 2000;
export function attentionFrame(snapshot: AttentionSnapshot, seq: number, previous?: AttentionSnapshot): AgentAttentionStreamFrame {
  // Display/read reports may beat this poll. A newly observed revision of the
  // viewer's own work still deserves its alert even when its conversation was
  // already open. Reading state is not consulted: a manual unread, or old work
  // re-entering the personal window, keeps its existing revision keys.
  const notices = previous ? [...snapshot.signals].filter(([key, value]) => value.mine && !previous.signals.has(key)).map(([, value]) => value.notice) : [];
  const type = !previous ? 'attention.snapshot' : notices.length > 100 ? 'attention.resync' : snapshot.version !== previous.version ? 'attention.invalidation' : 'attention.heartbeat';
  const changedPage = !previous || JSON.stringify([snapshot.page.items, snapshot.page.next_cursor]) !== JSON.stringify([previous.page.items, previous.page.next_cursor]);
  return { type, seq, page: type === 'attention.snapshot' || type === 'attention.resync' || type === 'attention.invalidation' && changedPage ? snapshot.page : null, version: snapshot.version,
    counts: snapshot.page.counts,
    unread_count: snapshot.unread_count, notices: type === 'attention.resync' ? [] : notices };
}

/** One queued frame at most: highWaterMark is backpressure, not disconnection. */
export async function writeAttentionFrame(raw: ServerResponse, frame: AgentAttentionStreamFrame, signal: AbortSignal) {
  if (signal.aborted || raw.destroyed) return;
  if (!raw.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)) await once(raw, 'drain', { signal });
}

/** Connection-owned loop, sequential reads, fresh authorization, no idle scanner. */
export async function pumpAttention(read: () => Promise<AttentionSnapshot | null>, send: (frame: AgentAttentionStreamFrame) => void | Promise<void>, signal: AbortSignal,
  pause: () => Promise<unknown> = () => delay(ATTENTION_POLL_MS, undefined, { signal })) {
  let previous: AttentionSnapshot | undefined;
  let seq = 0;
  try {
    while (!signal.aborted) {
      const next = await read();
      if (signal.aborted) break;
      if (!next) { await send({ type: 'attention.denied', seq: ++seq, page: null, version: '', unread_count: 0, notices: [] }); break; }
      await send(attentionFrame(next, ++seq, previous));
      if (signal.aborted) break;
      previous = next;
      await pause();
    }
  } catch (error) { if (!signal.aborted) throw error; }
}

export async function streamAgentAttention(config: ServerConfig, request: FastifyRequest, reply: FastifyReply, shutdown: AbortSignal) {
  const identity = await resolveIdentity(config, request, reply);
  if (!identity) return reply;
  const pool = dbPool(config);
  const baseline = await attentionBaseline(pool, identity.userId);
  // Initial errors use the normal JSON error path, before hijacking the response.
  let initial: AttentionSnapshot | undefined = await readAttentionSnapshot(pool, identity.userId, baseline);
  if (reply.raw.destroyed) return;
  const requestId = resolveRequestId(request);
  if (shutdown.aborted) {
    return sendErrorEnvelope(reply, 503, errorEnvelope('agent_attention_stream_unavailable', 'Agent attention stream is unavailable', requestId));
  }
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  const signal = AbortSignal.any([controller.signal, shutdown]);
  reply.raw.once('close', disconnect);
  reply.hijack();
  reply.raw.writeHead(200, sseResponseHeaders(requestId));
  try {
    await pumpAttention(async () => {
      if (initial) { const snapshot = initial; initial = undefined; return snapshot; }
      const current = await introspectIdentity(config, request);
      if (signal.aborted) return null;
      if (!current.ok) { if (current.reason === 'denied') return null; throw new Error('Attention identity unavailable'); }
      if (current.userId !== identity.userId) return null;
      return readAttentionSnapshot(pool, identity.userId, baseline);
    }, frame => {
      if (reply.raw.destroyed) { controller.abort(); return; }
      return writeAttentionFrame(reply.raw, frame, signal);
    }, signal);
  } catch (error) {
    if (!signal.aborted) request.log.warn({ err: error }, 'Agent attention stream ended after read/write failure');
  } finally {
    controller.abort();
    reply.raw.off('close', disconnect);
    if (shutdown.aborted && reply.raw.writableNeedDrain) reply.raw.destroy();
    else reply.raw.end();
  }
}
