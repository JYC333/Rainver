import { afterEach, describe, expect, it, vi } from "vitest";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";

afterEach(() => vi.useRealTimers());

describe("interrupted Host attempt stop confirmation", () => {
  it("waits for the exact Host, Run and launch nonce without consuming a newer dispatch", async () => {
    const registry = new HostConnectionRegistry();
    const frames: unknown[] = [];
    registry.registerConnection("host", { send: frame => frames.push(frame), close() {} });
    const newer = registry.dispatchLaunch("host", "run", { argv: ["agent"] }, undefined, undefined, undefined, null, "new");
    const stopped = registry.stopAttempt("host", "run", "old");
    expect(frames.at(-1)).toEqual({ type: "terminate", run_id: "run", launch_id: "old", force: true });
    let confirmed = false;
    void stopped.then(value => { confirmed = value; });
    const result = { exit_code: 1, timed_out: false, error: null };
    registry.receiveComplete("other-host", "run", result, "old");
    registry.receiveComplete("host", "other-run", result, "old");
    registry.receiveComplete("host", "run", result, "different");
    await Promise.resolve();
    expect(confirmed).toBe(false);
    registry.receiveComplete("host", "run", result, "old");
    await expect(stopped).resolves.toBe(true);
    let newerFinished = false;
    void newer.then(() => { newerFinished = true; });
    await Promise.resolve();
    expect(newerFinished).toBe(false);
    registry.receiveComplete("host", "run", result, "new");
    await newer;
  });

  it("does not treat offline Hosts or confirmation timeouts as exit", async () => {
    vi.useFakeTimers();
    const registry = new HostConnectionRegistry();
    await expect(registry.stopAttempt("offline", "run", "old")).resolves.toBe(false);
    registry.registerConnection("host", { send() {}, close() {} });
    const stopped = registry.stopAttempt("host", "run", "old");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stopped).resolves.toBe(false);
    registry.receiveComplete("host", "run", { exit_code: 1, timed_out: false, error: null }, "old");
  });
});
