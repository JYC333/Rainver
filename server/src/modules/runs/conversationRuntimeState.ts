import { lstat, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const CONVERSATION_RUNTIME_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PreparedConversationRuntimeState {
  home_dir: string;
  cwd: string;
  resume: boolean;
}

function validatedStateKey(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("conversation runtime state key must be a UUID");
  }
  return value;
}

function underRoot(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const child = resolve(base, ...parts);
  if (!child.startsWith(`${base}${sep}`)) {
    throw new Error("conversation runtime state path escapes its root");
  }
  return child;
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function ensureRealDirectoryChain(
  root: string,
  parts: string[],
): Promise<string> {
  const base = resolve(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(base);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`conversation runtime root '${base}' is not a real directory`);
  }
  let current = base;
  for (let index = 0; index < parts.length; index += 1) {
    current = underRoot(base, ...parts.slice(0, index + 1));
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`conversation runtime path '${current}' contains a symlink`);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}

async function stateRoots(input: {
  rainver_home: string;
  sandbox_root: string;
}): Promise<{ homes: string; sandboxes: string; conversationSandboxes: string }> {
  const [homes, sandboxes, conversationSandboxes] = await Promise.all([
    ensureRealDirectoryChain(input.rainver_home, [
      "cache",
      "conversation-runtime-homes",
    ]),
    ensureRealDirectoryChain(input.sandbox_root, ["conversation-runtime-state"]),
    ensureRealDirectoryChain(input.sandbox_root, ["conversation-sessions"]),
  ]);
  return { homes, sandboxes, conversationSandboxes };
}

export async function prepareConversationRuntimeState(input: {
  rainver_home: string;
  sandbox_root: string;
  state_key: string;
  resume_requested: boolean;
  conversation_id?: string | null;
}): Promise<PreparedConversationRuntimeState> {
  const stateKey = validatedStateKey(input.state_key);
  const roots = await stateRoots(input);
  const homeDir = underRoot(roots.homes, stateKey);
  const sandboxStateDir = underRoot(roots.sandboxes, stateKey);
  const conversationId = input.conversation_id ? validatedStateKey(input.conversation_id) : null;
  const cwd = conversationId
    ? underRoot(roots.conversationSandboxes, conversationId, "workspace")
    : underRoot(sandboxStateDir, "workspace");
  const resume = input.resume_requested
    && await realDirectory(homeDir)
    && await realDirectory(cwd);
  if (!resume) {
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(sandboxStateDir, { recursive: true, force: true }),
      ...(conversationId ? [] : [rm(cwd, { recursive: true, force: true })]),
    ]);
    await Promise.all([
      ensureRealDirectoryChain(roots.homes, [stateKey]),
      ...(conversationId ? [ensureRealDirectoryChain(roots.sandboxes, [stateKey])] : []),
      ensureRealDirectoryChain(
        conversationId ? roots.conversationSandboxes : roots.sandboxes,
        conversationId ? [conversationId, "workspace"] : [stateKey, "workspace"],
      ),
    ]);
  }
  await ensureRealDirectoryChain(roots.sandboxes, [stateKey]);
  const now = new Date();
  await Promise.all([
    utimes(homeDir, now, now),
    utimes(sandboxStateDir, now, now),
  ]);
  return { home_dir: homeDir, cwd, resume };
}

export async function removeConversationRuntimeState(input: {
  rainver_home: string;
  sandbox_root: string;
  state_key: string;
}): Promise<void> {
  const stateKey = validatedStateKey(input.state_key);
  const roots = await stateRoots(input);
  await Promise.all([
    rm(underRoot(roots.homes, stateKey), { recursive: true, force: true }),
    rm(underRoot(roots.sandboxes, stateKey), { recursive: true, force: true }),
  ]);
}

export async function sweepConversationRuntimeState(input: {
  rainver_home: string;
  sandbox_root: string;
  protected_state_keys: ReadonlySet<string>;
  retention_ms?: number;
  now?: Date;
}): Promise<number> {
  const roots = await stateRoots(input);
  const cutoff = (input.now ?? new Date()).getTime()
    - (input.retention_ms ?? CONVERSATION_RUNTIME_STATE_RETENTION_MS);
  const keys = new Set<string>([
    ...(await readdir(roots.homes)),
    ...(await readdir(roots.sandboxes)),
  ].filter((entry) => {
    try {
      validatedStateKey(entry);
      return true;
    } catch {
      return false;
    }
  }));
  let removed = 0;
  for (const stateKey of keys) {
    if (input.protected_state_keys.has(stateKey)) continue;
    const timestamps = await Promise.all([
      stateTimestamp(underRoot(roots.homes, stateKey)),
      stateTimestamp(underRoot(roots.sandboxes, stateKey)),
    ]);
    const newest = Math.max(...timestamps.filter((value): value is number => value !== null));
    if (newest >= cutoff) continue;
    await removeConversationRuntimeState({ ...input, state_key: stateKey });
    removed += 1;
  }
  return removed;
}

async function stateTimestamp(path: string): Promise<number | null> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink()
      ? stats.mtimeMs
      : Number.NEGATIVE_INFINITY;
  } catch {
    return null;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
