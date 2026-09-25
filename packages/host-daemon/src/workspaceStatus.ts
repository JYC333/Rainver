import { stat } from "node:fs/promises";
import { runLocationGit } from "@rainver/folder-read";

export interface WorkspaceStatusReport {
  location_id: string;
  branch: string | null;
  git_head: string | null;
  dirty: boolean | null;
  execution_ready: boolean;
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    // An Agent may have written this checkout's `.git/`; nothing it planted
    // there may run as the daemon (`runLocationGit`).
    const result = await runLocationGit(args, cwd, 5_000);
    return result.code === 0 ? result.stdout.trim() || null : null;
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
      git(["status", "--porcelain"], root),
    ]);
    return {
      location_id: locationId,
      branch,
      git_head: head,
      dirty: status !== null && status.length > 0,
      execution_ready: true,
    };
  }));
}
