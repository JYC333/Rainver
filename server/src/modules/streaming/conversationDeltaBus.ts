import { EventEmitter } from "node:events";

export const CHAT_TEXT_DELTA_TYPE = "chat.text_delta";

export interface ChatTextDelta {
  type: typeof CHAT_TEXT_DELTA_TYPE;
  run_id: string;
  delta_index: number;
  delta: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);
const buffers = new Map<string, {
  events: ChatTextDelta[];
  characters: number;
  expiresAt: number;
}>();
const BUFFER_TTL_MS = 5 * 60_000;
const MAX_BUFFERED_CHARACTERS = 256 * 1024;
const MAX_BUFFERED_RUNS = 1_000;

export function publishChatTextDelta(runId: string, delta: string): void {
  if (!delta) return;
  pruneExpiredBuffers();
  const buffer = buffers.get(runId) ?? {
    events: [],
    characters: 0,
    expiresAt: Date.now() + BUFFER_TTL_MS,
  };
  const event = {
    type: CHAT_TEXT_DELTA_TYPE,
    run_id: runId,
    delta_index: buffer.events.length
      ? buffer.events[buffer.events.length - 1]!.delta_index + 1
      : 0,
    delta,
  } satisfies ChatTextDelta;
  buffer.events.push(event);
  buffer.characters += delta.length;
  buffer.expiresAt = Date.now() + BUFFER_TTL_MS;
  while (
    buffer.characters > MAX_BUFFERED_CHARACTERS &&
    buffer.events.length > 1
  ) {
    buffer.characters -= buffer.events.shift()!.delta.length;
  }
  buffers.set(runId, buffer);
  pruneOldestBuffers();
  bus.emit(runId, event);
}

export function subscribeChatTextDeltas(
  runId: string,
  listener: (event: ChatTextDelta) => void,
): () => void {
  pruneExpiredBuffers();
  for (const event of buffers.get(runId)?.events ?? []) listener(event);
  bus.on(runId, listener);
  return () => bus.off(runId, listener);
}

function pruneExpiredBuffers(): void {
  const now = Date.now();
  for (const [runId, buffer] of buffers) {
    if (buffer.expiresAt <= now) buffers.delete(runId);
  }
}

function pruneOldestBuffers(): void {
  while (buffers.size > MAX_BUFFERED_RUNS) {
    const oldestRunId = buffers.keys().next().value as string | undefined;
    if (!oldestRunId) return;
    buffers.delete(oldestRunId);
  }
}
