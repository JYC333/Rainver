import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import {
  archiveManagedWorkspace,
  ensureManagedWorkspace,
  listManagedWorkspaces,
  managedWorkspacePath,
  restoreManagedWorkspace,
  sweepManagedWorkspaceArchives,
} from "../src/managedWorkspaces.js";
import { handleLaunch } from "../src/execution.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-managed-workspaces-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  await saveConfig({ server_url: "http://127.0.0.1:1", host_id: "host-1", token: "token", workspaces: {} });
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("managed workspaces", () => {
  it("derives a private per-container cwd and keeps it after a run", async () => {
    const frames: Record<string, unknown>[] = [];
    await handleLaunch({
      run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      workspace: { kind: "managed", agent_id: AGENT_ID, container: { kind: "room", id: ROOM_ID } },
      argv: ["sh", "-c", "pwd; printf managed > marker.txt"],
    }, (frame) => frames.push(frame), () => {});
    await new Promise<void>((resolve) => {
      const poll = () => frames.some((frame) => frame.type === "complete") ? resolve() : setTimeout(poll, 10);
      poll();
    });
    const path = managedWorkspacePath(AGENT_ID, { kind: "room", id: ROOM_ID });
    expect(frames.filter((frame) => frame.type === "output").map((frame) => frame.chunk).join("" )).toContain(path);
    expect(existsSync(join(path, "marker.txt"))).toBe(true);
  });

  it("archives, restores, reports and sweeps a container without exposing paths", async () => {
    const container = { kind: "room" as const, id: ROOM_ID };
    const path = await ensureManagedWorkspace(AGENT_ID, container);
    await writeFile(join(path, "work.txt"), "keep");
    expect(await archiveManagedWorkspace(AGENT_ID, container)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await listManagedWorkspaces()).toEqual([{
      agent_id: AGENT_ID,
      container_kind: "room",
      container_id: ROOM_ID,
      archived_available: true,
    }]);
    expect(await restoreManagedWorkspace(AGENT_ID, container)).toBe(true);
    expect(existsSync(join(path, "work.txt"))).toBe(true);
    await expect(restoreManagedWorkspace(AGENT_ID, container)).rejects.toThrow(/already exists/);
    await archiveManagedWorkspace(AGENT_ID, container);
    const archive = (await import("node:fs/promises")).readdir(join(stateDir, "agents", AGENT_ID, "rooms"));
    const archivePath = join(stateDir, "agents", AGENT_ID, "rooms", (await archive)[0]!);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(archivePath, old, old);
    expect(await sweepManagedWorkspaceArchives()).toBe(1);
    expect(existsSync(archivePath)).toBe(false);
  });

  it("rejects path-like identifiers before joining them", async () => {
    await expect(ensureManagedWorkspace("../escape", { kind: "room", id: ROOM_ID })).rejects.toThrow(/UUID-like/);
    await expect(ensureManagedWorkspace(AGENT_ID, { kind: "room", id: "../../escape" })).rejects.toThrow(/UUID-like/);
  });
});
