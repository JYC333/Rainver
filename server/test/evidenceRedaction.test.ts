import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_TEXT_CHARS,
  redactEvidenceText,
  redactSecretPatterns,
  sanitizeErrorJson,
  sanitizeEvidenceJson,
} from "../src/modules/runs/evidenceRedaction.js";

describe("run evidence redaction", () => {
  it("redacts named secret fields and provider-key patterns in error text", () => {
    expect(sanitizeEvidenceJson({ secret: "oauth-refresh" })).toEqual({
      secret: "[REDACTED_EVIDENCE_FIELD]",
    });
    expect(
      redactSecretPatterns(
        '{"error":"invalid_api_key","hint":"sk-live-abcdefghijklmnopqrstuvwxyz"}',
      ),
    ).toContain("[REDACTED_SECRET]");
  });

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

  /**
   * One negative case per shape that used to get through. Each of these was a
   * real miss: `\b` does not fire between `_` and a letter, a quoted JSON key
   * puts a `"` between the name and the colon, and a URL's `?key=` has no
   * `api` in front of it.
   */
  it.each([
    ["an underscore-prefixed name", "access_token=abcdefghijklmnop"],
    ["a refresh token", "refresh_token=abcdefghijklmnop"],
    ["an id token", "id_token=abcdefghijklmnop"],
    ["a client secret", "client_secret=abcdefghijklmnop"],
    ["a quoted JSON key", '{"api_key": "sk-live-abcdefghijklmn"}'],
    ["a hyphenated header name", "x-api-key: abcdefghijklmnop"],
    ["a bare query parameter", "https://example.test/v1?key=AIzaSyA0123456789abcdefghijklmnopqrs"],
    ["a Google API key on its own", "AIzaSyA0123456789abcdefghijklmnopqrs"],
    ["a GitHub token", "ghp_0123456789abcdefghijklmnopqrstuvwx"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
    ["basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=="],
  ])("redacts %s", (_label, text) => {
    const out = redactEvidenceText(text);
    expect(out).toContain("[REDACTED_SECRET]");
    // The secret itself must be gone, not merely flagged beside it.
    const secret = text.split(/[=:\s]/).filter(Boolean).pop()!;
    expect(out).not.toContain(secret);
  });

  it("leaves ordinary diagnostics alone", () => {
    for (const text of [
      "adapter completed",
      "exit code 1",
      "wrote 3 files to /tmp/run-1",
      // A process reporting that a credential is *not* set. Redacting this
      // hides the answer and protects nothing.
      "env-secret:absent",
      "token=none",
      // `Basic` is also an English adjective.
      "Basic authentication failed",
      "basic configuration error",
    ]) {
      expect(redactEvidenceText(text)).toBe(text);
    }
  });

  it.each([
    ["a credential word inside the name", "secret_ref: sr_1234567"],
    ["a value that starts with a not-set word", "password=nil-8f3a9c2b1d"],
  ])("redacts %s", (_label, text) => {
    expect(redactEvidenceText(text)).toContain("[REDACTED_SECRET]");
  });

  /**
   * The name-anchored pattern was quadratic: written with a leading `[\w.-]*`
   * it consumed to end-of-line and backtracked one character at a time from
   * every start position, so 64 KiB on one line — which a Custom Source handler
   * can print, and which `customSourceRunner` hands here whole — took 8.6
   * seconds on the single event loop.
   */
  it("scans a long single line in linear time", () => {
    const started = Date.now();
    redactSecretPatterns("a".repeat(65_536));
    expect(Date.now() - started).toBeLessThan(250);
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

  it("redacts a secret that straddles the truncation point", () => {
    // Scanning was moved before truncation so a 1MiB error is not matched in
    // full. Cutting first put the boundary inside a credential and left its
    // head, which no pattern is long enough to recognise; the scan reads a
    // little past the cut for exactly that reason.
    const head = `${"x".repeat(MAX_EVIDENCE_TEXT_CHARS - 10)} `;
    const redacted = redactEvidenceText(`${head}sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ trailing`)!;
    expect(redacted).not.toMatch(/sk-A/);
    expect(redacted.endsWith("...[truncated]")).toBe(true);
  });

  it('leaves no half a credential at either truncation boundary', () => {
    // Two boundaries can fall inside a secret, and each one hid the next.
    // Cutting at the cap before scanning left the head of a secret straddling
    // the cap — the overscan answered that. But redaction *shrinks* the text,
    // so a window that comes back under the cap is kept whole and its far edge
    // becomes a second boundary of the same kind. Measured at the time: a JWT
    // cut four characters into its signature kept a payload that decodes to
    // the subject's identity.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIiwiZW1haWwiOiJ2aWN0aW1AZXhhbXBsZS5jb20ifQ.SIGNATURE_TAIL';
    const shrinking = ` api_key="${'S'.repeat(200)}" `.repeat(3);
    for (let nudge = -8; nudge <= 48; nudge += 4) {
      const padding = MAX_EVIDENCE_TEXT_CHARS + 256 - shrinking.length - jwt.length + nudge - 1;
      const value = `${shrinking}${'z'.repeat(Math.max(0, padding))} ${jwt} trailing${'y'.repeat(4000)}`;
      expect(redactEvidenceText(value)!, `nudge ${nudge}`).not.toMatch(/eyJ[A-Za-z0-9_-]{6,}/);
    }
  });

  it("leaves usage counts alone", () => {
    // Every plural `tokens` spelling here is a count, and these ride back to
    // the person inside a model's own answer and inside job error text.
    for (const line of ["usage: input_tokens=1204 output_tokens=87", "max_tokens: 4096", "total_tokens = 51200"]) {
      expect(redactSecretPatterns(line), line).toBe(line);
    }
    // The singular is still a credential name.
    expect(redactSecretPatterns("access_token=abc123def")).toBe("[REDACTED_SECRET]");
  });
});
