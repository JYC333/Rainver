/**
 * What is removed and what is cut before anything leaves this machine.
 *
 * Both jobs live here because both are the same decision made twice: the
 * control plane is not entitled to this machine's raw terminal history. A raw
 * ACP replay carries every tool result in full — most of a session's bytes,
 * and the usual home of a printed key — so trimming does more of the work than
 * the patterns do, and the patterns catch what survives it.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  // Vendor key shapes, longest prefix first so a partial match cannot leave a tail.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/g,
  // Assignment shapes: the name says it is a secret even when the value has no recognisable shape.
  /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*["']?[^\s"',;}]{6,}/gi,
];

/**
 * Removes recognisable secrets before a record leaves the machine.
 *
 * Pattern-based redaction cannot be complete and this does not claim to be.
 * It is the posture the server already takes with its own logs, applied one
 * hop earlier so the network and the database never see the raw text at all.
 * Trimming does more of the work than these patterns do — a tool result cut
 * to a 512-byte label rarely still contains the key it printed.
 */
export function redactAmbientText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, name?: string) =>
      typeof name === "string" ? `${name}=[redacted]` : "[redacted]");
  }
  return out;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  // Cutting a buffer can split a multi-byte character; the replacement
  // character that produces is dropped rather than sent.
  const cut = buffer.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return { value: cut, truncated: true };
}

/** Redacts, drops what that leaves empty, and cuts to the caller's budget. */
export function clean(value: string | null, maxBytes: number, state: { truncated: boolean }): string | null {
  if (value === null) return null;
  const redacted = redactAmbientText(value);
  if (!redacted.trim()) return null;
  const cut = truncateUtf8(redacted, maxBytes);
  if (cut.truncated) state.truncated = true;
  return cut.value;
}

/**
 * A failure string safe to send to the control plane.
 *
 * Absolute paths are removed rather than redacted in place: ADR 0016 keeps
 * a remote machine's real paths on that machine, and an error message is not
 * an exception to that.
 */
export function sanitizeFailure(failure: unknown): string {
  const raw = failure instanceof Error ? failure.message : String(failure);
  return redactAmbientText(raw)
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.@ -]+[\\/])+[\w.@ -]*/g, "<path>")
    .slice(0, 512);
}
