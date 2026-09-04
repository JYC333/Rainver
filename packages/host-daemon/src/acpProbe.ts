import { spawn } from "node:child_process";
import type { RuntimeOptionChoice, RuntimeOptions, RuntimeSessionConfigOption } from "@rainver/protocol";

/**
 * What a runtime says it can be set to, asked over ACP rather than guessed.
 *
 * The alternative was hardcoding a list, and the list is wrong: Claude's
 * effort levels are not Codex's, and a bare `low`/`medium`/`high` misses
 * values a runtime really offers (`1m`, `default`). Only the runtime knows,
 * and ACP exists to ask it.
 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function selectChoice(value: unknown, group: string | null): RuntimeOptionChoice | null {
  const entry = record(value);
  const id = stringOrNull(entry.value);
  if (!id) return null;
  return {
    value: id,
    name: stringOrNull(entry.name),
    description: stringOrNull(entry.description),
    group,
  };
}

function selectChoices(value: unknown): RuntimeOptionChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    if (Array.isArray(entry.options)) {
      const group = stringOrNull(entry.name) ?? stringOrNull(entry.group);
      return entry.options.flatMap((choice) => {
        const parsed = selectChoice(choice, group);
        return parsed ? [parsed] : [];
      });
    }
    const parsed = selectChoice(entry, null);
    return parsed ? [parsed] : [];
  });
}

/** Defensive ACP-wire parser, exported so the protocol shape is testable without spawning a CLI. */
export function parseAcpSessionOptions(resultValue: unknown): RuntimeOptions {
  const result = record(resultValue);
  const configOptions = Array.isArray(result.configOptions) ? result.configOptions : [];
  const parsed = configOptions.flatMap((value): RuntimeSessionConfigOption[] => {
    const option = record(value);
    const id = stringOrNull(option.id);
    const name = stringOrNull(option.name) ?? id;
    if (!id || !name) return [];
    const base = {
      id,
      name,
      description: stringOrNull(option.description),
      category: stringOrNull(option.category),
    };
    if (option.type === "boolean" && typeof option.currentValue === "boolean") {
      return [{ ...base, type: "boolean", current_value: option.currentValue }];
    }
    if (option.type === "select" && typeof option.currentValue === "string") {
      return [{ ...base, type: "select", current_value: option.currentValue, options: selectChoices(option.options) }];
    }
    return [];
  });

  return { config_options: parsed };
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
  /** Must not be a real workspace: some runtimes snapshot or index whatever they are opened in. */
  cwd: string,
  timeoutMs = 20_000,
): Promise<RuntimeOptions | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: RuntimeOptions | null) => {
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
        cwd,
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
          send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
          continue;
        }
        if (message.id === 2) {
          finish(parseAcpSessionOptions(message.result));
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          session: { configOptions: { boolean: {} } },
        },
      },
    });
  });
}
