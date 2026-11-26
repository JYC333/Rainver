import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalToolBridge } from "../src/localBridge.ts";
import type { ToolRequest } from "../src/toolRequest.ts";

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
 * Production stages and resolves `dist/rainver.js`. Prefer that file when it
 * exists. A suite that only runs the TypeScript source does not test the
 * artifact CI builds.
 */
const BUILT = fileURLToPath(new URL("../dist/rainver.js", import.meta.url));
const CLI = existsSync(BUILT)
  ? BUILT
  : fileURLToPath(new URL("../src/rainver.ts", import.meta.url));

type Received = ToolRequest;
let root: string;
let bridge: Awaited<ReturnType<typeof startLocalToolBridge>>;
let received: Received[] = [];
let respond: (received: Received) => { status: number; body: string } = () => ({ status: 200, body: "{}" });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-cli-test-"));
  bridge = await startLocalToolBridge(root, async (request) => {
    received.push(request);
    const answer = respond(request);
    return { status: answer.status, text: answer.body };
  });
});

afterAll(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
  entry = CLI,
): Promise<{ code: number; stdout: string; stderr: string }> {
  received = [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...args], {
      env: {
        ...process.env,
        RAINVER_TOOL_BRIDGE: bridge.endpoint,
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
  it("also runs the unbuilt checkout entry", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ tools: [] }) });
    const result = await runCli(["list"], {}, undefined, fileURLToPath(new URL("../src/rainver.ts", import.meta.url)));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ tools: [] });
  });
  it("reads the run's tool surface through its private local bridge", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ tools: [{ name: "task.list" }] }) });

    const result = await runCli(["list"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ tools: [{ name: "task.list" }] });
    expect(received[0]).toMatchObject({
      method: "GET",
      path: "tools",
    });
  });

  it("asks for one action by name", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ name: "task.report" }) });

    await runCli(["describe", "task.report"]);

    expect(received[0]!.path).toBe("tools/task.report");
  });

  it("refuses to run without the run's environment", async () => {
    const result = await runCli(["list"], { RAINVER_TOOL_BRIDGE: "" });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("RAINVER_TOOL_BRIDGE");
  });
});

describe("rainver help", () => {
  it.each([
    ["--help"], ["-h"], ["help"],
    ["list", "--help"], ["list", "-h"],
    ["describe", "--help"], ["describe", "-h"],
    ["describe", "source.material.submit", "--help"],
    ["call", "--help"], ["call", "-h"],
    ["call", "source.material.submit", "--help"],
    ["call", "source.material.submit", "-h"],
  ].map((args) => ({ args })))("prints local usage for $args without a tool identity", async ({ args }) => {
    const result = await runCli(args, { RAINVER_TOOL_BRIDGE: "" });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    if (["list", "describe", "call"].includes(args[0]!)) {
      expect(result.stdout).toMatch(new RegExp(`^Usage: rainver ${args[0]}(?: |\\n)`));
      expect(result.stdout).not.toContain("rainver — report to Rainver");
    } else {
      expect(result.stdout).toContain("rainver — report to Rainver");
      expect(result.stdout).toContain("rainver call <action>");
    }
    expect(received).toHaveLength(0);
  });

  it("explains call's input forms, default and refusal status in its own help", async () => {
    const result = await runCli(["call", "--help"]);
    expect(result.stdout).toContain("Usage: rainver call <action> [--idempotency-key <key>] [input]");
    expect(result.stdout).toContain("inline JSON");
    expect(result.stdout).toContain("@file.json");
    expect(result.stdout).toContain("standard input");
    expect(result.stdout).toContain("empty object {}");
    expect(result.stdout).toContain("1 on action refusal");
    expect(result.stdout).toContain("rainver describe <action>");
    expect(result.stdout).not.toContain("rainver list                    ");
    expect(received).toHaveLength(0);
  });

  it("does not dispatch call --help through the local tool bridge", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: false, error_code: "system_action_not_granted" }) });
    const direct = await runCli(["call", "--help"]);
    expect(direct).toMatchObject({ code: 0, stderr: "" });
    expect(received).toHaveLength(0);

    const root = await mkdtemp(join(tmpdir(), "rainver-cli-help-"));
    let calls = 0;
    const host = await startLocalToolBridge(root, async () => {
      calls += 1;
      return { status: 200, text: JSON.stringify({ ok: false, error_code: "system_action_not_granted" }) };
    });
    try {
      const bridged = await runCli(["call", "--help"], { RAINVER_TOOL_BRIDGE: host.endpoint });
      expect(bridged).toMatchObject({ code: 0, stderr: "" });
      expect(bridged.stdout).toContain("rainver call <action>");
      expect(calls).toBe(0);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("rainver call", () => {
  it("preserves help text inside action input", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });
    const input = { summary: "Use --help or -h to read command help" };
    const result = await runCli(["call", "task.report", JSON.stringify(input)]);
    expect(result.code).toBe(0);
    expect(received[0]!.body).toEqual(input);
  });

  it("uses the Host bridge with command networking disabled and no server credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-cli-bridge-"));
    const denyNetwork = join(root, "deny-network.mjs");
    await writeFile(denyNetwork, 'globalThis.fetch = () => { throw new Error("command networking disabled"); };');
    try {
      respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });
      const env = { NODE_OPTIONS: `--import=${denyNetwork}` };
      const result = await runCli(["call", "task.report", '{"summary":"done"}'], env);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(received[0]).toMatchObject({ method: "POST", body: { summary: "done" } });
      expect(received[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      respond = () => ({ status: 403, body: JSON.stringify({ ok: false, error: "not granted" }) });
      const denied = await runCli(["list"], env);
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain("status 403");
      expect(JSON.parse(denied.stdout)).toMatchObject({ error: "not granted" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("posts the input and carries an idempotency key", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true, task_id: "task-1" }) });

    const result = await runCli(["call", "task.report", '{"task_id":"task-1","summary":"done"}']);

    expect(result.code).toBe(0);
    expect(received[0]).toMatchObject({ method: "POST", path: "tools/task.report" });
    expect(received[0]!.body).toEqual({ task_id: "task-1", summary: "done" });
    // A retried call must advance the work once, which is what the key is for.
    expect((received[0]!.idempotency_key ?? received[0]!.id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the input from a file and from stdin", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });
    const dir = await mkdtemp(join(tmpdir(), "rainver-cli-"));
    const file = join(dir, "input.json");
    await writeFile(file, JSON.stringify({ task_id: "from-file" }), "utf8");

    await runCli(["call", "task.report", `@${file}`]);
    expect(received[0]!.body).toEqual({ task_id: "from-file" });

    await runCli(["call", "task.report", "-"], {}, JSON.stringify({ task_id: "from-stdin" }));
    expect(received[0]!.body).toEqual({ task_id: "from-stdin" });
  });

  it("sends an empty object when no input is given", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });

    await runCli(["call", "task.list"]);

    expect(received[0]!.body).toEqual({});
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

  it("reports a closed local tool bridge instead of hanging", async () => {
    const result = await runCli(["list"], { RAINVER_TOOL_BRIDGE: root });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no longer available");
  });

  it("needs an action name", async () => {
    const result = await runCli(["call"]);

    expect(result.code).toBe(2);
    expect(received).toHaveLength(0);
  });
});


describe('explicit logical retry keys',()=>{
 it('forwards a deliberate key across separate CLI invocations while default calls remain distinct',async()=>{
  respond=()=>({status:200,body:'{}'});
  expect((await runCli(['call','task.report','--idempotency-key','retained-key','{}'])).code).toBe(0);
  expect((received[0]!.idempotency_key ?? received[0]!.id)).toBe('retained-key');
  expect((await runCli(['call','task.report','--idempotency-key','retained-key','{}'])).code).toBe(0);
  expect((received[0]!.idempotency_key ?? received[0]!.id)).toBe('retained-key');
  await runCli(['call','task.report','{}']);const first=(received[0]!.idempotency_key ?? received[0]!.id);
  await runCli(['call','task.report','{}']);expect((received[0]!.idempotency_key ?? received[0]!.id)).not.toBe(first);
 });
 it('does not retry a retryable conflict automatically',async()=>{
  respond=()=>({status:409,body:JSON.stringify({error:{code:'idempotency_in_progress',retryable:true}})});
  expect((await runCli(['call','task.report','--idempotency-key','once','{}'])).code).toBe(1);
  expect(received).toHaveLength(1);
 });
});

it('stops after a hidden-object 404 and leaves diagnosis to the current list and visible reads',async()=>{
 respond=()=>({status:404,body:JSON.stringify({error:{code:'operation_not_found'}})});
 const result=await runCli(['call','workspace.change.complete','{}']);
 expect(result.code).toBe(1);
 expect(result.stderr).toContain('Stop guessing after a 404');
 expect(result.stderr).toContain('do not try alternate names or ids');
 expect(received).toHaveLength(1);
 expect(received[0].method).toBe('POST');
});
