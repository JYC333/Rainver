import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * macOS refuses a link in one `open` but has no directory-relative rename or
 * removal in Node, so a pathname rename/unlink after the check would follow a
 * link swapped in meanwhile. Folder writes there fail closed with a reason;
 * nothing is created, replaced or removed.
 */
vi.mock("../src/safeOpen.js", () => ({ safeOpenCapability: async () => ({ kind: "darwin_nofollow_any" }) }));
const { restoreFolderFile, writeFolderFile } = await import("../src/write.js");

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rainver-write-darwin-")));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "file.txt"), "before");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Folder writes on macOS", () => {
  it("refuse saves, new files and removals with an explicit reason, changing nothing", async () => {
    const sha = createHash("sha256").update("before").digest("hex");
    const refused = { code: "write_failed", message: expect.stringMatching(/not supported on macOS/) };
    await expect(writeFolderFile(root, "sub/file.txt", "after", { expectedExists: true, expectedSha256: sha })).rejects.toMatchObject(refused);
    await expect(writeFolderFile(root, "sub/new.txt", "x", { expectedExists: false, expectedSha256: null })).rejects.toMatchObject(refused);
    await expect(restoreFolderFile(root, "sub/file.txt", null, { expectedExists: true, expectedSha256: sha })).rejects.toMatchObject(refused);
    expect(await readFile(join(root, "sub", "file.txt"), "utf8")).toBe("before");
    expect(await readdir(join(root, "sub"))).toEqual(["file.txt"]);
  });
});
