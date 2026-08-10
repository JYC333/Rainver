import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxRunnerCliCommandExecutor, SandboxRunnerVerificationExecutor } from "../src/modules/sandboxRunner/client";
import { LocalCliProcessRegistry } from "../src/modules/runs/localCliExecution";
import { SandboxRunnerPtyFactory } from "../src/modules/sandboxRunner/ptyFactory";
import type { ServerConfig } from "../src/config";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SandboxRunnerCliCommandExecutor", () => {
  it("exposes the Node toolchain inside verification namespaces", async () => {
    const source = await readFile(join(process.cwd(), "..", "sandbox", "runner.mjs"), "utf8");
    expect(source).toContain('"--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin"');
  });

  it("sends verification through a no-egress workspace-only Runner request", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-verification-"));
    roots.push(root);
    let launch: Record<string, unknown> | undefined;
    const { server, port } = await runnerServer((frame, send) => {
      if (frame.type !== "launch") return;
      launch = frame.request as Record<string, unknown>;
      send({ type: "ready" });
      send({ type: "exit", returncode: 0, timed_out: false });
    });
    servers.push(server);
    const workspace = join(root, "workspaces", "project-1");
    const result = await new SandboxRunnerVerificationExecutor(testConfig(root, port)).run({
      runId: "run-verification",
      cwd: workspace,
      command: [join(workspace, "node_modules", ".bin", "vitest"), "--root", workspace],
      timeoutSeconds: 45,
    });

    expect(result.returncode).toBe(0);
    expect(launch).toMatchObject({
      runtime: "verification",
      runtime_tool_id: "verification",
      arguments: ["/workspace/node_modules/.bin/vitest", "--root", "/workspace"],
      sandbox_mode: "read_write",
      egress_profile: "none",
      mounts: [{ root: "workspaces", id: "project-1", target: "/workspace", access: "read_write" }],
      environment: { locale: "C.UTF-8" },
    });
    expect(JSON.stringify(launch)).not.toContain(root);
  });

  it("sends only typed managed ids and translates host paths out of runtime arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-client-"));
    roots.push(root);
    let launch: Record<string, unknown> | undefined;
    const { server, port } = await runnerServer((frame, send) => {
      if (frame.type !== "launch") return;
      launch = frame.request as Record<string, unknown>;
      send({ type: "ready" });
      send({ type: "stdout", value: "ok" });
      send({ type: "exit", returncode: 0, timed_out: false });
    });
    servers.push(server);
    const config = testConfig(root, port);
    const workspace = join(root, "sandboxes", "worktrees", "run-1");
    const tool = join(root, "runtime-tools", "codex_cli", "versions", "1.2.3", "bin", "codex");
    const home = join(root, "cache", "runtime-homes", "run-1");
    const result = await new SandboxRunnerCliCommandExecutor(config, "codex_cli").runCommand({
      command: [tool, "exec", "--cwd", workspace, "hello"],
      cwd: workspace,
      timeout_seconds: 30,
      env: { HOME: home, CODEX_HOME: join(home, ".codex"), AGENT_SPACE_TOOL_TOKEN: "lease", AGENT_SPACE_MCP_URL: "http://server:8010/internal" },
      run_id: "run-1",
      stdin: null,
    });

    expect(result).toMatchObject({ returncode: 0, stdout: "ok", timed_out: false });
    expect(launch).toMatchObject({
      runtime: "codex_cli",
      runtime_tool_id: "codex_cli/versions/1.2.3/bin/codex",
      arguments: ["exec", "--cwd", "/workspace", "hello"],
      sandbox_mode: "read_write",
      egress_profile: "tools",
      mounts: expect.arrayContaining([
        { root: "sandboxes", id: "worktrees/run-1", target: "/workspace", access: "read_write" },
        { root: "run_homes", id: "run-1", target: "/home/sandbox", access: "read_write" },
      ]),
      environment: { codex_home: "/home/sandbox/.codex", tool_channel: { url: "http://server:8010/internal", token: "lease" } },
    });
    expect(launch).not.toHaveProperty("command");
    expect(launch).not.toHaveProperty("env");
    expect(JSON.stringify(launch)).not.toContain(root);
  });

  it("terminates verification when combined output exceeds the fixed bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-output-limit-"));
    roots.push(root);
    let terminated = false;
    const { server, port } = await runnerServer((frame, send) => {
      if (frame.type === "launch") {
        send({ type: "ready" });
        send({ type: "stdout", value: "x".repeat(70_000) });
      }
      if (frame.type === "terminate") {
        terminated = true;
        send({ type: "exit", returncode: 137, timed_out: false });
      }
    });
    servers.push(server);
    const result = await new SandboxRunnerVerificationExecutor(testConfig(root, port)).run({
      runId: "run-output-limit",
      cwd: join(root, "workspaces", "project-1"),
      command: ["npm", "test"],
      timeoutSeconds: 30,
    });

    expect(terminated).toBe(true);
    expect(result).toMatchObject({ returncode: -1, failure_code: "output_limit_exceeded" });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64_000);
  });

  it("fails closed when the dedicated Runner is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-unavailable-"));
    roots.push(root);
    const result = await new SandboxRunnerCliCommandExecutor(testConfig(root, 1), "claude_code").runCommand({
      command: [join(root, "runtime-tools", "claude_code", "versions", "1", "bin", "claude")],
      cwd: join(root, "sandboxes", "run-1"),
      timeout_seconds: 1,
      env: {},
      run_id: "run-1",
      stdin: null,
    });
    expect(result).toMatchObject({ returncode: -1, failure_code: "sandbox_runner_unavailable" });
  });

  it("routes cancellation to the Runner instead of signalling a server PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-cancel-"));
    roots.push(root);
    let terminated = false;
    const { server, port } = await runnerServer((frame, send) => {
      if (frame.type === "launch") send({ type: "ready" });
      if (frame.type === "terminate") {
        terminated = true;
        send({ type: "exit", returncode: 143, timed_out: false });
      }
    });
    servers.push(server);
    const registry = new LocalCliProcessRegistry();
    const executing = new SandboxRunnerCliCommandExecutor(testConfig(root, port), "opencode").runCommand({
      command: [join(root, "runtime-tools", "opencode", "versions", "1", "bin", "opencode")],
      cwd: join(root, "sandboxes", "run-1"), timeout_seconds: 30, env: {}, run_id: "run-1", stdin: null,
      process_registry: registry,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.terminate("run-1")).toBe(true);
    await expect(executing).resolves.toMatchObject({ returncode: 143 });
    expect(terminated).toBe(true);
  });

  it("preserves split UTF-8 protocol data and closes absent stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-utf8-"));
    roots.push(root);
    let stdinClosed = false;
    const { server, port } = await runnerServer((frame, send, socket) => {
      if (frame.type === "launch") {
        send({ type: "ready" });
        const encoded = Buffer.from(`${JSON.stringify({ type: "stdout", value: "你好" })}\n`);
        const splitAt = encoded.indexOf(Buffer.from("你")) + 1;
        socket.write(encoded.subarray(0, splitAt));
        socket.write(encoded.subarray(splitAt));
      }
      if (frame.type === "stdin_close") {
        stdinClosed = true;
        send({ type: "exit", returncode: 0, timed_out: false });
      }
    });
    servers.push(server);
    const result = await new SandboxRunnerCliCommandExecutor(testConfig(root, port), "claude_code").runCommand({
      command: [join(root, "runtime-tools", "claude_code", "versions", "1", "bin", "claude")],
      cwd: join(root, "sandboxes", "run-utf8"), timeout_seconds: 30, env: {}, run_id: "run-utf8", stdin: null,
    });
    expect(result).toMatchObject({ returncode: 0, stdout: "你好" });
    expect(stdinClosed).toBe(true);
  });

  it("carries interactive login through the typed Runner PTY channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-runner-pty-"));
    roots.push(root);
    let launch: Record<string, any> | undefined;
    const { server, port } = await runnerServer((frame, send) => {
      if (frame.type === "launch") { launch = frame.request; send({ type: "ready" }); }
      if (frame.type === "stdin") {
        send({ type: "stdout", value: `login:${frame.value}` });
        send({ type: "exit", returncode: 0, timed_out: false });
      }
    });
    servers.push(server);
    const workspace = join(root, "sandboxes", "logins", "login-1");
    const home = join(root, "cache", "login-homes", "codex_cli", "profile-1");
    const tool = join(root, "runtime-tools", "codex_cli", "versions", "1", "node_modules", ".bin", "codex");
    const factory = new SandboxRunnerPtyFactory(
      testConfig(root, port) as ServerConfig,
      "codex_cli",
      "login-1",
      workspace,
      "http://lease:token@server:49152",
    );
    const handle = factory.spawn(tool, ["login"], { cols: 80, rows: 24, env: { HOME: home } });
    const output = await new Promise<string>((resolve) => {
      let value = "";
      handle.onData((chunk) => { value += chunk; });
      handle.onExit(() => resolve(value));
      handle.write("device-code\r");
    });
    expect(output).toBe("login:device-code\r");
    expect(launch).toMatchObject({
      runtime: "codex_cli",
      terminal_mode: "pty",
      stdin_mode: "interactive",
      egress_profile: "provider",
      mounts: expect.arrayContaining([
        { root: "login_homes", id: "codex_cli/profile-1", target: "/home/sandbox", access: "read_write" },
      ]),
    });
  });
});

async function runnerServer(onFrame: (frame: Record<string, any>, send: (frame: object) => void, socket: import("node:net").Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let buffer = "";
    const send = (frame: object) => socket.write(`${JSON.stringify(frame)}\n`);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) onFrame(JSON.parse(line), send, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

function testConfig(root: string, port: number) {
  return {
    sandboxRunnerHost: "127.0.0.1",
    sandboxRunnerPort: port,
    sandboxRoot: join(root, "sandboxes"),
    workspaceRoot: join(root, "workspaces"),
    cliToolsRoot: join(root, "runtime-tools"),
    agentSpaceHome: root,
    internalToken: "runner-test-token",
  };
}
