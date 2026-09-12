const FORBIDDEN_EVIDENCE_KEYS = new Set([
  "api_key",
  "secret_ref",
  "encrypted_key",
  "credential_secret_ref",
  "secret",
  "authorization",
  "cookie",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "private_key",
  "rendered_context",
  "context_text",
  "private_memory_text",
  "raw_private_memory",
  "raw_memory_text",
  "full_patch",
  "patch",
  "diff",
  "file_content",
  "raw_file_content",
  "stdout",
  "stderr",
]);

/**
 * What a secret looks like in free text.
 *
 * The rule is deliberately eager: over-redacting a Run's evidence costs a line
 * of diagnostics, and under-redacting persists someone's key. Three shapes of
 * miss are why each group is written the way it is.
 *
 * - `\b` does not fire between `_` and a letter, so a name-anchored pattern
 *   that began `\b(token|secret)` never matched `access_token=`,
 *   `refresh_token=`, `id_token=` or `client_secret=`. The name now allows any
 *   leading word characters, which also catches `x-api-key` and `MY_API_KEY`.
 * - A quoted JSON key puts a `"` between the name and the colon, so
 *   `"api_key": "sk-…"` went through untouched. The quote is optional now.
 * - A URL carries `?key=` with no `api` in front of it, and Google's own keys
 *   are `AIza…`. Both are matched on their own.
 */
const SECRET_VALUE_PATTERNS = [
  // Shapes that need no name beside them.
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // A JSON Web Token: three base64url segments. Its payload is the identity.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // `Bearer` is a scheme name: in a log the next word is the credential.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // `Basic` is also an English adjective, so this one asks for something that
  // is not a letter — base64 of `user:pass` always has one, and "Basic
  // authentication failed" is the diagnostic a person reads to understand a
  // failed Run. A bare `Token` alternative is left out for the same reason;
  // `token=` is covered by the name-anchored pattern below.
  /\bBasic\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=_-])[A-Za-z0-9._~+/=-]{12,}/gi,
  // `name = value`, where a credential word appears anywhere in the name —
  // `access_token`, `x-api-key`, `secret_ref`, `token_hash`.
  //
  // `token` but not `tokens`: every plural spelling a provider writes is a usage
  // count — `input_tokens=1204`, `max_tokens: 4096`, `total_tokens = 51200` —
  // and those ride back to the person inside a model's own answer and inside
  // job error text. A count is not a credential, and redacting it takes away
  // the number someone is reading to understand what a Run spent.
  //
  // The trade, both ways, since neither side is free. It gives up the plural
  // *credential* spellings — `access_tokens=`, `refresh_tokens=` — which no
  // provider uses for a single credential and which `FORBIDDEN_EVIDENCE_KEYS`
  // still covers for structured values. And it does not reach the singular
  // count spellings: `token_count` and Gemini's `totalTokenCount` are still
  // redacted, which is over-redaction of a diagnostic, not a leak.
  //
  // The lookbehind is load-bearing, not style. Written as a leading `[\w.-]*`
  // this was quadratic: at every start position the engine consumed to the end
  // of the line and backtracked one character at a time, so 64 KiB of one line
  // — which a Custom Source handler can print, and which `customSourceRunner`
  // passes here whole — took 8.6 seconds on the single event loop. Anchored,
  // the same input is unmeasurable.
  //
  // A value that is exactly one of the words a process uses to say a credential
  // is *not* there is left alone: redacting `secret: absent` hides the answer
  // and protects nothing. Exactly, not by prefix — `password=nil-8f3a9c2b1d` is
  // a secret that starts with one of those words.
  /(?<![\w.-])[\w.-]{0,64}?(?:api[_-]?key|secret|token(?!s)|password|passwd|credential)[\w.-]{0,64}?["']?\s*[:=]\s*["']?(?!(?:absent|none|null|unset|missing|empty|true|false|set|present|redacted|nil)(?:$|[\s,;}"']))[^"',;\s}&]+/gi,
  // A query parameter, where the name may be a bare `key`.
  /[?&](?:key|api[_-]?key|access[_-]?token|token|secret|password)=(?!(?:absent|none|null|unset|missing|empty|true|false|set|present|redacted|nil)(?:$|[\s&]))[^&\s"']+/gi,
];

/** Maximum size for persisted free-form evidence text. */
export const MAX_EVIDENCE_TEXT_CHARS = 32_000;

/** Applies only the secret-pattern substitutions, with no length truncation. */
export function redactSecretPatterns(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, "[REDACTED_SECRET]");
  }
  return out;
}

/**
 * How far past the cut the scan still reads.
 *
 * Longer than any secret shape here, so a credential straddling the cut is
 * matched whole rather than left as a prefix too short for the `{12,}` and
 * `{20,}` floors to catch.
 */
const REDACTION_OVERSCAN_CHARS = 256;

export function redactEvidenceText(value: string | null | undefined): string | null {
  if (value == null) return null;
  // Truncate before scanning. Only what is kept is ever persisted, so scanning
  // the part about to be thrown away buys nothing and costs the scan — a 1 MiB
  // error string used to be matched in full before this line ran.
  if (value.length <= MAX_EVIDENCE_TEXT_CHARS) return redactSecretPatterns(value);
  const scanned = redactSecretPatterns(value.slice(0, MAX_EVIDENCE_TEXT_CHARS + REDACTION_OVERSCAN_CHARS));
  // Cutting *inside* the scanned window is safe: everything there was matched,
  // so a token split at this point has already had whatever redaction it was
  // going to get.
  if (scanned.length > MAX_EVIDENCE_TEXT_CHARS) {
    return `${scanned.slice(0, MAX_EVIDENCE_TEXT_CHARS)}...[truncated]`;
  }
  // Redaction shrank the text below the cap, so the whole window is kept and
  // its *far edge* becomes the boundary — the one place a secret can straddle
  // into text nothing scanned.
  const keepsWindowEdge = value.length > MAX_EVIDENCE_TEXT_CHARS + REDACTION_OVERSCAN_CHARS;
  const cut = keepsWindowEdge ? safeCutPoint(scanned) : scanned.length;
  return `${scanned.slice(0, cut)}...[truncated]`;
}

/**
 * Where the kept text may end when it ends at the scan window's far edge.
 *
 * Two boundaries can fall inside a secret, and each one hid the next. Cutting
 * at the cap before scanning left the head of a secret straddling the cap,
 * which no pattern is long enough to recognise — the overscan answered that.
 * But redaction *shrinks* the text, so a window that comes back under the cap
 * is kept whole, and its far edge is a second boundary of exactly the same
 * kind. Measured at the time: a JWT cut four characters into its signature kept
 * a payload that decodes to the subject's identity.
 *
 * So this cut backs off through whatever a credential is made of, leaving text
 * that ends at a character no secret contains — the cheap way to say "this is
 * not the front of something". Bounded, because an unbroken run that long is
 * not a straddling credential, and dropping the whole tail of a legitimate blob
 * would be its own kind of wrong.
 */
function safeCutPoint(scanned: string): number {
  let cut = scanned.length;
  const floor = Math.max(0, cut - REDACTION_OVERSCAN_CHARS);
  while (cut > floor && /[A-Za-z0-9_\-.+/=~]/.test(scanned[cut - 1]!)) cut -= 1;
  return cut;
}

export function sanitizeEvidenceJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") return redactEvidenceText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidenceJson(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.has(key.toLowerCase())) {
        out[key] = "[REDACTED_EVIDENCE_FIELD]";
      } else {
        out[key] = sanitizeEvidenceJson(child);
      }
    }
    return out;
  }
  return null;
}

export function sanitizeErrorJson(value: unknown): unknown {
  return sanitizeEvidenceJson(value ?? {});
}
