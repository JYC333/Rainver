import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitRepository, folderGitDiff, folderGitStatus, isGitRepo, parsePorcelain, runGit, runLocationGit } from "../src/index.js";

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
    expect(parsePorcelain(" M changed.ts\n?? new.ts\nD  old.ts\n")).toEqual([
      { path: "changed.ts", status: "modified" },
      { path: "new.ts", status: "untracked" },
      { path: "old.ts", status: "deleted" },
    ]);
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
