import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderGitStatus, isGitRepo, parsePorcelain, runGit } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("folder-read git operations", () => {
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
});
