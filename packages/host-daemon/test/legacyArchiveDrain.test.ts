import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDir, saveConfig } from "../src/config.js";
import { runtimeProfileContainerPath } from "../src/managedWorkspaces.js";

/**
 * Faults on the real filesystem, through the durable-write seam of each
 * (restarted) daemon's own `durableFile.js`: a file or directory fsync can be
 * made to fail, or to wait at a barrier, for one path. Every successful fsync
 * is recorded by path (a file by its final name, not its temporary one).
 */
const fsFaults = {
  syncs: [] as string[],
  failSync: null as null | ((path: string) => boolean),
  barrier: null as null | { path: string; reached: () => void; release: Promise<void> },
};
const recordName = (path: string) => path.replace(/\.[0-9a-f-]{36}\.tmp$/, "");
async function faultySync(path: string, sync: () => Promise<void>) {
  const name = recordName(path);
  const barrier = fsFaults.barrier;
  if (barrier?.path === name) { fsFaults.barrier = null; barrier.reached(); await barrier.release; }
  if (fsFaults.failSync?.(name)) throw Object.assign(new Error(`EIO: i/o error, fsync '${name}'`), { code: "EIO" });
  await sync();
  fsFaults.syncs.push(name);
}

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let stateDir: string;

/** This daemon's modules, fresh: a restarted process keeps only what is on disk. */
async function restartedDaemon() {
  vi.resetModules();
  const operations = await import("../src/managedWorkspaceOperations.js");
  const execution = await import("../src/executionWorkspace.js");
  const drain = await import("../src/legacyArchiveDrain.js");
  const durable = await import("../src/durableFile.js");
  durable.setDurableIoForTest({
    syncFile: (handle, path) => faultySync(path, () => handle.sync()),
    syncDirectory: (path) => faultySync(path, async () => {
      const handle = await open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }),
  });
  return { ...operations, ...drain, executeWorkspaceCommand: execution.executeWorkspaceCommand };
}

const legacyArchive = { action: "archive" as const, agent_id: AGENT_ID, container_kind: "conversation" as const, container_id: CONVERSATION_ID, include_workspace: false };
const legacyProfiles = { type: "execution_workspace_command", request_id: "r", action: "archive_profiles", operation_id: "op", retain_branch: true,
  profile_agents: [AGENT_ID], workspace: { workspace_location_id: "loc", execution_workspace: { id: WORKSPACE_ID, generation: 1 } } } as never;
const profile = () => runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);

async function seedProfile(path = profile()) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "memory.md"), "agent memory");
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-legacy-drain-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  await saveConfig({ server_url: "http://127.0.0.1:1", host_id: "host-1", token: "token", trust: "trusted", workspaces: {} });
});

afterEach(async () => {
  fsFaults.syncs.length = 0;
  fsFaults.failSync = null;
  fsFaults.barrier = null;
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("the legacy archive drain", () => {
  it("answers only after an identity-less archive admitted before it finished, then refuses every later one", async () => {
    await seedProfile();
    const daemon = await restartedDaemon();
    let open = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    // Admitted in the dispatch tick, still running when the drain arrives.
    const running = daemon.executeManagedWorkspaceOperation(legacyArchive, { beforeLegacyMove: () => gate });
    let drained = false;
    const drain = daemon.drainLegacyArchives().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drained).toBe(false);
    expect(existsSync(profile())).toBe(true);
    open();
    expect(await running).toEqual({ ok: true, changed: true, error: null });
    await drain;
    expect(drained).toBe(true);
    // Closed for good: a later copy, managed or an isolated workspace's profile archive, moves nothing.
    await seedProfile();
    const workspaceProfile = runtimeProfileContainerPath(AGENT_ID, "workspace", WORKSPACE_ID);
    await seedProfile(workspaceProfile);
    expect(await daemon.executeManagedWorkspaceOperation(legacyArchive)).toMatchObject({ ok: false, changed: false, error_code: "legacy_closed" });
    expect(await daemon.executeWorkspaceCommand(null, legacyProfiles)).toMatchObject({ ok: false, error_code: "legacy_closed" });
    expect(existsSync(profile())).toBe(true);
    expect(existsSync(workspaceProfile)).toBe(true);
    // Journaled operations are unaffected.
    expect(await daemon.executeManagedWorkspaceOperation({ ...legacyArchive, operation_id: "archive:t:1", generation: 1 })).toEqual({ ok: true, changed: true, error: null });
  });

  it("stays closed in a restarted process, and a drain with nothing admitted answers at once", async () => {
    await seedProfile();
    let daemon = await restartedDaemon();
    expect(daemon.legacyArchivesClosed()).toBe(false);
    await daemon.drainLegacyArchives();
    daemon = await restartedDaemon();
    expect(daemon.legacyArchivesClosed()).toBe(true);
    expect(await daemon.executeManagedWorkspaceOperation({ ...legacyArchive, action: "restore" })).toMatchObject({ ok: false, error_code: "legacy_closed" });
    expect(await daemon.executeManagedWorkspaceOperation(legacyArchive)).toMatchObject({ ok: false, error_code: "legacy_closed" });
    expect(existsSync(profile())).toBe(true);
    await daemon.drainLegacyArchives();
  });

  it("a drain does not wait for a legacy archive that failed", async () => {
    const daemon = await restartedDaemon();
    const failing = daemon.executeManagedWorkspaceOperation(legacyArchive, { beforeLegacyMove: () => Promise.reject(new Error("disk gone")) });
    await daemon.drainLegacyArchives();
    expect(await failing).toMatchObject({ ok: false, error: "disk gone" });
  });

  describe("answers only once the closure is durable", () => {
    const marker = () => join(configDir(), "managed-operations", "legacy-archives-closed");
    const directory = () => join(configDir(), "managed-operations");
    /** The marker and its directory were fsynced since the last reset (the chain above it, once per process). */
    const persistedNow = () => [marker(), directory()].every((path) => fsFaults.syncs.includes(path));

    for (const failing of ["the marker file", "its directory"] as const) {
      it(`a drain whose fsync of ${failing} fails is no proof, and its retry, or a restarted process's first drain, persists everything again`, async () => {
        await seedProfile();
        let daemon = await restartedDaemon();
        const failingPath = failing === "the marker file" ? marker : directory;
        fsFaults.failSync = (path) => path === failingPath();
        await expect(daemon.drainLegacyArchives()).rejects.toThrow(/EIO/);
        expect(fsFaults.syncs).toContain(configDir());
        // The file fsync fails before the rename (no marker); the directory fsync after it (a marker power loss may still discard).
        expect(existsSync(marker())).toBe(failing === "its directory");
        // This process stays closed regardless.
        expect(await daemon.executeManagedWorkspaceOperation(legacyArchive)).toMatchObject({ ok: false, error_code: "legacy_closed" });
        // The same process retries: whatever is on disk, it persists the marker again.
        fsFaults.failSync = null;
        fsFaults.syncs.length = 0;
        await daemon.drainLegacyArchives();
        expect(persistedNow()).toBe(true);
        // Once persisted, a later drain in the same process answers without writing it again ...
        fsFaults.syncs.length = 0;
        await daemon.drainLegacyArchives();
        expect(fsFaults.syncs).toEqual([]);
        // ... unless the marker has since disappeared.
        await rm(marker());
        await daemon.drainLegacyArchives();
        expect(persistedNow()).toBe(true);
        // A process restarted over a marker an earlier one failed to make durable: closed, and it persists it before its first answer.
        await rm(marker());
        fsFaults.failSync = (path) => path === directory();
        daemon = await restartedDaemon();
        await expect(daemon.drainLegacyArchives()).rejects.toThrow(/EIO/);
        daemon = await restartedDaemon();
        expect(existsSync(marker())).toBe(true);
        expect(daemon.legacyArchivesClosed()).toBe(true);
        expect(await daemon.executeManagedWorkspaceOperation(legacyArchive)).toMatchObject({ ok: false, error_code: "legacy_closed" });
        await expect(daemon.drainLegacyArchives()).rejects.toThrow(/EIO/);
        fsFaults.failSync = null;
        fsFaults.syncs.length = 0;
        await daemon.drainLegacyArchives();
        expect(persistedNow()).toBe(true);
        expect(existsSync(profile())).toBe(true);
      });
    }

    it("concurrent drains between the marker's creation and its fsync all wait for that one fsync and for every admitted archive", async () => {
      await seedProfile();
      const daemon = await restartedDaemon();
      let openArchive = () => {};
      const archiveGate = new Promise<void>((resolve) => { openArchive = resolve; });
      const running = daemon.executeManagedWorkspaceOperation(legacyArchive, { beforeLegacyMove: () => archiveGate });
      let reached = () => {};
      const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
      let releaseSync = () => {};
      fsFaults.barrier = { path: directory(), reached, release: new Promise<void>((resolve) => { releaseSync = resolve; }) };
      const settled: string[] = [];
      const first = daemon.drainLegacyArchives().then(() => settled.push("first"));
      await atBarrier;
      // The marker is in place but its directory entry is not yet fsynced: a second drain must not answer on it.
      expect(existsSync(marker())).toBe(true);
      const second = daemon.drainLegacyArchives().then(() => settled.push("second"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toEqual([]);
      releaseSync();
      // Durable now, but the archive admitted before them still runs (its gate is closed): neither answers.
      await vi.waitFor(() => expect(persistedNow()).toBe(true), { timeout: 4000 });
      expect(settled).toEqual([]);
      openArchive();
      expect(await running).toEqual({ ok: true, changed: true, error: null });
      await Promise.all([first, second]);
      expect(settled.sort()).toEqual(["first", "second"]);
      expect(fsFaults.syncs.filter((path) => path === marker())).toHaveLength(1);
    });

    it("a failed fsync rejects every drain sharing it, and the next drain retries it", async () => {
      const daemon = await restartedDaemon();
      let reached = () => {};
      const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
      let releaseSync = () => {};
      fsFaults.barrier = { path: marker(), reached, release: new Promise<void>((resolve) => { releaseSync = resolve; }) };
      fsFaults.failSync = (path) => path === marker();
      const first = daemon.drainLegacyArchives();
      await atBarrier;
      const second = daemon.drainLegacyArchives();
      releaseSync();
      await expect(first).rejects.toThrow(/EIO/);
      await expect(second).rejects.toThrow(/EIO/);
      fsFaults.failSync = null;
      await daemon.drainLegacyArchives();
      expect(persistedNow()).toBe(true);
    });

    it("an admitted archive whose work throws before returning is still a failed archive, never an escaped one", async () => {
      const daemon = await restartedDaemon();
      const thrown = daemon.admitLegacyArchive((() => { throw new Error("synchronous"); }) as () => Promise<never>);
      await expect(thrown).rejects.toThrow("synchronous");
      await daemon.drainLegacyArchives();
    });
  });
});
