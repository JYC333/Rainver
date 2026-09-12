import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  HostServerFrameSchema,
  type HostDaemonFrame,
  type HostServerFrame,
  type HostServerFrameOf,
  type RuntimeProbe,
} from "@rainver/protocol";
import { helloInfo } from "../api.js";
import { builtinCredentialPath, configDir, loadConfig, removeConfig } from "../config.js";
import { adoptBuiltinCredential } from "../builtinRegistration.js";
import { runHostCommand } from "../commandRun.js";
import { probeUsage } from "../usageProbe.js";
import { startEgressProxy } from "../egressProxy.js";

import {
  adapterIsBeingReplaced,
  holdingAdapter,
  withAdapterDrained,
  setEgressProxy,
  handleLaunch,
  handleStdin,
  handleStdinClose,
  handleTerminate,
  hasInFlightRuns,
  resolveAcpLaunch,
  stopAllRunsForRevocation,
  sweepStaleRunProfiles,
  type LaunchFrame,
  type LaunchWorkspace,
} from "../execution.js";
import { ReconnectableFrameSink } from "../reconnectableFrameSink.js";
import { OWN_INSTALLATION, installTool, managedInstallationId, rollbackTool, uninstallTool } from "../tools.js";
import { loginSession, openLoginSession } from "../login.js";
import { refreshAmbientSessionCounts } from "../ambientCounts.js";
import { importAmbientSessions, sanitizeFailure, type AmbientImportRequest } from "../ambientSessions.js";
import { FolderReadFrameError, performFolderRead, resolveFolderReadRequest } from "../folderRead.js";
import { forgetWorkspace, listDirectories, registerWorkspace } from "../remoteWorkspaceOps.js";
import { archiveAgentProfiles, archiveLegacyProfileTree, archiveManagedWorkspace, restoreManagedWorkspace, sweepManagedWorkspaceArchives, type ManagedWorkspaceContainer } from "../managedWorkspaces.js";
import { clearFailedRuntimeOptionsCache, clearRuntimeOptionsCache } from "../capabilities.js";
import { disableInstalledService } from "../service.js";
/**
 * How long an upgrade waits for the copy's Runs to finish before giving up.
 *
 * A Run has its own timeout well under this, so a drain that has not converged
 * in five minutes means something is stuck rather than busy — and the answer
 * is to abandon the upgrade, not to kill the Run.
 */
const TOOL_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;


const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const UPDATE_RESTART_POLL_MS = 30_000;
/** How often the built-in host looks for a credential the control plane has not published yet. */
const BUILTIN_CREDENTIAL_POLL_MS = 3_000;
// The installed unit uses Restart=on-failure: update is an intentional
// restart, while a revoked/unregistered daemon returns zero and stays down.
const UPDATE_RESTART_EXIT_CODE = 75;
/** What the latest control-plane acknowledgement said about runtimes; see `helloInfo`. */
let lastRuntimeProbes: RuntimeProbe[] | undefined;

function wsUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/internal/hosts/ws`;
}

function openHostSocket(endpoint: string, token: string): WebSocket {
  return new (WebSocket as unknown as {
    new (url: string, init: { headers: Record<string, string> }): WebSocket;
  })(endpoint, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * One inbound frame, parsed against the shared wire contract.
 *
 * This is the only place a control-plane frame becomes a typed value. There
 * is no field-by-field rebuild after it: a handler receives the parsed frame
 * itself, so a field the contract carries cannot be left behind on the way
 * — which is exactly how `provider_binding` and then `work_surface` each
 * shipped inert once, when this daemon copied frames by hand.
 *
 * A frame that does not parse is reported, not thrown: throwing inside the
 * socket listener would take the whole daemon down, losing the reporting
 * channel for every other run.
 */
export function parseServerFrame(raw: unknown):
  | { ok: true; frame: HostServerFrame }
  | { ok: false; type: string | null; run_id: string | null; launch_id: string | null; detail: string } {
  const parsed = HostServerFrameSchema.safeParse(raw);
  if (parsed.success) return { ok: true, frame: parsed.data };
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const issue = parsed.error.issues[0];
  const detail = issue
    ? `${issue.path.length > 0 ? issue.path.join(".") : "frame"}: ${issue.message}`
    : "malformed frame";
  return {
    ok: false,
    type: typeof record.type === "string" ? record.type : null,
    run_id: typeof record.run_id === "string" ? record.run_id : null,
    launch_id: typeof record.launch_id === "string" ? record.launch_id : null,
    detail,
  };
}

/**
 * The wire's `launch` frame as `execution.ts` consumes it. Everything is
 * carried over by spread; only the managed-workspace container is renamed
 * from its wire form (`user_id` / `conversation_id`) to the daemon's `id`.
 */
export function toLaunchFrame(frame: HostServerFrameOf<"launch">): LaunchFrame {
  const { type: _type, workspace, ...rest } = frame;
  return { ...rest, workspace: toLaunchWorkspace(workspace) };
}

function toLaunchWorkspace(workspace: HostServerFrameOf<"launch">["workspace"]): LaunchWorkspace | undefined {
  if (!workspace) return undefined;
  if (workspace.kind === "location") {
    return {
      kind: "location",
      workspace_location_id: workspace.workspace_location_id,
      ...(workspace.workspace_relative_path ? { workspace_relative_path: workspace.workspace_relative_path } : {}),
    };
  }
  return {
    kind: "managed",
    agent_id: workspace.agent_id,
    container: workspace.container.kind === "direct"
      ? { kind: "direct", id: workspace.container.user_id }
      : { kind: "conversation", id: workspace.container.conversation_id },
  };
}

/**
 * Resolves an `ambient_import` frame to the runtime it names.
 *
 * The argv comes from the server's own runtime probes, cached from
 * `hello_ack`, never from anything in the frame: which binary implements an
 * adapter is the server's knowledge (ADR 0016 §6), and a frame that could
 * name its own command would make this daemon spawn whatever it was told to.
 * The workspace's real path is resolved here and never sent (ADR 0016 D3).
 */
export function toAmbientImportRequest(
  frame: HostServerFrameOf<"ambient_import">,
  probes: readonly RuntimeProbe[],
  workspaces: Record<string, string>,
): AmbientImportRequest {
  const cwd = workspaces[frame.workspace_location_id];
  if (!cwd) throw new Error(`This host has no registered directory for location ${frame.workspace_location_id}`);
  const probe = probes.find((candidate) => candidate.adapter_type === frame.adapter_type);
  if (!probe) throw new Error(`This host has no probe for ${frame.adapter_type}; reconnect to refresh them.`);
  return {
    cwd,
    target: {
      adapter_type: frame.adapter_type,
      installation: frame.installation || OWN_INSTALLATION,
      argv: probe.argv,
    },
    session_ids: frame.session_ids,
    retry_session_ids: frame.retry_session_ids,
    unchanged: new Map(frame.unchanged.map((entry) => [entry.session_id, entry.updated_at])),
    window_days: frame.window_days,
    max_sessions: frame.max_sessions,
    limits: frame.limits,
  };
}

/**
 * Persistent outbound connection: register/hello, heartbeat, and job
 * dispatch — launch/stream/terminate/upload/complete, delegated to
 * `execution.ts` (`RemoteHostExecutionAdapter`'s daemon-side counterpart;
 * see control-center-plan.md §5). This function does not return; it runs
 * until the process is killed, exactly like a systemd/launchd-managed
 * service is expected to.
 */
export async function runService(options: { log?: (line: string) => void } = {}): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(`[rainver-host] ${line}`));
  // The built-in host has no pairing step: the control plane publishes its
  // credential into the mount both containers share and this adopts it. A
  // paired machine short-circuits here (`not_builtin`) and keeps the
  // registered-or-exit behaviour below.
  const builtin = builtinCredentialPath() !== null;
  if (builtin) {
    while ((await adoptBuiltinCredential(log)) === "unavailable") {
      // The container can start before the server has written the file. Waiting
      // is the whole recovery: exiting would need a manual restart to come up.
      log(`waiting for the control plane to publish the built-in host credential (${builtinCredentialPath()})`);
      await sleep(BUILTIN_CREDENTIAL_POLL_MS);
    }
  }
  let config = await loadConfig();
  if (!config) {
    log("not registered; exiting without reconnecting");
    return;
  }
  // Strict mode only. A trusted host is its owner's machine and its Runs use
  // the machine's own network — the trust its owner already extends (ADR 0016
  // §2). A strict host is not anyone's machine, so its Runs are pointed at a
  // proxy that says what they may reach and records what they did.
  if (config.trust === "strict") {
    setEgressProxy(await startEgressProxy(log), config.server_url);
  }
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  // A run outlives a single WebSocket connection (§5 — "an interrupted
  // connection while a run is active keeps the process alive"); see
  // `ReconnectableFrameSink`'s doc comment for why this can't be a plain
  // per-connection closure.
  const sink = new ReconnectableFrameSink();

  for (;;) {
    try {
      const result = await connectOnce(config.server_url, config.token, log, sink, config.workspaces);
      if (result === "update") {
        log("latest release is installed and the host is idle; restarting into it");
        process.exit(UPDATE_RESTART_EXIT_CODE);
      }
      if (result === "revoked") {
        // The built-in host cannot be revoked (the control plane refuses), so
        // this can only be a token the server rotated after losing its
        // published copy. Re-adopt and reconnect: disabling the service here
        // would take the instance's own execution host down permanently, and
        // there is no operator with a pairing code to bring it back.
        if (builtin) {
          log("the control plane rejected this built-in host's token; re-reading the published credential");
        } else {
          stopAllRunsForRevocation(log);
          await disableInstalledService().catch((error) => {
            log(`could not disable the revoked service: ${error instanceof Error ? error.message : String(error)}`);
          });
          await removeConfig();
          log("registration revoked by the control plane; removed local credentials and stopped reconnecting");
          return;
        }
      } else {
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
      }
    } catch (error) {
      log(`connection lost: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (builtin) {
      await adoptBuiltinCredential(log);
      config = (await loadConfig()) ?? config;
    }
    log(`reconnecting in ${Math.round(reconnectDelay / 1000)}s`);
    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRevocationClose(code: number, reason: string): boolean {
  return code === 1008 && (reason === "host_revoked" || reason === "invalid_token");
}

function connectOnce(serverUrl: string, token: string, log: (line: string) => void, sink: ReconnectableFrameSink, workspaces: Record<string, string>): Promise<"disconnected" | "update" | "revoked"> {
  return new Promise((resolve, reject) => {
    const endpoint = wsUrl(serverUrl);
    log(`connecting to ${endpoint}`);
    const socket = openHostSocket(endpoint, token);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let helloAcked = false;
    let updateRestartTimer: ReturnType<typeof setInterval> | null = null;
    let restartForUpdate = false;
    const updateRequestPath = join(configDir(), "update-restart-requested");
    // Bound into `sink` only once hello succeeds (below), matching when the
    // server actually registers this connection in
    // `sharedHostConnectionRegistry` — a frame sent on this socket before
    // that would be rejected server-side as unauthenticated anyway.
    const sendOnThisConnection = (payload: HostDaemonFrame) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    };
    const currentWorkspaces = async () => (await loadConfig())?.workspaces ?? workspaces;
    // Carried across reconnects so a reconnecting daemon's first hello
    // already names its runtimes rather than only git for one heartbeat.
    let runtimeProbes: RuntimeProbe[] | undefined = lastRuntimeProbes;
    const sendHeartbeat = () => {
      void currentWorkspaces()
        .then((ws) => helloInfo(ws, runtimeProbes, log))
        .then((info) => sendOnThisConnection({ type: "heartbeat", ...info }));
      // Fire-and-forget, and deliberately after the heartbeat is already on
      // its way: counting starts an agent process per runtime, so it must
      // never be something a heartbeat waits for. Whatever it measures is
      // reported by the next heartbeat.
      void currentWorkspaces()
        .then((ws) => refreshAmbientSessionCounts(ws, runtimeProbes ?? [], resolveAcpLaunch))
        .catch(() => undefined);
    };

    socket.addEventListener("open", () => {
      void currentWorkspaces().then((ws) => helloInfo(ws, runtimeProbes, log)).then((info) => {
        // Reclaims the directories of runs this daemon is no longer executing
        // — their outputs, their work surface, and the per-run profile an
        // older layout put there. A run still launching, running, or uploading
        // is held out of the sweep by `execution.ts`; a vendor profile is
        // shared per adapter and provider and lives elsewhere, untouched.
        void sweepStaleRunProfiles().then((removed) => {
          if (removed > 0) log(`removed ${removed} finished run director${removed === 1 ? "y" : "ies"}`);
        }).catch(() => {});
        void archiveLegacyProfileTree().then((moved) => {
          if (moved) log("archived the pre-Agent-keyed profiles/ tree; it is swept after the retention window");
        }).catch((error) => log(`legacy profile tree archive failed: ${error instanceof Error ? error.message : String(error)}`));
        void sweepManagedWorkspaceArchives().catch((error) => log(`managed workspace sweep failed: ${error instanceof Error ? error.message : String(error)}`));
        sendOnThisConnection({ type: "hello", token, ...info });
      });
    });

    updateRestartTimer = setInterval(() => {
      if (restartForUpdate || hasInFlightRuns()) return;
      void stat(updateRequestPath).then(() => {
        // A launch may have arrived while stat was in flight.
        if (hasInFlightRuns()) return;
        restartForUpdate = true;
        socket.close(1000, "update installed");
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") log(`could not inspect update request: ${error.message}`);
      });
    }, UPDATE_RESTART_POLL_MS);
    updateRestartTimer.unref?.();

    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = parseServerFrame(raw);
      if (!parsed.ok) {
        log(`rejected ${parsed.type ?? "unknown"} frame: ${parsed.detail}`);
        // A run the server is waiting on must be told, or it hangs until its
        // timeout; the reply is routed by the dispatch nonce, so a frame with
        // none can only be logged. Other requests have their own timeouts.
        if (parsed.type === "launch" && parsed.run_id && parsed.launch_id) {
          sink.send({ type: "complete", run_id: parsed.run_id, launch_id: parsed.launch_id, exit_code: 1, timed_out: false, error: `launch frame rejected: ${parsed.detail}` });
        }
        return;
      }
      const frame = parsed.frame;
      switch (frame.type) {
        case "hello_ack": {
          helloAcked = true;
          sink.bind(sendOnThisConnection);
          log(`connected as host ${frame.host_id}`);
          // The hello went out before the server could say how to ask each
          // runtime for its options, so report them now rather than a
          // heartbeat interval later.
          runtimeProbes = frame.runtime_probes;
          lastRuntimeProbes = runtimeProbes;
          // A failed ACP option probe must not survive a control-plane
          // restart for fifteen minutes. Keep successful catalogs cached,
          // but retry failures at this fresh connection boundary.
          clearFailedRuntimeOptionsCache();
          sendHeartbeat();
          heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
          return;
        }
        case "heartbeat_ack":
          // ACP registry agents may be enabled while this connection stays
          // open. Refresh the server-owned probe catalog and immediately
          // report again when it changed, so a just-installed runtime appears
          // without restarting the daemon or waiting another interval.
          if (frame.runtime_probes && JSON.stringify(runtimeProbes) !== JSON.stringify(frame.runtime_probes)) {
            runtimeProbes = frame.runtime_probes;
            lastRuntimeProbes = runtimeProbes;
            clearFailedRuntimeOptionsCache();
            sendHeartbeat();
          }
          return;
        case "error":
          log(`server error: ${frame.detail}`);
          return;
        case "launch": {
          const launchFrame = toLaunchFrame(frame);
          log(`launch run ${launchFrame.run_id}`);
          // Always routed through `sink`, never `sendOnThisConnection`
          // directly — this run's `complete` frame may need to go out on a
          // later reconnect, not this connection.
          void handleLaunch(launchFrame, (payload) => sink.send(payload), log).catch((error) => {
            log(`run ${launchFrame.run_id}: launch failed: ${error instanceof Error ? error.message : String(error)}`);
            sink.send({
              type: "complete",
              run_id: launchFrame.run_id,
              launch_id: launchFrame.launch_id,
              exit_code: 1,
              timed_out: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        case "terminate":
          handleTerminate(frame, log);
          return;
        case "stdin":
          handleStdin(frame);
          return;
        case "stdin_close":
          handleStdinClose(frame);
          return;
        case "list_dirs": {
          void listDirectories(frame.path).then((result) => {
            sink.send({ type: "list_dirs_result", request_id: frame.request_id, ...result });
          });
          return;
        }
        case "workspace_register": {
          void registerWorkspace({ path: frame.path, project_id: frame.project_id, name: frame.name }).then((result) => {
            sink.send({ type: "workspace_register_result", request_id: frame.request_id, ...result });
            if (result.ok) sendHeartbeat();
          });
          return;
        }
        case "workspace_forget": {
          void forgetWorkspace(frame.workspace_id).then((result) => {
            sink.send({ type: "workspace_forget_result", request_id: frame.request_id, ...result });
          }).catch((error) => {
            sink.send({ type: "workspace_forget_result", request_id: frame.request_id, ok: false, changed: false, error: error instanceof Error ? error.message : String(error) });
          });
          return;
        }
        case "managed_workspace_archive":
        case "managed_workspace_restore": {
          const action = frame.type === "managed_workspace_archive" ? "archive" : "restore";
          void (async () => {
            try {
              const container: ManagedWorkspaceContainer = { kind: frame.container_kind, id: frame.container_id };
              const changed = action === "archive"
                ? await archiveManagedWorkspace(frame.agent_id, container, frame.include_workspace)
                : await restoreManagedWorkspace(frame.agent_id, container, frame.include_workspace);
              sink.send({ type: "managed_workspace_result", request_id: frame.request_id, action, ok: true, changed, error: null });
              sendHeartbeat();
            } catch (error) {
              sink.send({ type: "managed_workspace_result", request_id: frame.request_id, action, ok: false, changed: false, error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }
        case "agent_profiles_reset": {
          void (async () => {
            try {
              const changed = await archiveAgentProfiles(frame.agent_id);
              sink.send({ type: "managed_workspace_result", request_id: frame.request_id, action: "reset", ok: true, changed, error: null });
              sendHeartbeat();
            } catch (error) {
              sink.send({ type: "managed_workspace_result", request_id: frame.request_id, action: "reset", ok: false, changed: false, error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }
        case "command_run": {
          // Fire-and-forget like every other request frame: a verification
          // recipe can run for minutes, and the socket must keep carrying
          // heartbeats and Run frames while it does.
          void (async () => {
            const result = await runHostCommand(
              {
                request_id: frame.request_id,
                workspace: toLaunchWorkspace(frame.workspace),
                ...(frame.workspace_location_id ? { workspace_location_id: frame.workspace_location_id } : {}),
                ...(frame.run_id ? { run_id: frame.run_id } : {}),
                ...(frame.scratch_workspace ? { scratch_workspace: true } : {}),
                ...(frame.adapter_type ? { adapter_type: frame.adapter_type } : {}),
                ...(frame.installation ? { installation: frame.installation } : {}),
                ...(frame.stdin !== undefined ? { stdin: frame.stdin } : {}),
                command: frame.command,
                timeout_seconds: frame.timeout_seconds,
                ...(frame.isolation ? { isolation: frame.isolation } : {}),
              },
              log,
            );
            sink.send({ type: "command_result", request_id: frame.request_id, ...result });
          })();
          return;
        }
        case "usage_probe": {
          // Fire-and-forget: reading a quota means a network round trip or a
          // short-lived subprocess, and neither may hold up Run frames.
          void (async () => {
            // Every other request handler contains its own failure; without
            // this a synchronous throw inside `probeUsage` becomes an
            // unhandled rejection and takes the daemon — and every in-flight
            // Run's `complete` frame — with it.
            try {
              // A probe launches the copy, so it takes the same closed door a
              // Run does — otherwise it reads a directory a replacement is
              // deleting, or two concurrent Codex app-servers rewrite one
              // `auth.json` between them.
              if (adapterIsBeingReplaced(frame.adapter_type)) {
                throw new Error(`${frame.adapter_type} is being upgraded on this host; retry in a moment.`);
              }
              const quota = await holdingAdapter(frame.adapter_type, () => probeUsage({
                adapter_type: frame.adapter_type,
                installation: frame.installation,
                login: frame.login,
                timeout_seconds: frame.timeout_seconds,
              }));
              sink.send({ type: "usage_probe_result", request_id: frame.request_id, quota });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              log(`usage_probe failed: ${message}`);
              sink.send({
                type: "usage_probe_result",
                request_id: frame.request_id,
                quota: { available: false, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: message },
              });
            }
          })();
          return;
        }
        case "rollback_tool": {
          void (async () => {
            try {
              // Held closed for the whole promotion, same as an upgrade:
              // promoting the previous copy deletes the directory a live
              // session would be running out of.
              const promoted = await withAdapterDrained(
                frame.adapter_type,
                TOOL_DRAIN_TIMEOUT_MS,
                () => rollbackTool(frame.adapter_type),
              );
              if (!promoted) throw new Error(`No previous version of ${frame.adapter_type} is kept on this host`);
              log(`rolled ${frame.adapter_type} back to ${promoted.version}`);
              sendHeartbeat();
              sink.send({
                type: "tool_result",
                request_id: frame.request_id,
                ok: true,
                error: null,
                installation: managedInstallationId(promoted.version),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              log(`rollback_tool failed: ${message}`);
              sink.send({ type: "tool_result", request_id: frame.request_id, ok: false, error: message, installation: null });
            }
          })();
          return;
        }
        case "install_tool":
        case "uninstall_tool": {
          const fail = (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`${frame.type} failed: ${message}`);
            sink.send({ type: "tool_result", request_id: frame.request_id, ok: false, error: message, installation: null });
          };
          const action = frame.type === "install_tool"
            ? withAdapterDrained(frame.adapter_type, TOOL_DRAIN_TIMEOUT_MS, async () => {
                // Held closed across the download too, not merely drained
                // before it: swapping the binary under a live ACP session is
                // how an upgrade breaks a Run someone is watching (ADR 0016 §9),
                // and a materialize takes long enough for a new dispatch to
                // arrive. A drain that does not converge aborts the upgrade
                // rather than killing the Run.
                log(`install ${frame.adapter_type} ${managedInstallationId(frame.version)}`);
                const manifest = await installTool(frame, log);
                log(`installed ${frame.adapter_type} ${managedInstallationId(frame.version)} → ${manifest.command}`);
                return managedInstallationId(frame.version);
              })
            // Removal takes the same door: it deletes a directory a Run could
            // be running out of, exactly like a replacement.
            : withAdapterDrained(frame.adapter_type, TOOL_DRAIN_TIMEOUT_MS, async () => {
                if (!(await uninstallTool(frame))) throw new Error(`${frame.adapter_type} ${managedInstallationId(frame.version)} is not installed`);
                log(`removed ${frame.adapter_type} ${managedInstallationId(frame.version)}`);
                return managedInstallationId(frame.version);
              });
          void action.then((installation) => {
            // Report the new capability now rather than on the next interval.
            sendHeartbeat();
            sink.send({ type: "tool_result", request_id: frame.request_id, ok: true, error: null, installation });
          }, fail);
          return;
        }
        case "login_open": {
          try {
            // The login process executes versioned binaries even though its
            // state lives in the stable managed HOME. Refuse replacement while
            // that process is active, like a launch.
            if (adapterIsBeingReplaced(frame.adapter_type)) {
              throw new Error(`${frame.adapter_type} is being upgraded on this host; retry in a moment.`);
            }
            openLoginSession(frame, (payload) => {
              sink.send(payload);
              // A finished login changes what this host reports.
              if (payload.type === "login_exit") {
                clearRuntimeOptionsCache(frame.adapter_type, frame.installation);
                sendHeartbeat();
              }
            }, log);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`login_open rejected: ${message}`);
            sink.send({ type: "login_output", session_id: frame.session_id, data: `${message}\n` });
            sink.send({ type: "login_exit", session_id: frame.session_id, exit_code: -1, logged_in: null });
          }
          return;
        }
        case "login_input":
          loginSession(frame.session_id)?.write(frame.data);
          return;
        case "login_close":
          loginSession(frame.session_id)?.close();
          return;
        case "ambient_import": {
          void (async () => {
            try {
              const request = toAmbientImportRequest(frame, runtimeProbes ?? [], await currentWorkspaces());
              log(`ambient import ${request.target.adapter_type} in ${request.cwd}`);
              const { sessions, enumeration } = await importAmbientSessions(request, resolveAcpLaunch, log);
              for (const session of sessions) {
                // One frame per session rather than one for the whole import:
                // a folder's history is megabytes even after trimming, and a
                // single frame would have to be buffered whole on both ends.
                sink.send({ type: "ambient_import_session", request_id: frame.request_id, session });
              }
              // What the runtime still holds for this folder, before any
              // Rainver-side narrowing — the server needs it to decide which of
              // its own imports the machine no longer has, a question its own
              // records cannot answer. Null when the enumeration was
              // inconclusive, because "I found nothing" and "I could not tell"
              // must not both read as "everything here is gone".
              sink.send({
                type: "ambient_import_result",
                request_id: frame.request_id,
                ok: true,
                error: null,
                session_count: sessions.length,
                listed_session_ids: enumeration.conclusive ? enumeration.held : null,
              });
            } catch (error) {
              const message = sanitizeFailure(error);
              log(`ambient import failed: ${message}`);
              sink.send({ type: "ambient_import_result", request_id: frame.request_id, ok: false, error: message, session_count: 0, listed_session_ids: null });
            }
          })();
          return;
        }
        case "folder_read": {
          void (async () => {
            try {
              const request = resolveFolderReadRequest(frame, await currentWorkspaces());
              sink.send(await performFolderRead(request));
            } catch (error) {
              const code = error instanceof FolderReadFrameError ? error.code : "read_failed";
              sink.send({
                type: "folder_read_result",
                request_id: frame.request_id,
                ok: false,
                error: code,
                message: sanitizeFailure(error),
              });
            }
          })();
          return;
        }
      }
    });

    socket.addEventListener("close", (event) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (updateRestartTimer) clearInterval(updateRestartTimer);
      sink.unbindIfCurrent(sendOnThisConnection);
      if (isRevocationClose(event.code, event.reason)) {
        resolve("revoked");
        return;
      }
      // A launch message already queued when close() was requested may have
      // registered a child before this event. Reconnect and retry later in
      // that case; the marker stays in place and no Run is interrupted.
      if (restartForUpdate && !hasInFlightRuns()) {
        void rm(updateRequestPath, { force: true }).then(() => resolve("update"), reject);
      }
      else if (helloAcked) resolve("disconnected");
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
