import { randomUUID } from "node:crypto";
import type { FileContent, FileNode, GitDiff, GitStatus } from "@rainver/folder-read";
/**
 * ADR 0016 P3: tracks which hosts currently hold a live WebSocket connection
 * and lets server code (the dispatch path, `RemoteWsCliCommandExecutor`)
 * push job frames to a specific daemon and correlate its replies back to the
 * run that triggered them. A process-wide singleton, same reasoning as
 * `sharedCliProcessRegistry` (`server/src/modules/runs/processRegistry.ts`):
 * it must be the same instance across every request path in this process,
 * since the connection lives only in this process's memory (audit report
 * §5.6's accepted single-process assumption for phase 1).
 *
 * Pending runs are tracked by run_id, not nested inside the connection
 * object, and survive a reconnect within `RECONNECT_GRACE_MS`
 * (control-center-plan.md §5: "an interrupted connection while a run is
 * active keeps the process alive"). A brief WS blip — laptop sleep/wake, a
 * flaky network — must not permanently fail a run whose daemon-side process
 * is still running and will report its real outcome once reconnected.
 *
 * Narrower than the plan's full "interruption semantics" bullet: a
 * disconnect that outlasts the grace window still resolves the pending run
 * as a normal failure (`host_disconnected`), not a distinct `interrupted`
 * run status with its own reconciliation-on-reconnect lifecycle — adding a
 * new terminal run status would touch retry policy, the supervisor, and
 * finalization across the whole run subsystem, out of proportion for this
 * phase. See `.agent/tasks/deferred-register.md`.
 */

export interface HostFrameSink {
  send(frame: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
}

const RECONNECT_GRACE_MS = 60_000;

interface PendingRun {
  hostId: string;
  onOutput?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * ACP runtime replatform P2: fires once the daemon confirms the run is
   * registered and its child process spawned. A bidirectional-protocol
   * caller must wait for this before sending the first `stdin` frame — see
   * the `launched` frame's doc comment in `packages/host-daemon/src/execution.ts`.
   */
  onLaunched?: () => void;
  resolveComplete: (result: { exit_code: number; timed_out: boolean; error: string | null }) => void;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /**
   * ACP runtime replatform P2 (discovery review fix): a controller-driven
   * run depends on live outbound `stdin`/`stdin_close` traffic for the
   * entire run, unlike the one-shot launch path this registry's grace-period
   * tolerance was originally built for. Without this queue, a `stdin` frame
   * sent during the same brief blip the grace timer already tolerates for
   * `output`/`complete` would be silently dropped — the daemon-side agent
   * and the controller would each wait on a message that never arrives,
   * stalling the run until its full timeout instead of a few seconds.
   * Queued frames are redelivered in order once `registerConnection` sees
   * this host reconnect, mirroring the same "a blip must not lose this run's
   * state" tolerance already applied to the grace timer above.
   */
  pendingStdin: Array<{ type: "stdin"; value: string } | { type: "stdin_close" }>;
}

interface HostConnection {
  sink: HostFrameSink | null;
}

/** What the daemon reports back for one `install_tool` / `uninstall_tool` request. */
/** Terminal report of one ambient-session import; sessions arrive before it, one frame each. */
export interface AmbientImportResult {
  ok: boolean;
  error: string | null;
  session_count: number;
  /**
   * Every session the host still holds for the folder, as it enumerated them.
   * Null when the enumeration itself failed — the difference matters, because
   * an empty list is evidence that the history is gone and a failed one is
   * evidence of nothing.
   */
  listed_session_ids: string[] | null;
}

export interface ToolInstallResult {
  ok: boolean;
  error: string | null;
  /** The installation id (`managed:<version>`) the action produced or removed. */
  installation: string | null;
}

export type FolderReadKind = "tree" | "file" | "git_status" | "git_diff";
export type FolderReadFailureCode = "host_offline" | "host_timeout" | "location_unknown" | "path_forbidden" | "not_found" | "is_directory" | "too_large" | "read_failed";
/** What each `folder_read` kind returns, so callers keep the type the daemon produced. */
export interface FolderReadPayload {
  tree: FileNode;
  file: FileContent;
  git_status: GitStatus;
  git_diff: GitDiff;
}
export type FolderReadSuccess<K extends FolderReadKind = FolderReadKind> =
  { [Kind in K]: { ok: true; kind: Kind; result: FolderReadPayload[Kind] } }[K];
export type FolderReadFailure = { ok: false; error: FolderReadFailureCode; message?: string };
export type FolderReadResult<K extends FolderReadKind = FolderReadKind> = FolderReadSuccess<K> | FolderReadFailure;

/** What a daemon's login terminal sends back, frame by frame. */
export type LoginSessionEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exit_code: number; logged_in: boolean | null };

interface PendingLogin {
  hostId: string;
  onEvent: (event: LoginSessionEvent) => void;
}

/** An install is a download plus an `npm install`; minutes, not seconds. */
const TOOL_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * An import replays every changed session, and each replay starts an agent
 * process on the host. A folder with a month of history can take minutes; the
 * ceiling exists so a wedged runtime eventually frees the request, not to
 * bound normal work.
 */
const AMBIENT_IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
export const FOLDER_READ_TIMEOUT_MS = 15_000;

export class HostConnectionRegistry {
  private readonly connections = new Map<string, HostConnection>();
  private readonly pending = new Map<string, PendingRun>();
  private readonly pendingInstalls = new Map<string, { hostId: string; resolve: (result: ToolInstallResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly pendingImports = new Map<string, {
    hostId: string;
    onSession: (session: unknown) => void;
    resolve: (result: AmbientImportResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingFolderReads = new Map<string, {
    hostId: string;
    kind: FolderReadKind;
    resolve: (result: FolderReadResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Settles everything waiting on a host that has gone.
   *
   * Unlike a run, an import and an install have no reconnect grace: the
   * request behind them is an HTTP call someone is waiting on, and holding it
   * open for the full timeout after the host is already known to be gone is
   * a hang, not patience.
   */
  private failPendingRequests(hostId: string): void {
    for (const [requestId, pending] of this.pendingInstalls) {
      if (pending.hostId !== hostId) continue;
      this.pendingInstalls.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "host_disconnected", installation: null });
    }
    for (const [requestId, pending] of this.pendingImports) {
      if (pending.hostId !== hostId) continue;
      this.pendingImports.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "host_disconnected", session_count: 0, listed_session_ids: null });
    }
    for (const [requestId, pending] of this.pendingFolderReads) {
      if (pending.hostId !== hostId) continue;
      this.pendingFolderReads.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "host_offline" });
    }
  }
  private readonly logins = new Map<string, PendingLogin>();

  registerConnection(hostId: string, sink: HostFrameSink): void {
    // A second connection from the same host (e.g. daemon restart racing its
    // own reconnect) replaces the stale one rather than stacking silently.
    this.connections.get(hostId)?.sink?.close(1000, "superseded_by_new_connection");
    this.connections.set(hostId, { sink });
    // The daemon is back before any pending run's grace period expired —
    // let it keep waiting for the real outcome instead of failing it out.
    for (const [runId, pendingRun] of this.pending) {
      if (pendingRun.hostId !== hostId) continue;
      if (pendingRun.graceTimer) {
        clearTimeout(pendingRun.graceTimer);
        pendingRun.graceTimer = null;
      }
      if (pendingRun.pendingStdin.length === 0) continue;
      const queued = pendingRun.pendingStdin;
      pendingRun.pendingStdin = [];
      for (const frame of queued) {
        sink.send(frame.type === "stdin"
          ? { type: "stdin", run_id: runId, value: frame.value }
          : { type: "stdin_close", run_id: runId });
      }
    }
  }

  unregisterConnection(hostId: string, sink: HostFrameSink): void {
    const connection = this.connections.get(hostId);
    if (!connection || connection.sink !== sink) return;
    connection.sink = null;
    for (const [runId, pendingRun] of this.pending) {
      if (pendingRun.hostId !== hostId || pendingRun.graceTimer) continue;
      pendingRun.graceTimer = setTimeout(() => {
        this.pending.delete(runId);
        pendingRun.resolveComplete({ exit_code: -1, timed_out: false, error: "host_disconnected" });
      }, RECONNECT_GRACE_MS);
      pendingRun.graceTimer.unref?.();
    }
    this.failPendingRequests(hostId);
  }

  isOnline(hostId: string): boolean {
    return this.connections.get(hostId)?.sink != null;
  }

  /**
   * Closes a host's live connection immediately, if it has one — used on
   * revoke so "revoke = cut off now" holds even for a daemon that was
   * already connected when its token was revoked (the WS `close` handler
   * calls `unregisterConnection`, which starts pending runs down the normal
   * grace-period path rather than failing them out instantly here).
   */
  closeConnection(hostId: string, code?: number, reason?: string): void {
    this.connections.get(hostId)?.sink?.close(code, reason);
  }

  /** Sends the launch frame and returns a promise that resolves on the matching `complete` frame. */
  dispatchLaunch(
    hostId: string,
    runId: string,
    frame: Record<string, unknown>,
    onOutput?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
    onLaunched?: () => void,
  ): Promise<{ exit_code: number; timed_out: boolean; error: string | null }> {
    const connection = this.connections.get(hostId);
    if (!connection?.sink) return Promise.resolve({ exit_code: -1, timed_out: false, error: "host_offline" });
    const sink = connection.sink;
    return new Promise((resolve) => {
      this.pending.set(runId, { hostId, onOutput, onStderr, onLaunched, resolveComplete: resolve, graceTimer: null, pendingStdin: [] });
      sink.send({ ...frame, type: "launch", run_id: runId });
    });
  }

  sendTerminate(hostId: string, runId: string, force: boolean): boolean {
    const connection = this.connections.get(hostId);
    if (!connection?.sink) return false;
    connection.sink.send({ type: "terminate", run_id: runId, force });
    return true;
  }

  /**
   * Drives a bidirectional-protocol run's child stdin across the run's
   * lifetime. If the host is briefly offline, the frame is queued on the
   * pending run (see `PendingRun.pendingStdin`) and redelivered once
   * `registerConnection` sees this host reconnect, rather than silently
   * dropped — the same reconnect tolerance `output`/`complete` already get.
   */
  sendStdin(hostId: string, runId: string, value: string): boolean {
    const connection = this.connections.get(hostId);
    if (connection?.sink) {
      connection.sink.send({ type: "stdin", run_id: runId, value });
      return true;
    }
    const pending = this.pending.get(runId);
    if (pending?.hostId === hostId) pending.pendingStdin.push({ type: "stdin", value });
    return false;
  }

  /** Signals the daemon to close the run's child stdin, ending an interactive protocol session's input stream. Queued and redelivered the same way `sendStdin` is if the host is briefly offline. */
  sendStdinClose(hostId: string, runId: string): boolean {
    const connection = this.connections.get(hostId);
    if (connection?.sink) {
      connection.sink.send({ type: "stdin_close", run_id: runId });
      return true;
    }
    const pending = this.pending.get(runId);
    if (pending?.hostId === hostId) pending.pendingStdin.push({ type: "stdin_close" });
    return false;
  }

  /**
   * Asks a daemon to install a tool into its managed tools directory and
   * resolves with its report. Unlike a run, an install has no reconnect
   * grace: a daemon that drops mid-install starts over on the next request,
   * and the operator sees the failure now rather than after a grace period.
   */
  requestToolAction(hostId: string, type: "install_tool" | "uninstall_tool", frame: Record<string, unknown>): Promise<ToolInstallResult> {
    const connection = this.connections.get(hostId);
    if (!connection?.sink) return Promise.resolve({ ok: false, error: "host_offline", installation: null });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInstalls.delete(requestId);
        resolve({ ok: false, error: "install_timed_out", installation: null });
      }, TOOL_INSTALL_TIMEOUT_MS);
      timer.unref?.();
      this.pendingInstalls.set(requestId, { hostId, resolve, timer });
      connection.sink!.send({ ...frame, type, request_id: requestId });
    });
  }

  /**
   * Asks a daemon to replay a folder's ambient CLI sessions.
   *
   * Sessions stream back one frame each rather than as one reply: a folder's
   * history is megabytes even after trimming, and a single frame would have to
   * be buffered whole on both ends. The promise settles on the daemon's
   * terminal report, or on the timeout — replaying a session starts an agent
   * process, so the ceiling is minutes rather than the seconds an install gets.
   */
  requestAmbientImport(
    hostId: string,
    frame: Record<string, unknown>,
    onSession: (session: unknown) => void,
  ): Promise<AmbientImportResult> {
    const connection = this.connections.get(hostId);
    if (!connection?.sink) return Promise.resolve({ ok: false, error: "host_offline", session_count: 0, listed_session_ids: null });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingImports.delete(requestId);
        resolve({ ok: false, error: "ambient_import_timed_out", session_count: 0, listed_session_ids: null });
      }, AMBIENT_IMPORT_TIMEOUT_MS);
      timer.unref?.();
      this.pendingImports.set(requestId, { hostId, onSession, resolve, timer });
      connection.sink!.send({ ...frame, type: "ambient_import", request_id: requestId });
    });
  }

  receiveAmbientImportSession(hostId: string, requestId: string, session: unknown): void {
    const pending = this.pendingImports.get(requestId);
    if (!pending || pending.hostId !== hostId) return;
    pending.onSession(session);
  }

  receiveAmbientImportResult(hostId: string, requestId: string, result: AmbientImportResult): void {
    const pending = this.pendingImports.get(requestId);
    if (!pending || pending.hostId !== hostId) return;
    this.pendingImports.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** Asks a daemon for one bounded live tree/file/Git read. */
  requestFolderRead<K extends FolderReadKind>(hostId: string, frame: { kind: K } & Record<string, unknown>): Promise<FolderReadResult<K>> {
    const connection = this.connections.get(hostId);
    if (!connection?.sink) return Promise.resolve({ ok: false, error: "host_offline" });
    const kind = frame.kind;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFolderReads.delete(requestId);
        resolve({ ok: false, error: "host_timeout" });
      }, FOLDER_READ_TIMEOUT_MS);
      timer.unref?.();
      this.pendingFolderReads.set(requestId, { hostId, kind, resolve: resolve as (result: FolderReadResult) => void, timer });
      try {
        connection.sink!.send({ ...frame, type: "folder_read", request_id: requestId });
      } catch {
        clearTimeout(timer);
        this.pendingFolderReads.delete(requestId);
        resolve({ ok: false, error: "host_offline" });
      }
    });
  }

  /** Routes a daemon's single-frame folder read response to its caller. */
  receiveFolderReadResult(hostId: string, requestId: string, result: FolderReadResult): void {
    const pending = this.pendingFolderReads.get(requestId);
    if (!pending || pending.hostId !== hostId) return;
    if (result.ok && result.kind !== pending.kind) return;
    clearTimeout(pending.timer);
    this.pendingFolderReads.delete(requestId);
    pending.resolve(result);
  }

  /**
   * Opens an interactive login on the daemon and relays its terminal. The
   * person types through `sendLoginInput`; the session ends when the login
   * command exits or the caller closes it. Returns the session id, or null
   * when the host is offline.
   */
  openLoginSession(hostId: string, frame: Record<string, unknown>, onEvent: (event: LoginSessionEvent) => void): string | null {
    const connection = this.connections.get(hostId);
    if (!connection?.sink) return null;
    const sessionId = randomUUID();
    this.logins.set(sessionId, { hostId, onEvent });
    connection.sink.send({ ...frame, type: "login_open", session_id: sessionId });
    return sessionId;
  }

  sendLoginInput(hostId: string, sessionId: string, data: string): boolean {
    const connection = this.connections.get(hostId);
    if (!connection?.sink || this.logins.get(sessionId)?.hostId !== hostId) return false;
    connection.sink.send({ type: "login_input", session_id: sessionId, data });
    return true;
  }

  closeLoginSession(hostId: string, sessionId: string): void {
    const pending = this.logins.get(sessionId);
    if (!pending || pending.hostId !== hostId) return;
    this.logins.delete(sessionId);
    this.connections.get(hostId)?.sink?.send({ type: "login_close", session_id: sessionId });
  }

  /** Routes a daemon's `login_output` / `login_exit` frame to the stream that opened the session. */
  receiveLoginEvent(hostId: string, sessionId: string, event: LoginSessionEvent): void {
    const pending = this.logins.get(sessionId);
    if (!pending || pending.hostId !== hostId) return;
    if (event.type === "exit") this.logins.delete(sessionId);
    pending.onEvent(event);
  }

  /** Routes a daemon's `tool_result` frame to the request that asked. */
  receiveToolResult(hostId: string, requestId: string, result: ToolInstallResult): void {
    const pending = this.pendingInstalls.get(requestId);
    if (!pending || pending.hostId !== hostId) return;
    clearTimeout(pending.timer);
    this.pendingInstalls.delete(requestId);
    pending.resolve(result);
  }

  /** Routes a daemon's `launched` frame to whatever dispatched that run, so it knows the child process is registered before sending any `stdin` frame. */
  receiveLaunched(hostId: string, runId: string): void {
    const pending = this.pending.get(runId);
    if (pending?.hostId === hostId) pending.onLaunched?.();
  }

  /** Routes a daemon's `output` frame to whatever is awaiting that run's stream. */
  receiveOutput(hostId: string, runId: string, chunk: string): void {
    const pending = this.pending.get(runId);
    if (pending?.hostId === hostId) pending.onOutput?.(chunk);
  }

  /** Routes a daemon's `stderr` frame the same way `receiveOutput` routes `output` (C5: full live stream, not just a failure tail). */
  receiveStderr(hostId: string, runId: string, chunk: string): void {
    const pending = this.pending.get(runId);
    if (pending?.hostId === hostId) pending.onStderr?.(chunk);
  }

  /** Routes a daemon's `complete` frame and clears the pending entry. */
  receiveComplete(hostId: string, runId: string, result: { exit_code: number; timed_out: boolean; error: string | null }): void {
    const pending = this.pending.get(runId);
    if (!pending || pending.hostId !== hostId) return;
    if (pending.graceTimer) clearTimeout(pending.graceTimer);
    this.pending.delete(runId);
    pending.resolveComplete(result);
  }
}

export const sharedHostConnectionRegistry = new HostConnectionRegistry();
