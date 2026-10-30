import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForReconnectOrUpdate } from "../src/updateRestart.js";

let root: string;
let request: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-host-update-restart-"));
  request = join(root, "update-restart-requested");
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("Host update during offline reconnect backoff", () => {
  it("adopts an installed update during the fifteen-minute outdated wait", async () => {
    vi.useFakeTimers();
    let busy = true;
    const waiting = waitForReconnectOrUpdate(900_000, request, () => busy, () => {});
    await writeFile(request, "");
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(waiting).resolves.toBe("update");
    await expect(stat(request)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the update request and reconnects when existing Runs are still active", async () => {
    vi.useFakeTimers();
    await writeFile(request, "");
    const waiting = waitForReconnectOrUpdate(60_000, request, () => true, () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(waiting).resolves.toBe("reconnect");
    expect((await stat(request)).isFile()).toBe(true);
    await expect(waitForReconnectOrUpdate(60_000, request, () => false, () => {})).resolves.toBe("update");
  });

  it("rechecks in-flight work before consuming the install marker", async () => {
    await writeFile(request, "");
    let checks = 0;
    await expect(waitForReconnectOrUpdate(0, request, () => ++checks > 1, () => {})).resolves.toBe("reconnect");
    expect((await stat(request)).isFile()).toBe(true);
  });

  it("retains the ordinary reconnect deadline without an installed update", async () => {
    vi.useFakeTimers();
    const waiting = waitForReconnectOrUpdate(1_000, request, () => true, () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe("reconnect");
  });
});
