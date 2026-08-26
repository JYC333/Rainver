import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { workspaceAdd } from "../src/commands/workspace.js";

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-host-ws-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  await saveConfig({ server_url: "http://127.0.0.1:1", host_id: "h", token: "t", workspaces: {} });
});
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

describe("workspace add", () => {
  it("refuses a path that does not exist or is not a directory before telling the server anything", async () => {
    await expect(workspaceAdd({ path: join(configDir, "missing"), projectId: "p", name: "n" })).rejects.toThrow(/does not exist/);
    await writeFile(join(configDir, "file.txt"), "x");
    await expect(workspaceAdd({ path: join(configDir, "file.txt"), projectId: "p", name: "n" })).rejects.toThrow(/Not a directory/);
  });
});
