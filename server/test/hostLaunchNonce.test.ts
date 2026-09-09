import { describe, expect, it } from "vitest";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";

// A supervisor retry reuses the run id within seconds of the first attempt's
// kill, before that attempt's child has finished uploading and reported. The
// registry keys pending runs by run id, so without a per-dispatch nonce the
// first attempt's late `complete` resolved the second attempt's promise with
// the first attempt's exit code — and the second attempt's tool token was
// revoked while its process was still running.
describe("launch nonce routing", () => {
  function sink(): HostFrameSink & { sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    return { sent, send: (frame) => { sent.push(frame as Record<string, unknown>); }, close: () => undefined };
  }

  it("ignores a previous attempt's late complete and resolves on the current one", async () => {
    const registry = new HostConnectionRegistry();
    const connection = sink();
    registry.registerConnection("host-1", connection);

    let first: { exit_code: number } | undefined;
    void registry.dispatchLaunch("host-1", "run-1", { argv: ["claude"] }).then((r) => { first = r; });
    const firstLaunch = String(connection.sent.at(-1)!.launch_id);
    const second = registry.dispatchLaunch("host-1", "run-1", { argv: ["claude"] });
    const secondLaunch = String(connection.sent.at(-1)!.launch_id);
    expect(secondLaunch).not.toBe(firstLaunch);

    // Attempt 1 reports after being killed: nobody is waiting for it any more.
    registry.receiveComplete("host-1", "run-1", { exit_code: 137, timed_out: true, error: null }, firstLaunch);
    let settled = false;
    void second.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(first).toBeUndefined();

    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, secondLaunch);
    await expect(second).resolves.toMatchObject({ exit_code: 0 });
  });

  it("routes output only to the dispatch it belongs to", async () => {
    const registry = new HostConnectionRegistry();
    const connection = sink();
    registry.registerConnection("host-1", connection);
    const chunks: string[] = [];
    const completion = registry.dispatchLaunch("host-1", "run-1", { argv: ["claude"] }, (chunk) => chunks.push(chunk));
    const launch = String(connection.sent.at(-1)!.launch_id);

    registry.receiveOutput("host-1", "run-1", "stale", "some-other-launch");
    registry.receiveOutput("host-1", "run-1", "mine", launch);
    expect(chunks).toEqual(["mine"]);

    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, "some-other-launch");
    registry.receiveComplete("host-1", "run-1", { exit_code: 0, timed_out: false, error: null }, launch);
    await expect(completion).resolves.toMatchObject({ exit_code: 0 });
  });

  // The built-in host runs on one machine with no cgroups under bubblewrap, so
  // the container's own limits and this count are the only capacity levers
  // there are. Without the cap a burst of dispatches would start every Run at
  // once and starve all of them.
  it("queues a dispatch past the host's concurrency cap and releases on completion", async () => {
    const registry = new HostConnectionRegistry();
    const connection = sink();
    registry.registerConnection("host-builtin", connection);

    const settled: string[] = [];
    for (const runId of ["run-1", "run-2"]) {
      void registry.dispatchLaunch("host-builtin", runId, { argv: ["claude"] }, undefined, undefined, undefined, 2)
        .then(() => settled.push(runId));
    }
    // Two slots, two launches — and synchronously, because an uncapped
    // dispatch must not have its frame pushed into a microtask.
    expect(connection.sent).toHaveLength(2);

    void registry.dispatchLaunch("host-builtin", "run-3", { argv: ["claude"] }, undefined, undefined, undefined, 2)
      .then(() => settled.push("run-3"));
    expect(connection.sent).toHaveLength(2);

    const firstLaunch = String(connection.sent[0]!.launch_id);
    registry.receiveComplete("host-builtin", "run-1", { exit_code: 0, timed_out: false, error: null }, firstLaunch);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The freed slot is what lets the queued dispatch go, not a timer.
    expect(connection.sent).toHaveLength(3);
    expect(settled).toEqual(["run-1"]);
  });

  it("releases a queued dispatch's slot when the host turns out to be offline", async () => {
    const registry = new HostConnectionRegistry();
    const connection = sink();
    registry.registerConnection("host-builtin", connection);

    void registry.dispatchLaunch("host-builtin", "run-1", { argv: ["claude"] }, undefined, undefined, undefined, 1);
    const queued = registry.dispatchLaunch("host-builtin", "run-2", { argv: ["claude"] }, undefined, undefined, undefined, 1);
    registry.unregisterConnection("host-builtin", connection);

    const launchId = String(connection.sent[0]!.launch_id);
    registry.receiveComplete("host-builtin", "run-1", { exit_code: 0, timed_out: false, error: null }, launchId);
    // A host that went away while this was queued fails it rather than holding
    // the slot for a connection that is not coming back.
    await expect(queued).resolves.toMatchObject({ error: "host_offline" });
  });
  it("cancels only the named waiter without releasing an occupied slot", async () => {
    const registry = new HostConnectionRegistry();
    const connection = sink();
    registry.registerConnection("host", connection);
    const first = registry.dispatchLaunch("host", "active", { argv: ["claude"] }, undefined, undefined, undefined, 1);
    const cancelled = registry.dispatchLaunch("host", "cancelled", { argv: ["claude"] }, undefined, undefined, undefined, 1);
    const next = registry.dispatchLaunch("host", "next", { argv: ["claude"] }, undefined, undefined, undefined, 1);
    expect(registry.sendTerminate("host", "cancelled", false)).toBe(true);
    await expect(cancelled).resolves.toMatchObject({ error: "run_abandoned_before_launch" });
    expect(connection.sent).toHaveLength(1);
    registry.receiveComplete("host", "active", { exit_code: 0, timed_out: false, error: null }, String(connection.sent[0]!.launch_id));
    await first;
    expect(connection.sent.map((frame) => frame.run_id)).toEqual(["active", "next"]);
    registry.receiveComplete("host", "next", { exit_code: 0, timed_out: false, error: null }, String(connection.sent[1]!.launch_id));
    await next;
  });

});
