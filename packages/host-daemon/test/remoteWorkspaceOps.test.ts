import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirectories, forgetWorkspace } from "../src/remoteWorkspaceOps.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-remote-ws-"));
  await mkdir(join(root, "beta"));
  await mkdir(join(root, "alpha"));
  await writeFile(join(root, "file.txt"), "not a directory\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.RAINVER_HOST_CONFIG_DIR;
});

describe("remote workspace ops", () => {
  it("lists one level of subdirectories, sorted, without files", async () => {
    const result = await listDirectories(root);
    expect(result).toMatchObject({ ok: true, path: root, dirs: ["alpha", "beta"], truncated: false });
    expect(result.parent).toBeTruthy();
  });

  it("refuses relative, missing, and non-directory paths", async () => {
    expect((await listDirectories("relative/path")).ok).toBe(false);
    expect((await listDirectories(join(root, "missing"))).ok).toBe(false);
    expect((await listDirectories(join(root, "file.txt"))).ok).toBe(false);
    expect((await listDirectories("\u0000bad")).ok).toBe(false);
  });

  it("forgets a workspace mapping from the local config only", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rainver-host-config-"));
    process.env.RAINVER_HOST_CONFIG_DIR = configDir;
    await writeFile(join(configDir, "config.json"), JSON.stringify({
      server_url: "http://unused", host_id: "host-1", token: "t", workspaces: { "loc-1": root },
    }));
    await expect(forgetWorkspace("loc-1")).resolves.toMatchObject({ ok: true, changed: true });
    await expect(forgetWorkspace("loc-1")).resolves.toMatchObject({ ok: true, changed: false });
    await rm(configDir, { recursive: true, force: true });
  });
});
