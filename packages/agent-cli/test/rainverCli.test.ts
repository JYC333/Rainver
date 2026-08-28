import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `rainver` command, run as the agent runs it.
 *
 * Spawned as a real child process against a stub control plane rather than
 * imported: what has to hold is the contract at the process boundary — the
 * environment it reads, the exit status it leaves behind, and the JSON it
 * prints — and a direct import would test none of those.
 */

/**
 * The built entry when there is one, the source otherwise.
 *
 * Production stages and resolves `dist/rainver.js`, so a suite that only ever
 * ran the TypeScript source would leave the shipped artifact untested — and CI
 * builds this package before running these tests for exactly that reason.
 */
const BUILT = fileURLToPath(new URL("../dist/rainver.js", import.meta.url));
const CLI = existsSync(BUILT)
  ? BUILT
  : fileURLToPath(new URL("../src/rainver.ts", import.meta.url));

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: string;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];
let respond: (received: Received) => { status: number; body: string } = () => ({ status: 200, body: "{}" });

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const entry: Received = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        body,
      };
      received.push(entry);
      const answer = respond(entry);
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  received = [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      env: {
        ...process.env,
        RAINVER_API_URL: baseUrl,
        RAINVER_RUN_ID: "run-1",
        RAINVER_TOOL_TOKEN: "token-1",
        ...env,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("rainver list / describe", () => {
  it("reads the run's tool surface with its own bearer token", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ tools: [{ name: "task.list" }] }) });

    const result = await runCli(["list"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ tools: [{ name: "task.list" }] });
    expect(received[0]).toMatchObject({
      method: "GET",
      url: "/internal/runs/run-1/tools",
      authorization: "Bearer token-1",
    });
  });

  it("asks for one action by name", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ name: "task.report" }) });

    await runCli(["describe", "task.report"]);

    expect(received[0]!.url).toBe("/internal/runs/run-1/tools/task.report");
  });

  it("refuses to run without the run's environment", async () => {
    const result = await runCli(["list"], { RAINVER_TOOL_TOKEN: "" });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("RAINVER_TOOL_TOKEN");
  });
});

describe("rainver call", () => {
  it("posts the input and carries an idempotency key", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true, task_id: "task-1" }) });

    const result = await runCli(["call", "task.report", '{"task_id":"task-1","summary":"done"}']);

    expect(result.code).toBe(0);
    expect(received[0]).toMatchObject({ method: "POST", url: "/internal/runs/run-1/tools/task.report" });
    expect(JSON.parse(received[0]!.body)).toEqual({ task_id: "task-1", summary: "done" });
    // A retried call must advance the work once, which is what the key is for.
    expect(received[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the input from a file and from stdin", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });
    const dir = await mkdtemp(join(tmpdir(), "rainver-cli-"));
    const file = join(dir, "input.json");
    await writeFile(file, JSON.stringify({ task_id: "from-file" }), "utf8");

    await runCli(["call", "task.report", `@${file}`]);
    expect(JSON.parse(received[0]!.body)).toEqual({ task_id: "from-file" });

    await runCli(["call", "task.report", "-"], {}, JSON.stringify({ task_id: "from-stdin" }));
    expect(JSON.parse(received[0]!.body)).toEqual({ task_id: "from-stdin" });
  });

  it("sends an empty object when no input is given", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });

    await runCli(["call", "task.list"]);

    expect(JSON.parse(received[0]!.body)).toEqual({});
  });

  it("fails without calling the server when the input is not a JSON object", async () => {
    const invalid = await runCli(["call", "task.report", "not json"]);
    expect(invalid.code).toBe(2);
    expect(received).toHaveLength(0);

    const array = await runCli(["call", "task.report", "[1,2]"]);
    expect(array.code).toBe(2);
    expect(received).toHaveLength(0);
  });

  it("exits non-zero when the action refused inside a 200 body", async () => {
    // The refusal has to be visible to a script that checks the exit status,
    // or an agent reports success for a write that never happened.
    respond = () => ({ status: 200, body: JSON.stringify({ ok: false, error: "not granted" }) });

    const result = await runCli(["call", "task.report", "{}"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });

  it("exits non-zero and still prints the body on an error status", async () => {
    respond = () => ({ status: 422, body: JSON.stringify({ ok: false, error: "bad input" }) });

    const result = await runCli(["call", "task.report", "{}"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "bad input" });
  });

  it("reports an unreachable control plane instead of hanging", async () => {
    const result = await runCli(["list"], { RAINVER_API_URL: "http://127.0.0.1:1" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not reach Rainver");
  });

  it("needs an action name", async () => {
    const result = await runCli(["call"]);

    expect(result.code).toBe(2);
    expect(received).toHaveLength(0);
  });
});
