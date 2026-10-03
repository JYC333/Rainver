import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import { workspaceAdd } from "../src/commands/workspace.js";

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-host-ws-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  await saveConfig({ server_url: "http://127.0.0.1:1", host_id: "h", token: "t", trust: "trusted", workspaces: {} });
});
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

describe("workspace add", () => {
  it("keeps every registration's path when two registrations overlap", async () => {
    // The server answers both registrations only once both have arrived, the
    // way two workspace_register frames handled at once reach it.
    const pending: Array<() => void> = [];
    const server: Server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const name = String(JSON.parse(body).name);
        pending.push(() => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: `ws-${name}`, project_id: "p", name, display_path: null, status: "active" }));
        });
        if (pending.length === 2) for (const answer of pending.splice(0)) answer();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await saveConfig({ server_url: `http://127.0.0.1:${port}`, host_id: "h", token: "t", trust: "trusted", workspaces: {} });
      await Promise.all([
        workspaceAdd({ path: configDir, projectId: "p", name: "b" }),
        workspaceAdd({ path: configDir, projectId: "p", name: "c" }),
      ]);
      expect((await loadConfig())?.workspaces).toEqual({ "ws-b": configDir, "ws-c": configDir });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a path that does not exist or is not a directory before telling the server anything", async () => {
    await expect(workspaceAdd({ path: join(configDir, "missing"), projectId: "p", name: "n" })).rejects.toThrow(/does not exist/);
    await writeFile(join(configDir, "file.txt"), "x");
    await expect(workspaceAdd({ path: join(configDir, "file.txt"), projectId: "p", name: "n" })).rejects.toThrow(/Not a directory/);
  });
});
