import { describe, expect, it, vi } from "vitest";
import { ReconnectableFrameSink } from "../src/reconnectableFrameSink.js";

describe("ReconnectableFrameSink", () => {
  it("drops a frame sent before any connection has bound", () => {
    const sink = new ReconnectableFrameSink();
    expect(() => sink.send({ type: "complete", run_id: "run-1" })).not.toThrow();
  });

  it("routes a frame to whichever connection is currently bound", () => {
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    sink.bind(connectionA);
    sink.send({ type: "output", run_id: "run-1", chunk: "hello" });
    expect(connectionA).toHaveBeenCalledWith({ type: "output", run_id: "run-1", chunk: "hello" });
  });

  it("delivers a run's complete frame on a later connection after a reconnect mid-run", () => {
    // The exact bug this class fixes: a run launched while connection A was
    // live must still deliver its `complete` frame if the WS reconnects to
    // connection B before the run's process actually finishes — not be
    // silently dropped on the now-dead connection A.
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    const connectionB = vi.fn();

    sink.bind(connectionA);
    // A launch captures `(frame) => sink.send(frame)`, not `connectionA`
    // directly — simulate that indirection here.
    const runFrameSink = (frame: Record<string, unknown>) => sink.send(frame);

    // Connection A drops mid-run.
    sink.unbindIfCurrent(connectionA);
    // Connection B comes up and binds.
    sink.bind(connectionB);

    // The still-running process now finishes and sends its complete frame
    // through the indirection captured back at launch time.
    runFrameSink({ type: "complete", run_id: "run-1", exit_code: 0, timed_out: false, error: null });

    expect(connectionA).not.toHaveBeenCalled();
    expect(connectionB).toHaveBeenCalledWith({ type: "complete", run_id: "run-1", exit_code: 0, timed_out: false, error: null });
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

    sink.send({ type: "heartbeat" });
    expect(connectionB).toHaveBeenCalledWith({ type: "heartbeat" });
    expect(connectionA).not.toHaveBeenCalled();
  });

  it("drops frames sent while disconnected between two connections", () => {
    const sink = new ReconnectableFrameSink();
    const connectionA = vi.fn();
    sink.bind(connectionA);
    sink.unbindIfCurrent(connectionA);

    expect(() => sink.send({ type: "output", run_id: "run-1", chunk: "x" })).not.toThrow();
    expect(connectionA).not.toHaveBeenCalled();
  });
});
