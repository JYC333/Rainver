import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocationGit } from "@rainver/folder-read";

// The well-known SHA-1 hash of an empty tree, constant across every git
// repository — the baseline for a repository with no commits yet.
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function isGitWorkTree(cwd: string): Promise<boolean> {
  const isRepo = await runLocationGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return isRepo.code === 0 && isRepo.stdout.trim() === "true";
}

/**
 * Write the working tree — tracked and untracked, `.gitignore` respected —
 * as a git tree object and return its id, through a private index file so
 * the repository's own index is never read or written. The blobs and the
 * tree land in the object store unreferenced, exactly as `git stash create`
 * leaves them, and `git gc` prunes them on its usual schedule. `timeoutMs`
 * bounds each git step; a Task worktree's settle gives it far longer than a
 * Run's diff baseline gets. `baseTree` seeds the private index instead of
 * HEAD: the result is then that tree with the working tree's own changes on
 * top, and what `add --all` cannot pick up again (a submodule's commit, a
 * force-added ignored file) stays as the base has it.
 */
export async function captureWorkspaceTree(cwd: string, timeoutMs = 30_000, baseTree?: string): Promise<string | null> {
  if (!(await isGitWorkTree(cwd))) return null;
  const indexDir = await mkdtemp(join(tmpdir(), "rainver-host-index-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  try {
    const hasHead = baseTree ? { code: 0 } : await runLocationGit(["rev-parse", "--verify", "HEAD"], cwd);
    if (hasHead.code === 0) {
      const read = await runLocationGit(["read-tree", baseTree ?? "HEAD"], cwd, timeoutMs, { env });
      if (read.code !== 0) return null;
    }
    const add = await runLocationGit(["add", "--all"], cwd, timeoutMs, { env });
    if (add.code !== 0) return null;
    const tree = await runLocationGit(["write-tree"], cwd, timeoutMs, { env });
    if (tree.code !== 0) return null;
    return tree.stdout.trim() || null;
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/**
 * The Run's bounded review artifact: a unified diff of what changed in the
 * working tree *during this Run*, from the tree captured before its process
 * started (`captureWorkspaceTree`) to the tree now. Without a baseline —
 * a launch that could not capture one — it falls back to the tree against
 * HEAD, which is every uncommitted change in the directory, not this Run's.
 *
 * Earlier this was always `git diff HEAD`, staged through the repository's
 * own index: a later recipient's diff repeated every earlier Agent's and the
 * person's uncommitted edits, and the capture's `git reset` dropped whatever
 * the person had staged. Oversized-file exclusion is not done here — git
 * elides binary content, and the upload endpoint truncates the whole payload
 * by size (`MAX_DIFF_BYTES`); that is the one place the cap lives.
 */
export async function captureWorkspaceDiff(
  cwd: string,
  baselineTree: string | null = null,
): Promise<string | null> {
  if (!(await isGitWorkTree(cwd))) return null;
  const afterTree = await captureWorkspaceTree(cwd);
  if (!afterTree) return null;
  let base = baselineTree;
  if (!base) {
    const hasHead = await runLocationGit(["rev-parse", "--verify", "HEAD"], cwd);
    base = hasHead.code === 0 ? "HEAD" : EMPTY_TREE_HASH;
  }
  const diff = await runLocationGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, afterTree], cwd);
  return diff.code === 0 ? diff.stdout : null;
}

/**
 * Where the checkout stands: `rev-parse --abbrev-ref HEAD` and
 * `rev-parse HEAD`, the same reads a heartbeat reports for a Location
 * (`workspaceStatus.ts`), so the control plane compares like with like. Null
 * outside a git checkout and before the first commit.
 */
export async function captureGitHead(cwd: string): Promise<{ branch: string | null; head: string } | null> {
  if (!(await isGitWorkTree(cwd))) return null;
  const [branch, head] = await Promise.all([
    runLocationGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    runLocationGit(["rev-parse", "HEAD"], cwd),
  ]);
  const commit = head.code === 0 ? head.stdout.trim() : "";
  if (!commit) return null;
  return { branch: branch.code === 0 ? branch.stdout.trim() || null : null, head: commit };
}
