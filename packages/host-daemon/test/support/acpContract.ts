import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { resolvePackagedAdapter } from "../../src/adapterInstallation.js";
import { killProcessGroup } from "../../src/processGroup.js";

/** Real resolved adapter, isolated HOME, no ambient keys and only opt-in synthetic turns. */
export function launchAcpContract(runtime: "codex_cli" | "claude_code", root: string, executable: string, options: { syntheticTurns?: boolean } = {}) {
  const entry = resolvePackagedAdapter(runtime === "codex_cli" ? "codex-acp" : "claude-agent-acp", {});
  if (!entry) throw new Error(`Missing packaged ${runtime} adapter`);
  const child = spawn(process.execPath, [entry], {
    cwd: root, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
      XDG_STATE_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      CODEX_HOME: join(root, "codex"), CODEX_PATH: executable,
      CLAUDE_CONFIG_DIR: join(root, "claude"), CLAUDE_SECURESTORAGE_CONFIG_DIR: join(root, "claude"),
      CLAUDE_CODE_EXECUTABLE: executable, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
  });
  let stderr = "", nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      for (const request of pending.values()) request.reject(new Error(`ACP exited (${code}): ${stderr}`));
      resolve(code);
    });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      if (message.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Contract probe provides no tools" } }) + "\n");
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    entry,
    notify(method: string, params: object) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    async request(method: string, params: object): Promise<any> {
      if (method === "session/prompt" && !options.syntheticTurns) throw new Error("Inference is forbidden in a contract probe");
      const id = ++nextId;
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(new Error(`${runtime} ${method} timed out: ${stderr}`)), 8000);
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      } finally { clearTimeout(timer!); pending.delete(id); }
    },
    async close() {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(() => { killProcessGroup(child, "SIGKILL"); resolve(); }, 3000); })]);
        await closed;
      } finally { clearTimeout(timer!); lines.close(); }
    },
  };
}
