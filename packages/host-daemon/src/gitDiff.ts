import { spawn } from "node:child_process";

// The well-known SHA-1 hash of an empty tree, constant across every git
// repository — used as the base for a repo with no commits yet, since
// `git diff --cached` compares index-to-tree content and would show nothing
// for an intent-to-add entry (its staged blob is deliberately empty; only a
// worktree-relative diff — `git diff <tree>`, the same mechanism `git diff
// HEAD` uses — reads the real file off disk for those paths).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: 1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/**
 * Phase-1 diff capture (control-center-plan.md §5): unified `git diff HEAD`
 * with untracked files staged via intent-to-add so their new content shows
 * up. This is the Run's bounded review artifact; live browse reads use the
 * read-only `folder_read` channel in `folderRead.ts`. Oversized-file exclusion is not done here — git
 * already elides binary content ("Binary files ... differ"), and the
 * upload endpoint truncates the whole payload by size (`MAX_DIFF_BYTES`);
 * that is the one place the cap lives.
 */
export async function captureWorkspaceDiff(cwd: string): Promise<string | null> {
  const isRepo = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (isRepo.code !== 0 || isRepo.stdout.trim() !== "true") return null;
  await runGit(["add", "--intent-to-add", "--all"], cwd);
  try {
    const hasHead = await runGit(["rev-parse", "--verify", "HEAD"], cwd);
    const diff = await runGit(["diff", hasHead.code === 0 ? "HEAD" : EMPTY_TREE_HASH], cwd);
    return diff.stdout;
  } finally {
    // Index-only: drops the intent-to-add entries without touching the
    // working tree, so the daemon leaves no trace of having looked.
    await runGit(["reset"], cwd);
  }
}
