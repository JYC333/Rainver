import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectOutputFiles } from "../src/outputFiles.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rainver-host-outputs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectOutputFiles", () => {
  it("returns an empty array for a directory with no files", async () => {
    expect(await collectOutputFiles(dir)).toEqual([]);
  });

  it("returns an empty array for a directory that does not exist", async () => {
    expect(await collectOutputFiles(join(dir, "missing"))).toEqual([]);
  });

  it("collects nested files with paths relative to the root", async () => {
    await writeFile(join(dir, "report.md"), "# Report\n");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "notes.txt"), "notes\n");

    const files = await collectOutputFiles(dir);
    expect(files.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: join("nested", "notes.txt"), content: "notes\n" },
      { name: "report.md", content: "# Report\n" },
    ]);
  });
});
