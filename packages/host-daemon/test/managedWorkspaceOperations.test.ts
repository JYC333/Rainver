import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.js";
import { managedWorkspacePath, runtimeProfileContainerPath } from "../src/managedWorkspaces.js";
import type * as Operations from "../src/managedWorkspaceOperations.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const container = { kind: "conversation" as const, id: CONVERSATION_ID };

let stateDir: string;

/** A fresh module: the in-process lock and everything else a daemon restart loses, only the journal on disk remains. */
async function restartedDaemon(): Promise<typeof Operations> {
  vi.resetModules();
  return import("../src/managedWorkspaceOperations.js");
}

const workspace = () => managedWorkspacePath(AGENT_ID, container);
const profile = () => runtimeProfileContainerPath(AGENT_ID, "conversation", CONVERSATION_ID);
const archives = async (live: string) => (await readdir(dirname(live)).catch(() => [] as string[]))
  .filter((name) => name.startsWith(`${CONVERSATION_ID}.removed-`));

async function seedLive(): Promise<void> {
  await mkdir(workspace(), { recursive: true });
  await writeFile(join(workspace(), "work.txt"), "shared work");
  await mkdir(join(profile(), "claude_code"), { recursive: true });
  await writeFile(join(profile(), "claude_code", "memory.md"), "agent memory");
}

const frame = (action: "archive" | "restore", operation_id: string, generation: number, include_workspace = true) =>
  ({ action, agent_id: AGENT_ID, container_kind: "conversation" as const, container_id: CONVERSATION_ID, include_workspace, operation_id, generation });

class Crash extends Error {}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-managed-operations-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  await saveConfig({ server_url: "http://127.0.0.1:1", host_id: "host-1", token: "token", trust: "trusted", workspaces: {} });
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("journaled managed-workspace operations", () => {
  it("finishes a restore interrupted between the workspace and the profile, instead of meeting its own move as a conflict", async () => {
    await seedLive();
    let daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1))).toEqual({ ok: true, changed: true, error: null });
    expect(existsSync(workspace())).toBe(false);
    expect(existsSync(profile())).toBe(false);

    // The workspace is back on disk; the daemon dies before journaling it or touching the profile.
    daemon = await restartedDaemon();
    const crashed = await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2), {
      afterMove: (stage) => { if (stage === "workspace") throw new Crash("crash"); },
    });
    expect(crashed).toMatchObject({ ok: false, error_code: "io_error" });
    expect(existsSync(workspace())).toBe(true);
    expect(existsSync(profile())).toBe(false);

    // The control plane repeats the same operation after the restart: the profile follows, nothing conflicts.
    daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2))).toEqual({ ok: true, changed: true, error: null });
    expect(await readFile(join(workspace(), "work.txt"), "utf8")).toBe("shared work");
    expect(await readFile(join(profile(), "claude_code", "memory.md"), "utf8")).toBe("agent memory");
    expect(await archives(workspace())).toEqual([]);
    expect(await archives(profile())).toEqual([]);
  });

  it("replays a completed restore whose reply was lost with its original result and moves nothing again", async () => {
    await seedLive();
    let daemon = await restartedDaemon();
    await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1));
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2))).toEqual({ ok: true, changed: true, error: null });
    daemon = await restartedDaemon();
    // The live workspace now exists; a fresh restore would call that a conflict. The same operation replays.
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2))).toEqual({ ok: true, changed: true, error: null });
    expect(await readFile(join(workspace(), "work.txt"), "utf8")).toBe("shared work");
    // Reusing the identity for a different request is refused, not replayed.
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2, false)))
      .toMatchObject({ ok: false, error_code: "operation_mismatch" });
  });

  it("finishes an archive interrupted after the profile moved", async () => {
    await seedLive();
    let daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1), {
      afterMove: (stage) => { if (stage === "profile") throw new Crash("crash"); },
    })).toMatchObject({ ok: false, error_code: "io_error" });
    expect(existsSync(profile())).toBe(false);
    expect(existsSync(workspace())).toBe(true);
    daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1))).toEqual({ ok: true, changed: true, error: null });
    expect(existsSync(workspace())).toBe(false);
    expect(await archives(profile())).toHaveLength(1);
    expect(await archives(workspace())).toHaveLength(1);
  });

  it("refuses an archive delivered after the restore ordered after it, so the restored state stays live", async () => {
    await seedLive();
    const daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1))).toMatchObject({ ok: true });
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2))).toEqual({ ok: true, changed: true, error: null });
    // A delayed duplicate of the acknowledged archive: its receipt answers, nothing moves.
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1))).toEqual({ ok: true, changed: true, error: null });
    // An older intent the Host never saw before (its receipt pruned, or a different copy): fenced.
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t0:1", 1))).toMatchObject({ ok: false, error_code: "stale_generation" });
    expect(existsSync(workspace())).toBe(true);
    expect(existsSync(profile())).toBe(true);
    // A newer archive (the Agent removed again) still archives.
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t2:3", 3))).toEqual({ ok: true, changed: true, error: null });
    expect(existsSync(profile())).toBe(false);
  });

  it("refuses a late archive that arrives after the restore even when the restore came first", async () => {
    await seedLive();
    const daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2, false))).toEqual({ ok: true, changed: false, error: null });
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1))).toMatchObject({ ok: false, error_code: "stale_generation" });
    expect(await readFile(join(profile(), "claude_code", "memory.md"), "utf8")).toBe("agent memory");
  });

  it("keeps refusing to restore over a live shared workspace and leaves both the live and archived state in place", async () => {
    await seedLive();
    let daemon = await restartedDaemon();
    await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1));
    // Another Agent's Run recreated the shared cwd meanwhile.
    await mkdir(workspace(), { recursive: true });
    await writeFile(join(workspace(), "other.txt"), "another agent");
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2)))
      .toMatchObject({ ok: false, changed: false, error_code: "live_conflict" });
    daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2)))
      .toMatchObject({ ok: false, changed: false, error_code: "live_conflict" });
    expect(await readFile(join(workspace(), "other.txt"), "utf8")).toBe("another agent");
    expect(existsSync(join(workspace(), "work.txt"))).toBe(false);
    expect(existsSync(profile())).toBe(false);
    expect(await archives(workspace())).toHaveLength(1);
    expect(await archives(profile())).toHaveLength(1);
  });

  it("serializes concurrent copies of one operation so only one moves anything", async () => {
    await seedLive();
    const daemon = await restartedDaemon();
    await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1));
    const results = await Promise.all([1, 2, 3].map(() => daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r1", 2))));
    expect(results).toEqual([1, 2, 3].map(() => ({ ok: true, changed: true, error: null })));
    expect(await archives(workspace())).toEqual([]);
  });

  it("rejects an identity without a generation and keeps legacy requests working", async () => {
    await seedLive();
    const daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation({ ...frame("archive", "archive:t1:1", 1), generation: undefined }))
      .toMatchObject({ ok: false, error_code: "invalid_request" });
    expect(await daemon.executeManagedWorkspaceOperation({ action: "archive", agent_id: AGENT_ID, container_kind: "conversation", container_id: CONVERSATION_ID, include_workspace: true }))
      .toEqual({ ok: true, changed: true, error: null });
  });

  it("ends an archive interrupted after its move once a newer restore ran, instead of archiving the restored state again", async () => {
    await seedLive();
    let daemon = await restartedDaemon();
    // 1. The archive moves the workspace, and the daemon dies before journaling that stage.
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1), {
      afterMove: (stage) => { if (stage === "workspace") throw new Crash("crash"); },
    })).toMatchObject({ ok: false, error_code: "io_error" });
    expect(existsSync(workspace())).toBe(false);
    expect(existsSync(profile())).toBe(false);
    // 2. The restore ordered after it brings both back.
    daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("restore", "restore:r2", 2))).toEqual({ ok: true, changed: true, error: null });
    // 3. The control plane repeats the unfinished archive: fenced, nothing moves, and the answer stays the same.
    daemon = await restartedDaemon();
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1)))
      .toMatchObject({ ok: false, changed: true, error_code: "stale_generation" });
    expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:t1:1", 1)))
      .toMatchObject({ ok: false, error_code: "stale_generation" });
    expect(await readFile(join(workspace(), "work.txt"), "utf8")).toBe("shared work");
    expect(await readFile(join(profile(), "claude_code", "memory.md"), "utf8")).toBe("agent memory");
    expect(await archives(workspace())).toEqual([]);
    expect(await archives(profile())).toEqual([]);
  });

  describe("two Agents sharing one Conversation cwd", () => {
    const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const otherProfile = () => runtimeProfileContainerPath(OTHER, "conversation", CONVERSATION_ID);
    const as = (agent_id: string, value: ReturnType<typeof frame>) => ({ ...value, agent_id });

    async function seedOther(): Promise<void> {
      await mkdir(otherProfile(), { recursive: true });
      await writeFile(join(otherProfile(), "memory.md"), "other agent memory");
    }

    it("skips the cwd stage of an interrupted archive that another Agent's newer restore took over, and still archives its own profile", async () => {
      await seedLive();
      let daemon = await restartedDaemon();
      // B leaves last and its archive takes the cwd; then A, still a member, has its profile archived.
      await seedOther();
      expect(await daemon.executeManagedWorkspaceOperation(as(OTHER, frame("archive", "archive:b:1", 1)))).toEqual({ ok: true, changed: true, error: null });
      expect(existsSync(workspace())).toBe(false);
      // B is re-added: its restore brings the cwd and its profile back.
      expect(await daemon.executeManagedWorkspaceOperation(as(OTHER, frame("restore", "restore:b:3", 3)))).toEqual({ ok: true, changed: true, error: null });
      await writeFile(join(workspace(), "after-restore.txt"), "B's new work");
      // A late archive of A's, ordered before B's restore and carrying the cwd: A's profile goes, the cwd stays.
      daemon = await restartedDaemon();
      expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:a:2", 2))).toEqual({ ok: true, changed: true, error: null });
      expect(existsSync(profile())).toBe(false);
      expect(await readFile(join(workspace(), "after-restore.txt"), "utf8")).toBe("B's new work");
      expect(await readFile(join(otherProfile(), "memory.md"), "utf8")).toBe("other agent memory");
    });

    it("never lets one Agent's interrupted cwd archive remove the cwd another Agent's restore brought back", async () => {
      await seedLive();
      await seedOther();
      let daemon = await restartedDaemon();
      // 1. A's archive moves its profile and the shared cwd, then dies before journaling the cwd stage.
      expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:a:1", 1), {
        afterMove: (stage) => { if (stage === "workspace") throw new Crash("crash"); },
      })).toMatchObject({ ok: false, error_code: "io_error" });
      expect(existsSync(workspace())).toBe(false);
      // 2. B's restore, a newer operation on the same cwd under B's own journal, brings the cwd back.
      daemon = await restartedDaemon();
      expect(await daemon.executeManagedWorkspaceOperation(as(OTHER, frame("restore", "restore:b:2", 2)))).toMatchObject({ ok: true });
      await writeFile(join(workspace(), "b.txt"), "B works here");
      // 3. A's repeat is not fenced on A's profile, but the cwd is B's operation's now: it is skipped.
      daemon = await restartedDaemon();
      expect(await daemon.executeManagedWorkspaceOperation(frame("archive", "archive:a:1", 1))).toEqual({ ok: true, changed: true, error: null });
      expect(await readFile(join(workspace(), "b.txt"), "utf8")).toBe("B works here");
      expect(await readFile(join(workspace(), "work.txt"), "utf8")).toBe("shared work");
      expect(await archives(workspace())).toEqual([]);
      expect(existsSync(profile())).toBe(false);
      expect(await readFile(join(otherProfile(), "memory.md"), "utf8")).toBe("other agent memory");
    });

    it("runs two Agents' operations on one cwd one at a time, in either order, without deadlock", async () => {
      await seedLive();
      await seedOther();
      const daemon = await restartedDaemon();
      let active = 0, overlapped = false;
      const hooks = { afterMove: async () => {
        active += 1; if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      } };
      const results = await Promise.all([
        daemon.executeManagedWorkspaceOperation(frame("archive", "archive:a:1", 1), hooks),
        daemon.executeManagedWorkspaceOperation(as(OTHER, frame("archive", "archive:b:2", 2)), hooks),
        daemon.executeManagedWorkspaceOperation(as(OTHER, frame("restore", "restore:b:3", 3)), hooks),
        daemon.executeManagedWorkspaceOperation(frame("restore", "restore:a:4", 4, false), hooks),
      ]);
      expect(overlapped).toBe(false);
      expect(results.every((result) => result.ok)).toBe(true);
      // B's restore came after both cwd archives: the cwd is live, with nothing of it left archived.
      expect(await readFile(join(workspace(), "work.txt"), "utf8")).toBe("shared work");
      expect(await archives(workspace())).toEqual([]);
    });
  });
});
