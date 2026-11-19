import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A pinned directory handle follows its directory when that directory, or one
 * above it, is renamed out of the root. These tests run a real save on a real
 * filesystem and move a directory out at an exact point inside it: the real
 * `fs/promises` call the save makes is wrapped so the "attacker" acts right
 * after the temporary file exists (before the pre-rename proof) or right after
 * the rename (inside the window that proof cannot close). No production hook.
 */
const attack = vi.hoisted(() => ({
  afterTemporary: null as null | (() => Promise<void>),
  afterRename: null as null | (() => Promise<void>),
  /** A removal moved the checked file aside and has not yet proved its directory. */
  afterAside: null as null | (() => Promise<void>),
  /** The undo removed the save's own file and has not yet put the preimage back. */
  afterUndoRemoved: null as null | (() => Promise<void>),
  /** Fail the undo's own steps (putting the preimage back), as a full disk or EIO would. */
  failUndo: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const once = async (key: "afterTemporary" | "afterRename" | "afterAside" | "afterUndoRemoved") => {
    const step = attack[key];
    attack[key] = null;
    await step?.();
  };
  const injected = () => Object.assign(new Error("EIO: injected undo failure"), { code: "EIO" });
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      if (attack.failUndo && String(args[0]).includes(".rainver-undo-")) throw injected();
      const handle = await real.open(...args);
      if (String(args[0]).includes(".rainver-write-")) await once("afterTemporary");
      return handle;
    },
    link: async (from: string, to: string) => {
      if (attack.failUndo && String(from).includes(".rainver-preimage-")) throw injected();
      await real.link(from, to);
    },
    rename: async (from: string, to: string) => {
      await real.rename(from, to);
      if (String(from).includes(".rainver-write-")) await once("afterRename");
      if (String(to).includes(".rainver-remove-")) await once("afterAside");
    },
    unlink: async (path: string) => {
      await real.unlink(path);
      if (String(path).includes(".rainver-undo-")) await once("afterUndoRemoved");
    },
  };
});

const fs = await vi.importActual<typeof FsPromises>("node:fs/promises");
const { restoreFolderFile, writeFolderFile } = await import("../src/write.js");

let base: string;
let root: string;
let outside: string;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "rainver-write-move-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await fs.mkdir(join(root, "sub"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(root, "sub", "file.txt"), "before");
});

afterEach(async () => {
  attack.afterTemporary = attack.afterRename = attack.afterAside = attack.afterUndoRemoved = null;
  attack.failUndo = false;
  await fs.rm(base, { recursive: true, force: true });
});

/** Move `root/<relative>` to `outside/<relative's name>`; optionally leave a link to it in its place. */
const moveOut = (relative: string, name: string, leaveLink: boolean) => async () => {
  await fs.rename(join(root, relative), join(outside, name));
  if (leaveLink) await fs.symlink(join(outside, name), join(root, relative));
};

const leftovers = async (directory: string) => (await fs.readdir(directory)).filter((name) => name.includes(".rainver-"));

describe.runIf(process.platform === "linux")("Folder writes when a pinned directory leaves the root", () => {
  it("refuses before the rename when the parent was moved outside and replaced by a link", async () => {
    attack.afterTemporary = moveOut("sub", "sub", true);
    await expect(writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("before");
    expect(await leftovers(join(outside, "sub"))).toEqual([]);
    expect((await fs.lstat(join(root, "sub"))).isSymbolicLink()).toBe(true);
  });

  it("refuses before the rename when an ancestor, not the parent, was moved outside", async () => {
    await fs.mkdir(join(root, "a", "b"), { recursive: true });
    await fs.writeFile(join(root, "a", "b", "file.txt"), "before");
    attack.afterTemporary = moveOut("a", "a", false);
    await expect(writeFolderFile(root, "a/b/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    expect(await fs.readFile(join(outside, "a", "b", "file.txt"), "utf8")).toBe("before");
    expect(await leftovers(join(outside, "a", "b"))).toEqual([]);
  });

  it("detects a move that lands the rename outside, undoes it there and reports failure", async () => {
    attack.afterRename = moveOut("sub", "sub", true);
    await expect(writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("before");
    expect(await leftovers(join(outside, "sub"))).toEqual([]);
  });

  it("removes a new file it placed in a directory that moved out, leaving that directory's own files", async () => {
    attack.afterRename = moveOut("sub", "sub", false);
    await expect(writeFolderFile(root, "sub/new.txt", "user text", { expectedExists: false, expectedSha256: null }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    expect((await fs.readdir(join(outside, "sub"))).sort()).toEqual(["file.txt"]);
  });

  it("puts the very same removed file (inode, mode) back when the removal landed in a directory that moved out", async () => {
    await fs.chmod(join(root, "sub", "file.txt"), 0o600);
    const original = await fs.stat(join(root, "sub", "file.txt"));
    attack.afterAside = moveOut("sub", "sub", true);
    await expect(restoreFolderFile(root, "sub/file.txt", null, { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    const back = await fs.stat(join(outside, "sub", "file.txt"));
    expect([back.ino, back.mode & 0o777]).toEqual([original.ino, 0o600]);
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("before");
    expect(await leftovers(join(outside, "sub"))).toEqual([]);
  });

  it("does not put a removed file over a file another writer created there; keeps it aside and says where", async () => {
    attack.afterAside = async () => {
      await moveOut("sub", "sub", false)();
      await fs.writeFile(join(outside, "sub", "file.txt"), "theirs");
    };
    const failure = restoreFolderFile(root, "sub/file.txt", null, { expectedExists: true, expectedSha256: sha("before") });
    await expect(failure).rejects.toMatchObject({ code: "write_failed", message: expect.stringMatching(/kept as file\.txt\.rainver-remove-.*outside\/sub/) });
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("theirs");
    const [aside] = await leftovers(join(outside, "sub"));
    expect(await fs.readFile(join(outside, "sub", aside!), "utf8")).toBe("before");
  });

  it("puts back the preimage's own inode and 0600 mode, not a re-created 0644 copy", async () => {
    await fs.chmod(join(root, "sub", "file.txt"), 0o600);
    const original = await fs.stat(join(root, "sub", "file.txt"));
    attack.afterRename = moveOut("sub", "sub", false);
    await expect(writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    const back = await fs.stat(join(outside, "sub", "file.txt"));
    expect([back.ino, back.mode & 0o777, back.nlink]).toEqual([original.ino, 0o600, 1]);
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("before");
    expect(await leftovers(join(outside, "sub"))).toEqual([]);
  });

  it("leaves a file another writer put at the name after the move alone, and keeps the preimage as evidence", async () => {
    attack.afterRename = async () => {
      await moveOut("sub", "sub", false)();
      await fs.writeFile(join(outside, "sub", "theirs.tmp"), "theirs");
      await fs.rename(join(outside, "sub", "theirs.tmp"), join(outside, "sub", "file.txt"));
    };
    const theirsWritten = writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") });
    await expect(theirsWritten).rejects.toMatchObject({ code: "write_failed", message: expect.stringMatching(/replaced by another writer.*previous version is kept as file\.txt\.rainver-preimage-/) });
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("theirs");
    const [preimage] = await leftovers(join(outside, "sub"));
    expect(await fs.readFile(join(outside, "sub", preimage!), "utf8")).toBe("before");
  });

  it("does not put the preimage over a new file another writer created while the undo ran", async () => {
    attack.afterRename = moveOut("sub", "sub", false);
    attack.afterUndoRemoved = () => fs.writeFile(join(outside, "sub", "file.txt"), "theirs");
    await expect(writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "write_failed", message: expect.stringMatching(/another writer created a new file\.txt.*kept as/) });
    expect(await fs.readFile(join(outside, "sub", "file.txt"), "utf8")).toBe("theirs");
    const [preimage] = await leftovers(join(outside, "sub"));
    expect(await fs.readFile(join(outside, "sub", preimage!), "utf8")).toBe("before");
  });

  it("reports an undo that failed instead of claiming nothing was saved, and keeps the preimage", async () => {
    attack.afterRename = moveOut("sub", "sub", false);
    attack.failUndo = true;
    await expect(writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") }))
      .rejects.toMatchObject({ code: "write_failed", message: expect.stringMatching(/could not be fully undone.*previous version is kept as/) });
    const [preimage] = await leftovers(join(outside, "sub"));
    expect(await fs.readFile(join(outside, "sub", preimage!), "utf8")).toBe("before");
  });

  it("a save with no interference lands at the root path", async () => {
    await fs.chmod(join(root, "sub", "file.txt"), 0o600);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(join(root, "sub", "file.txt"), old, old);
    const saved = await writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha("before") });
    const info = await fs.stat(join(root, "sub", "file.txt"));
    expect([info.mode & 0o777, info.nlink]).toEqual([0o600, 1]);
    expect(info.mtimeMs).toBeGreaterThan(old.getTime());
    expect(await leftovers(join(root, "sub"))).toEqual([]);
    expect(saved.before).toEqual({ path: "sub/file.txt", exists: true, content: "before", sha256: sha("before") });
    expect(await fs.readFile(join(root, "sub", "file.txt"), "utf8")).toBe("after");
    const removed = await restoreFolderFile(root, "sub/file.txt", null, { expectedExists: true, expectedSha256: sha("after") });
    expect(removed.before).toEqual({ path: "sub/file.txt", exists: true, content: "after", sha256: sha("after") });
    expect(await fs.readdir(join(root, "sub"))).toEqual([]);
  });
});
