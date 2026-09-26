import { redactEvidenceText } from "../runs/evidenceRedaction.js";

export const MAX_TOOL_NAME_CHARS = 200;

/**
 * ACP runtimes may use a whole shell command as a tool title. Keep that
 * durable display label useful without persisting secrets or an unbounded
 * command body. Correlation ids are deliberately not changed here.
 */
export function normalizeToolName(value: string | null): string | null {
  const redacted = redactEvidenceText(value);
  if (redacted === null) return null;
  return redacted.length > MAX_TOOL_NAME_CHARS
    ? `${redacted.slice(0, MAX_TOOL_NAME_CHARS)}...[truncated]`
    : redacted;
}
