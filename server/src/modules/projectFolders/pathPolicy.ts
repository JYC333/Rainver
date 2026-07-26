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
    lowerParts.length >= 2 &&
    lowerParts[lowerParts.length - 2] === ".git" &&
    lowerParts[lowerParts.length - 1] === "config"
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
    mode === "write" &&
    input.forTrustedCodePatchApply !== true &&
    FORBIDDEN_WRITE_SUFFIXES.has(suffix)
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

export function redactSecretLikeDiff(diff: string): { diff: string; redacted: boolean } {
  let redacted = false;
  const next = diff.replace(
    /(api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*([^\s'"]+)/gi,
    (_match, key: string) => {
      redacted = true;
      return `${key}=[REDACTED]`;
    },
  );
  return { diff: next, redacted };
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
