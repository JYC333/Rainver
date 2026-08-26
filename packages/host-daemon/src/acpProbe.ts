import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a runtime says it can be set to, asked over ACP rather than guessed.
 *
 * The alternative was hardcoding a list, and the list is wrong: Claude's
 * effort levels are not Codex's, and a bare `low`/`medium`/`high` misses
 * values a runtime really offers (`1m`, `default`). Only the runtime knows,
 * and ACP exists to ask it.
 */
/** One choice as the runtime describes it, not as we would guess. */
export interface AcpOption {
  value: string;
  /** The runtime's own display name — `Fable` for `claude-fable-5[1m]`. */
  name: string | null;
  /** What it resolves to, which is the only way to know what `default` means. */
  description: string | null;
}

export interface AcpRuntimeOptions {
  models: AcpOption[];
  currentModel: string | null;
  efforts: AcpOption[];
  currentEffort: string | null;
}

/** Codex and Claude each name their own effort option; OpenCode exposes none. */
const EFFORT_OPTION_IDS = ["reasoning_effort", "effort"];

interface ConfigOption {
  id?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

function optionValues(option: ConfigOption | undefined): AcpOption[] {
  if (!option || !Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => {
    const record = entry as { value?: unknown; name?: unknown; description?: unknown } | null;
    const value = record?.value;
    if (typeof value !== "string" || !value) return [];
    return [{
      value,
      name: stringOrNull(record?.name),
      description: stringOrNull(record?.description),
    }];
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Opens one ACP session purely to read its `configOptions`, then kills it.
 *
 * Deliberately not part of the per-heartbeat capability probe: this starts an
 * agent process, which costs orders of magnitude more than `--version`. The
 * caller decides how often it is worth paying — the answer changes only when
 * the CLI is reconfigured or upgraded.
 *
 * A runtime that is not installed, not logged in, or slow to start yields null
 * rather than throwing: a probe that cannot answer must cost the option list,
 * never the heartbeat that carries it.
 */
export function probeAcpOptions(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<AcpRuntimeOptions | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: AcpRuntimeOptions | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, ...env },
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    const send = (frame: Record<string, unknown>) => {
      try { child.stdin?.write(`${JSON.stringify(frame)}\n`); } catch { finish(null); }
    };

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          void cwdPromise.then((cwd) => send({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd, mcpServers: [] },
          }));
          continue;
        }
        if (message.id === 2) {
          const result = (message.result ?? {}) as { configOptions?: unknown };
          const options = Array.isArray(result.configOptions)
            ? (result.configOptions as ConfigOption[])
            : [];
          const model = options.find((option) => option.id === "model");
          const effort = options.find((option) => EFFORT_OPTION_IDS.includes(String(option.id)));
          finish({
            models: optionValues(model),
            currentModel: stringOrNull(model?.currentValue),
            efforts: optionValues(effort),
            currentEffort: stringOrNull(effort?.currentValue),
          });
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));

    // A session needs a working directory, and the probe must not touch a real
    // workspace: some runtimes snapshot or index whatever they are opened in.
    const cwdPromise = mkdtemp(join(tmpdir(), "agent-space-acp-probe-"));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
  });
}
