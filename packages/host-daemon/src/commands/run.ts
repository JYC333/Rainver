import { helloInfo, parseRuntimeProbes, type RuntimeProbe } from "../api.js";
import { loadConfig, requireConfig } from "../config.js";
import {
  handleLaunch,
  handleStdin,
  handleStdinClose,
  handleTerminate,
  resolveAcpLaunch,
  sweepStaleRunProfiles,
  type LaunchFrame,
  type ProviderBindingFrame,
  type TerminateFrame,
} from "../execution.js";
import { ReconnectableFrameSink } from "../reconnectableFrameSink.js";
import { OWN_INSTALLATION, installTool, managedInstallationId, parseInstallToolFrame, parseUninstallToolFrame, uninstallTool } from "../tools.js";
import { loginSession, openLoginSession, parseLoginOpenFrame } from "../login.js";
import { refreshAmbientSessionCounts } from "../ambientCounts.js";
import { DEFAULT_LIMITS, importAmbientSessions, sanitizeFailure, type AmbientImportRequest, type AmbientTrimLimits } from "../ambientSessions.js";
import { FolderReadFrameError, parseFolderReadFrame, performFolderRead } from "../folderRead.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** What the last `hello_ack` said about runtimes; see `helloInfo`. */
let lastRuntimeProbes: RuntimeProbe[] | undefined;

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
/**
 * Reads an `ambient_import` frame and resolves the runtime it names.
 *
 * The argv comes from the server's own runtime probes, cached from
 * `hello_ack`, never from anything in the frame: which binary implements an
 * adapter is the server's knowledge (ADR 0016 §5), and a frame that could
 * name its own command would make this daemon spawn whatever it was told to.
 */
export function parseAmbientImportFrame(
  frame: Record<string, unknown>,
  probes: readonly RuntimeProbe[],
  workspaces: Record<string, string>,
): AmbientImportRequest {
  const locationId = typeof frame.workspace_location_id === "string" ? frame.workspace_location_id : "";
  const adapterType = typeof frame.adapter_type === "string" ? frame.adapter_type : "";
  if (!locationId || !adapterType) {
    throw new Error("ambient_import frame needs a workspace_location_id and an adapter_type");
  }
  // Resolved here, never sent: this file is the only place a workspace's real
  // path is written down, and the control plane never learns it (ADR 0016 D3).
  const cwd = workspaces[locationId];
  if (!cwd) throw new Error(`This host has no registered directory for location ${locationId}`);
  const probe = probes.find((candidate) => candidate.adapter_type === adapterType);
  if (!probe) throw new Error(`This host has no probe for ${adapterType}; reconnect to refresh them.`);
  const unchanged = new Map<string, string>();
  if (Array.isArray(frame.unchanged)) {
    for (const entry of frame.unchanged) {
      const record = entry as Record<string, unknown> | null;
      if (typeof record?.session_id !== "string" || typeof record.updated_at !== "string") continue;
      unchanged.set(record.session_id, record.updated_at);
    }
  }
  const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  const rawLimits = (frame.limits ?? {}) as Record<string, unknown>;
  const limits: AmbientTrimLimits = {
    text_max_bytes: positiveInt(rawLimits.text_max_bytes, DEFAULT_LIMITS.text_max_bytes),
    tool_input_max_bytes: positiveInt(rawLimits.tool_input_max_bytes, DEFAULT_LIMITS.tool_input_max_bytes),
    tool_output_max_bytes: positiveInt(rawLimits.tool_output_max_bytes, DEFAULT_LIMITS.tool_output_max_bytes),
    raw_max_bytes: positiveInt(rawLimits.raw_max_bytes, DEFAULT_LIMITS.raw_max_bytes),
  };
  return {
    cwd,
    target: {
      adapter_type: adapterType,
      installation: typeof frame.installation === "string" && frame.installation ? frame.installation : OWN_INSTALLATION,
      argv: probe.argv,
    },
    session_ids: Array.isArray(frame.session_ids)
      ? frame.session_ids.filter((value): value is string => typeof value === "string")
      : null,
    retry_session_ids: Array.isArray(frame.retry_session_ids)
      ? frame.retry_session_ids.filter((value): value is string => typeof value === "string")
      : [],
    unchanged,
    window_days: positiveInt(frame.window_days, 30),
    max_sessions: positiveInt(frame.max_sessions, 50),
    limits,
  };
}

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
    // Carried across reconnects so a reconnecting daemon's first hello
    // already names its runtimes rather than only git for one heartbeat.
    let runtimeProbes: RuntimeProbe[] | undefined = lastRuntimeProbes;
    const sendHeartbeat = () => {
      void currentWorkspaces().then((ws) => helloInfo(ws, serverUrl, runtimeProbes)).then((info) => socket.send(JSON.stringify({ type: "heartbeat", ...info })));
      // Fire-and-forget, and deliberately after the heartbeat is already on
      // its way: counting starts an agent process per runtime, so it must
      // never be something a heartbeat waits for. Whatever it measures is
      // reported by the next heartbeat.
      void currentWorkspaces()
        .then((ws) => refreshAmbientSessionCounts(ws, runtimeProbes ?? [], resolveAcpLaunch))
        .catch(() => undefined);
    };

    socket.addEventListener("open", () => {
      void currentWorkspaces().then((ws) => helloInfo(ws, serverUrl, runtimeProbes)).then((info) => {
        // Reclaims the directories of runs this daemon is no longer executing
        // — their outputs, their work surface, and the per-run profile an
        // older layout put there. A run still launching, running, or uploading
        // is held out of the sweep by `execution.ts`; a vendor profile is
        // shared per adapter and provider and lives elsewhere, untouched.
        void sweepStaleRunProfiles().then((removed) => {
          if (removed > 0) log(`removed ${removed} finished run director${removed === 1 ? "y" : "ies"}`);
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
        // The hello went out before the server could say how to ask each
        // runtime for its options, so report them now rather than a
        // heartbeat interval later.
        runtimeProbes = parseRuntimeProbes(frame.runtime_probes);
        lastRuntimeProbes = runtimeProbes;
        sendHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
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
          installation: typeof frame.installation === "string" ? frame.installation : undefined,
          adapter_type: typeof frame.adapter_type === "string" ? frame.adapter_type : undefined,
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
      if (frame.type === "install_tool" || frame.type === "uninstall_tool") {
        const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
        const fail = (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log(`${String(frame.type)} failed: ${message}`);
          if (requestId) sink.send({ type: "tool_result", request_id: requestId, ok: false, error: message, installation: null });
        };
        const action = frame.type === "install_tool"
          ? (async () => {
              const install = parseInstallToolFrame(frame);
              log(`install ${install.adapter_type} ${managedInstallationId(install.version)}`);
              const manifest = await installTool(install, log);
              log(`installed ${install.adapter_type} ${managedInstallationId(install.version)} → ${manifest.command}`);
              return managedInstallationId(install.version);
            })()
          : (async () => {
              const uninstall = parseUninstallToolFrame(frame);
              if (!(await uninstallTool(uninstall))) throw new Error(`${uninstall.adapter_type} ${managedInstallationId(uninstall.version)} is not installed`);
              log(`removed ${uninstall.adapter_type} ${managedInstallationId(uninstall.version)}`);
              return managedInstallationId(uninstall.version);
            })();
        void action.then((installation) => {
          // Report the new capability now rather than on the next interval.
          sendHeartbeat();
          sink.send({ type: "tool_result", request_id: requestId, ok: true, error: null, installation });
        }, fail);
        return;
      }
      if (frame.type === "login_open") {
        const sessionId = typeof frame.session_id === "string" ? frame.session_id : null;
        try {
          openLoginSession(parseLoginOpenFrame(frame), (payload) => {
            sink.send(payload);
            // A finished login changes what this host reports.
            if (payload.type === "login_exit") sendHeartbeat();
          }, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`login_open rejected: ${message}`);
          if (sessionId) {
            sink.send({ type: "login_output", session_id: sessionId, data: `${message}\n` });
            sink.send({ type: "login_exit", session_id: sessionId, exit_code: -1, logged_in: null });
          }
        }
        return;
      }
      if (frame.type === "login_input" && typeof frame.session_id === "string" && typeof frame.data === "string") {
        loginSession(frame.session_id)?.write(frame.data);
        return;
      }
      if (frame.type === "login_close" && typeof frame.session_id === "string") {
        loginSession(frame.session_id)?.close();
        return;
      }
      if (frame.type === "ambient_import") {
        const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
        if (!requestId) return;
        void (async () => {
          try {
            const request = parseAmbientImportFrame(frame, runtimeProbes ?? [], await currentWorkspaces());
            log(`ambient import ${request.target.adapter_type} in ${request.cwd}`);
            const { sessions, enumeration } = await importAmbientSessions(request, resolveAcpLaunch, log);
            for (const session of sessions) {
              // One frame per session rather than one for the whole import:
              // a folder's history is megabytes even after trimming, and a
              // single frame would have to be buffered whole on both ends.
              sink.send({ type: "ambient_import_session", request_id: requestId, session });
            }
            // What the runtime still holds for this folder, before any
            // Rainver-side narrowing — the server needs it to decide which of
            // its own imports the machine no longer has, a question its own
            // records cannot answer. Null when the enumeration was
            // inconclusive, because "I found nothing" and "I could not tell"
            // must not both read as "everything here is gone".
            sink.send({
              type: "ambient_import_result",
              request_id: requestId,
              ok: true,
              error: null,
              session_count: sessions.length,
              listed_session_ids: enumeration.conclusive ? enumeration.held : null,
            });
          } catch (error) {
            const message = sanitizeFailure(error);
            log(`ambient import failed: ${message}`);
            sink.send({ type: "ambient_import_result", request_id: requestId, ok: false, error: message, session_count: 0, listed_session_ids: null });
          }
        })();
        return;
      }
      if (frame.type === "folder_read") {
        const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
        if (!requestId) return;
        void (async () => {
          try {
            const request = parseFolderReadFrame(frame, await currentWorkspaces());
            sink.send(await performFolderRead(request));
          } catch (error) {
            const code = error instanceof FolderReadFrameError ? error.code : "read_failed";
            sink.send({
              type: "folder_read_result",
              request_id: requestId,
              ok: false,
              error: code,
              message: sanitizeFailure(error),
            });
          }
        })();
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
