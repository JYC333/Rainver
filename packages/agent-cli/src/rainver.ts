#!/usr/bin/env node
/**
 * `rainver` — the command a dispatched agent calls Rainver back with.
 *
 * Deliberately a pass-through: `list`, `describe`, `call`. Action names and
 * input schemas come from the server at run time, so a new System Action needs
 * nothing added here, and the Zod schemas that already define those inputs are
 * never copied into a second hand-written surface that could disagree with
 * them.
 *
 * It ships with this daemon rather than being installed onto `PATH`: the
 * daemon puts nothing into the machine's global tool space (ADR 0016 §6) and
 * passes an absolute path as `RAINVER_CLI` instead. It carries no
 * authorization of its own — the run's token names the run, and the server
 * decides what that run may do.
 */
import { readFile } from "node:fs/promises";

interface Environment {
  apiUrl: string;
  runId: string;
  token: string;
}

const USAGE = `rainver — report to Rainver about the work you were given

  rainver list                    the actions this run may call
  rainver describe <action>       one action's JSON input schema
  rainver call <action> [input]   invoke it; input is JSON, @file, or - for stdin

Reads RAINVER_API_URL, RAINVER_RUN_ID and RAINVER_TOOL_TOKEN from the
environment; the run you were dispatched for already has them set.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  let env: Environment;
  try {
    env = readEnvironment();
  } catch (error) {
    process.stderr.write(`${message(error)}\n`);
    return 2;
  }

  switch (command) {
    case "list":
      return request(env, "GET", "tools");
    case "describe": {
      const action = rest[0];
      if (!action) {
        process.stderr.write("rainver describe needs an action name\n");
        return 2;
      }
      return request(env, "GET", `tools/${encodeURIComponent(action)}`);
    }
    case "call": {
      const action = rest[0];
      if (!action) {
        process.stderr.write("rainver call needs an action name\n");
        return 2;
      }
      let input: string;
      try {
        input = await readInput(rest[1]);
      } catch (error) {
        process.stderr.write(`${message(error)}\n`);
        return 2;
      }
      let parsed: unknown;
      try {
        parsed = input.trim() ? JSON.parse(input) : {};
      } catch {
        process.stderr.write("The input must be a JSON object. Use @file or - for anything with quotes or newlines.\n");
        return 2;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        process.stderr.write("The input must be a JSON object.\n");
        return 2;
      }
      return request(env, "POST", `tools/${encodeURIComponent(action)}`, parsed);
    }
    default:
      process.stderr.write(`Unknown command '${command}'.\n\n${USAGE}\n`);
      return 2;
  }
}

function readEnvironment(): Environment {
  const apiUrl = process.env.RAINVER_API_URL?.trim();
  const runId = process.env.RAINVER_RUN_ID?.trim();
  const token = process.env.RAINVER_TOOL_TOKEN?.trim();
  if (!apiUrl || !runId || !token) {
    throw new Error(
      "This run has no Rainver tool surface: RAINVER_API_URL, RAINVER_RUN_ID and RAINVER_TOOL_TOKEN must all be set.",
    );
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), runId, token };
}

async function readInput(argument: string | undefined): Promise<string> {
  if (argument === undefined) return "{}";
  if (argument === "-") return readStdin();
  if (argument.startsWith("@")) {
    const path = argument.slice(1);
    if (!path) throw new Error("@ needs a file path");
    return readFile(path, "utf8");
  }
  return argument;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One call, printed as JSON.
 *
 * A refusal is a result the agent has to be able to read and act on, so the
 * body is printed either way and only the exit status distinguishes them.
 *
 * Each invocation mints its own `Idempotency-Key`: it is what a side-effecting
 * action dedupes a *transport* retry on, not a claim that running the command
 * twice is free. An agent that means one write calls once.
 */
async function request(
  env: Environment,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<number> {
  const url = `${env.apiUrl}/internal/runs/${encodeURIComponent(env.runId)}/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${env.token}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": idempotencyKey() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    process.stderr.write(`Could not reach Rainver at ${env.apiUrl}: ${message(error)}\n`);
    return 1;
  }
  const text = await response.text();
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (response.ok) {
    // An action can refuse inside a 200 body; the agent must see that as a
    // failure too, or a script that checks the exit status reports success for
    // a write that never happened.
    try {
      const parsed = JSON.parse(text) as { ok?: unknown };
      if (parsed && typeof parsed === "object" && parsed.ok === false) return 1;
    } catch {
      // A non-JSON 200 is unexpected but not itself a refusal.
    }
    return 0;
  }
  return 1;
}

function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  });
