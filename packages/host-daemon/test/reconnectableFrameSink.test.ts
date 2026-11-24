import { describe, expect, it, vi } from "vitest";
import type { HostDaemonFrame } from "@rainver/protocol";
import { ReconnectableFrameSink } from "../src/reconnectableFrameSink.js";

describe("ReconnectableFrameSink", () => {
  it("retains an enqueued completion until its launch is acknowledged by the server", () => {
    const sink = new ReconnectableFrameSink();
    const complete = { type: "complete", run_id: "run-1", launch_id: "launch-1", exit_code: 0, timed_out: false, error: null } as const;
    const old = vi.fn(() => true);
    const next = vi.fn(() => true);
    sink.bind(old, true);
    sink.send(complete);
    sink.unbindIfCurrent(old);
    sink.bind(next, true);
    expect(old).toHaveBeenCalledExactlyOnceWith(complete);
    expect(next).toHaveBeenCalledExactlyOnceWith(complete);
    sink.acknowledgeCompletion(complete.run_id, complete.launch_id);
    sink.bind(old, true);
    expect(old).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a surviving launch from one the daemon never received", () => {
    const sink = new ReconnectableFrameSink();
    const send = vi.fn();
    sink.bind(send, true);
    sink.beginLaunch("run-1", "launch-1");
    sink.send({ type: "launched", run_id: "run-1", launch_id: "launch-1" });
    sink.reconcileLaunch("run-1", "launch-1");
    sink.reconcileLaunch("run-1", "absent-launch");
    expect(send.mock.calls.slice(1)).toEqual([
      [{ type: "run_reconnect_state", run_id: "run-1", launch_id: "launch-1", phase: "launched" }],
      [{ type: "run_reconnect_state", run_id: "run-1", launch_id: "absent-launch", phase: "missing" }],
    ]);
  });
  it("replays a completion sent while disconnected exactly once on the next connection", () => {
    const sink = new ReconnectableFrameSink();
    const frame = { type: "complete", run_id: "run-1", launch_id: "launch-1", exit_code: 0, timed_out: false, error: null } as const;
    const first = vi.fn();
    const second = vi.fn();
    sink.bind(first);
    sink.unbindIfCurrent(first);
    sink.send(frame);
    sink.bind(first);
    sink.bind(second);
    expect(first).toHaveBeenCalledExactlyOnceWith(frame);
    expect(second).not.toHaveBeenCalled();
  });

  it("routes a frame to whichever connection is currently bound", () => {
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    sink.bind(connectionA);
    sink.send({ type: "output", run_id: "run-1", launch_id: "launch-1", chunk: "hello" });
    expect(connectionA).toHaveBeenCalledWith({ type: "output", run_id: "run-1", launch_id: "launch-1", chunk: "hello" });
  });

  it("delivers a run's complete frame on a later connection after a reconnect mid-run", () => {
    // A complete frame must still deliver after the WebSocket reconnects.
    // Do not bind the run to the connection that was live at launch.
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    const connectionB = vi.fn();

    sink.bind(connectionA);
    // A launch captures `(frame) => sink.send(frame)`, not `connectionA`
    // directly — simulate that indirection here.
    const runFrameSink = (frame: HostDaemonFrame) => sink.send(frame);

    // Connection A drops mid-run.
    sink.unbindIfCurrent(connectionA);
    // Connection B comes up and binds.
    sink.bind(connectionB);

    // The still-running process now finishes and sends its complete frame
    // through the indirection captured back at launch time.
    runFrameSink({ type: "complete", run_id: "run-1", launch_id: "launch-1", exit_code: 0, timed_out: false, error: null });

    expect(connectionA).not.toHaveBeenCalled();
    expect(connectionB).toHaveBeenCalledWith({ type: "complete", run_id: "run-1", launch_id: "launch-1", exit_code: 0, timed_out: false, error: null });
  });

  it("does not clobber a newer connection's binding if an older connection's close arrives late", () => {
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    const connectionB = vi.fn();

    sink.bind(connectionA);
    sink.bind(connectionB);
    // Connection A's close handler fires after B already took over — its
    // stale reference must not be allowed to unbind B.
    sink.unbindIfCurrent(connectionA);

    sink.send({ type: "launched", run_id: "run-1", launch_id: "launch-1" });
    expect(connectionB).toHaveBeenCalledWith({ type: "launched", run_id: "run-1", launch_id: "launch-1" });
    expect(connectionA).not.toHaveBeenCalled();
  });

  it("replays launch, fragmented ACP output and completion in order", () => {
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    const connectionB = vi.fn();
    const attempt = { run_id: "run-1", launch_id: "launch-1" };
    const frames: HostDaemonFrame[] = [
      { ...attempt, type: "waiting_for_workspace" },
      { ...attempt, type: "launched" },
      { ...attempt, type: "output", chunk: '{"jsonrpc":' },
      { ...attempt, type: "output", chunk: '"2.0"}\n' },
      { ...attempt, type: "stderr", chunk: "diagnostic" },
      { ...attempt, type: "complete", exit_code: 0, timed_out: false, error: null },
    ];
    sink.bind(connectionA);
    sink.unbindIfCurrent(connectionA);
    frames.forEach((frame) => sink.send(frame));
    sink.bind(() => false);
    sink.bind(connectionB);
    expect(connectionA).not.toHaveBeenCalled();
    expect(connectionB.mock.calls.map(([frame]) => frame)).toEqual(frames);
  });

  it("reports overflow only after the process sends a real completion", () => {
    const sink = new ReconnectableFrameSink();
    const connection = vi.fn();
    const attempt = { run_id: "run-1", launch_id: "launch-1" };
    const launched = { ...attempt, type: "launched" } as const;
    sink.send(launched);
    sink.send({ ...attempt, type: "output", chunk: "x".repeat(16 * 1024 * 1024 + 1) });
    sink.bind(connection);
    sink.send({ ...attempt, type: "output", chunk: "discarded tail" });
    expect(connection).toHaveBeenCalledExactlyOnceWith(launched);
    sink.send({ ...attempt, type: "complete", exit_code: 0, timed_out: false, error: null });
    expect(connection).toHaveBeenLastCalledWith({
      ...attempt, type: "complete", exit_code: 1, timed_out: false,
      error: "Host Run output exceeded the reconnect buffer.",
    });
  });
});
