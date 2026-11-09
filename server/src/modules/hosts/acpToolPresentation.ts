import { stripVTControlCharacters } from "node:util";
import type { ToolCallDetails } from "@rainver/protocol";
import { redactSecretPatterns } from "../runs/evidenceRedaction.js";
import { normalizeToolName } from "../runtimeAdapters/toolName.js";

const OUTPUT_LIMIT = 16_000;
const DIFF_LIMIT = 8_000;
const PENDING_LINE_LIMIT = OUTPUT_LIMIT * 16;
const OMITTED = "\n… [output truncated; middle omitted] …\n";

interface ToolPresentation {
  title?: string;
  text: string | null;
  details: ToolCallDetails;
  terminalOutput: boolean;
  completed: boolean;
  streamText: string;
  pendingLine: string;
  skippingLine: boolean;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function safeToolText(value: string, limit = OUTPUT_LIMIT, shape: "head" | "middle" = "middle"): string {
  // Read past both cuts so credentials crossing a truncation boundary are redacted whole.
  const window = limit * 16;
  if (shape === "head") {
    const text = redactSecretPatterns(stripVTControlCharacters(value.slice(0, window)));
    return text.length > limit || value.length > window ? `${text.slice(0, limit)}…` : text;
  }
  const text = value.length > window * 2
    ? `${redactSecretPatterns(stripVTControlCharacters(value.slice(0, window)))}${OMITTED}${redactSecretPatterns(stripVTControlCharacters(value.slice(-window)))}`
    : redactSecretPatterns(stripVTControlCharacters(value));
  if (text.length <= limit) return text;
  const half = Math.floor((limit - OMITTED.length) / 2);
  return `${text.slice(0, half)}${OMITTED}${text.slice(-(limit - half - OMITTED.length))}`;
}

/** One bounded output snapshot per tool; v1 terminal extensions remain display-only. */
export function createAcpToolPresentation() {
  const calls = new Map<string, ToolPresentation>();
  return (id: string, update: Record<string, unknown>): { output: string | null; details?: ToolCallDetails } => {
    let call = calls.get(id);
    if (!call) {
      if (calls.size >= 512) {
        const completed = [...calls].find(([, value]) => value.completed)?.[0];
        calls.delete(completed ?? calls.keys().next().value!);
      }
      call = { text: null, details: {}, terminalOutput: false, completed: false, streamText: "", pendingLine: "", skippingLine: false };
      calls.set(id, call);
    }
    const { details } = call;
    if (typeof update.name === "string") details.name = normalizeToolName(update.name) ?? undefined;
    if (typeof update.title === "string") {
      const title = normalizeToolName(update.title) ?? undefined;
      // A completion's programmatic name must not replace the original readable command.
      const programmatic = title && /^[\w.-]+$/.test(title) && call.title && /\s/.test(call.title);
      if (!call.title || (title !== details.name && !programmatic)) call.title = title;
      if (details.name || (call.title && call.title !== title)) details.title = call.title;
    }
    if (details.name && call.title) details.title = call.title;
    if (update.status === "cancelled" || update.status === "canceled") details.cancelled = true;
    const raw = update.rawOutput ?? update.raw_output;
    const result = recordValue(raw);
    if (result.cancelled === true || result.canceled === true) details.cancelled = true;
    const meta = recordValue(update._meta);
    const terminalExit = recordValue(meta.terminal_exit);
    const exit = Object.hasOwn(terminalExit, "exit_code") ? terminalExit.exit_code
      : Object.hasOwn(result, "exit_code") ? result.exit_code : result.exitCode;
    if (exit === null || (typeof exit === "number" && Number.isSafeInteger(exit))) details.exit_code = exit;
    else if (typeof exit === "string" && /^-?\d+$/.test(exit) && Number.isSafeInteger(Number(exit))) details.exit_code = Number(exit);
    const signal = Object.hasOwn(terminalExit, "signal") ? terminalExit.signal : result.signal;
    if (typeof signal === "string" || signal === null) details.signal = signal === null ? null : safeToolText(signal, 128);

    const error = update.error ?? result.error ?? result.error_message ?? result.errorMessage ?? meta.error
      ?? (update.status === "failed" ? result.message : undefined);
    const errorText = typeof error === "string" ? error : recordValue(error).message;
    if (typeof errorText === "string") details.error = safeToolText(errorText, 2_000);
    if (Array.isArray(update.locations)) {
      details.locations = update.locations.slice(0, 32).flatMap(value => {
        const location = recordValue(value);
        if (typeof location.path !== "string") return [];
        return [{ path: safeToolText(location.path, 2_000), ...(typeof location.line === "number" && Number.isSafeInteger(location.line) && location.line >= 0 ? { line: location.line } : {}) }];
      });
    }

    const content = Array.isArray(update.content) ? update.content.map(recordValue) : null;
    if (content) {
      const diffs = content.filter(block => block.type === "diff");
      if (diffs.length || details.diffs?.length) details.diffs = diffs.slice(0, 8).flatMap(diff => typeof diff.path !== "string" || typeof diff.newText !== "string" ? [] : [{
        path: safeToolText(diff.path, 2_000),
        old_text: typeof diff.oldText === "string" ? safeToolText(diff.oldText, DIFF_LIMIT) : null,
        new_text: safeToolText(diff.newText, DIFF_LIMIT),
        truncated: diff.newText.length > DIFF_LIMIT || (typeof diff.oldText === "string" && diff.oldText.length > DIFF_LIMIT),
      }]);
      const terminals = content.filter(block => block.type === "terminal").flatMap(block => typeof block.terminalId === "string" ? [block.terminalId.slice(0, 256)] : []);
      if (terminals.length || details.terminal_ids?.length) details.terminal_ids = terminals.slice(0, 8);
    }

    const chunk = recordValue(meta.terminal_output_delta ?? meta.terminal_output);
    if (typeof chunk.data === "string" && typeof result.formatted_output !== "string") {
      if (!call.terminalOutput) {
        call.text = null;
        call.streamText = "";
        call.pendingLine = "";
        call.skippingLine = false;
      }
      call.terminalOutput = true;
      appendTerminalOutput(call, chunk.data);
    } else if (!call.terminalOutput || typeof result.formatted_output === "string") {
      const textBlocks = content?.flatMap(block => {
        const inner = recordValue(block.content);
        const text = block.type === "content" ? inner.text : block.type === "text" ? block.text : undefined;
        return typeof text === "string" ? [text] : [];
      });
      let text: string | undefined;
      if (typeof result.formatted_output === "string") text = result.formatted_output;
      else if (textBlocks?.length) text = textBlocks.join("\n");
      else if (details.error) text = details.error;
      else if (typeof raw === "string") text = raw;
      else if (content && raw == null && call.text !== null) text = "";
      else if (raw != null && !("exit_code" in result || "exitCode" in result)) {
        try { text = JSON.stringify(raw); } catch { /* An unrepresentable result supplies no display text. */ }
      }
      if (text !== undefined) {
        if (text.length > OUTPUT_LIMIT || result.truncated === true) details.output_truncated = true;
        else if (details.output_truncated !== undefined) details.output_truncated = false;
        call.text = safeToolText(text);
        call.streamText = call.text;
        call.pendingLine = "";
        call.skippingLine = false;
      }
    }
    const ended = Object.hasOwn(terminalExit, "exit_code") || exit !== undefined;
    if (ended || (!call.terminalOutput && ["completed", "failed", "cancelled", "canceled"].includes(String(update.status)))) {
      call.completed = true;
      call.pendingLine = "";
      call.streamText = call.text ?? "";
    }
    // Keep process metadata separate from bounded text, also for existing output readers.
    const output = call.text !== null && (details.exit_code !== undefined || typeof result.formatted_output === "string")
      ? JSON.stringify({ exit_code: details.exit_code ?? null, formatted_output: call.text ?? "", truncated: details.output_truncated === true })
      : call.text;
    return { output, ...(Object.keys(details).length ? { details: { ...details } } : {}) };
  };
}

/** Keep the unfinished line raw in memory so redaction can match across chunks. */
function appendTerminalOutput(call: ToolPresentation, data: string): void {
  if (call.skippingLine) {
    const end = data.indexOf("\n");
    if (end < 0) return;
    data = data.slice(end + 1);
    call.skippingLine = false;
  }
  const combined = call.pendingLine + data;
  const end = combined.lastIndexOf("\n");
  if (end >= 0) {
    const lines = combined.slice(0, end).split("\n").map(line => {
      if (line.length <= PENDING_LINE_LIMIT) return safeToolText(line, PENDING_LINE_LIMIT);
      call.details.output_truncated = true;
      return OMITTED;
    }).join("\n") + "\n";
    if (call.streamText.length + lines.length > OUTPUT_LIMIT) call.details.output_truncated = true;
    call.streamText = safeToolText(call.streamText + lines);
  }
  call.pendingLine = combined.slice(end + 1);
  if (call.pendingLine.length > PENDING_LINE_LIMIT) {
    call.pendingLine = "";
    call.skippingLine = true;
    call.streamText = safeToolText(call.streamText + OMITTED);
    call.details.output_truncated = true;
  }
  if (call.streamText.length + call.pendingLine.length > OUTPUT_LIMIT) call.details.output_truncated = true;
  call.text = safeToolText(call.streamText + call.pendingLine);
}
