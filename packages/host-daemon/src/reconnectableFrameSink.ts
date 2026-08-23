/**
 * A run outlives a single WebSocket connection (control-center-plan.md §5 —
 * "an interrupted connection while a run is active keeps the process
 * alive"). `handleLaunch` is only ever called once, at launch time, with
 * whatever frame sink is current then; if it captured a plain closure bound
 * to that one connection, a reconnect mid-run would leave the run's
 * eventual `output`/`complete` frames being sent on a dead socket forever
 * (silently dropped — this was a real bug, found in the plan's final
 * integration review). This class is the one stable object `handleLaunch`
 * closes over: `bind`/`unbindIfCurrent` let each connection attempt hand off
 * "where frames currently go" without `handleLaunch` ever needing to know a
 * reconnect happened.
 */
export class ReconnectableFrameSink {
  private current: ((frame: Record<string, unknown>) => void) | null = null;

  send(frame: Record<string, unknown>): void {
    this.current?.(frame);
  }

  /** Called once a connection's hello succeeds — frames now go out on it. */
  bind(sendOnThisConnection: (frame: Record<string, unknown>) => void): void {
    this.current = sendOnThisConnection;
  }

  /**
   * Called when a connection closes. Only clears the binding if this
   * connection is still the current one — guards the handoff race where a
   * newer connection's `bind` already ran before this older connection's
   * `close` event fires, which would otherwise clobber the newer binding.
   */
  unbindIfCurrent(sendOnThisConnection: (frame: Record<string, unknown>) => void): void {
    if (this.current === sendOnThisConnection) this.current = null;
  }
}
