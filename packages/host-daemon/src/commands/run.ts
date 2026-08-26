import { helloInfo } from "../api.js";
import { loadConfig, requireConfig } from "../config.js";
import {
  handleLaunch,
  handleStdin,
  handleStdinClose,
  handleTerminate,
  sweepStaleRunProfiles,
  type LaunchFrame,
  type ProviderBindingFrame,
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
export function parseProviderBinding(value: unknown): ProviderBindingFrame | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("launch frame carried a malformed provider_binding");
  }
  const record = value as Record<string, unknown>;
  const files = Array.isArray(record.files) ? record.files : null;
  if (!files || !isStringMap(record.env) || !isStringMap(record.profile_env)) {
    throw new Error("launch frame carried a malformed provider_binding");
  }
  if (typeof record.profile_key !== "string" || !record.profile_key) {
    throw new Error("launch frame carried a provider_binding with no profile key");
  }
  return {
    profile_key: record.profile_key,
    env: record.env as Record<string, string>,
    profile_env: record.profile_env as Record<string, string>,
    files: files.map((entry) => {
      const file = entry as Record<string, unknown>;
      if (typeof file?.relative_path !== "string" || typeof file?.contents !== "string") {
        throw new Error("launch frame carried a malformed provider_binding file");
      }
      return {
        relative_path: file.relative_path,
        contents: file.contents,
        ...(file.escape === "toml_basic_string" ? { escape: "toml_basic_string" as const } : {}),
      };
    }),
  };
}

function isStringMap(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

export async function runService(options: { log?: (line: string) => void } = {}): Promise<never> {
  const log = options.log ?? ((line: string) => console.log(`[rainver-host] ${line}`));
  const config = await requireConfig();
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  // A run outlives a single WebSocket connection (§5 — "an interrupted
  // connection while a run is active keeps the process alive"); see
  // `ReconnectableFrameSink`'s doc comment for why this can't be a plain
  // per-connection closure.
  const sink = new ReconnectableFrameSink();

  for (;;) {
    try {
      await connectOnce(config.server_url, config.token, log, sink, config.workspaces);
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

function connectOnce(serverUrl: string, token: string, log: (line: string) => void, sink: ReconnectableFrameSink, workspaces: Record<string, string>): Promise<void> {
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
    const currentWorkspaces = async () => (await loadConfig())?.workspaces ?? workspaces;

    socket.addEventListener("open", () => {
      void currentWorkspaces().then((ws) => helloInfo(ws, serverUrl)).then((info) => {
        // Reclaims per-run profiles written by an older daemon, which no run
        // will ever come back for. Profiles are shared per adapter and
        // provider now, and are not swept.
        void sweepStaleRunProfiles().then((removed) => {
          if (removed > 0) log(`removed ${removed} profile(s) from a previous daemon layout`);
        }).catch(() => {});
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
          void currentWorkspaces().then((ws) => helloInfo(ws, serverUrl)).then((info) => socket.send(JSON.stringify({ type: "heartbeat", ...info })));
        }, HEARTBEAT_INTERVAL_MS);
        return;
      }
      if (frame.type === "error") {
        log(`server error: ${String(frame.detail)}`);
        return;
      }
      if (frame.type === "launch" && typeof frame.run_id === "string" && Array.isArray(frame.argv)) {
        let providerBinding: ProviderBindingFrame | undefined;
        try {
          providerBinding = parseProviderBinding(frame.provider_binding);
        } catch (error) {
          // Throwing here would escape the WS listener and take the whole
          // daemon down, losing the reporting channel for every other run.
          // Fail this run instead, and say why.
          log(`launch run ${String(frame.run_id)}: rejected: ${error instanceof Error ? error.message : String(error)}`);
          sink.send({
            type: "complete",
            run_id: frame.run_id,
            exit_code: 1,
            timed_out: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const launchFrame: LaunchFrame = {
          run_id: frame.run_id,
          workspace_location_id: typeof frame.workspace_location_id === "string" ? frame.workspace_location_id : undefined,
          project_folder_id: typeof frame.project_folder_id === "string" ? frame.project_folder_id : undefined,
          argv: frame.argv.map(String),
          stdin: typeof frame.stdin === "string" ? frame.stdin : null,
          timeout_seconds: typeof frame.timeout_seconds === "number" ? frame.timeout_seconds : null,
          keep_stdin_open: frame.keep_stdin_open === true,
          // Dropping this silently is how a bound run ends up on the machine's
          // own login while the control plane believes otherwise, so it is
          // parsed strictly above: a malformed binding fails the run rather
          // than degrading into an unbound one.
          provider_binding: providerBinding,
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
