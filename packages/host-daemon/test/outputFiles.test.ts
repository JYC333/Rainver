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

it('collects raster bytes without UTF-8 corruption and refuses symlinks and unsupported binary', async () => {
  const { symlink } = await import('node:fs/promises');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(dir, 'preview.png'), png);
  await writeFile(join(dir, 'unknown.bin'), Buffer.from([0, 255, 2]));
  await symlink(join(dir, 'preview.png'), join(dir, 'linked.png'));
  await mkdir(join(dir, '.ssh'));
  await writeFile(join(dir, '.ssh', 'secret.txt'), 'private');
  const files = await collectOutputFiles(dir);
  expect(files).toEqual([{ name: 'preview.png', content: png.toString('base64'), encoding: 'base64' }]);
});

it('bounds collection by file count and skips oversize output', async () => {
  await writeFile(join(dir, '000-too-big.txt'), 'x'.repeat(2 * 1024 * 1024));
  for (let i = 0; i < 23; i++) await writeFile(join(dir, `${i}.txt`), 'text');
  const files = await collectOutputFiles(dir);
  expect(files).toHaveLength(20);
  expect(files.some(file => file.name === '000-too-big.txt')).toBe(false);
});
