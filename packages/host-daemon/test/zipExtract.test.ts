import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
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
});
