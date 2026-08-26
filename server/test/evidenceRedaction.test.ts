import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_TEXT_CHARS,
  redactEvidenceText,
  sanitizeErrorJson,
  sanitizeEvidenceJson,
} from "../src/modules/runs/evidenceRedaction.js";

describe("run evidence redaction", () => {
  it("redacts secret-looking text without hiding ordinary evidence", () => {
    expect(redactEvidenceText("calling Bearer rawsecrettokenvalue")).toBe(
      "calling [REDACTED_SECRET]",
    );
    expect(redactEvidenceText("api_key=sk-1234567890abcdef failed")).toBe(
      "[REDACTED_SECRET] failed",
    );
    expect(redactEvidenceText("adapter completed")).toBe("adapter completed");
  });

  it("removes raw evidence fields recursively from persisted metadata", () => {
    expect(
      sanitizeEvidenceJson({
        adapter_type: "codex_cli",
        stdout: "raw output",
        nested: {
          api_key: "sk-1234567890abcdef",
          notes: "token=secret-value",
        },
        events: [{ stderr: "raw error" }, "Bearer rawsecrettokenvalue"],
      }),
    ).toEqual({
      adapter_type: "codex_cli",
      stdout: "[REDACTED_EVIDENCE_FIELD]",
      nested: {
        api_key: "[REDACTED_EVIDENCE_FIELD]",
        notes: "[REDACTED_SECRET]",
      },
      events: [
        { stderr: "[REDACTED_EVIDENCE_FIELD]" },
        "[REDACTED_SECRET]",
      ],
    });
  });

  it("normalizes null error evidence to an empty object", () => {
    expect(sanitizeErrorJson(null)).toEqual({});
  });

  it("keeps long structured content intact below the expanded evidence limit", () => {
    const content = JSON.stringify({ content: "x".repeat(8_000) });
    const sanitized = sanitizeEvidenceJson({ content }) as { content: string };

    expect(sanitized.content).toBe(content);
    expect(JSON.parse(sanitized.content)).toEqual({ content: "x".repeat(8_000) });
  });

  it("truncates only after the expanded evidence limit", () => {
    const value = "x".repeat(MAX_EVIDENCE_TEXT_CHARS + 1);

    expect(redactEvidenceText(value)).toBe(
      `${"x".repeat(MAX_EVIDENCE_TEXT_CHARS)}...[truncated]`,
    );
  });
});
