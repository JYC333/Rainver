import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import {
  archiveAgentProfiles,
  archiveLegacyProfileTree,
  archiveManagedWorkspace,
  ensureManagedWorkspace,
  listManagedWorkspaces,
  managedWorkspacePath,
  restoreManagedWorkspace,
  runtimeProfileContainerPath,
  sweepManagedWorkspaceArchives,
} from "../src/managedWorkspaces.js";
import { handleLaunch } from "../src/execution.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AGENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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
      launch_id: "launch-managed",
      workspace: { kind: "managed", agent_id: AGENT_ID, container: { kind: "direct", id: USER_ID } },
      argv: ["sh", "-c", "pwd; printf managed > marker.txt"],
    }, (frame) => frames.push(frame), () => {});
    await new Promise<void>((resolve) => {
      const poll = () => frames.some((frame) => frame.type === "complete") ? resolve() : setTimeout(poll, 10);
      poll();
    });
    const path = managedWorkspacePath(AGENT_ID, { kind: "direct", id: USER_ID });
    expect(frames.filter((frame) => frame.type === "output").map((frame) => frame.chunk).join("" )).toContain(path);
    expect(existsSync(join(path, "marker.txt"))).toBe(true);
  });

  it("archives, restores, reports and sweeps a container without exposing paths", async () => {
    const container = { kind: "direct" as const, id: USER_ID };
    const path = await ensureManagedWorkspace(AGENT_ID, container);
    await writeFile(join(path, "work.txt"), "keep");
    expect(await archiveManagedWorkspace(AGENT_ID, container, true)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await listManagedWorkspaces()).toEqual([{
      agent_id: AGENT_ID,
      container_kind: "direct",
      container_id: USER_ID,
      archived_available: true,
    }]);
    expect(await restoreManagedWorkspace(AGENT_ID, container, true)).toBe(true);
    expect(existsSync(join(path, "work.txt"))).toBe(true);
    await expect(restoreManagedWorkspace(AGENT_ID, container, true)).rejects.toThrow(/Already exists/);
    await archiveManagedWorkspace(AGENT_ID, container, true);
    const archive = (await import("node:fs/promises")).readdir(join(stateDir, "agents", AGENT_ID, "direct"));
    const archivePath = join(stateDir, "agents", AGENT_ID, "direct", (await archive)[0]!);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(archivePath, old, old);
    expect(await sweepManagedWorkspaceArchives()).toBe(1);
    expect(existsSync(archivePath)).toBe(false);
  });

  it("rejects path-like identifiers before joining them", async () => {
    await expect(ensureManagedWorkspace("../escape", { kind: "direct", id: USER_ID })).rejects.toThrow(/UUID-like/);
    await expect(ensureManagedWorkspace(AGENT_ID, { kind: "direct", id: "../../escape" })).rejects.toThrow(/UUID-like/);
  });

  it("archives an Agent's profile without the Conversation cwd another Agent still uses", async () => {
    // A Room the Agent was removed from while others stayed. Its own CLI state
    // — login, vendor sessions, auto-memory — has to go, or it walks into the
    // next Room; the shared cwd belongs to the Agents still in the Room.
    const container = { kind: "conversation" as const, id: CONVERSATION_ID };
    const cwd = await ensureManagedWorkspace(AGENT_ID, container);
    await writeFile(join(cwd, "shared.txt"), "still in use");
    const profile = runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);
    await mkdir(join(profile, "claude_code", "ambient", ".claude"), { recursive: true });
    await writeFile(join(profile, "claude_code", "ambient", ".claude", "memory.md"), "what I learned here");

    expect(await archiveManagedWorkspace(AGENT_ID, container, false)).toBe(true);

    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(cwd, "shared.txt"))).toBe(true);
  });

  it("clears every profile of one Agent and leaves the other Agent's and the workspaces alone", async () => {
    // `POST /agents/:id/host-state/reset` — "clear this Agent's CLI memory on
    // this host". Archived, not deleted: a person who ran it by mistake still
    // has what was there until the 30-day sweep.
    const cwd = await ensureManagedWorkspace(AGENT_ID, { kind: "direct", id: USER_ID });
    const mine = runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);
    const alsoMine = runtimeProfileContainerPath(AGENT_ID, "direct", USER_ID);
    const theirs = runtimeProfileContainerPath(OTHER_AGENT_ID, "conversation", CONVERSATION_ID);
    for (const path of [mine, alsoMine, theirs]) await mkdir(path, { recursive: true });

    expect(await archiveAgentProfiles(AGENT_ID)).toBe(true);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(alsoMine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(cwd)).toBe(true);
    // Nothing to clear reports so, rather than failing.
    expect(await archiveAgentProfiles(AGENT_ID)).toBe(false);
  });

  it("sweeps an archived profile on the same 30-day clock as a workspace", async () => {
    const profile = runtimeProfileContainerPath(AGENT_ID, "location", CONVERSATION_ID);
    await mkdir(profile, { recursive: true });
    await archiveAgentProfiles(AGENT_ID);
    const base = join(stateDir, "agents", AGENT_ID, "profiles", "location");
    const archived = join(base, (await readdir(base))[0]!);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(archived, old, old);

    expect(await sweepManagedWorkspaceArchives()).toBe(1);
    expect(existsSync(archived)).toBe(false);
  });

  it("archives the pre-Agent-keyed profiles tree and sweeps it on the same clock", async () => {
    // The old `profiles/<adapter>/<provider>` tree held one login and one
    // session store shared by every Agent on the machine, plus dead lease
    // tokens. Nothing reads it any more; it is retired the way every other
    // directory here is — aside under the marker, never deleted outright.
    const legacy = join(stateDir, "profiles", "claude_code", "provider-1");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "config.toml"), "dead lease token");

    expect(await archiveLegacyProfileTree()).toBe(true);
    expect(existsSync(join(stateDir, "profiles"))).toBe(false);
    const archived = (await readdir(stateDir)).filter((name) => name.startsWith("profiles.removed-"));
    expect(archived).toHaveLength(1);
    // Nothing to move the second time.
    expect(await archiveLegacyProfileTree()).toBe(false);

    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(join(stateDir, archived[0]!), old, old);
    expect(await sweepManagedWorkspaceArchives()).toBe(1);
    expect(existsSync(join(stateDir, archived[0]!))).toBe(false);
  });

  it("uses one shared managed cwd for a Conversation across Agents", async () => {
    const container = { kind: "conversation" as const, id: CONVERSATION_ID };
    const first = await ensureManagedWorkspace(AGENT_ID, container);
    const second = managedWorkspacePath(OTHER_AGENT_ID, container);
    expect(second).toBe(first);
    await writeFile(join(second, "shared.txt"), "same conversation");
    expect(existsSync(join(first, "shared.txt"))).toBe(true);
    expect(await listManagedWorkspaces()).toEqual([{
      container_kind: "conversation",
      container_id: CONVERSATION_ID,
      archived_available: false,
    }]);
  });
});
