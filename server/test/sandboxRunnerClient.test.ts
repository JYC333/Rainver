import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxRunnerCliCommandExecutor, SandboxRunnerVerificationExecutor } from "../src/modules/sandboxRunner/client.js";
import { LocalCliProcessRegistry } from "../src/modules/runs/localCliExecution.js";
import { SandboxRunnerPtyFactory } from "../src/modules/sandboxRunner/ptyFactory.js";
import type { ServerConfig } from "../src/config.js";
import type { SandboxRuntimeEnvironment } from "../src/modules/sandboxRunner/protocol.js";

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

  // `sandbox/runner.mjs` runs in a container with no dependencies, so it
  // cannot import `protocol.ts` and maps the request by hand. This pins that
  // mapping to the declaration: `Required<...>` makes every field the type
  // declares appear here, and the whole environment is compared, so a field
  // added to `SandboxRuntimeEnvironment` fails until the runner maps it —
  // the sandbox analogue of the host daemon's `work_surface`, which was
  // dropped exactly this way.
  it("maps every declared environment field the runner is sent", async () => {
    const runner = await import(new URL("../../sandbox/runner.mjs", import.meta.url).href) as {
      environmentMap: (env: SandboxRuntimeEnvironment) => Record<string, string>;
    };
    const environment: {
      [K in keyof Required<SandboxRuntimeEnvironment>]-?: NonNullable<SandboxRuntimeEnvironment[K]> extends object
        ? NonNullable<SandboxRuntimeEnvironment[K]> extends unknown[]
          ? NonNullable<SandboxRuntimeEnvironment[K]>
          : Required<NonNullable<SandboxRuntimeEnvironment[K]>>
        : NonNullable<SandboxRuntimeEnvironment[K]>;
    } = {
      locale: "en_US.UTF-8",
      term: "xterm",
      codex_home: "/home/sandbox/.codex",
      provider_channel: { kind: "managed_proxy" },
      anthropic: {
        base_url: "http://proxy/anthropic",
        auth_token: "lease-token",
        model: "m",
        default_sonnet_model: "s",
        default_opus_model: "o",
        default_haiku_model: "h",
      },
      proxy: { http: "http://p", https: "https://p", all: "socks://p", no_proxy: "localhost" },
      tool_channel: { url: "http://server/api", token: "tool-token", run_id: "run-1", cli_path: "/runner/rainver", skill_path: "/runner/SKILL.md" },
      workspace_access: [{ workspace_location_id: "loc-1", access_mode: "write", target: "/attachments/0" }],
      exchange: true,
    };
    expect(runner.environmentMap(environment)).toEqual({
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      CODEX_HOME: "/home/sandbox/.codex",
      // `provider_channel` selects mounts and egress, never an environment variable.
      ANTHROPIC_BASE_URL: "http://proxy/anthropic",
      ANTHROPIC_AUTH_TOKEN: "lease-token",
      ANTHROPIC_MODEL: "m",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "s",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "o",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "h",
      HTTP_PROXY: "http://p", http_proxy: "http://p",
      HTTPS_PROXY: "https://p", https_proxy: "https://p",
      ALL_PROXY: "socks://p", all_proxy: "socks://p",
      NO_PROXY: "localhost", no_proxy: "localhost",
      RAINVER_API_URL: "http://server/api",
      RAINVER_TOOL_TOKEN: "tool-token",
      RAINVER_RUN_ID: "run-1",
      RAINVER_CLI: "/runner/rainver",
      RAINVER_SKILL_PATH: "/runner/SKILL.md",
      RAINVER_EXCHANGE_INPUT: "/run-exchange/input/run_input.json",
      RAINVER_EXCHANGE_OUTPUT: "/run-exchange/output",
      RAINVER_WORKSPACE_ACCESS: JSON.stringify([{ workspace_location_id: "loc-1", access_mode: "write", path: "/attachments/0" }]),
    });
  });

  it("sends verification through a no-egress workspace-only Runner request", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-verification-"));
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
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-client-"));
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
      env: {
        HOME: home, CODEX_HOME: join(home, ".codex"),
        RAINVER_TOOL_TOKEN: "lease", RAINVER_API_URL: "http://server:8010",
        RAINVER_RUN_ID: "run-1", RAINVER_CLI: "/workspace/.rainver/rainver",
        RAINVER_SKILL_PATH: "/workspace/.rainver/SKILL.md",
      },
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
      environment: {
        codex_home: "/home/sandbox/.codex",
        tool_channel: {
          url: "http://server:8010", token: "lease", run_id: "run-1",
          cli_path: "/workspace/.rainver/rainver",
          skill_path: "/workspace/.rainver/SKILL.md",
        },
      },
    });
    expect(launch).not.toHaveProperty("command");
    expect(launch).not.toHaveProperty("env");
    expect(JSON.stringify(launch)).not.toContain(root);
  });

  it("mounts authorized attached Locations with explicit access modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-attachments-"));
    roots.push(root);
    let launch: Record<string, unknown> | undefined;
    const { server, port } = await runnerServer((frame, send) => {
      if (frame.type !== "launch") return;
      launch = frame.request as Record<string, unknown>;
      send({ type: "ready" });
      send({ type: "exit", returncode: 0, timed_out: false });
    });
    servers.push(server);
    const config = testConfig(root, port);
    const workspace = join(root, "sandboxes", "conversation-1");
    const attachment = join(root, "workspaces", "location-attached");
    const tool = join(root, "runtime-tools", "codex_cli", "versions", "1.2.3", "bin", "codex");
    const result = await new SandboxRunnerCliCommandExecutor(config, "codex_cli").runCommand({
      command: [tool, "exec", "hello"],
      cwd: workspace,
      timeout_seconds: 30,
      env: {},
      run_id: "run-attachments",
      stdin: null,
      workspace_access: [{
        workspace_location_id: "location-attached",
        access_mode: "read",
        path: attachment,
      }],
    });
    expect(result.returncode).toBe(0);
    expect(launch).toMatchObject({
      mounts: expect.arrayContaining([
        { root: "workspaces", id: "location-attached", target: "/attachments/0", access: "read_only" },
      ]),
      environment: {
        workspace_access: [{ workspace_location_id: "location-attached", access_mode: "read", target: "/attachments/0" }],
      },
    });
    expect(JSON.stringify(launch)).not.toContain(root);
  });

  it("terminates verification when combined output exceeds the fixed bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-output-limit-"));
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
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-unavailable-"));
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
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-cancel-"));
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
    // The run registers once the Runner answers `ready`; a terminate sent
    // before that finds nothing to signal and the run would never end.
    await vi.waitUntil(() => registry.terminate("run-1"), { timeout: 5_000 });
    await expect(executing).resolves.toMatchObject({ returncode: 143 });
    expect(terminated).toBe(true);
  });

  it("preserves split UTF-8 protocol data and closes absent stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-utf8-"));
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
    const root = await mkdtemp(join(tmpdir(), "rainver-runner-pty-"));
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
    rainverHome: root,
    internalToken: "runner-test-token",
  };
}
