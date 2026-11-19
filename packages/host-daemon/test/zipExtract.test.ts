import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZip } from "../src/zipExtract.js";

/**
 * The registry publishes zips (Antigravity, for one) and a stock Linux image
 * has no `unzip`; extraction is in process so that an install depends on
 * nothing the machine may lack. These are the properties `unzip` gave that
 * an install relies on, plus the one it did not: a path-escaping entry.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rainver-zip-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const unixAttrs = (mode: number) => mode << 16;

async function archiveOf(entries: Parameters<typeof zipSync>[0]): Promise<string> {
  const path = join(dir, "archive");
  await writeFile(path, zipSync(entries));
  return path;
}

describe("extractZip", () => {
  it("writes files with the Unix mode the archive carries, directories, and symlinks", async () => {
    const archive = await archiveOf({
      "agy_acp_server.par": [new TextEncoder().encode("#!/bin/sh\necho hi\n"), { attrs: unixAttrs(0o100755) }],
      "lib/data.txt": [new TextEncoder().encode("data"), { attrs: unixAttrs(0o100644) }],
      "empty/": [new Uint8Array(0), { attrs: unixAttrs(0o040755) }],
      "link": [new TextEncoder().encode("agy_acp_server.par"), { attrs: unixAttrs(0o120777) }],
      "plain.txt": new TextEncoder().encode("no attrs at all"),
    });
    const out = join(dir, "out");
    await extractZip(archive, out);

    expect((await stat(join(out, "agy_acp_server.par"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(out, "lib/data.txt"))).mode & 0o777).toBe(0o644);
    expect(await readFile(join(out, "lib/data.txt"), "utf8")).toBe("data");
    expect((await stat(join(out, "empty"))).isDirectory()).toBe(true);
    expect(await readlink(join(out, "link"))).toBe("agy_acp_server.par");
    // No attribute word: a plain readable file, not an unreadable or executable one.
    expect(await readFile(join(out, "plain.txt"), "utf8")).toBe("no attrs at all");
    expect((await stat(join(out, "plain.txt"))).mode & 0o111).toBe(0);
  });

  it("refuses an entry that would land outside the destination", async () => {
    const archive = await archiveOf({ "../escape.txt": new TextEncoder().encode("x") });
    const out = join(dir, "out");
    // yauzl refuses the name at the central directory; the extractor's own
    // check stands behind it for a name yauzl lets through (an absolute path).
    await expect(extractZip(archive, out)).rejects.toThrow(/invalid relative path|escapes the tool directory/);
    await expect(stat(join(dir, "escape.txt"))).rejects.toThrow();
  });

  it("streams a file larger than one chunk intact", async () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const archive = await archiveOf({ "big.bin": big });
    const out = join(dir, "out");
    await extractZip(archive, out);
    const extracted = await readFile(join(out, "big.bin"));
    expect(extracted.length).toBe(big.length);
    expect(extracted.equals(Buffer.from(big))).toBe(true);
  });

  describe("refuses writing through links (the archive is untrusted content)", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const link = (target: string) => [text(target), { attrs: unixAttrs(0o120777) }] as [Uint8Array, { attrs: number }];

    it("does not write through a link the archive itself created to a directory outside", async () => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      const archive = await archiveOf({ "a": link("../outside"), "a/f": [text("pwned"), { attrs: unixAttrs(0o107777) }] });
      const out = join(dir, "out");
      await expect(extractZip(archive, out)).rejects.toThrow(/link/i);
      expect(await readdir(outside)).toEqual([]);
    });

    it("does not write through a link nested below a contained one", async () => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      const archive = await archiveOf({ "sub/": [new Uint8Array(0), { attrs: unixAttrs(0o040755) }], "sub/l": link("../../outside"), "sub/l/f": text("pwned") });
      await expect(extractZip(archive, join(dir, "out"))).rejects.toThrow(/link/i);
      expect(await readdir(outside)).toEqual([]);
    });

    it("refuses a link whose target leaves the destination, absolute or relative", async () => {
      for (const target of ["../outside", "/etc", "sub/../../outside", "C:\\Windows", "\\\\server\\share"]) {
        const out = join(dir, `out-${Math.random().toString(16).slice(2)}`);
        const archive = await archiveOf({ "keep.txt": text("k"), "l": link(target) });
        await expect(extractZip(archive, out), target).rejects.toThrow(/link/i);
        // A failed extraction leaves nothing it created behind.
        expect(await readdir(out).catch(() => [])).toEqual([]);
      }
    });

    it("refuses a link that escapes only through another link resolved later", async () => {
      // "x" is lexically contained while "d" is missing; "d" -> "." makes it root/../outside.
      const archive = await archiveOf({ "x": link("d/../../outside"), "d": link(".") });
      await expect(extractZip(archive, join(dir, "out"))).rejects.toThrow(/link/i);
      const archive2 = await archiveOf({ "x": link("d/../outside"), "d": link(".") });
      await expect(extractZip(archive2, join(dir, "out2"))).rejects.toThrow(/link/i);
    });

    it("does not follow a link already present in the destination", async () => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      const out = join(dir, "out");
      await mkdir(out);
      await symlink(outside, join(out, "pre"));
      const archive = await archiveOf({ "pre/f": text("pwned") });
      await expect(extractZip(archive, out)).rejects.toThrow(/link/i);
      const archive2 = await archiveOf({ "pre": text("replace the link") });
      await expect(extractZip(archive2, out)).rejects.toThrow(/exist/i);
      expect(await readdir(outside)).toEqual([]);
      expect((await lstat(join(out, "pre"))).isSymbolicLink()).toBe(true);
    });

    it("refuses duplicate entries instead of overwriting, and non-file types", async () => {
      // fflate's object form cannot hold a duplicate name; an equivalent case is
      // a file after a directory of the same name, and a file over a pre-existing file.
      const out = join(dir, "out");
      await mkdir(out);
      await writeFile(join(out, "archive-like"), "original");
      await expect(extractZip(await archiveOf({ "archive-like": text("over") }), out)).rejects.toThrow(/exist/i);
      expect(await readFile(join(out, "archive-like"), "utf8")).toBe("original");
      await expect(extractZip(await archiveOf({ "d/": [new Uint8Array(0), { attrs: unixAttrs(0o040755) }], "d/x": text("1"), "fifo": [new Uint8Array(0), { attrs: unixAttrs(0o010644) }] }), join(dir, "o2"))).rejects.toThrow(/type/i);
    });

    it("a failed extraction removes only what it created, never content already in the destination", async () => {
      const out = join(dir, "out");
      await mkdir(join(out, "keep"), { recursive: true });
      await writeFile(join(out, "keep", "user.txt"), "user");
      const archive = await archiveOf({ "keep/new.txt": text("n"), "fresh/deep/a.txt": text("a"), "l": link("../outside") });
      await expect(extractZip(archive, out)).rejects.toThrow(/link/i);
      expect((await readdir(out)).sort()).toEqual(["keep"]);
      expect(await readdir(join(out, "keep"))).toEqual(["user.txt"]);
      expect(await readFile(join(out, "keep", "user.txt"), "utf8")).toBe("user");
    });

    it("drops setuid, setgid and sticky bits but keeps the executable bit", async () => {
      const archive = await archiveOf({ "bin": [text("#!/bin/sh\n"), { attrs: unixAttrs(0o107755) }] });
      const out = join(dir, "out");
      await extractZip(archive, out);
      expect((await stat(join(out, "bin"))).mode & 0o7777).toBe(0o755);
    });

    it("keeps contained links, including ones that climb within the tree and chain", async () => {
      const archive = await archiveOf({
        "lib/tool": [text("#!/bin/sh\n"), { attrs: unixAttrs(0o100755) }],
        "bin/tool": link("../lib/tool"),
        "Versions/A/x": text("x"),
        "Versions/Current": link("A"),
        "x": link("Versions/Current/x"),
      });
      const out = join(dir, "out");
      await extractZip(archive, out);
      expect(await readFile(join(out, "x"), "utf8")).toBe("x");
      expect(await readlink(join(out, "bin/tool"))).toBe("../lib/tool");
    });
  });
});
