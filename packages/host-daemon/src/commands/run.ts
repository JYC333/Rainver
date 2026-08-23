import { helloInfo } from "../api.js";
import { requireConfig } from "../config.js";
import {
  handleLaunch,
  handleStdin,
  handleStdinClose,
  handleTerminate,
  type LaunchFrame,
  type TerminateFrame,
} from "../execution.js";
import { ReconnectableFrameSink } from "../reconnectableFrameSink.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function wsUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/internal/hosts/ws`;
}

/**
 * Persistent outbound connection: register/hello, heartbeat, and now (P3)
 * job dispatch — launch/stream/terminate/upload/complete, delegated to
 * `execution.ts` (`RemoteHostExecutionAdapter`'s daemon-side counterpart;
 * see control-center-plan.md §5). This function does not return; it runs
 * until the process is killed, exactly like a systemd/launchd-managed
 * service is expected to.
 */
export async function runService(options: { log?: (line: string) => void } = {}): Promise<never> {
  const log = options.log ?? ((line: string) => console.log(`[agent-space-host] ${line}`));
  const config = await requireConfig();
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  // A run outlives a single WebSocket connection (§5 — "an interrupted
  // connection while a run is active keeps the process alive"); see
  // `ReconnectableFrameSink`'s doc comment for why this can't be a plain
  // per-connection closure.
  const sink = new ReconnectableFrameSink();

  for (;;) {
    try {
      await connectOnce(config.server_url, config.token, log, sink);
      reconnectDelay = RECONNECT_BASE_DELAY_MS;
    } catch (error) {
      log(`connection lost: ${error instanceof Error ? error.message : String(error)}`);
    }
    log(`reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectOnce(serverUrl: string, token: string, log: (line: string) => void, sink: ReconnectableFrameSink): Promise<void> {
  return new Promise((resolve, reject) => {
    const endpoint = wsUrl(serverUrl);
    log(`connecting to ${endpoint}`);
    const socket = new WebSocket(endpoint);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let helloAcked = false;
    // Bound into `sink` only once hello succeeds (below), matching when the
    // server actually registers this connection in
    // `sharedHostConnectionRegistry` — a frame sent on this socket before
    // that would be rejected server-side as unauthenticated anyway.
    const sendOnThisConnection = (payload: Record<string, unknown>) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    };

    socket.addEventListener("open", () => {
      void helloInfo().then((info) => {
        socket.send(JSON.stringify({ type: "hello", token, ...info }));
      });
    });

    socket.addEventListener("message", (event) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "hello_ack") {
        helloAcked = true;
        sink.bind(sendOnThisConnection);
        log(`connected as host ${String(frame.host_id)}`);
        heartbeatTimer = setInterval(() => {
          void helloInfo().then((info) => socket.send(JSON.stringify({ type: "heartbeat", ...info })));
        }, HEARTBEAT_INTERVAL_MS);
        return;
      }
      if (frame.type === "error") {
        log(`server error: ${String(frame.detail)}`);
        return;
      }
      if (frame.type === "launch" && typeof frame.run_id === "string" && Array.isArray(frame.argv)) {
        const launchFrame: LaunchFrame = {
          run_id: frame.run_id,
          project_folder_id: String(frame.project_folder_id ?? ""),
          argv: frame.argv.map(String),
          stdin: typeof frame.stdin === "string" ? frame.stdin : null,
          timeout_seconds: typeof frame.timeout_seconds === "number" ? frame.timeout_seconds : null,
          keep_stdin_open: frame.keep_stdin_open === true,
        };
        log(`launch run ${launchFrame.run_id}`);
        // Always routed through `sink`, never `sendOnThisConnection`
        // directly — this run's `complete` frame may need to go out on a
        // later reconnect, not this connection.
        void handleLaunch(launchFrame, (payload) => sink.send(payload), log).catch((error) => {
          log(`run ${launchFrame.run_id}: launch failed: ${error instanceof Error ? error.message : String(error)}`);
          sink.send({
            type: "complete",
            run_id: launchFrame.run_id,
            exit_code: 1,
            timed_out: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      if (frame.type === "terminate" && typeof frame.run_id === "string") {
        const terminateFrame: TerminateFrame = { run_id: frame.run_id, force: frame.force === true };
        handleTerminate(terminateFrame, log);
        return;
      }
      if (frame.type === "stdin" && typeof frame.run_id === "string" && typeof frame.value === "string") {
        handleStdin({ run_id: frame.run_id, value: frame.value });
        return;
      }
      if (frame.type === "stdin_close" && typeof frame.run_id === "string") {
        handleStdinClose({ run_id: frame.run_id });
        return;
      }
    });

    socket.addEventListener("close", (event) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      sink.unbindIfCurrent(sendOnThisConnection);
      if (helloAcked) resolve();
      else {
        const reason = event.reason ? `, reason ${event.reason}` : "";
        reject(new Error(`connection closed before hello was acknowledged (code ${event.code}${reason})`));
      }
    });

    socket.addEventListener("error", () => {
      // "close" always follows "error" for the WebSocket standard's
      // connection-failure path; let that handler settle the promise.
    });
  });
}
