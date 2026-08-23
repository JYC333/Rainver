import { createConnection } from "node:net";
import { relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ServerConfig } from "../../config";
import type {
  CliCommandExecutor,
  CliExecutionResult,
  CliStdioController,
} from "../runs/localCliExecution";
import {
  SANDBOX_RUNNER_PROTOCOL_VERSION,
  type SandboxClientFrame,
  type SandboxEgressProfile,
  type SandboxLaunchRequest,
  type SandboxMountRef,
  type SandboxRunnerFrame,
  type SandboxRuntimeEnvironment,
} from "./protocol";

interface RemoteProcessRegistry {
  registerRemote?(runId: string, terminate: () => void, forceTerminate: () => void): void;
}

const VERIFICATION_OUTPUT_LIMIT_BYTES = 64_000;

export class SandboxRunnerCliCommandExecutor implements CliCommandExecutor {
  constructor(
    private readonly config: Pick<ServerConfig,
      "sandboxRunnerHost" | "sandboxRunnerPort" | "sandboxRoot" | "workspaceRoot"
      | "cliToolsRoot" | "agentSpaceHome" | "internalToken">,
    private readonly runtime: "claude_code" | "codex_cli" | "opencode",
  ) {}

  async runCommand(input: Parameters<CliCommandExecutor["runCommand"]>[0]): Promise<CliExecutionResult> {
    let request: SandboxLaunchRequest;
    try {
      request = buildLaunchRequest(this.config, this.runtime, input);
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : "Invalid Sandbox Runner request.");
    }
    return await connectAndRun(
      this.config.sandboxRunnerHost,
      this.config.sandboxRunnerPort,
      request,
      this.config.internalToken,
      input.stdin,
      input.stdio_controller,
      input.raw_stdio_controller,
      input.on_stdout_chunk,
      input.process_registry as (typeof input.process_registry & RemoteProcessRegistry),
    );
  }
}

export class SandboxRunnerVerificationExecutor {
  constructor(
    private readonly config: Pick<ServerConfig,
      "sandboxRunnerHost" | "sandboxRunnerPort" | "sandboxRoot" | "workspaceRoot"
      | "cliToolsRoot" | "agentSpaceHome" | "internalToken">,
  ) {}

  async run(input: { runId: string; cwd: string; command: string[]; timeoutSeconds: number }): Promise<CliExecutionResult> {
    if (!input.command[0]) return unavailable("Verification command is empty.");
    let workspace: SandboxMountRef;
    try {
      workspace = mountRef(input.cwd, this.config, "/workspace", "read_write");
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : "Invalid verification workspace.");
    }
    const request: SandboxLaunchRequest = {
      protocol_version: SANDBOX_RUNNER_PROTOCOL_VERSION,
      run_id: input.runId,
      scope_id: `${input.runId}:verification`,
      runtime: "verification",
      runtime_tool_id: "verification",
      arguments: input.command.map((value) => translateArgument(value, { workspace: input.cwd })),
      sandbox_mode: "read_write",
      egress_profile: "none",
      mounts: [workspace],
      environment: { locale: "C.UTF-8" },
      timeout_seconds: input.timeoutSeconds,
      stdin_mode: "none",
      terminal_mode: "pipe",
    };
    return connectAndRun(
      this.config.sandboxRunnerHost,
      this.config.sandboxRunnerPort,
      request,
      this.config.internalToken,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      VERIFICATION_OUTPUT_LIMIT_BYTES,
    );
  }
}

function buildLaunchRequest(
  config: Pick<ServerConfig, "sandboxRoot" | "workspaceRoot" | "cliToolsRoot" | "agentSpaceHome">,
  runtime: SandboxLaunchRequest["runtime"],
  input: Parameters<CliCommandExecutor["runCommand"]>[0],
): SandboxLaunchRequest {
  if (!input.command[0] || !input.cwd) throw new Error("Sandbox Runner requires a runtime tool and scoped working directory.");
  const toolId = pathId(input.command[0], config.cliToolsRoot, "runtime tool");
  const readOnly = input.read_only;
  const workspacePath = readOnly?.workspace_cwd ?? input.cwd;
  const workspace = mountRef(workspacePath, config, "/workspace", readOnly ? "read_only" : "read_write");
  const mounts: SandboxMountRef[] = [workspace, {
    root: "runtime_tools",
    id: toolId,
    target: "/runtime-tool",
    access: "read_only",
  }];
  if (readOnly) mounts.push(mountRef(readOnly.context_cwd, config, "/delivery", "read_only"));
  const home = input.env.HOME;
  if (home) mounts.push(runtimeHomeMount(home, config.agentSpaceHome));
  const exchangeInput = input.env.AGENT_SPACE_EXCHANGE_INPUT;
  const exchangeOutput = input.env.AGENT_SPACE_EXCHANGE_OUTPUT;
  if (exchangeInput || exchangeOutput) {
    if (!exchangeInput || !exchangeOutput) throw new Error("Both Run Exchange channels are required.");
    mounts.push(mountRef(resolve(exchangeInput, ".."), config, "/run-exchange/input", "read_only"));
    mounts.push(mountRef(exchangeOutput, config, "/run-exchange/output", "read_write"));
  }
  const environment = typedEnvironment(input.env, Boolean(exchangeInput));
  const requestedEgress = input.egress_profile ?? egressProfile(environment);
  if (requestedEgress === "provider" || requestedEgress === "provider_and_tools") {
    environment.provider_channel = {
      kind: environment.anthropic || input.env.CODEX_HOME ? "managed_proxy" : "credential_profile",
    };
  }
  const translatedArgs = input.command.slice(1).map((value) => translateArgument(value, {
    workspace: workspacePath,
    delivery: readOnly?.context_cwd,
    home,
    exchangeInput: exchangeInput ? resolve(exchangeInput, "..") : undefined,
    exchangeOutput,
  }));
  return {
    protocol_version: SANDBOX_RUNNER_PROTOCOL_VERSION,
    run_id: input.run_id,
    scope_id: input.scope_id ?? input.run_id,
    runtime,
    runtime_tool_id: toolId,
    arguments: translatedArgs,
    sandbox_mode: readOnly ? "read_only" : "read_write",
    egress_profile: requestedEgress,
    mounts,
    environment,
    timeout_seconds: input.timeout_seconds,
    stall_timeout_seconds: input.stall_timeout_seconds,
    stdin_mode: input.stdio_controller || input.raw_stdio_controller ? "interactive" : input.stdin !== null ? "fixed" : "none",
    terminal_mode: input.terminal ? "pty" : "pipe",
  };
}

function mountRef(path: string, config: Pick<ServerConfig, "sandboxRoot" | "workspaceRoot">, target: SandboxMountRef["target"], access: SandboxMountRef["access"]): SandboxMountRef {
  try { return { root: "sandboxes", id: pathId(path, config.sandboxRoot, "sandbox mount"), target, access }; }
  catch { return { root: "workspaces", id: pathId(path, config.workspaceRoot, "workspace mount"), target, access }; }
}

function runtimeHomeMount(path: string, agentSpaceHome: string): SandboxMountRef {
  const runRoot = resolve(agentSpaceHome, "cache", "runtime-homes");
  try { return { root: "run_homes", id: pathId(path, runRoot, "run home"), target: "/home/sandbox", access: "read_write" }; }
  catch {
    const conversationRoot = resolve(agentSpaceHome, "cache", "conversation-runtime-homes");
    try { return { root: "conversation_homes", id: pathId(path, conversationRoot, "conversation home"), target: "/home/sandbox", access: "read_write" }; }
    catch {
      const loginRoot = resolve(agentSpaceHome, "cache", "login-homes");
      return { root: "login_homes", id: pathId(path, loginRoot, "login home"), target: "/home/sandbox", access: "read_write" };
    }
  }
}

function pathId(path: string, root: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const id = relative(resolvedRoot, resolvedPath).split(sep).join("/");
  if (!id || id.startsWith("../") || id === ".." || resolve(resolvedRoot, id) !== resolvedPath) {
    throw new Error(`${label} is outside its managed root.`);
  }
  return id;
}

function translateArgument(value: string, paths: Record<string, string | undefined>): string {
  const mappings: Array<[string | undefined, string]> = [
    [paths.delivery, "/workspace"], [paths.workspace, "/workspace"],
    [paths.home, "/home/sandbox"], [paths.exchangeInput, "/run-exchange/input"],
    [paths.exchangeOutput, "/run-exchange/output"],
  ];
  for (const [from, target] of mappings) {
    if (from && (value === from || value.startsWith(`${from}/`))) return `${target}${value.slice(from.length)}`;
  }
  return value;
}

function typedEnvironment(env: Record<string, string>, exchange: boolean): SandboxRuntimeEnvironment {
  return {
    locale: env.LANG,
    term: env.TERM,
    codex_home: env.CODEX_HOME ? "/home/sandbox/.codex" : undefined,
    anthropic: compact({
      base_url: env.ANTHROPIC_BASE_URL, auth_token: env.ANTHROPIC_AUTH_TOKEN,
      model: env.ANTHROPIC_MODEL, default_sonnet_model: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      default_opus_model: env.ANTHROPIC_DEFAULT_OPUS_MODEL, default_haiku_model: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    }),
    proxy: compact({ http: env.HTTP_PROXY ?? env.http_proxy, https: env.HTTPS_PROXY ?? env.https_proxy, all: env.ALL_PROXY ?? env.all_proxy, no_proxy: env.NO_PROXY ?? env.no_proxy }),
    tool_channel: env.AGENT_SPACE_MCP_URL && env.AGENT_SPACE_TOOL_TOKEN ? { url: env.AGENT_SPACE_MCP_URL, token: env.AGENT_SPACE_TOOL_TOKEN } : undefined,
    exchange,
  };
}

function compact(value: Record<string, string | undefined>): Record<string, string> | undefined {
  const result = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  return Object.keys(result).length ? result as Record<string, string> : undefined;
}

function egressProfile(env: SandboxRuntimeEnvironment): SandboxEgressProfile {
  const provider = Boolean(env.provider_channel || env.anthropic || env.proxy);
  const tools = Boolean(env.tool_channel);
  return provider && tools ? "provider_and_tools" : provider ? "provider" : tools ? "tools" : "none";
}

async function connectAndRun(host: string, port: number, request: SandboxLaunchRequest, token: string | null, stdin: string | null, controller: CliStdioController | undefined, rawController: Parameters<CliCommandExecutor["runCommand"]>[0]["raw_stdio_controller"], onStdout: ((chunk: string) => void) | undefined, registry?: (Parameters<CliCommandExecutor["runCommand"]>[0]["process_registry"] & RemoteProcessRegistry), outputLimitBytes?: number): Promise<CliExecutionResult> {
  return await new Promise((resolveResult) => {
    if (!token) { resolveResult(unavailable("Sandbox Runner service token is unavailable.")); return; }
    const socket = createConnection({ host, port });
    let stdout = "", stderr = "", buffer = "", protocolBuffer = "", settled = false;
    let outputBytes = 0, outputLimitExceeded = false;
    const decoder = new StringDecoder("utf8");
    const send = (frame: SandboxClientFrame) => socket.write(`${JSON.stringify(frame)}\n`);
    const appendOutput = (current: string, value: string): string => {
      if (outputLimitBytes === undefined) return current + value;
      const encoded = Buffer.from(value, "utf8");
      const remaining = Math.max(0, outputLimitBytes - outputBytes);
      outputBytes += Math.min(remaining, encoded.length);
      if (encoded.length > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        send({ type: "terminate", force: true });
      }
      return current + encoded.subarray(0, remaining).toString("utf8");
    };
    const finish = (result: CliExecutionResult) => { if (settled) return; settled = true; registry?.deregister(request.run_id); socket.destroy(); resolveResult(result); };
    socket.setTimeout(10_000, () => finish(unavailable("Sandbox Runner connection timed out.")));
    socket.once("error", (error) => finish(unavailable(error.message)));
    socket.once("connect", () => send({ type: "launch", token, request }));
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) {
        let frame: SandboxRunnerFrame;
        try { frame = JSON.parse(line) as SandboxRunnerFrame; } catch { finish(unavailable("Sandbox Runner emitted invalid protocol data.")); return; }
        if (frame.type === "ready") {
          socket.setTimeout(0);
          registry?.registerRemote?.(request.run_id, () => send({ type: "terminate", force: false }), () => send({ type: "terminate", force: true }));
          if (controller) controller.start((value) => send({ type: "stdin", value: `${JSON.stringify(value)}\n` }));
          else if (rawController) rawController.start((value) => send({ type: "stdin", value }));
          else if (stdin !== null) { send({ type: "stdin", value: stdin }); send({ type: "stdin_close" }); }
          else send({ type: "stdin_close" });
        } else if (frame.type === "stdout") {
          stdout = appendOutput(stdout, frame.value); onStdout?.(frame.value); registry?.touchActivity?.(request.run_id);
          rawController?.receive(frame.value);
          if (controller) {
            protocolBuffer += frame.value;
            const records = protocolBuffer.split(/\r?\n/); protocolBuffer = records.pop() ?? "";
            for (const record of records) {
              // See the doc comment on `remoteHostCliAdapter.ts`'s
              // `RemoteWsCliCommandExecutor.onOutput`: `receive()`'s
              // `Promise<void>` return type matches `CliStdioController`
              // (localCliExecution.ts) but its body is synchronous, so no
              // `await` is needed here. The `.catch()` below is not for that
              // synchronous body: an `async` function converts even a
              // synchronous internal throw into a rejected Promise rather
              // than letting it propagate to this `try/catch`, so without it
              // a future bug inside `receive()` would become an unhandled
              // rejection instead of a contained Run failure (discovery
              // review finding #2).
              try {
                controller.receive(JSON.parse(record), (value) => send({ type: "stdin", value: `${JSON.stringify(value)}\n` }), () => send({ type: "stdin_close" }))
                  .catch(() => { controller.reject("CLI protocol emitted invalid JSON"); send({ type: "stdin_close" }); });
              } catch {
                controller.reject("CLI protocol emitted invalid JSON");
                send({ type: "stdin_close" });
              }
            }
          }
        } else if (frame.type === "stderr") { stderr = appendOutput(stderr, frame.value); registry?.touchActivity?.(request.run_id); }
        else if (frame.type === "error") finish({ ...unavailable(frame.message), failure_code: frame.code === "sandbox_namespace_unavailable" ? "sandbox_namespace_unavailable" : "sandbox_runner_unavailable" });
        else if (frame.type === "exit") {
          if (controller && protocolBuffer.trim()) {
            try {
              controller.receive(JSON.parse(protocolBuffer), () => {}, () => {})
                .catch(() => { controller.reject("CLI protocol emitted invalid JSON"); });
            }
            catch { controller.reject("CLI protocol emitted invalid JSON"); }
            protocolBuffer = "";
          }
          const protocol = controller?.result();
          finish(outputLimitExceeded
            ? { returncode: -1, stdout, stderr, timed_out: false, failure_code: "output_limit_exceeded" }
            : { returncode: protocol && (!protocol.completed || protocol.error) ? -1 : frame.returncode, stdout, stderr: protocol?.error ?? stderr, timed_out: frame.timed_out, failure_code: frame.failure_code });
        }
      }
    });
    socket.once("close", () => { if (!settled) finish(unavailable("Sandbox Runner closed before returning an exit result.")); });
  });
}

function unavailable(message: string): CliExecutionResult { return { returncode: -1, stdout: "", stderr: message, timed_out: false, failure_code: "sandbox_runner_unavailable" }; }
