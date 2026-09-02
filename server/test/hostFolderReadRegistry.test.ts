import { afterEach, describe, expect, it, vi } from "vitest";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";

function sink(frames: Record<string, unknown>[]): HostFrameSink {
  return {
    send: (frame) => frames.push(frame),
    close: () => undefined,
  };
}

describe("HostConnectionRegistry folder reads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("correlates concurrent single-frame requests with their daemon replies", async () => {
    const registry = new HostConnectionRegistry();
    const frames: Record<string, unknown>[] = [];
    const connection = sink(frames);
    registry.registerConnection("host-1", connection);
    const first = registry.requestFolderRead("host-1", { workspace_location_id: "loc-1", kind: "tree", protected: false });
    const second = registry.requestFolderRead("host-1", { workspace_location_id: "loc-1", kind: "git_status", protected: false });
    expect(frames).toHaveLength(2);
    const firstId = String(frames[0]!.request_id);
    const secondId = String(frames[1]!.request_id);
    registry.receiveFolderReadResult("host-1", secondId, { ok: true, kind: "git_status", result: { is_repo: false, branch: null, files: [] } });
    registry.receiveFolderReadResult("host-1", firstId, { ok: false, error: "path_forbidden", message: "blocked" });
    await expect(first).resolves.toMatchObject({ ok: false, error: "path_forbidden" });
    await expect(second).resolves.toMatchObject({ ok: true, kind: "git_status" });
  });

  it("round-trips a generic host action and fails it on disconnect or offline", async () => {
    const registry = new HostConnectionRegistry();
    const frames: Record<string, unknown>[] = [];
    const connection = sink(frames);
    registry.registerConnection("host-1", connection);
    const listing = registry.listHostDirectories("host-1", "/home");
    expect(frames.at(-1)).toMatchObject({ type: "list_dirs", path: "/home" });
    // The reply is the contract's `list_dirs_result`, used whole — nothing is
    // filled in or rebuilt on this side.
    registry.receiveHostActionResult("host-1", String(frames.at(-1)!.request_id), { ok: true, path: "/home", parent: "/", dirs: ["a"], truncated: false, error: null });
    await expect(listing).resolves.toMatchObject({ ok: true, dirs: ["a"], error: null });

    const dropped = registry.forgetHostWorkspace("host-1", "loc-1");
    registry.unregisterConnection("host-1", connection);
    // Reported in the reply's own shape, the contract's `workspace_forget_result`.
    await expect(dropped).resolves.toEqual({ ok: false, changed: false, error: "host_offline" });
    await expect(registry.listHostDirectories("host-2", "/"))
      .resolves.toMatchObject({ ok: false, error: "host_offline" });
  });

  it("fails a pending read when the host disconnects", async () => {
    const registry = new HostConnectionRegistry();
    const frames: Record<string, unknown>[] = [];
    const connection = sink(frames);
    registry.registerConnection("host-1", connection);
    const pending = registry.requestFolderRead("host-1", { workspace_location_id: "loc-1", kind: "tree", protected: false });
    registry.unregisterConnection("host-1", connection);
    await expect(pending).resolves.toEqual({ ok: false, error: "host_offline" });
  });

  it("returns host_offline without sending when no daemon is connected", async () => {
    const registry = new HostConnectionRegistry();
    await expect(registry.requestFolderRead("missing", { workspace_location_id: "loc-1", kind: "tree", protected: false }))
      .resolves.toEqual({ ok: false, error: "host_offline" });
  });

  it("ignores a reply whose kind does not match the pending request", async () => {
    const registry = new HostConnectionRegistry();
    const frames: Record<string, unknown>[] = [];
    const connection = sink(frames);
    registry.registerConnection("host-1", connection);
    const pending = registry.requestFolderRead("host-1", { workspace_location_id: "loc-1", kind: "tree", protected: false });
    registry.receiveFolderReadResult("host-1", String(frames[0]!.request_id), {
      ok: true,
      kind: "file",
      result: { path: "wrong", content: "wrong", size: 5, line_count: 1 },
    });
    registry.unregisterConnection("host-1", connection);
    await expect(pending).resolves.toMatchObject({ ok: false, error: "host_offline" });
  });

  it("turns a synchronous send failure into a cleaned-up host_offline result", async () => {
    const registry = new HostConnectionRegistry();
    const connection: HostFrameSink = { send: () => { throw new Error("socket closed"); }, close: () => undefined };
    registry.registerConnection("host-1", connection);
    await expect(registry.requestFolderRead("host-1", { workspace_location_id: "loc-1", kind: "tree", protected: false }))
      .resolves.toEqual({ ok: false, error: "host_offline" });
  });

  it("settles an unresponsive read at the fifteen-second deadline", async () => {
    vi.useFakeTimers();
    const registry = new HostConnectionRegistry();
    const frames: Record<string, unknown>[] = [];
    registry.registerConnection("host-1", sink(frames));
    const pending = registry.requestFolderRead("host-1", { workspace_location_id: "loc-1", kind: "tree", protected: false });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ ok: false, error: "host_timeout" });
  });
});
