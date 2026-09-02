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
});
