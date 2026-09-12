import { spawn } from "node:child_process";
import { isAcpAuthRequiredError, type RuntimeAuthMethod, type RuntimeOptionChoice, type RuntimeOptions, type RuntimeSessionConfigOption } from "@rainver/protocol";
import { terminalAuthAvailable } from "./terminalAuth.js";
import { helperProcessEnv } from "./providerBinding.js";

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

/** ACP defaults a missing method type to protocol-driven Agent Auth. */
export function parseAcpAuthMethods(value: unknown): RuntimeAuthMethod[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): RuntimeAuthMethod[] => {
    const method = record(raw);
    const id = stringOrNull(method.id);
    const name = stringOrNull(method.name) ?? id;
    const type = method.type === "terminal" ? "terminal" : method.type === undefined || method.type === "agent" ? "agent" : null;
    if (!id || !name || !type) return [];
    return [{
      id,
      name,
      description: stringOrNull(method.description),
      type,
      args: Array.isArray(method.args) ? method.args.filter((item): item is string => typeof item === "string") : [],
      env: Object.fromEntries(Object.entries(record(method.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    }];
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

export { isAcpAuthRequiredError } from "@rainver/protocol";

export function parseAcpSessionProbeResult(
  result: unknown,
  error: unknown,
  authMethods: RuntimeAuthMethod[],
): RuntimeOptions | null {
  if (error !== undefined && !isAcpAuthRequiredError(error)) {
    // The session probe is inconclusive, but the auth methods came from a
    // successful `initialize` and are the only login path a registry agent
    // has. Not every agent reports a missing login as ACP's `auth_required`;
    // dropping the methods here left such a copy with no Log in button and
    // no way to ever become logged in. Keep them; the login state is unknown.
    if (authMethods.length === 0) return null;
    return { config_options: [], auth_methods: authMethods, authenticated: null };
  }
  return {
    ...parseAcpSessionOptions(result),
    auth_methods: authMethods,
    authenticated: error === undefined,
  };
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
  /**
   * Told why a probe yielded nothing. The null result is deliberate (a probe
   * must never cost the heartbeat), but silent null left a copy with no login
   * button and no explanation anywhere; the reason goes to the daemon log.
   */
  onFailure?: (reason: string) => void,
  adapterType?: string,
): Promise<RuntimeOptions | null> {
  return new Promise((resolve) => {
    let authMethods: RuntimeAuthMethod[] = [];
    let settled = false;
    let stderr = "";
    // ACP Agent Auth is per process: a copy that is logged in on this host
    // still answers its first session request with "authenticate first". Do
    // what a Run's session controller does — authenticate with the advertised
    // Agent-Auth method once and ask again — so `authenticated` reports the
    // copy's real state rather than the protocol's first refusal.
    let authenticateTried = false;
    let sessionRequestId = 2;
    const openSession = () => {
      send({ jsonrpc: "2.0", id: sessionRequestId, method: "session/new", params: { cwd, mcpServers: [] } });
    };
    const stderrTail = () => {
      const text = stderr.trim();
      return text ? `; stderr: ${text.slice(-600).replace(/\s+/g, " ")}` : "";
    };
    const finish = (value: RuntimeOptions | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (value === null && reason) onFailure?.(reason);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null, `no answer within ${Math.round(timeoutMs / 1000)}s${stderrTail()}`), timeoutMs);
    timer.unref?.();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...helperProcessEnv(process.env, adapterType ?? ""), ...env },
      });
    } catch (error) {
      clearTimeout(timer);
      onFailure?.(`cannot start ${command}: ${error instanceof Error ? error.message : String(error)}`);
      resolve(null);
      return;
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });

    const send = (frame: Record<string, unknown>) => {
      try { child.stdin?.write(`${JSON.stringify(frame)}\n`); } catch (error) {
        finish(null, `stdin closed: ${error instanceof Error ? error.message : String(error)}${stderrTail()}`);
      }
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
          if (message.error) {
            finish(null, `initialize failed: ${JSON.stringify(message.error)}`);
            continue;
          }
          authMethods = parseAcpAuthMethods(record(message.result).authMethods)
            .filter((method) => method.type !== "terminal" || terminalAuthAvailable());
          openSession();
          continue;
        }
        if (message.id === sessionRequestId) {
          const agentMethod = authMethods.find((method) => method.type === "agent");
          if (message.error && !authenticateTried && agentMethod && isAcpAuthRequiredError(message.error)) {
            authenticateTried = true;
            send({ jsonrpc: "2.0", id: 3, method: "authenticate", params: { methodId: agentMethod.id } });
            continue;
          }
          const parsed = parseAcpSessionProbeResult(message.result, message.error, authMethods);
          finish(
            parsed,
            parsed === null
              ? `session/new failed with a reason other than auth_required and initialize advertised no auth method: ${JSON.stringify(message.error)}`
              : undefined,
          );
          continue;
        }
        if (message.id === 3) {
          if (message.error) {
            // The copy is not logged in on this host: report exactly that, with
            // the methods intact so the Log in button exists.
            finish({ config_options: [], auth_methods: authMethods, authenticated: false });
            continue;
          }
          sessionRequestId = 4;
          openSession();
        }
      }
    });
    child.on("error", (error) => finish(null, `cannot start ${command}: ${error.message}`));
    child.on("close", (code, signal) => finish(null, `exited (${signal ?? `code ${code}`}) before answering${stderrTail()}`));

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          ...(terminalAuthAvailable() ? { auth: { terminal: true } } : {}),
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "rainver-host", version: "1" },
      },
    });
  });
}
