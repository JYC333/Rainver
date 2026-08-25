import type { HostThreadEventType } from "./threadEventRepository";

export interface ThreadEventDraft {
  event_type: HostThreadEventType;
  text?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_input_summary?: string | null;
  tool_kind?: string | null;
  tool_result_summary?: string | null;
  status?: string | null;
}

const MAX_TOOL_RESULT_SUMMARY_CHARS = 200;

/**
 * Turns a remote-host vendor CLI's ACP protocol traffic into the thread's
 * normalized conversation events, incrementally as it arrives.
 *
 * Text comes only from streamed deltas (`agent_message_chunk` —
 * see `pushAcpTextDelta`), coalesced into one `assistant_text` event per
 * completed line or tool-event boundary — never from a turn's final
 * consolidated message, which would duplicate the same text already seen
 * via deltas. Tool activity comes only from fully-formed lifecycle signals
 * (`tool_call`/`tool_call_update` — see `pushAcpProtocolEvent`) — never
 * from deltas.
 *
 * Reasoning arrives two ways and both become `assistant_thought`. A runtime
 * that keeps it on its own ACP channel feeds `pushAcpThoughtDelta`; a model
 * that inlines it in the message text as `<think>…</think>` — MiniMax and
 * other reasoning models do this, and no ACP channel separates it — is split
 * out of the text stream here. Without that split the reasoning was stored
 * and displayed as the answer itself.
 */
export function createThreadEventNormalizer(): {
  pushStderr(chunk: string): ThreadEventDraft[];
  pushAcpTextDelta(delta: string): ThreadEventDraft[];
  pushAcpThoughtDelta(delta: string): ThreadEventDraft[];
  pushAcpProtocolEvent(event: Record<string, unknown>): ThreadEventDraft[];
  finish(): ThreadEventDraft[];
} {
  let stderrBuffer = "";
  let textSegment = "";
  let thoughtSegment = "";
  // Whether the message stream is currently inside an inlined <think> block.
  // Streamed deltas split the tags at arbitrary points, so this cannot be
  // decided per chunk.
  let insideInlineThink = false;
  // A partial tag held back across chunks: "<thi" at the end of one delta is
  // not text, it is the start of a tag whose rest has not arrived.
  let pendingTag = "";

  const OPEN_TAG = "<think>";
  const CLOSE_TAG = "</think>";

  function flushSegment(kind: "assistant_text" | "assistant_thought"): ThreadEventDraft[] {
    const buffered = kind === "assistant_text" ? textSegment : thoughtSegment;
    if (!buffered) return [];
    if (kind === "assistant_text") textSegment = "";
    else thoughtSegment = "";
    return [{ event_type: kind, text: buffered }];
  }

  function flushTextSegment(): ThreadEventDraft[] {
    return [...flushSegment("assistant_thought"), ...flushSegment("assistant_text")];
  }

  function appendDelta(
    kind: "assistant_text" | "assistant_thought",
    text: string,
  ): ThreadEventDraft[] {
    if (kind === "assistant_text") textSegment += text;
    else thoughtSegment += text;
    let rest = kind === "assistant_text" ? textSegment : thoughtSegment;
    if (!rest.includes("\n")) return [];
    const drafts: ThreadEventDraft[] = [];
    // A chunk can carry more than one completed line.
    let at = rest.indexOf("\n");
    while (at !== -1) {
      const line = rest.slice(0, at);
      if (line) drafts.push({ event_type: kind, text: line });
      rest = rest.slice(at + 1);
      at = rest.indexOf("\n");
    }
    if (kind === "assistant_text") textSegment = rest;
    else thoughtSegment = rest;
    return drafts;
  }

  /**
   * The longest suffix of `value` that could still grow into `tag`. Holding it
   * back is what keeps a tag split across two deltas from being emitted as
   * text one character at a time.
   */
  function partialTagSuffix(value: string, tag: string): number {
    const max = Math.min(value.length, tag.length - 1);
    for (let length = max; length > 0; length -= 1) {
      if (tag.startsWith(value.slice(value.length - length))) return length;
    }
    return 0;
  }

  function pushAcpTextDelta(delta: string): ThreadEventDraft[] {
    if (!delta) return [];
    const drafts: ThreadEventDraft[] = [];
    let rest = pendingTag + delta;
    pendingTag = "";
    for (;;) {
      const tag = insideInlineThink ? CLOSE_TAG : OPEN_TAG;
      const at = rest.indexOf(tag);
      if (at === -1) break;
      const before = rest.slice(0, at);
      if (before) drafts.push(...appendDelta(insideInlineThink ? "assistant_thought" : "assistant_text", before));
      // Whatever was buffered belongs to the side being left, and must not be
      // merged into the first line of the side being entered.
      drafts.push(...flushSegment(insideInlineThink ? "assistant_thought" : "assistant_text"));
      insideInlineThink = !insideInlineThink;
      rest = rest.slice(at + tag.length);
    }
    const held = partialTagSuffix(rest, insideInlineThink ? CLOSE_TAG : OPEN_TAG);
    if (held > 0) {
      pendingTag = rest.slice(rest.length - held);
      rest = rest.slice(0, rest.length - held);
    }
    if (rest) drafts.push(...appendDelta(insideInlineThink ? "assistant_thought" : "assistant_text", rest));
    return drafts;
  }

  function pushAcpThoughtDelta(delta: string): ThreadEventDraft[] {
    return delta ? appendDelta("assistant_thought", delta) : [];
  }

  function pushAcpProtocolEvent(event: Record<string, unknown>): ThreadEventDraft[] {
    if (event.method !== "session/update") return [];
    const update = recordValue(recordValue(event.params).update);
    const callId = stringValue(update.toolCallId ?? update.tool_call_id);
    if (update.sessionUpdate === "tool_call") {
      return [
        ...flushTextSegment(),
        {
          event_type: "tool_activity_started",
          tool_call_id: callId,
          tool_name: stringValue(update.title ?? update.name),
          tool_input_summary: null,
          // ACP runtime replatform P3 (A9): the 9-category kind is what
          // makes claude/codex/opencode tool rows comparable in the UI.
          tool_kind: stringValue(update.kind),
        },
      ];
    }
    if (update.sessionUpdate === "tool_call_update") {
      const status = stringValue(update.status);
      if (status !== "completed" && status !== "failed" && status !== "in_progress") return [];
      return [
        ...flushTextSegment(),
        {
          event_type: "tool_activity_finished",
          tool_call_id: callId,
          status: status === "failed" ? "failed" : status === "in_progress" ? "in_progress" : "succeeded",
          // A9: absorbed for claude/opencode; codex-acp 1.6.2 reports none
          // (a known adapter asymmetry, not a bug).
          tool_result_summary: summarizeToolResultContent(update.content),
        },
      ];
    }
    if (update.sessionUpdate === "plan") {
      // A9: appended as a snapshot, never mutated — a reader takes the
      // thread's latest plan_updated event, not a running diff of them.
      return [
        ...flushTextSegment(),
        { event_type: "plan_updated", text: JSON.stringify(update.entries ?? []) },
      ];
    }
    // agent_message_chunk (and any other update kind) carries no lifecycle
    // signal this normalizer surfaces — text arrives via pushAcpTextDelta
    // instead, never both, matching the raw-stdout path's separation.
    return [];
  }

  function pushStderr(chunk: string): ThreadEventDraft[] {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): ThreadEventDraft => ({ event_type: "diagnostic", text: line }));
  }

  function finish(): ThreadEventDraft[] {
    const drafts: ThreadEventDraft[] = [];
    // An unterminated tag at end of stream is text the model actually sent,
    // not framing: emitting it is better than losing the last few characters
    // of a turn to a tag that never closed.
    if (pendingTag) {
      drafts.push(...appendDelta(insideInlineThink ? "assistant_thought" : "assistant_text", pendingTag));
      pendingTag = "";
    }
    drafts.push(...flushTextSegment());
    if (stderrBuffer.trim()) drafts.push({ event_type: "diagnostic", text: stderrBuffer.trim() });
    stderrBuffer = "";
    return drafts;
  }

  return { pushStderr, pushAcpTextDelta, pushAcpThoughtDelta, pushAcpProtocolEvent, finish };
}

/**
 * ACP runtime replatform P3 (A9): only the "content" tool-call-content
 * variant is absorbed — text an agent explicitly reported as a tool's
 * result. The "diff" variant is declined by design (the daemon's own
 * `git diff HEAD` captures the workspace's true state, including changes the
 * agent never reported — strictly better for review than trusting the
 * agent's self-reported diff).
 */
function summarizeToolResultContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content
    .map(recordValue)
    .filter((block) => block.type === "content")
    .map((block) => stringValue(recordValue(block.content).text))
    .filter((text): text is string => text !== null);
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  return joined.length > MAX_TOOL_RESULT_SUMMARY_CHARS
    ? `${joined.slice(0, MAX_TOOL_RESULT_SUMMARY_CHARS)}…`
    : joined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
