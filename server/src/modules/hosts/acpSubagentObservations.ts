import { createHash } from "node:crypto";
import type { SubagentObservation } from "@rainver/protocol";
import { recordValue as record, safeToolText } from "./acpToolPresentation.js";
import type { ThreadEventDraft } from "./threadEventNormalization.js";

export const ACP_SUBAGENT_STATUS = "runtime_subagent";

const MAX_OUTPUT_CHARS = 8_000;

function subagentState(value: unknown): SubagentObservation["state"] {
  const state = record(value);
  switch (state.state) {
    case "running": return "running";
    case "requires_action": return "waiting";
    case "unknown": return "unknown";
    case "idle":
      if (Array.isArray(state.background) && state.background.length) return "running";
      if (state.stopReason === "end_turn") return "completed";
      if (state.stopReason === "cancelled") return "cancelled";
      if (state.stopReason === "error") return "failed";
      return "ended";
    default: return undefined;
  }
}

function draft(observation: SubagentObservation): ThreadEventDraft {
  return { event_type: "status", status: ACP_SUBAGENT_STATUS, text: JSON.stringify(observation) };
}

function messageText(content: unknown): string {
  if (Array.isArray(content)) return content.map(textBlock).join("\n");
  return textBlock(content);
}

function textBlock(value: unknown): string {
  const block = record(value);
  return block.type === "text" && typeof block.text === "string" ? block.text : "";
}

export function createAcpSubagentObservations() {
  const children = new Map<string, { key: string; output: string; dirty: boolean; last: string; messageId?: string; newMessage?: boolean }>();
  const handled = (events: ThreadEventDraft[] = []) => ({ handled: true, events, key: null });
  const pass = (key: string | null = null) => ({ handled: false, events: [], key });

  function flush(child: { key: string; output: string; dirty: boolean }): ThreadEventDraft[] {
    if (!child.dirty) return [];
    child.dirty = false;
    return [draft({ key: child.key, output: safeToolText(child.output, MAX_OUTPUT_CHARS) })];
  }

  return {
    push(event: Record<string, unknown>) {
      if (event.method !== "session/update") return pass();
      const params = record(event.params);
      const update = record(params.update);
      if (update.sessionUpdate === "subagent_update" && typeof update.sessionId === "string") {
        const id = update.sessionId;
        if (!id || id.length > 256) return handled();
        let child = children.get(id);
        if (!child) {
          if (children.size >= 256) return handled();
          child = { key: createHash("sha256").update(id).digest("hex"), output: "", dirty: false, last: "" };
          children.set(id, child);
        }
        const state = subagentState(update.state);
        const title = typeof update.title === "string" ? safeToolText(update.title, 160) : undefined;
        const observation = draft({ key: child.key, title, state });
        const events = state && state !== "running" ? flush(child) : [];
        if (observation.text !== child.last) {
          child.last = observation.text!;
          events.push(observation);
        }
        return handled(events);
      }
      if (params._rainverChildSession !== true) return pass();
      const child = typeof params.sessionId === "string" ? children.get(params.sessionId) : undefined;
      if (!child) return handled();
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if (update.sessionUpdate === "tool_call") child.newMessage = true;
        return pass(child.key);
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        const text = textBlock(update.content);
        if (text && child.output.length < MAX_OUTPUT_CHARS * 2) {
          const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
          const boundary = child.newMessage || (messageId && child.messageId !== messageId);
          const content = boundary && child.output ? `\n\n${text}` : text;
          child.messageId = messageId;
          child.newMessage = false;
          child.output += content.slice(0, MAX_OUTPUT_CHARS * 2 - child.output.length);
          child.dirty = true;
        }
      } else if (update.sessionUpdate === "session_message" && update.recipientSessionId === params.sessionId) {
        const task = messageText(update.content);
        if (task) {
          child.newMessage = true;
          return handled([...flush(child), draft({ key: child.key, task: safeToolText(task, 2_000) })]);
        }
      }
      return handled();
    },
    finish() {
      return [...children.values()].flatMap(flush);
    },
  };
}
