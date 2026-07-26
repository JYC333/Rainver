/**
 * Run-scope ephemeral sandbox: a system-provisioned throwaway working directory
 * for a file-access CLI adapter that has no persistent workspace bound. This is
 * the first rung of the working-directory scope ladder (none -> ephemeral ->
 * session -> project -> worktree); `worktree` is now owned by the workspace
 * manager in `modules/projectFolders/sandbox.ts`.
 *
 * The directory lives under the shared sandbox root (same root as worktrees),
 * is isolated per run, and is removed on every terminal path (success, failure,
 * cancel). It is NOT a git repo and carries no persistent workspace — adapter
 * output is materialized to artifacts before teardown, so removing the dir never
 * loses history (B18: sandboxes are short-lived execution areas).
 */
import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export type WorkingDirScope = "none" | "ephemeral" | "read_only" | "worktree";

/** Cleanup kind marking a server-owned ephemeral dir. */
export const EPHEMERAL_CLEANUP_KIND = "ephemeral_ts";

/** Map a resolved `required_sandbox_level` to its working-directory scope. */
export function workingDirScopeForLevel(
  level: string | null | undefined,
): WorkingDirScope {
  if (level === "ephemeral") return "ephemeral";
  if (level === "read_only") return "read_only";
  if (level === "worktree" || level === "one_shot_docker") return "worktree";
  return "none";
}

function ephemeralRoot(sandboxRoot: string): string {
  return resolve(sandboxRoot, "ephemeral");
}

/** Refuse any path that resolves outside the ephemeral root (path-escape guard). */
function ensureUnderRoot(child: string, root: string): void {
  const r = resolve(root);
  const c = resolve(child);
  if (c !== r && !c.startsWith(r + sep)) {
    throw new Error("ephemeral sandbox path escapes sandbox root");
  }
}

/** Create and return the isolated ephemeral working dir for a run. */
export async function prepareEphemeralDir(
  sandboxRoot: string,
  spaceId: string,
  runId: string,
): Promise<string> {
  const root = ephemeralRoot(sandboxRoot);
  const dir = resolve(root, spaceId, runId);
  ensureUnderRoot(dir, root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove an ephemeral working dir; no-op when absent. Confined to the root. */
export async function removeEphemeralDir(
  sandboxRoot: string,
  dir: string | null | undefined,
): Promise<void> {
  if (!dir) return;
  const root = ephemeralRoot(sandboxRoot);
  ensureUnderRoot(dir, root);
  await rm(dir, { recursive: true, force: true });
  // Best-effort prune of the now-empty per-space parent so empty space dirs
  // don't accumulate. rmdir only removes it when empty (concurrent runs in the
  // same space keep siblings, so ENOTEMPTY is expected and ignored).
  const parent = dirname(dir);
  if (parent !== root && parent.startsWith(root + sep)) {
    await rmdir(parent).catch(() => {});
  }
}
