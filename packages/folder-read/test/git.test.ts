import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitRepository, folderGitDiff, folderGitStatus, isGitRepo, parsePorcelain, runGit, runLocationGit } from "../src/index.js";
import { MAX_FILES } from "../src/limits.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("folder-read git operations", () => {
  // First in the file: the module's first git call is the one that reads git's version.
  it("keeps working after its first call met a checkout that does not exist", async () => {
    const missing = join(tmpdir(), `rainver-folder-read-missing-${Date.now()}`);
    await runLocationGit(["status", "--porcelain"], missing).catch(() => undefined);
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-after-missing-"));
    roots.push(root);
    expect((await runGit(["init", "-q"], root)).code).toBe(0);
    expect((await runLocationGit(["status", "--porcelain"], root)).code).toBe(0);
  });

  it("parses porcelain statuses", () => {
    expect(parsePorcelain(" M changed.ts\0?? new.ts\0D  old.ts\0R  moved.ts\0was.ts\0")).toEqual([
      { path: "changed.ts", status: "modified" },
      { path: "new.ts", status: "untracked" },
      { path: "old.ts", status: "deleted" },
      { path: "moved.ts", status: "renamed" },
    ]);
  });

  it("reports a non-ASCII name and a rename by their real paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-status-names-"));
    roots.push(root);
    expect((await runGit(["init", "-q"], root)).code).toBe(0);
    await runGit(["config", "user.email", "test@example.invalid"], root);
    await runGit(["config", "user.name", "Test"], root);
    await mkdir(join(root, "文档"));
    await writeFile(join(root, "文档", "说明.md"), "before\n", "utf8");
    await writeFile(join(root, "old name.txt"), "same\n", "utf8");
    await runGit(["add", "."], root);
    await runGit(["commit", "-q", "-m", "initial"], root);
    await writeFile(join(root, "文档", "说明.md"), "after\n", "utf8");
    await runGit(["mv", "old name.txt", "new name.txt"], root);

    const status = await folderGitStatus(root);
    expect(status.files).toEqual(expect.arrayContaining([
      { path: "文档/说明.md", status: "modified" },
      { path: "new name.txt", status: "renamed" },
    ]));
    expect(status.files).toHaveLength(2);
  });

  it("marks a diff git did not finish as truncated rather than passing a prefix off as the whole", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-partial-diff-"));
    roots.push(root);
    await runGit(["init", "-q"], root);
    await runGit(["config", "user.email", "test@example.invalid"], root);
    await runGit(["config", "user.name", "Test"], root);
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    await runGit(["add", "."], root);
    await runGit(["commit", "-q", "-m", "initial"], root);
    await writeFile(join(root, "README.md"), "after\n", "utf8");

    // A git whose `diff` dies part-way through its output, the way a killed
    // (timed out) or failing one does; every other command is the real git.
    const fakeBin = join(root, "..", `${root.split("/").pop()}-bin`);
    roots.push(fakeBin);
    await mkdir(fakeBin);
    const realGitPath = execSync("command -v git", { encoding: "utf8" }).trim();
    await writeFile(join(fakeBin, "git"), [
      "#!/bin/sh",
      'case " $* " in',
      '  *" diff "*"--name-only"*) exec "' + realGitPath + '" "$@" ;;',
      '  *" diff "*) printf "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n"; exit 128 ;;',
      '  *) exec "' + realGitPath + '" "$@" ;;',
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });

    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
    try {
      const result = await folderGitDiff(root, "README.md");
      expect(result.diff).toContain("-before");
      expect(result.truncated).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("stops reading a command's output at the caller's limit and says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-output-cap-"));
    roots.push(root);
    await runGit(["init", "-q"], root);
    await runGit(["config", "user.email", "test@example.invalid"], root);
    await runGit(["config", "user.name", "Test"], root);
    await writeFile(join(root, "big.txt"), "a\n".repeat(200_000), "utf8");
    await runGit(["add", "."], root);
    await runGit(["commit", "-q", "-m", "initial"], root);
    await writeFile(join(root, "big.txt"), "b\n".repeat(200_000), "utf8");

    const result = await runGit(["diff", "--no-ext-diff"], root, 30_000, { maxOutputBytes: 64 * 1024 });
    expect(result.incomplete).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
  });

  it("uses a real git repository for status detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-git-"));
    roots.push(root);
    expect(await isGitRepo(root)).toBe(false);
    expect((await runGit(["init"], root)).code).toBe(0);
    await writeFile(join(root, "new.txt"), "new\n", "utf8");
    expect(await isGitRepo(root)).toBe(true);
    await expect(folderGitStatus(root)).resolves.toMatchObject({ is_repo: true, files: [{ path: "new.txt", status: "untracked" }] });
  });

  it("marks a status with more changes than the list holds as truncated, never as the whole tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-status-cap-"));
    roots.push(root);
    expect((await runGit(["init"], root)).code).toBe(0);
    await expect(folderGitStatus(root)).resolves.toMatchObject({ is_repo: true, files: [], truncated: false });
    await Promise.all(Array.from({ length: MAX_FILES + 1 }, (_, index) => writeFile(join(root, `f${index}.txt`), "x\n", "utf8")));
    const status = await folderGitStatus(root);
    expect(status.files).toHaveLength(MAX_FILES);
    expect(status.truncated).toBe(true);
  });

  it("initializes a managed directory without changing an existing repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-ensure-git-"));
    roots.push(root);

    await expect(ensureGitRepository(root)).resolves.toBe(true);
    await writeFile(join(root, "new.txt"), "new\n", "utf8");
    await expect(ensureGitRepository(root)).resolves.toBe(true);
    await expect(folderGitStatus(root)).resolves.toMatchObject({
      is_repo: true,
      files: [{ path: "new.txt", status: "untracked" }],
    });
  });

  it("creates one empty baseline without staging files or requiring an identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-managed-baseline-"));
    roots.push(root);
    await writeFile(join(root, "summary.md"), "existing work\n");
    await writeFile(join(root, ".env"), "PRIVATE=value\n");
    expect(await ensureGitRepository(root)).toBe(true);
    const before = (await runGit(["rev-parse", "HEAD"], root)).stdout;
    expect((await runGit(["ls-tree", "-r", "HEAD"], root)).stdout).toBe("");
    expect(existsSync(join(root, ".git", "index"))).toBe(false);
    expect(await ensureGitRepository(root)).toBe(true);
    expect((await runGit(["rev-parse", "HEAD"], root)).stdout).toBe(before);
    expect(await readFile(join(root, "summary.md"), "utf8")).toBe("existing work\n");
    expect((await runGit(["status", "--porcelain"], root)).stdout).toContain("?? summary.md");
  });

  it("creates an empty baseline preserving the staged index and bypassing hooks/signing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-managed-index-"));
    roots.push(root);
    await runGit(["init", "-q"], root);
    await writeFile(join(root, "staged.txt"), "staged\n");
    await runGit(["add", "staged.txt"], root);
    const index = await readFile(join(root, ".git", "index"));
    await writeFile(join(root, ".git", "hooks", "reference-transaction"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await runGit(["config", "commit.gpgSign", "true"], root);
    await runGit(["config", "gpg.program", "/nonexistent/rainver-signing"], root);
    expect(await ensureGitRepository(root)).toBe(true);
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect((await runGit(["ls-tree", "-r", "HEAD"], root)).stdout).toBe("");
    expect((await runGit(["diff", "--cached", "--name-only"], root)).stdout.trim()).toBe("staged.txt");
    // Existing real history and later user commits remain the selected baseline.
    await runLocationGit(["-c", "user.name=Person", "-c", "user.email=person@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "User work"], root);
    const tip = (await runGit(["rev-parse", "HEAD"], root)).stdout;
    expect(await ensureGitRepository(root)).toBe(true);
    expect((await runGit(["rev-parse", "HEAD"], root)).stdout).toBe(tip);
    expect((await runGit(["ls-tree", "-r", "--name-only", "HEAD"], root)).stdout.trim()).toBe("staged.txt");
  });

  it("does not replace corrupt, detached, redirected or previously populated repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-managed-refusal-"));
    roots.push(root);
    await runGit(["init", "-q"], root);
    const headPath = join(root, ".git", "HEAD");
    await writeFile(headPath, "0".repeat(40) + "\n");
    expect(await ensureGitRepository(root)).toBe(false);
    expect(await readFile(headPath, "utf8")).toBe("0".repeat(40) + "\n");
    await writeFile(headPath, "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "refs", "heads", "main"), "a".repeat(40) + "\n");
    expect(await ensureGitRepository(root)).toBe(false);
    await rm(join(root, ".git", "refs", "heads", "main"));
    expect(await ensureGitRepository(root)).toBe(true);
    await runGit(["symbolic-ref", "HEAD", "refs/heads/new-unborn"], root);
    expect(await ensureGitRepository(root)).toBe(false);
    await mkdir(join(root, "redirected"));
    await writeFile(join(root, "redirected", ".git"), "gitdir: ../.git\n");
    expect(await ensureGitRepository(join(root, "redirected"))).toBe(false);
    const alias = root + "-alias";
    roots.push(alias);
    await symlink(root, alias);
    expect(await ensureGitRepository(alias)).toBe(false);
  });

  it("lets concurrent initializers converge on a single root commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-managed-concurrent-"));
    roots.push(root);
    await runGit(["init", "-q"], root);
    expect(await Promise.all(Array.from({ length: 4 }, () => ensureGitRepository(root)))).toEqual([true, true, true, true]);
    expect((await runGit(["rev-list", "--count", "HEAD"], root)).stdout.trim()).toBe("1");
  });

  it("runs nothing an Agent planted in the checkout's own configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-untrusted-"));
    roots.push(root);
    const marker = (name: string) => join(root, "..", `${root.split("/").pop()}-${name}`);
    const git = async (args: string[]) => expect((await runGit(args, root)).code).toBe(0);
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=evil\n*.md filter=we=ird\n", "utf8");
    await writeFile(join(root, "a.txt"), "a\n", "utf8");
    await writeFile(join(root, "b.md"), "b\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "init"]);
    // Planted after the commit, as a Run would: a filter pair (one with a name
    // that `-c` would split at its `=`), an fsmonitor, and a hook.
    await git(["config", "filter.evil.clean", `touch '${marker("clean")}'; cat`]);
    await git(["config", "filter.evil.smudge", `touch '${marker("smudge")}'; cat`]);
    await git(["config", "filter.we=ird.clean", `touch '${marker("weird")}'; cat`]);
    await git(["config", "core.fsmonitor", `touch '${marker("fsmonitor")}'; false`]);
    await writeFile(join(root, "a.txt"), "changed\n", "utf8");
    await writeFile(join(root, "b.md"), "changed\n", "utf8");

    await expect(folderGitStatus(root)).resolves.toMatchObject({ is_repo: true });
    await folderGitDiff(root, null);
    expect((await runLocationGit(["add", "--all"], root)).code).toBe(0);
    expect((await runLocationGit(["checkout", "--", "a.txt"], root)).code).toBe(0);
    for (const name of ["clean", "smudge", "weird", "fsmonitor"]) expect(existsSync(marker(name)), name).toBe(false);
    // The same plant is live for git run the ordinary way.
    await writeFile(join(root, "a.txt"), "again\n", "utf8");
    await runGit(["add", "a.txt"], root);
    expect(existsSync(marker("clean"))).toBe(true);
    await rm(marker("clean"), { force: true });
    await rm(marker("fsmonitor"), { force: true });
  });

  it("never runs a nested repository's own filter driver to tell whether it is dirty", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-nested-"));
    roots.push(root);
    const marker = `${root}-nested-clean`;
    const git = async (args: string[], cwd: string) => expect((await runGit(args, cwd)).code).toBe(0);
    const inner = join(root, "inner");
    await mkdir(inner);
    for (const dir of [root, inner]) {
      await git(["init", "-q", "-b", "main"], dir);
      await git(["config", "user.email", "t@example.com"], dir);
      await git(["config", "user.name", "T"], dir);
    }
    await writeFile(join(inner, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(inner, "f.txt"), "one\n");
    await git(["add", "."], inner);
    await git(["commit", "-q", "-m", "inner"], inner);
    await git(["config", "filter.evil.clean", `touch '${marker}'; cat`], inner);
    await git(["add", "inner"], root);
    await git(["commit", "-q", "-m", "outer"], root);
    await writeFile(join(inner, "f.txt"), "two, and longer\n");

    expect((await runLocationGit(["status", "--porcelain"], root)).code).toBe(0);
    expect((await runLocationGit(["diff", "--name-status", "HEAD"], root)).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // A commit in the nested repository is still a change of this one.
    await git(["-c", "filter.evil.clean=cat", "commit", "-q", "-am", "inner 2"], inner);
    const moved = await runLocationGit(["diff", "--name-status", "HEAD"], root);
    expect(moved.stdout).toMatch(/^M\tinner$/m);
    expect(existsSync(marker)).toBe(false);
    // Asked to show that change as a full diff, git would run one inside the
    // nested repository, under its own configuration.
    const external = `${root}-nested-external`;
    await git(["config", "diff.external", `sh -c 'touch "${external}"'`], inner);
    await git(["config", "diff.submodule", "diff"], root);
    for (const args of [["diff"], ["diff", "HEAD"], ["diff", "--stat", "HEAD"], ["status"]]) {
      expect((await runLocationGit(args, root)).code).toBe(0);
    }
    expect(existsSync(external)).toBe(false);
    await rm(external, { force: true });
    await rm(marker, { force: true });
  });

  it("never recurses into nested repositories, whatever the checkout configures", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-recurse-"));
    roots.push(root);
    expect((await runGit(["init", "-q"], root)).code).toBe(0);
    expect((await runGit(["config", "submodule.recurse", "true"], root)).code).toBe(0);
    const effective = await runLocationGit(["config", "--get", "submodule.recurse"], root);
    expect(effective.stdout.trim()).toBe("false");
  });

  it("never lets a command start maintenance or gc under the checkout's own configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-gc-"));
    roots.push(root);
    expect((await runGit(["init", "-q"], root)).code).toBe(0);
    expect((await runGit(["config", "maintenance.auto", "true"], root)).code).toBe(0);
    expect((await runGit(["config", "gc.auto", "1"], root)).code).toBe(0);
    expect((await runLocationGit(["config", "--get", "maintenance.auto"], root)).stdout.trim()).toBe("false");
    expect((await runLocationGit(["config", "--get", "gc.auto"], root)).stdout.trim()).toBe("0");
  });

  it("refuses a checkout whose own configuration it cannot read, rather than running blind", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-badconfig-"));
    roots.push(root);
    expect((await runGit(["init", "-q"], root)).code).toBe(0);
    await writeFile(join(root, ".git", "config"), "[core\n\tbroken = \"unterminated\n");
    const result = await runLocationGit(["status", "--porcelain"], root);
    expect(result.code).toBe(128);
    expect(result.stderr).toMatch(/could not read this checkout's git configuration/);
  });

  it("refuses a checkout whose own configuration moves its work tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-folder-read-worktree-"));
    roots.push(root);
    expect((await runGit(["init", "-q"], root)).code).toBe(0);
    expect((await runGit(["config", "core.worktree", "/"], root)).code).toBe(0);
    const result = await runLocationGit(["status", "--porcelain"], root);
    expect(result.code).toBe(128);
    expect(result.stderr).toMatch(/core\.worktree/);
  });
});
