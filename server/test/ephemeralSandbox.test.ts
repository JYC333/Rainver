import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EPHEMERAL_CLEANUP_KIND,
  prepareEphemeralDir,
  removeEphemeralDir,
  workingDirScopeForLevel,
} from "../src/modules/runs/ephemeralSandbox.js";

const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) {
    await removeEphemeralDir(r, join(r, "ephemeral", "x", "y")).catch(() => {});
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-root-"));
  roots.push(root);
  return root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("workingDirScopeForLevel", () => {
  it("maps levels to scopes", () => {
    expect(workingDirScopeForLevel("ephemeral")).toBe("ephemeral");
    expect(workingDirScopeForLevel("worktree")).toBe("worktree");
    expect(workingDirScopeForLevel("none")).toBe("none");
    expect(workingDirScopeForLevel("dry_run")).toBe("none");
    expect(workingDirScopeForLevel(null)).toBe("none");
  });
});

describe("ephemeral sandbox dir", () => {
  it("creates an isolated per-run dir under the ephemeral root", async () => {
    const root = await makeRoot();
    const dir = await prepareEphemeralDir(root, "space-1", "run-1");
    expect(dir).toBe(resolve(root, "ephemeral", "space-1", "run-1"));
    expect(await exists(dir)).toBe(true);
  });

  it("removes the dir and its contents, and prunes the empty space parent", async () => {
    const root = await makeRoot();
    const dir = await prepareEphemeralDir(root, "space-1", "run-2");
    await writeFile(join(dir, "scratch.txt"), "work");
    await removeEphemeralDir(root, dir);
    expect(await exists(dir)).toBe(false);
    // The now-empty per-space parent is pruned too.
    expect(await exists(resolve(root, "ephemeral", "space-1"))).toBe(false);
  });

  it("keeps the space parent when a sibling run dir still exists", async () => {
    const root = await makeRoot();
    const a = await prepareEphemeralDir(root, "space-1", "run-a");
    await prepareEphemeralDir(root, "space-1", "run-b");
    await removeEphemeralDir(root, a);
    expect(await exists(a)).toBe(false);
    // Sibling keeps the space dir alive (rmdir ENOTEMPTY is ignored).
    expect(await exists(resolve(root, "ephemeral", "space-1"))).toBe(true);
  });

  it("remove is a no-op for an absent dir / null", async () => {
    const root = await makeRoot();
    await expect(removeEphemeralDir(root, null)).resolves.toBeUndefined();
    await expect(
      removeEphemeralDir(root, resolve(root, "ephemeral", "s", "missing")),
    ).resolves.toBeUndefined();
  });

  it("refuses to remove a path outside the ephemeral root (escape guard)", async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await mkdir(outside, { recursive: true });
    await expect(removeEphemeralDir(root, outside)).rejects.toThrow(
      /escapes sandbox root/,
    );
    // The outside dir must still exist — it was never touched.
    expect(await exists(outside)).toBe(true);
  });

  it("exposes a server-owned cleanup kind", () => {
    expect(EPHEMERAL_CLEANUP_KIND).toBe("ephemeral_ts");
  });
});
