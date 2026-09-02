import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

// This file runs inside the sandbox-runner container with no dependencies,
// so it cannot share `server/src/modules/sandboxRunner/protocol.ts` the way
// the host daemon shares `@rainver/protocol`. The request mapping below is
// therefore hand-written — and pinned: `server/test/sandboxRunnerClient.test.ts`
// imports `environmentMap` and feeds it every field the protocol declares,
// so a field added there fails that test until it is mapped here.
let RUNNER_TOKEN;
let ROOTS;

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
  const PORT = boundedPort(process.env.SANDBOX_RUNNER_PORT ?? "8020");
  RUNNER_TOKEN = process.env.SANDBOX_RUNNER_TOKEN ?? process.env.SERVER_INTERNAL_TOKEN;
  if (!RUNNER_TOKEN) throw new Error("Sandbox Runner service token is required.");
  ROOTS = Object.freeze({
    workspaces: requiredRoot("SANDBOX_RUNNER_WORKSPACES_ROOT", "/runner/workspaces"),
    sandboxes: requiredRoot("SANDBOX_RUNNER_SANDBOXES_ROOT", "/runner/sandboxes"),
    runtime_tools: requiredRoot("SANDBOX_RUNNER_TOOLS_ROOT", "/runner/runtime-tools"),
    run_homes: requiredRoot("SANDBOX_RUNNER_RUN_HOMES_ROOT", "/runner/run-homes"),
    conversation_homes: requiredRoot("SANDBOX_RUNNER_CONVERSATION_HOMES_ROOT", "/runner/conversation-homes"),
    login_homes: requiredRoot("SANDBOX_RUNNER_LOGIN_HOMES_ROOT", "/runner/login-homes"),
  });
  serve(PORT);
}

const RUNTIME_EXECUTABLES = Object.freeze({
  claude_code: "node_modules/.bin/claude",
  codex_cli: "node_modules/.bin/codex",
  opencode: "node_modules/.bin/opencode",
});
const ETC = ["/etc/alternatives", "/etc/ca-certificates.conf", "/etc/gai.conf", "/etc/group", "/etc/host.conf", "/etc/hostname", "/etc/hosts", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/localtime", "/etc/nsswitch.conf", "/etc/passwd", "/etc/resolv.conf", "/etc/ssl/certs", "/etc/ssl/openssl.cnf", "/etc/timezone"];

function serve(PORT) {
createServer((socket) => {
  let buffer = "";
  const socketDecoder = new StringDecoder("utf8");
  let child = null;
  let launched = false;
  let namespaceReady = false;
  let timeoutTimer, stallTimer, killTimer;
  let terminationReason;
  const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
  const clearTimers = () => { clearTimeout(timeoutTimer); clearTimeout(stallTimer); clearTimeout(killTimer); };
  const touch = () => {
    if (!child?.pid || !currentRequest?.stall_timeout_seconds) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => terminate(false, "stall_timeout"), currentRequest.stall_timeout_seconds * 1000);
    stallTimer.unref?.();
  };
  const terminate = (force, reason) => {
    if (!child?.pid) return;
    terminationReason ??= reason;
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
    if (!force) { killTimer = setTimeout(() => terminate(true, reason), 2_000); killTimer.unref?.(); }
  };
  let currentRequest;
  socket.on("data", (chunk) => {
    buffer += socketDecoder.write(chunk);
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) {
      let frame;
      try { frame = JSON.parse(line); } catch { send({ type: "error", code: "invalid_request", message: "Invalid JSON frame." }); socket.end(); return; }
      if (!launched) {
        if (frame?.type !== "launch") { send({ type: "error", code: "invalid_request", message: "First frame must be launch." }); socket.end(); return; }
        if (!validToken(frame.token)) { send({ type: "error", code: "invalid_request", message: "Sandbox Runner authorization failed." }); socket.end(); return; }
        try {
          currentRequest = validateRequest(frame.request);
          const command = buildNamespaceCommand(currentRequest);
          child = spawn(command[0], command.slice(1), { detached: true, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
          launched = true;
          const stdoutDecoder = new StringDecoder("utf8");
          const stderrDecoder = new StringDecoder("utf8");
          child.stdout.on("data", (value) => { touch(); const decoded = stdoutDecoder.write(value); if (decoded) send({ type: "stdout", value: decoded }); });
          child.stderr.on("data", (value) => { touch(); const decoded = stderrDecoder.write(value); if (decoded) send({ type: "stderr", value: decoded }); });
          child.stdin.on("error", (error) => {
            if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
            send({ type: "error", code: "sandbox_namespace_unavailable", message: error.message });
            terminate(true, "sandbox_namespace_unavailable");
          });
          child.stdio[3].once("data", (value) => {
            if (value.toString("utf8") !== "ready\n") { terminate(true, "sandbox_namespace_unavailable"); return; }
            namespaceReady = true;
            timeoutTimer = setTimeout(() => terminate(true, "timeout"), currentRequest.timeout_seconds * 1000); timeoutTimer.unref?.();
            touch(); send({ type: "ready" });
          });
          child.on("error", (error) => { clearTimers(); send({ type: "error", code: "sandbox_namespace_unavailable", message: error.message }); socket.end(); });
          child.on("close", (code) => {
            clearTimers();
            if (!namespaceReady) { send({ type: "error", code: "sandbox_namespace_unavailable", message: "Sandbox namespace failed before readiness." }); socket.end(); return; }
            const stdoutTail = stdoutDecoder.end(); if (stdoutTail) send({ type: "stdout", value: stdoutTail });
            const stderrTail = stderrDecoder.end(); if (stderrTail) send({ type: "stderr", value: stderrTail });
            send({ type: "exit", returncode: code ?? -1, timed_out: terminationReason === "timeout" || terminationReason === "stall_timeout", failure_code: terminationReason }); socket.end();
          });
        } catch (error) { send({ type: "error", code: "invalid_request", message: error instanceof Error ? error.message : "Invalid launch request." }); socket.end(); }
      } else if (frame?.type === "stdin" && typeof frame.value === "string") child?.stdin.write(frame.value);
      else if (frame?.type === "stdin_close") child?.stdin.end();
      else if (frame?.type === "terminate") terminate(Boolean(frame.force));
      else { send({ type: "error", code: "invalid_request", message: "Unsupported Runner frame." }); terminate(true); }
    }
  });
  socket.on("close", () => { clearTimers(); terminate(true); });
  socket.on("error", () => { clearTimers(); terminate(true); });
}).listen(PORT, "0.0.0.0");
}

export function validateRequest(value) {
  if (!value || value.protocol_version !== 2) throw new Error("Unsupported Sandbox Runner protocol.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.run_id) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.scope_id)) throw new Error("Invalid run or scope id.");
  if (!["claude_code", "codex_cli", "opencode", "verification"].includes(value.runtime)) throw new Error("Unknown runtime adapter.");
  if (!["read_only", "read_write"].includes(value.sandbox_mode)) throw new Error("Unknown sandbox mode.");
  if (!["none", "provider", "tools", "provider_and_tools"].includes(value.egress_profile)) throw new Error("Unknown egress profile.");
  if (!["pipe", "pty"].includes(value.terminal_mode)) throw new Error("Unknown terminal mode.");
  if (!Array.isArray(value.arguments) || value.arguments.some((item) => typeof item !== "string" || item.includes("\0"))) throw new Error("Invalid runtime arguments.");
  if (!Number.isFinite(value.timeout_seconds) || value.timeout_seconds <= 0 || value.timeout_seconds > 86_400) throw new Error("Invalid timeout.");
  if (!Array.isArray(value.mounts)) throw new Error("Mount allowlist is required.");
  for (const mount of value.mounts) resolveMount(mount);
  assertMountContract(value);
  return value;
}

function assertMountContract(request) {
  const targets = new Set(request.mounts.map((mount) => mount.target));
  if (request.runtime === "verification") {
    const environmentKeys = Object.keys(request.environment ?? {});
    if (request.runtime_tool_id !== "verification" || request.arguments.length === 0
      || request.sandbox_mode !== "read_write" || request.egress_profile !== "none"
      || request.stdin_mode !== "none" || request.terminal_mode !== "pipe"
      || request.mounts.length !== 1 || request.mounts[0]?.target !== "/workspace"
      || environmentKeys.some((key) => key !== "locale")) {
      throw new Error("Invalid verification launch contract.");
    }
  }
  if (!targets.has("/workspace") || (request.runtime !== "verification" && !targets.has("/runtime-tool"))) throw new Error("Required Runner mounts are missing.");
  if (request.runtime === "verification" && targets.has("/runtime-tool")) throw new Error("Verification cannot mount a runtime tool.");
  if (request.sandbox_mode === "read_only" && !targets.has("/delivery")) throw new Error("Read-only mode requires a delivery overlay.");
  if (targets.size !== request.mounts.length) throw new Error("Duplicate mount target.");
  const hasProvider = Boolean(request.environment?.provider_channel || request.environment?.anthropic || request.environment?.proxy);
  const hasTools = Boolean(request.environment?.tool_channel);
  const expectedEgress = hasProvider && hasTools ? "provider_and_tools" : hasProvider ? "provider" : hasTools ? "tools" : "none";
  if (request.egress_profile !== expectedEgress) throw new Error("Egress profile does not match typed channels.");
  for (const mount of request.mounts) {
    if (mount.target === "/workspace" && request.sandbox_mode === "read_only" && mount.access !== "read_only") {
      throw new Error("Read-only mode requires a read-only workspace mount.");
    }
    if (mount.target === "/workspace" && request.sandbox_mode === "read_write" && mount.access !== "read_write") {
      throw new Error("Read-write mode requires a read-write workspace mount.");
    }
    const attachmentTarget = typeof mount.target === "string" && /^\/attachments\/\d+$/.test(mount.target);
    const allowed = attachmentTarget ? mount.root === "workspaces" && (mount.access === "read_only" || mount.access === "read_write")
      : mount.target === "/runtime-tool" ? mount.root === "runtime_tools" && mount.access === "read_only"
      : mount.target === "/home/sandbox" ? (mount.root === "run_homes" || mount.root === "conversation_homes" || mount.root === "login_homes") && mount.access === "read_write"
      : mount.target === "/workspace" ? (mount.root === "workspaces" || mount.root === "sandboxes")
      : mount.target === "/delivery" ? mount.root === "sandboxes" && mount.access === "read_only"
      : mount.target === "/run-exchange/input" ? mount.root === "sandboxes" && mount.access === "read_only"
      : mount.target === "/run-exchange/output" ? mount.root === "sandboxes" && mount.access === "read_write"
      : false;
    if (!allowed) throw new Error(`Mount ${mount.target} is not allowed.`);
  }
}

function buildNamespaceCommand(request) {
  const mounts = new Map(request.mounts.map((mount) => [mount.target, { ...mount, source: resolveMount(mount) }]));
  const verification = request.runtime === "verification";
  const tool = mounts.get("/runtime-tool");
  let executable;
  let runtimeArguments;
  const args = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-pid", "--tmpfs", "/", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/sandbox"];
  if (verification) {
    if (!request.arguments[0]) throw new Error("Verification command is required.");
    executable = request.arguments[0];
    runtimeArguments = request.arguments.slice(1);
  } else {
    if (tool.id !== request.runtime_tool_id) throw new Error("Runtime tool mount does not match the selected tool id.");
    const versionMarker = tool.id.split("/").indexOf("versions");
    if (versionMarker < 1 || versionMarker + 1 >= tool.id.split("/").length) throw new Error("Runtime tool id is not version scoped.");
    const parts = tool.id.split("/");
    const versionId = parts.slice(0, versionMarker + 2).join("/");
    const versionRoot = resolveManaged(ROOTS.runtime_tools, versionId);
    if (parts[0] !== request.runtime || parts.slice(versionMarker + 2).join("/") !== RUNTIME_EXECUTABLES[request.runtime]) {
      throw new Error("Runtime tool id does not match the registered runtime executable.");
    }
    executable = `/runtime-tool/${RUNTIME_EXECUTABLES[request.runtime]}`;
    runtimeArguments = request.arguments;
    args.push("--dir", "/runtime-tool", "--ro-bind", versionRoot, "/runtime-tool");
  }
  for (const path of ETC) if (exists(path)) args.push("--ro-bind", path, path);
  // The Runner service is attached only to the internal Runner control network.
  // A launch without a typed provider/tool channel receives a fresh network
  // namespace as an additional fail-closed boundary.
  if (request.egress_profile === "none") args.push("--unshare-net");
  const workspace = mounts.get("/workspace");
  if (request.sandbox_mode === "read_only") addReadOnlyWorkspace(args, workspace.source, mounts.get("/delivery").source);
  else args.push("--dir", "/workspace", "--bind", workspace.source, "/workspace");
  for (const target of ["/home/sandbox", "/run-exchange/input", "/run-exchange/output"]) {
    const mount = mounts.get(target); if (!mount) continue;
    args.push(mount.access === "read_only" ? "--ro-bind" : "--bind", mount.source, target);
  }
  for (const [target, mount] of mounts) {
    if (!/^\/attachments\/\d+$/.test(target)) continue;
    args.push("--dir", target, mount.access === "read_only" ? "--ro-bind" : "--bind", mount.source, target);
  }
  args.push("--setenv", "HOME", "/home/sandbox");
  if (verification) args.push("--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin");
  for (const [key, value] of Object.entries(environmentMap(request.environment))) args.push("--setenv", key, value);
  const runtimeArgv = request.terminal_mode === "pty"
    ? ["/usr/bin/script", "-qefc", [executable, ...runtimeArguments].map(shellQuote).join(" "), "/dev/null"]
    : [executable, ...runtimeArguments];
  args.push("--chdir", "/workspace", "--", "/bin/sh", "-c", "printf 'ready\\n' >&3; exec \"$@\"", "sandbox-launch", ...runtimeArgv);
  return args;
}

function addReadOnlyWorkspace(args, workspace, delivery) {
  args.push("--tmpfs", "/workspace", "--ro-bind", delivery, "/delivery");
  const generated = new Set(readdirSync(delivery));
  for (const name of readdirSync(workspace)) {
    if (generated.has(name)) continue;
    const source = join(workspace, name); const stat = lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("Unsupported Project entry.");
    args.push("--ro-bind", source, join("/workspace", name));
  }
  for (const name of generated) {
    const source = join(delivery, name); const stat = lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Unsupported delivery entry.");
    args.push("--ro-bind", source, join("/workspace", name));
  }
  args.push("--remount-ro", "/workspace");
}

export function environmentMap(env = {}) {
  const result = { LANG: env.locale ?? "C.UTF-8", TERM: env.term ?? "dumb" };
  if (env.codex_home) result.CODEX_HOME = env.codex_home;
  const anthropic = env.anthropic ?? {};
  for (const [field, key] of [["base_url", "ANTHROPIC_BASE_URL"], ["auth_token", "ANTHROPIC_AUTH_TOKEN"], ["model", "ANTHROPIC_MODEL"], ["default_sonnet_model", "ANTHROPIC_DEFAULT_SONNET_MODEL"], ["default_opus_model", "ANTHROPIC_DEFAULT_OPUS_MODEL"], ["default_haiku_model", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]]) if (typeof anthropic[field] === "string") result[key] = anthropic[field];
  const proxy = env.proxy ?? {};
  for (const [field, keys] of [["http", ["HTTP_PROXY", "http_proxy"]], ["https", ["HTTPS_PROXY", "https_proxy"]], ["all", ["ALL_PROXY", "all_proxy"]], ["no_proxy", ["NO_PROXY", "no_proxy"]]]) if (typeof proxy[field] === "string") for (const key of keys) result[key] = proxy[field];
  const tools = env.tool_channel;
  if (tools && typeof tools.url === "string" && typeof tools.token === "string") {
    result.RAINVER_API_URL = tools.url;
    result.RAINVER_TOOL_TOKEN = tools.token;
    if (typeof tools.run_id === "string") result.RAINVER_RUN_ID = tools.run_id;
    if (typeof tools.cli_path === "string") result.RAINVER_CLI = tools.cli_path;
    if (typeof tools.skill_path === "string") result.RAINVER_SKILL_PATH = tools.skill_path;
  }
  if (env.exchange) { result.RAINVER_EXCHANGE_INPUT = "/run-exchange/input/run_input.json"; result.RAINVER_EXCHANGE_OUTPUT = "/run-exchange/output"; }
  if (Array.isArray(env.workspace_access)) {
    result.RAINVER_WORKSPACE_ACCESS = JSON.stringify(env.workspace_access.map((item) => ({
      workspace_location_id: item.workspace_location_id,
      access_mode: item.access_mode,
      path: item.target,
    })));
  }
  return result;
}

function resolveMount(mount) {
  if (!mount || !ROOTS[mount.root] || !["read_only", "read_write"].includes(mount.access) || typeof mount.id !== "string") throw new Error("Invalid mount reference.");
  return resolveManaged(ROOTS[mount.root], mount.id);
}
function resolveManaged(root, id) {
  if (!id || id.startsWith("/") || id.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe mount id.");
  const path = resolve(root, id); const real = realpathSync(path); if (real !== root && !real.startsWith(`${root}/`)) throw new Error("Mount escapes managed root."); return real;
}
function requiredRoot(key, fallback) { const root = realpathSync(resolve(process.env[key] ?? fallback)); return root; }
function exists(path) { try { lstatSync(path); return true; } catch { return false; } }
function boundedPort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SANDBOX_RUNNER_PORT"); return port; }
function shellQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
function validToken(value) { if (typeof value !== "string") return false; const expected = Buffer.from(RUNNER_TOKEN); const actual = Buffer.from(value); return expected.length === actual.length && timingSafeEqual(expected, actual); }
