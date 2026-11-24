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
type Sender = (frame: HostDaemonFrame) => boolean | void;
type RunFrame = Extract<HostDaemonFrame, { type: "launched" | "waiting_for_workspace" | "output" | "stderr" | "complete" }>;
type Completion = Extract<RunFrame, { type: "complete" }>;
type LaunchPhase = Extract<HostDaemonFrame, { type: "run_reconnect_state" }>["phase"];
type PendingFrames = { frames: RunFrame[]; bytes: number; overflowed: boolean; expires: number };
const REPLAY_TTL_MS = 10 * 60_000;
const REPLAY_LAUNCH_LIMIT = 256;
const REPLAY_FRAME_LIMIT = 1024;
const REPLAY_BYTE_LIMIT = 16 * 1024 * 1024;

function isRunFrame(frame: HostDaemonFrame): frame is RunFrame {
  return frame.type === "launched" || frame.type === "waiting_for_workspace" || frame.type === "output" || frame.type === "stderr" || frame.type === "complete";
}

function streamBytes(frame: RunFrame): number {
  return "chunk" in frame ? Buffer.byteLength(frame.chunk) : 0;
}

export class ReconnectableFrameSink {
  private current: Sender | null = null;
  private readonly pending = new Map<string, PendingFrames>();
  private readonly active = new Map<string, { runId: string; phase: LaunchPhase }>();
  private readonly completed = new Map<string, { frame: Completion; expires: number }>();
  private acknowledgeCompletions = false;
  private pendingBytes = 0;

  beginLaunch(runId: string, launchId: string): void {
    this.active.set(launchId, { runId, phase: "starting" });
  }

  acknowledgeCompletion(runId: string, launchId: string): void {
    if (this.completed.get(launchId)?.frame.run_id === runId) this.completed.delete(launchId);
  }

  reconcileLaunch(runId: string, launchId: string): void {
    this.prune(Date.now());
    const completed = this.completed.get(launchId);
    if (completed?.frame.run_id === runId) {
      this.current?.(completed.frame);
      return;
    }
    const active = this.active.get(launchId);
    this.current?.({ type: "run_reconnect_state", run_id: runId, launch_id: launchId,
      phase: active?.runId === runId ? active.phase : "missing" });
  }

  send(frame: HostDaemonFrame): void {
    if (!isRunFrame(frame)) {
      this.current?.(frame);
      return;
    }
    const active = this.active.get(frame.launch_id);
    if (frame.type === "complete") this.active.delete(frame.launch_id);
    else if (active && (frame.type === "launched" || frame.type === "waiting_for_workspace")) active.phase = frame.type;
    const pending = this.pending.get(frame.launch_id);
    if (!pending && this.current && this.deliver(this.current, frame)) return;
    const now = Date.now();
    this.prune(now);
    let batch = this.pending.get(frame.launch_id);
    if (!batch) {
      if (this.pending.size >= REPLAY_LAUNCH_LIMIT) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.remove(oldest);
      }
      batch = { frames: [], bytes: 0, overflowed: false, expires: now + REPLAY_TTL_MS };
      this.pending.set(frame.launch_id, batch);
    }
    if ("chunk" in frame) {
      const bytes = streamBytes(frame);
      if (batch.frames.length >= REPLAY_FRAME_LIMIT || this.pendingBytes + bytes > REPLAY_BYTE_LIMIT) {
        // A truncated ACP stream cannot be parsed. Keep lifecycle frames and
        // fail the Run only once the real child has finished and cleaned up.
        batch.overflowed = true;
        batch.frames = batch.frames.filter((item) => !("chunk" in item));
        this.pendingBytes -= batch.bytes;
        batch.bytes = 0;
      }
      if (!batch.overflowed) {
        batch.frames.push(frame);
        batch.bytes += bytes;
        this.pendingBytes += bytes;
      }
    } else {
      batch.frames.push(frame.type === "complete" && batch.overflowed
        ? { ...frame, exit_code: 1, error: "Host Run output exceeded the reconnect buffer." }
        : frame);
    }
    batch.expires = now + REPLAY_TTL_MS;
    if (this.current) this.flush(this.current);
  }

  /** Called once a connection's hello succeeds — frames now go out on it. */
  bind(sendOnThisConnection: Sender, acknowledgeCompletions = false): void {
    this.current = sendOnThisConnection;
    this.acknowledgeCompletions = acknowledgeCompletions;
    this.prune(Date.now());
    if (!acknowledgeCompletions) this.completed.clear();
    for (const { frame } of this.completed.values()) if (sendOnThisConnection(frame) === false) break;
    this.flush(sendOnThisConnection);
  }

  private deliver(send: Sender, frame: RunFrame): boolean {
    if (send(frame) === false) return false;
    if (frame.type === "complete" && this.acknowledgeCompletions) {
      this.completed.set(frame.launch_id, { frame, expires: Date.now() + REPLAY_TTL_MS });
      while (this.completed.size > REPLAY_LAUNCH_LIMIT) this.completed.delete(this.completed.keys().next().value!);
    }
    return true;
  }

  private flush(send: Sender): void {
    for (const [id, batch] of this.pending) {
      let sent = 0;
      for (const frame of batch.frames) {
        if (!this.deliver(send, frame)) break;
        sent++;
        const bytes = streamBytes(frame);
        this.pendingBytes -= bytes;
        batch.bytes -= bytes;
      }
      const deliveredCompletion = batch.frames[sent - 1]?.type === "complete";
      batch.frames.splice(0, sent);
      if (!batch.frames.length && (!batch.overflowed || deliveredCompletion)) this.remove(id);
      if (batch.frames.length) break;
    }
  }

  private prune(now: number): void {
    for (const [id, batch] of this.pending) {
      if (batch.expires <= now) this.remove(id);
    }
    for (const [id, completed] of this.completed) if (completed.expires <= now) this.completed.delete(id);
  }

  private remove(id: string): void {
    this.pendingBytes -= this.pending.get(id)?.bytes ?? 0;
    this.pending.delete(id);
  }

  /**
   * Called when a connection closes. Only clears the binding if this
   * connection is still the current one — guards the handoff race where a
   * newer connection's `bind` already ran before this older connection's
   * `close` event fires, which would otherwise clobber the newer binding.
   */
  unbindIfCurrent(sendOnThisConnection: Sender): void {
    if (this.current === sendOnThisConnection) this.current = null;
  }
}
