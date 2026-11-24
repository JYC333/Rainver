import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonFrame, HostServerFrame } from "@rainver/protocol";
import { HostConnectionRegistry, type HostFrameSink } from "../src/modules/hosts/connectionRegistry.js";
import { ReconnectableFrameSink } from "../../packages/host-daemon/src/reconnectableFrameSink.js";

// The Host recovery matrix, end to end over a synthetic transport: the
// daemon's real `ReconnectableFrameSink` and the server's real
// `HostConnectionRegistry`, joined by connections that can drop frames in
// either direction. The two handlers below mirror `hosts/routes.ts` and
// `commands/run.ts` for the frames a Run's delivery and recovery use. Each
// case records three things separately: what the transport replayed, which
// launch the server resumed, and how many times the Run settled.

const HOST = "host-1";
const RUN = "run-1";
const OK = { type: "complete", exit_code: 0, timed_out: false, error: null } as const;

class Pair {
  readonly registry: HostConnectionRegistry;
  daemon = new ReconnectableFrameSink();
  output: string[] = [];
  terminated: Array<{ run_id: string; launch_id?: string }> = [];
  settlements: Array<{ exit_code: number; error?: string | null }> = [];
  /** `complete` frames that reached the server: the transport's replays, counted apart from settlement. */
  completesReceived = 0;
  private connection: { server: HostFrameSink; daemon: (frame: HostDaemonFrame) => boolean; open: boolean; dropAcks: boolean } | null = null;

  constructor(readonly ack: boolean, registry = new HostConnectionRegistry()) {
    this.registry = registry;
    const finish = (this.registry as unknown as { finishPendingRun: (...args: unknown[]) => void });
    const original = finish.finishPendingRun.bind(this.registry);
    finish.finishPendingRun = (runId, pending, result) => {
      this.settlements.push(result as { exit_code: number; error?: string | null });
      original(runId, pending, result);
    };
  }

  /** A new connection: hello → registerConnection, hello_ack → bind, then the reconnect probes. */
  async connect(options: { dropAcks?: boolean } = {}): Promise<void> {
    const connection = {
      open: true,
      dropAcks: options.dropAcks ?? false,
      server: {
        // A socket delivers on a later turn, never inside the sender's call.
        send: (frame: HostServerFrame) => { queueMicrotask(() => { if (connection.open) this.toDaemon(frame, connection); }); },
        close: () => { connection.open = false; },
      } as HostFrameSink,
      daemon: (frame: HostDaemonFrame): boolean => {
        if (!connection.open) return false;
        this.toServer(frame, connection.server);
        return true;
      },
    };
    this.connection = connection;
    expect(this.registry.registerConnection(HOST, connection.server, false, this.ack)).toBe(true);
    this.daemon.bind(connection.daemon, this.ack);
    if (this.ack) this.registry.probeReconnectedRuns(HOST, connection.server);
    await delivered();
  }

  disconnect(): void {
    const connection = this.connection!;
    connection.open = false;
    this.registry.unregisterConnection(HOST, connection.server);
    this.daemon.unbindIfCurrent(connection.daemon);
  }

  async launch(): Promise<{ done: Promise<unknown>; launchId: string }> {
    const done = this.registry.dispatchLaunch(HOST, RUN, { argv: ["agent"] } as never, (chunk) => this.output.push(chunk));
    await delivered();
    return { done, launchId: this.lastLaunchId! };
  }

  lastLaunchId: string | null = null;

  /** `commands/run.ts`: what the daemon does with a server frame. */
  private toDaemon(frame: HostServerFrame, connection: { dropAcks: boolean }): void {
    switch (frame.type) {
      case "launch": this.lastLaunchId = frame.launch_id; this.daemon.beginLaunch(frame.run_id, frame.launch_id); return;
      case "run_completion_ack": if (!connection.dropAcks) this.daemon.acknowledgeCompletion(frame.run_id, frame.launch_id); return;
      case "run_reconnect_probe": this.daemon.reconcileLaunch(frame.run_id, frame.launch_id); return;
      case "terminate":
        this.terminated.push({ run_id: frame.run_id, launch_id: frame.launch_id });
        return;
      default: return;
    }
  }

  /** `hosts/routes.ts`: what the server does with a daemon frame. */
  private toServer(frame: HostDaemonFrame, sink: HostFrameSink): void {
    switch (frame.type) {
      case "launched": this.registry.receiveLaunched(HOST, frame.run_id, frame.launch_id); return;
      case "output": this.registry.receiveOutput(HOST, frame.run_id, frame.chunk, frame.launch_id); return;
      case "run_reconnect_state": if (this.ack) this.registry.receiveReconnectedRun(HOST, sink, frame); return;
      case "complete":
        this.completesReceived += 1;
        this.registry.receiveComplete(HOST, frame.run_id, { exit_code: frame.exit_code, timed_out: frame.timed_out, error: frame.error }, frame.launch_id);
        if (this.ack) sink.send({ type: "run_completion_ack", run_id: frame.run_id, launch_id: frame.launch_id });
        return;
      default: return;
    }
  }

  /** The child process, writing through the daemon's sink. */
  emit(launchId: string, frame: { type: "launched" } | { type: "output"; chunk: string } | typeof OK | { type: "complete"; exit_code: number; timed_out: boolean; error: string | null }): void {
    this.daemon.send({ ...frame, run_id: RUN, launch_id: launchId } as HostDaemonFrame);
  }
}

afterEach(() => { vi.useRealTimers(); });

/** Lets queued socket deliveries (and what they trigger) run. Microtasks are not faked timers. */
async function delivered(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("Host Run recovery matrix (synthetic transport, real sink and registry)", () => {
  it.each([true, false])("replays what was sent offline in order and settles once (completion ack %s)", async (ack) => {
    const pair = new Pair(ack);
    await pair.connect();
    const { done, launchId } = await pair.launch();
    pair.emit(launchId, { type: "launched" });
    pair.emit(launchId, { type: "output", chunk: "a" });
    pair.disconnect();
    pair.emit(launchId, { type: "output", chunk: "b" });
    pair.emit(launchId, OK);
    expect(pair.settlements).toEqual([]);
    await pair.connect();
    await expect(done).resolves.toMatchObject({ exit_code: 0 });
    expect(pair.output).toEqual(["a", "b"]);
    expect(pair.settlements).toHaveLength(1);
    // Nothing is left to replay on a later connection.
    pair.disconnect(); await pair.connect();
    expect(pair.output).toEqual(["a", "b"]);
    expect(pair.completesReceived).toBe(1);
    expect(pair.settlements).toHaveLength(1);
  });

  it("re-sends an unacknowledged completion on the next connection and the server settles it only once", async () => {
    const pair = new Pair(true);
    await pair.connect({ dropAcks: true });
    const { done, launchId } = await pair.launch();
    pair.emit(launchId, { type: "launched" });
    pair.emit(launchId, OK);
    await expect(done).resolves.toMatchObject({ exit_code: 0 });
    // The ack was lost with the connection: the daemon still holds the completion and replays it.
    pair.disconnect();
    await pair.connect();
    expect(pair.completesReceived).toBe(2);
    expect(pair.settlements).toHaveLength(1);
    // This time the ack arrives, and the completion is no longer retained.
    pair.disconnect(); await pair.connect();
    expect(pair.completesReceived).toBe(2);
    expect(pair.settlements).toHaveLength(1);
  });

  it("finishes a launch the restarted daemon never knew as host_disconnected, once", async () => {
    const pair = new Pair(true);
    await pair.connect();
    const { done, launchId } = await pair.launch();
    pair.emit(launchId, { type: "launched" });
    pair.disconnect();
    pair.daemon = new ReconnectableFrameSink(); // the daemon process restarted and lost its launch
    await pair.connect();
    await expect(done).resolves.toMatchObject({ exit_code: -1, error: "host_disconnected" });
    expect(pair.settlements).toHaveLength(1);
  });

  it("settles nothing in a restarted server's registry when the daemon replays a completion it holds", async () => {
    const pair = new Pair(true);
    await pair.connect({ dropAcks: true });
    const { launchId } = await pair.launch();
    pair.emit(launchId, { type: "launched" });
    pair.disconnect();
    pair.emit(launchId, OK);
    // A new server process: an empty registry receives the daemon's replay. The Run is
    // the durable Run recovery's to settle; the transport only clears what it retained.
    const restarted = new Pair(true, new HostConnectionRegistry());
    restarted.daemon = pair.daemon;
    await restarted.connect();
    expect(restarted.completesReceived).toBe(1);
    expect(restarted.settlements).toEqual([]);
    restarted.disconnect(); await restarted.connect();
    expect(restarted.completesReceived).toBe(1);
    expect(restarted.settlements).toEqual([]);
  });

  it("settles host_disconnected after the grace period, owes the stop, and ignores the late completion", async () => {
    vi.useFakeTimers();
    const pair = new Pair(true);
    await pair.connect();
    const { done, launchId } = await pair.launch();
    pair.emit(launchId, { type: "launched" });
    pair.disconnect();
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(done).resolves.toMatchObject({ exit_code: -1, error: "host_disconnected" });
    pair.emit(launchId, OK);
    await pair.connect();
    expect(pair.completesReceived).toBe(1);
    expect(pair.terminated).toEqual([{ run_id: RUN, launch_id: launchId }]);
    expect(pair.settlements).toHaveLength(1);
  });

  it("resumes the surviving launch, not a superseded one, after a retry while offline", async () => {
    const pair = new Pair(true);
    await pair.connect();
    const first = await pair.launch();
    pair.emit(first.launchId, { type: "launched" });
    const second = await pair.launch();
    pair.emit(second.launchId, { type: "launched" });
    pair.disconnect();
    pair.emit(first.launchId, { type: "complete", exit_code: 137, timed_out: true, error: null });
    pair.emit(second.launchId, OK);
    await pair.connect();
    await expect(first.done).resolves.toMatchObject({ error: "superseded_by_retry" });
    await expect(second.done).resolves.toMatchObject({ exit_code: 0 });
    expect(pair.settlements.map((settled) => settled.exit_code)).toEqual([0]);
  });
});
