import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderWriteLockPath, restoreFolderFile, writeFolderFile } from "../src/write.js";

/**
 * A save checks names once; another writer of the same checkout (an Agent in
 * its workspace) can then swap a checked directory for a link. These tests
 * park a real save between its check and its mutation — by holding the
 * cross-process write lock it waits on — swap the directory, and release.
 * The save must refuse, and nothing outside the root may change.
 */
let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "rainver-write-race-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Holds the lock a save of `relative` waits on; resolves the hold when released. */
async function holdLock(relative: string, holderPid = process.pid): Promise<{ path: string; release: () => Promise<void> }> {
  const path = folderWriteLockPath(`${root}\u0000${join(root, relative)}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(path);
  await writeFile(join(path, "holder"), `${holderPid} ${Date.now()}`);
  return { path, release: () => rm(path, { recursive: true, force: true }) };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function swapSubForOutsideLink(): Promise<void> {
  await rename(join(root, "sub"), join(root, "sub-real"));
  await symlink(outside, join(root, "sub"));
}

describe("Folder writes under a concurrent directory swap", () => {
  it("does not create a new file through a directory swapped for a link", async () => {
    const lock = await holdLock("sub/new.txt");
    const save = writeFolderFile(root, "sub/new.txt", "user text", { expectedExists: false, expectedSha256: null });
    await settle();
    await swapSubForOutsideLink();
    await lock.release();
    await expect(save).rejects.toMatchObject({ code: "path_forbidden" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not create new directories through a swapped link", async () => {
    const lock = await holdLock("sub/deep/er/new.txt");
    const save = writeFolderFile(root, "sub/deep/er/new.txt", "user text", { expectedExists: false, expectedSha256: null });
    await settle();
    await swapSubForOutsideLink();
    await lock.release();
    await expect(save).rejects.toMatchObject({ code: "path_forbidden" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not overwrite a same-named file the link points at", async () => {
    await writeFile(join(root, "sub", "file.txt"), "before");
    await writeFile(join(outside, "file.txt"), "before");
    const lock = await holdLock("sub/file.txt");
    const save = writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") });
    await settle();
    await swapSubForOutsideLink();
    await lock.release();
    await expect(save).rejects.toMatchObject({ code: "path_forbidden" });
    expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("before");
    expect(await readdir(outside)).toEqual(["file.txt"]);
  });

  it("does not remove a file through a swapped link on restore", async () => {
    await writeFile(join(root, "sub", "file.txt"), "before");
    await writeFile(join(outside, "file.txt"), "before");
    const lock = await holdLock("sub/file.txt");
    const restore = restoreFolderFile(root, "sub/file.txt", null, { expectedExists: true, expectedSha256: sha("before") });
    await settle();
    await swapSubForOutsideLink();
    await lock.release();
    await expect(restore).rejects.toMatchObject({ code: "path_forbidden" });
    expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("before");
  });

  it("does not write through a final component swapped for a link", async () => {
    await writeFile(join(root, "sub", "file.txt"), "before");
    await writeFile(join(outside, "target.txt"), "outside");
    const lock = await holdLock("sub/file.txt");
    const save = writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") });
    await settle();
    await rm(join(root, "sub", "file.txt"));
    await symlink(join(outside, "target.txt"), join(root, "sub", "file.txt"));
    await lock.release();
    await expect(save).rejects.toMatchObject({ code: "path_forbidden" });
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside");
  });

  it("still saves, keeps the mode, creates directories, and reports a stale preimage", async () => {
    await writeFile(join(root, "sub", "run.sh"), "#!/bin/sh\n");
    await chmod(join(root, "sub", "run.sh"), 0o755);
    const saved = await writeFolderFile(root, "sub/run.sh", "#!/bin/sh\necho hi\n", { expectedExists: true, expectedSha256: sha("#!/bin/sh\n") });
    expect(saved.before).toEqual({ path: "sub/run.sh", exists: true, content: "#!/bin/sh\n", sha256: sha("#!/bin/sh\n") });
    expect((await stat(join(root, "sub", "run.sh"))).mode & 0o777).toBe(0o755);
    await writeFolderFile(root, "a/b/c.md", "new", { expectedExists: false, expectedSha256: null });
    expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("new");
    await expect(writeFolderFile(root, "sub/run.sh", "x", { expectedExists: true, expectedSha256: sha("old") })).rejects.toMatchObject({ code: "stale" });
    // No temporary file is left behind.
    expect((await readdir(join(root, "sub"))).filter((name) => name.includes(".rainver-write-"))).toEqual([]);
  });
});

describe("Folder write lock", () => {
  it("lives in a private per-user directory, not a shared predictable /tmp name", async () => {
    await writeFolderFile(root, "sub/x.txt", "x", { expectedExists: false, expectedSha256: null });
    const directory = dirname(folderWriteLockPath("anything"));
    const info = await stat(directory);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
    expect(directory).not.toBe(tmpdir());
  });

  it("does not take over a live holder's lock however old, and recovers once the holder is gone", async () => {
    const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    try {
      const lock = await holdLock("sub/live.txt", holder.pid!);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(lock.path, old, old);
      let settled = false;
      const save = writeFolderFile(root, "sub/live.txt", "x", { expectedExists: false, expectedSha256: null }).finally(() => { settled = true; });
      await settle(400);
      expect(settled).toBe(false);
      expect((await stat(lock.path)).isDirectory()).toBe(true);
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.once("exit", resolve));
      await expect(save).resolves.toMatchObject({ exists: true });
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
