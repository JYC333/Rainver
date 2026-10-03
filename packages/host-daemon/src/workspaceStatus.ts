import { stat } from "node:fs/promises";
import { runLocationGit } from "@rainver/folder-read";

interface WorkspaceStatusReport {
  location_id: string;
  branch: string | null;
  git_head: string | null;
  dirty: boolean | null;
  execution_ready: boolean;
}

/** A command's trimmed output, or `null` when it failed, timed out, or printed nothing. */
async function git(args: string[], cwd: string): Promise<string | null> {
  const result = await gitResult(args, cwd);
  return result === null ? null : result.trim() || null;
}

/**
 * A command's raw output, or `null` when it failed or timed out. Unlike
 * `git`, an empty answer stays an empty string: for `status --porcelain`
 * that is a clean work tree, where `null` is one it could not read.
 */
async function gitResult(args: string[], cwd: string): Promise<string | null> {
  try {
    // An Agent may have written this checkout's `.git/`; nothing it planted
    // there may run as the daemon (`runLocationGit`).
    const result = await runLocationGit(args, cwd, 5_000);
    return result.code === 0 && !result.incomplete ? result.stdout : null;
  } catch {
    return null;
  }
}

export async function collectWorkspaceStatus(
  workspaces: Record<string, string>,
): Promise<WorkspaceStatusReport[]> {
  return Promise.all(Object.entries(workspaces).map(async ([locationId, root]) => {
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) {
      return { location_id: locationId, branch: null, git_head: null, dirty: null, execution_ready: false };
    }
    const isRepo = (await git(["rev-parse", "--is-inside-work-tree"], root)) === "true";
    if (!isRepo) {
      return { location_id: locationId, branch: null, git_head: null, dirty: null, execution_ready: true };
    }
    const [branch, head, status] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"], root),
      git(["rev-parse", "HEAD"], root),
      gitResult(["status", "--porcelain"], root),
    ]);
    return {
      location_id: locationId,
      branch,
      git_head: head,
      // Unknown (`null`) when status failed or ran out of time: reporting
      // that as clean would hide real local changes behind a stale index
      // lock or a slow repository.
      dirty: status === null ? null : status.trim().length > 0,
      execution_ready: true,
    };
  }));
}
