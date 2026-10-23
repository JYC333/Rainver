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

export async function streamAgentAttention(config: ServerConfig, request: FastifyRequest, reply: FastifyReply) {
  const identity = await resolveIdentity(config, request, reply);
  if (!identity) return reply;
  const pool = dbPool(config);
  const baseline = await attentionBaseline(pool, identity.userId);
  // Initial errors use the normal JSON error path, before hijacking the response.
  let initial: AttentionSnapshot | undefined = await readAttentionSnapshot(pool, identity.userId, baseline);
  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());
  reply.hijack();
  reply.raw.writeHead(200, sseResponseHeaders(resolveRequestId(request)));
  try {
    await pumpAttention(async () => {
      if (initial) { const snapshot = initial; initial = undefined; return snapshot; }
      const current = await introspectIdentity(config, request);
      if (!current.ok) { if (current.reason === 'denied') return null; throw new Error('Attention identity unavailable'); }
      if (current.userId !== identity.userId) return null;
      return readAttentionSnapshot(pool, identity.userId, baseline);
    }, frame => {
      if (reply.raw.destroyed) { controller.abort(); return; }
      return writeAttentionFrame(reply.raw, frame, controller.signal);
    }, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) request.log.warn({ err: error }, 'Agent attention stream ended after read/write failure');
  } finally { controller.abort(); reply.raw.end(); }
}
