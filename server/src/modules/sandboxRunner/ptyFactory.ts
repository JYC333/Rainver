import type { ServerConfig } from "../../config.js";
import type { PtyFactory, PtyHandle } from "../providers/cli/loginEngine.js";
import { LocalCliProcessRegistry } from "../runs/localCliExecution.js";
import { SandboxRunnerCliCommandExecutor } from "./client.js";

export class SandboxRunnerPtyFactory implements PtyFactory {
  constructor(
    private readonly config: ServerConfig,
    private readonly runtime: "claude_code" | "codex_cli" | "opencode",
    private readonly runId: string,
    private readonly workspaceCwd: string,
    private readonly proxyUrl: string,
  ) {}

  spawn(command: string, args: string[], options: { cols: number; rows: number; env: Record<string, string> }): PtyHandle {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];
    const queued: string[] = [];
    const registry = new LocalCliProcessRegistry();
    const runId = this.runId;
    let sendInput: ((value: string) => void) | null = null;
    let exited = false;
    let killRequested = false;
    const emitExit = (code: number) => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener(code);
    };
    void new SandboxRunnerCliCommandExecutor(this.config, this.runtime).runCommand({
      command: [command, ...args],
      cwd: this.workspaceCwd,
      timeout_seconds: 600,
      env: {
        ...options.env,
        TERM: options.env.TERM ?? "xterm-256color",
        COLUMNS: String(options.cols),
        LINES: String(options.rows),
        HTTP_PROXY: this.proxyUrl,
        HTTPS_PROXY: this.proxyUrl,
      },
      run_id: this.runId,
      scope_id: this.runId,
      stdin: null,
      terminal: true,
      egress_profile: "provider",
      process_registry: registry,
      raw_stdio_controller: {
        start(send) {
          sendInput = send;
          for (const value of queued.splice(0)) send(value);
          if (killRequested) registry.terminate(runId);
        },
        receive(value) { for (const listener of dataListeners) listener(value); },
      },
    }).then((result) => emitExit(result.returncode), () => emitExit(-1));

    return {
      write(value) { if (sendInput) sendInput(value); else queued.push(value); },
      onData(listener) { dataListeners.push(listener); },
      onExit(listener) { exitListeners.push(listener); },
      kill() {
        killRequested = true;
        if (!registry.terminate(runId)) registry.forceTerminate(runId);
      },
    };
  }
}
