import { runLocationGit } from "@rainver/folder-read";

/**
 * The branch a Location's work lands on (ADR 0016 §11): the short name `origin/HEAD` points at, then `main`, then
 * `master` — the first that exists as a *local* branch — and failing all of
 * them whatever the checkout has checked out (its branch, or its commit when
 * HEAD is detached or on a Task branch, with `branch: null`). Nothing is fetched or pushed: a
 * remote is only asked which of its branches it calls HEAD, as it was last
 * recorded locally.
 *
 * Every git call goes through `runLocationGit`: the repository is one an
 * Agent may have written.
 */
export interface MainBranch {
  /** Short branch name (`main`), or null for a detached checkout. */
  branch: string | null;
  commit: string;
}

export async function resolveMainBranch(repoRoot: string): Promise<MainBranch | null> {
  const candidates: string[] = [];
  const originHead = await runLocationGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoRoot);
  const prefix = "refs/remotes/origin/";
  const target = originHead.code === 0 ? originHead.stdout.trim() : "";
  if (target.startsWith(prefix) && target.length > prefix.length) candidates.push(target.slice(prefix.length));
  candidates.push("main", "master");
  for (const name of candidates) {
    const commit = await commitOfRef(repoRoot, `refs/heads/${name}`);
    if (commit) return { branch: name, commit };
  }
  const current = await runLocationGit(["symbolic-ref", "--quiet", "HEAD"], repoRoot);
  const currentRef = current.code === 0 ? current.stdout.trim() : "";
  const head = await commitOfRef(repoRoot, "HEAD");
  if (!head) return null;
  const branch = currentRef.startsWith("refs/heads/") ? currentRef.slice("refs/heads/".length) : null;
  // A Task's own branch is never anyone's main branch: a checkout that has
  // one checked out names no main branch (a merge then answers
  // `no_main_branch`; a new Task branch starts from its commit).
  return { branch: branch?.startsWith("rainver/task-") ? null : branch, commit: head };
}

/** The commit a ref (or any revision) names, or null when it names none. */
export async function commitOfRef(repoRoot: string, ref: string): Promise<string | null> {
  const result = await runLocationGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
  const commit = result.code === 0 ? result.stdout.trim() : "";
  return commit || null;
}
