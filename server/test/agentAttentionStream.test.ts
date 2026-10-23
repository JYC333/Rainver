import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { writeAttentionFrame, attentionFrame, pumpAttention, ATTENTION_POLL_MS } from '../src/modules/streaming/agentAttentionStream.js';
import type { AttentionSnapshot } from '../src/modules/agentAttention/snapshot.js';
const snapshot = (version = 'v1', keys: string[] = []): AttentionSnapshot => ({ version, unread_count: keys.length,
  page: { items: [], next_cursor: null, counts: { needs_you: 0, recently_finished: 0, working: 1, waiting: 0, idle: 0 }, as_of: '2026-10-21T00:00:00Z' },
  signals: new Map(keys.map(key => [key, { notice: { key, work_key: 'work', kind: 'finished' }, mine: true }])) });
describe('Agent Attention stream', () => {
  it('uses a two second nonoverlapping connection-owned read budget', () => expect(ATTENTION_POLL_MS).toBe(2000));
  it('silently reconciles initial snapshots and emits exact new revision identities', () => {
    expect(attentionFrame(snapshot('v1', ['old']), 1).notices).toEqual([]);
    expect(attentionFrame(snapshot('v2', ['old', 'new']), 2, snapshot('v1', ['old'])).notices.map(n => n.key)).toEqual(['new']);
  });
  it('announces only new revisions of the viewer\'s own work and bounds overflow with resync', () => {
    // A manual unread or a work becoming the viewer's keeps its revision keys.
    const previous = snapshot('v1', ['same']); previous.signals.get('same')!.mine = false;
    expect(attentionFrame(snapshot('v2', ['same']), 2, previous).notices).toEqual([]);
    const others = snapshot('v2', ['same', 'not-mine']); others.signals.get('not-mine')!.mine = false;
    expect(attentionFrame(others, 2, previous).notices).toEqual([]);
    const overflow = attentionFrame(snapshot('v3', Array.from({ length: 101 }, (_, i) => `key-${i}`)), 3, previous);
    expect(overflow.type).toBe('attention.resync'); expect(overflow.notices).toEqual([]);
  });
  it('announces a new revision even if the open conversation reported it read before the stream poll', () => {
    const before = snapshot('before');
    const after = snapshot('after', ['just-displayed']);
    after.unread_count = 0;
    expect(attentionFrame(after, 2, before).notices.map(notice => notice.key)).toEqual(['just-displayed']);
    expect(attentionFrame(after, 3, after).notices).toEqual([]);
    expect(attentionFrame(after, 1).notices).toEqual([]);
  });
  it('replaces removals, heartbeats unchanged data, and terminates on authorization loss', async () => {
    const controller = new AbortController(); const frames: string[] = []; let count = 0;
    await pumpAttention(async () => ++count < 3 ? snapshot() : null, frame => { frames.push(frame.type); }, controller.signal, async () => {});
    expect(frames).toEqual(['attention.snapshot', 'attention.heartbeat', 'attention.denied']);
    expect(attentionFrame(snapshot('empty'), 2, snapshot('v1', ['removed'])).page).toBeNull();
  });
  it('does not publish late reads or continue work after a disconnected client', async () => {
    const controller = new AbortController(); let sent = false;
    await pumpAttention(async () => { controller.abort(); return snapshot() }, () => { sent = true; }, controller.signal);
    expect(sent).toBe(false);

  });
  it('waits for a pressured frame to drain before another read and removes listeners on disconnect', async () => {
    const controller = new AbortController(); let reads = 0; let drain!: () => void;
    const raw = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { drain = done; } });
    const pause = vi.fn(async () => {});
    const pumping = pumpAttention(async () => { if (++reads === 2) controller.abort(); return snapshot(); },
      frame => writeAttentionFrame(raw as unknown as ServerResponse, frame, controller.signal), controller.signal, pause);
    await Promise.resolve(); await Promise.resolve();
    expect(reads).toBe(1); expect(pause).not.toHaveBeenCalled(); expect(raw.writableNeedDrain).toBe(true);
    drain(); await pumping;
    expect(reads).toBe(2); expect(raw.listenerCount('drain')).toBe(0); raw.destroy();
    const abort = new AbortController();
    const blocked = new Writable({ highWaterMark: 1, write() {} });
    const writing = writeAttentionFrame(blocked as unknown as ServerResponse, attentionFrame(snapshot(),1), abort.signal);
    abort.abort(); await expect(writing).rejects.toHaveProperty('name','AbortError');
    expect(blocked.listenerCount('drain')).toBe(0); blocked.destroy();
  });
  it('omits an unchanged personal window while sending complete counts, ignoring as_of churn', () => {
    const before = snapshot('before'), after = snapshot('after');
    after.page.as_of = '2026-10-21T00:01:00Z'; after.page.counts.working = 99;
    const frame = attentionFrame(after,2,before);
    expect(frame.type).toBe('attention.invalidation'); expect(frame.page).toBeNull(); expect(frame.counts?.working).toBe(99);
    after.page.next_cursor = 'changed-window';
    expect(attentionFrame(after,2,before).page).toBe(after.page);
  });

});
