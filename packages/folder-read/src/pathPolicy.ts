import { relative, resolve, sep } from "node:path";

const FORBIDDEN_DIR_NAMES = new Set([".ssh", ".aws", ".gcp", ".azure", "credentials"]);
const FORBIDDEN_DIR_SEQUENCES = [
  ["instance", "secrets"],
  ["config", "secrets"],
] as const;
const FORBIDDEN_FILE_NAMES = new Set([".env", "id_rsa", "id_ed25519"]);
const ALLOWED_ENV_TEMPLATE_NAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dev.example",
  ".env.test.example",
  ".env.prod.example",
]);
const FORBIDDEN_FILE_SUFFIXES = new Set([".pem", ".key"]);
const FORBIDDEN_WRITE_SUFFIXES = new Set([".py", ".sh", ".bash", ".zsh", ".fish"]);

export class PathPolicyError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export interface PathPolicyInput {
  path: string;
  allowedRoot: string;
  mode?: "read" | "write";
  /** Protected Folders forbid direct .git access — use the worktree sandbox instead. */
  protectedFolder?: boolean;
  forTrustedCodePatchApply?: boolean;
}

/**
 * Checks the transport-level path contract shared by the server and daemon.
 * Traversal segments remain for the daemon's registered-root PathPolicy to
 * reject, but absolute paths must never cross the control-plane wire.
 */
export function isWireRelativePath(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !/^[A-Za-z]:/.test(value);
}

export function validatePath(input: PathPolicyInput): string {
  const mode = input.mode ?? "read";
  const root = resolve(input.allowedRoot);
  const candidate = resolve(input.path);
  if (!isInside(candidate, root)) {
    throw new PathPolicyError(
      `Path traversal denied: '${candidate}' is not under '${root}'`,
    );
  }

  const rel = relative(root, candidate);
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
  const lowerParts = parts.map((part) => part.toLowerCase());
  for (const part of lowerParts) {
    if (FORBIDDEN_DIR_NAMES.has(part)) {
      throw new PathPolicyError(`Access to '${part}' is forbidden`);
    }
  }
  for (const sequence of FORBIDDEN_DIR_SEQUENCES) {
    for (let i = 0; i <= lowerParts.length - sequence.length; i += 1) {
      if (sequence.every((part, offset) => lowerParts[i + offset] === part)) {
        throw new PathPolicyError(`Access to '${sequence.join("/")}' is forbidden`);
      }
    }
  }
  if (
    lowerParts.length >= 2
    && lowerParts[lowerParts.length - 2] === ".git"
    && lowerParts[lowerParts.length - 1] === "config"
  ) {
    throw new PathPolicyError("Access to '.git/config' is forbidden");
  }

  const filename = lowerParts[lowerParts.length - 1] ?? "";
  if (FORBIDDEN_FILE_NAMES.has(filename)) {
    throw new PathPolicyError(`Access to '${filename}' is forbidden`);
  }
  if (filename.startsWith(".env.") && !ALLOWED_ENV_TEMPLATE_NAMES.has(filename)) {
    throw new PathPolicyError(`Access to '${filename}' is forbidden`);
  }
  const suffix = fileSuffix(filename);
  if (FORBIDDEN_FILE_SUFFIXES.has(suffix)) {
    throw new PathPolicyError(`Access to '${suffix}' files is forbidden`);
  }
  if (
    mode === "write"
    && input.forTrustedCodePatchApply !== true
    && FORBIDDEN_WRITE_SUFFIXES.has(suffix)
  ) {
    throw new PathPolicyError(
      `Agents may not write '${suffix}' files directly - use a code_patch Proposal instead`,
    );
  }
  if (input.protectedFolder && lowerParts.includes(".git")) {
    throw new PathPolicyError(
      "protected Folder: direct access to .git is forbidden - use git worktree sandbox for all operations",
    );
  }
  return candidate;
}

export function isInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.startsWith("/"));
}

export function looksSecretLikePath(path: string | null | undefined): boolean {
  if (!path) return false;
  return /(^|\/)(\.env($|\.)|id_rsa$|id_ed25519$|secrets?\.[^/]+$|[^/]+\.(pem|key)$|\.ssh\/|\.aws\/|config\/secrets\/)/i
    .test(path);
}

/**
 * The second implementation of one rule, and it has to stay a second one.
 *
 * `server/src/modules/runs/evidenceRedaction.ts` decides what a secret looks
 * like in free text everywhere else. This runs inside `@rainver/folder-read`,
 * which ships in the host daemon as well as the server, and the daemon cannot
 * import server code — so the rule is shared and the code is not. **Change both
 * together.** They diverged once already: this copy kept `\b(token|secret)\b`
 * after the server's was fixed, and `\b` does not fire between `_` and a
 * letter, so a diff line reading `access_token = "ghp_…"` or
 * `client_secret = "GOCSPX-…"` went to the reader and into the persisted
 * `remote_diff` in the clear.
 *
 * Two passes, because a diff needs both. The name pass catches
 * `access_token = "…"` whatever the value looks like; the shape pass catches a
 * credential whose variable name gives nothing away — `const key =
 * "sk-proj-…"` is the ordinary way an API key is hard-coded, and no rule about
 * names will ever see it — and a bare `?key=` in a URL.
 *
 * A value that is exactly one of the words a process uses to say a credential
 * is *absent* is left alone, the same way and for the same reason as the
 * server's: redacting `password: none` hides the answer and protects nothing.
 */
export function redactSecretLikeDiff(diff: string): { diff: string; redacted: boolean } {
  let redacted = false;
  // A credential word anywhere in the name, not only at a `\b` boundary:
  // `access_token`, `x-api-key`, `client_secret`, `token_hash`. Anchored with a
  // lookbehind and bounded on both sides rather than led by a greedy `[\w.-]*`,
  // which made the same shape quadratic on one long line.
  const keyPattern =
    /(?<![\w.-])[\w.-]{0,64}?(api[_-]?key|token(?!s)|secret|password|passwd|credential|private[_-]?key)[\w.-]{0,64}?["']?\s*([:=])(?!\s*(?:absent|none|null|unset|missing|empty|true|false|set|present|redacted|nil)(?:$|[\s,;}"']))\s*/gi;
  let next = "";
  let cursor = 0;
  for (let match = keyPattern.exec(diff); match; match = keyPattern.exec(diff)) {
    const valueStart = keyPattern.lastIndex;
    // A list or an object is redacted whole, not scanned for a scalar inside
    // it. Taking the first element out left the rest dangling —
    // `credentials: []` came out as `credentials:[REDACTED]]` and
    // `secrets: [1,2]` as `secrets:[REDACTED],2]`, which is a mangled diff
    // rather than a redacted one. Whole, because the alternative is deciding
    // which elements of `api_key: ["…"]` are the credential, and over-redacting
    // a list somebody named `credentials` costs a reader nothing they cannot
    // get from the file itself. An empty one has nothing to redact.
    const valueEnd = isStructureStart(diff[valueStart])
      ? scanStructuredValue(diff, valueStart)
      : scanSecretValue(diff, valueStart);
    // Nothing inside is nothing to hide: `credentials: []` saying
    // `credentials:[REDACTED]` tells a reader something was there when it
    // was not.
    if (!/[^\s[\]{}]/.test(diff.slice(valueStart, valueEnd))) {
      keyPattern.lastIndex = valueStart + 1;
      continue;
    }
    next += diff.slice(cursor, match.index);
    // The whole matched name, not just the credential word inside it: printing
    // `match[1]` alone turned `access_token=` into `token=[REDACTED]` and lost
    // which field it was.
    const separatorAt = match[0].lastIndexOf(match[2]!);
    next += `${match[0].slice(0, separatorAt)}${match[2]}[REDACTED]`;
    cursor = valueEnd;
    keyPattern.lastIndex = valueEnd;
    redacted = true;
  }
  next += diff.slice(cursor);
  // The shapes that need no name beside them. Same set as the server's, minus
  // the `Bearer`/`Basic` scheme words, which belong to a log line rather than
  // to source code.
  for (const shape of SECRET_SHAPES) {
    next = next.replace(shape, () => {
      redacted = true;
      return "[REDACTED]";
    });
  }
  return { diff: next, redacted };
}

const SECRET_SHAPES = [
  // A query parameter, where the name may be a bare `key` — a hard-coded
  // `https://api.example.com/v1?key=OPAQUE` has neither a credential word in
  // front of it nor a recognisable shape.
  /[?&](?:key|api[_-]?key|access[_-]?token|token|secret|password)=(?!(?:absent|none|null|unset|missing|empty|true|false|set|present|redacted|nil)(?:$|[\s&]))[^&\s"']+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // A JSON Web Token: three base64url segments. Its payload is the identity.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
];

function isStructureStart(character: string | undefined): boolean {
  return character === "[" || character === "{";
}

/**
 * The end of a bracketed value, counting depth and skipping quoted strings so a
 * bracket inside a string does not close it. An unterminated structure ends the
 * line, which is the most a single diff line can tell us anyway.
 */
function scanStructuredValue(text: string, start: number): number {
  const open = text[start]!;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\n") return index;
    if (character === '"' || character === "'") {
      index = skipQuoted(text, index);
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/** The index of a quoted run's closing quote, honouring backslash escapes. */
function skipQuoted(text: string, start: number): number {
  const quote = text[start]!;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") { index += 1; continue; }
    if (text[index] === quote) return index;
    if (text[index] === "\n") return index - 1;
  }
  return text.length;
}

function scanSecretValue(text: string, start: number): number {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') {
    let index = start;
    while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index += 1;
    return index;
  }

  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\n" || character === "\r") return index;
    if (character !== quote) continue;
    let backslashes = 0;
    for (let previous = index - 1; previous >= start && text[previous] === "\\"; previous -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) continue;
    const next = text[index + 1];
    // If a malformed or partially escaped value has more token characters
    // immediately after this quote, keep scanning to avoid leaking its tail.
    if (next && !/[\s,}\]]/.test(next)) continue;
    return index + 1;
  }
  const lineBreak = text.indexOf("\n", start);
  const carriageReturn = text.indexOf("\r", start);
  if (lineBreak < 0) return carriageReturn < 0 ? text.length : carriageReturn;
  if (carriageReturn < 0) return lineBreak;
  return Math.min(lineBreak, carriageReturn);
}

export function diffTouchesSecretLikePath(diff: string): boolean {
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ") && !line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }
    if (looksSecretLikePath(line)) return true;
  }
  return false;
}

function fileSuffix(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index > 0 ? filename.slice(index) : "";
}

/**
 * Replaces local filesystem paths in free text with `<path>` so a failure
 * message can leave a machine without naming its directories. Shared by the
 * daemon (before a message goes on the wire) and the server (before a
 * daemon's message is shown), so the two never disagree about what a path
 * looks like. The character class is deliberately broad — valid names carry
 * `+`, parentheses, spaces, quotes and non-ASCII — while commas and angle
 * brackets act as delimiters, and the look-behind keeps an `https://` tail
 * from reading as a path.
 */
export function redactLocalPaths(text: string): string {
  return text.replace(
    /['"]?(?:[A-Za-z]:[\\/]|\\\\|(?<![A-Za-z0-9:/])\/(?!\/))[^\r\n<>;,\u0000]*/g,
    "<path>",
  );
}
