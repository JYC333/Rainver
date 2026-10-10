import type { HostDaemonFrame } from "@rainver/protocol";
/**
 * A run outlives a single WebSocket connection. An interrupted connection
 * while a run is active keeps the process alive. `handleLaunch` is called
 * once, at launch, with whatever frame sink is current then. Do not close
 * over that one connection: a reconnect mid-run would send the run's
 * `output` and `complete` frames on a dead socket. This class is the stable
 * object `handleLaunch` closes over. `bind` and `unbindIfCurrent` hand off
 * where frames currently go without `handleLaunch` knowing a reconnect
 * happened.
 */
export class ReconnectableFrameSink {
  private current: ((frame: HostDaemonFrame) => void) | null = null;

  send(frame: HostDaemonFrame): void {
    this.current?.(frame);
  }

  /** Called once a connection's hello succeeds — frames now go out on it. */
  bind(sendOnThisConnection: (frame: HostDaemonFrame) => void): void {
    this.current = sendOnThisConnection;
  }

  /**
   * Called when a connection closes. Only clears the binding if this
   * connection is still the current one — guards the handoff race where a
   * newer connection's `bind` already ran before this older connection's
   * `close` event fires, which would otherwise clobber the newer binding.
   */
  unbindIfCurrent(sendOnThisConnection: (frame: HostDaemonFrame) => void): void {
    if (this.current === sendOnThisConnection) this.current = null;
  }
}
