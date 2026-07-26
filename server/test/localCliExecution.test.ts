import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalCliCommandExecutor,
  LocalCliProcessRegistry,
  ReadOnlyCliCommandExecutor,
  type CliCommandExecutor,
  type CliExecutionResult,
  type CliStdioController,
} from "../src/modules/runs/localCliExecution";

const bubblewrapAvailable = canCreateBubblewrapNamespace();

describe("local CLI execution supervision", () => {
  it("fails a command that produces no output before the overall timeout", async () => {
    const result = await new LocalCliCommandExecutor().runCommand({
      command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      cwd: null,
      timeout_seconds: 10,
      stall_timeout_seconds: 0.05,
      env: cleanEnv(),
      run_id: "stall-test",
      stdin: null,
    });

    expect(result).toMatchObject({
      timed_out: true,
      failure_code: "stall_timeout",
    });
  });

  it("deregisters a process after the watchdog terminates it", async () => {
    const registry = new LocalCliProcessRegistry();
    const result = await new LocalCliCommandExecutor().runCommand({
      command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      cwd: null,
      timeout_seconds: 10,
      stall_timeout_seconds: 0.05,
      env: cleanEnv(),
      run_id: "registry-stall-test",
      stdin: null,
      process_registry: registry,
    });

    expect(result.failure_code).toBe("stall_timeout");
    expect(await registry.waitForExit("registry-stall-test", 1)).toBe(true);
  });

  it("keeps stdin open for an NDJSON controller until the protocol completes", async () => {
    let completed = false;
    const controller: CliStdioController = {
      start(send) {
        send({ id: 1, method: "start" });
      },
      receive(message, _send, closeStdin) {
        if (message.id === 1 && message.result === "done") {
          completed = true;
          closeStdin();
        }
      },
      reject() {},
      result() {
        return { completed, error: null, text: "" };
      },
    };
    const result = await new LocalCliCommandExecutor().runCommand({
      command: [
        "/bin/sh",
        "-c",
        `IFS= read -r line; printf '%s' '{"id":1,"result":"done"}'`,
      ],
      cwd: null,
      timeout_seconds: 5,
      env: cleanEnv(),
      run_id: "ndjson-test",
      stdin: null,
      stdio_controller: controller,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ returncode: 0, timed_out: false });
    expect(completed).toBe(true);
  });

  it("builds a fail-closed read-only namespace with only managed write mounts", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-read-only-"));
    try {
      const workspace = join(root, "workspace");
      const context = join(root, "sandboxes", "context");
      const home = join(root, "aspace", "cache", "home");
      const tools = join(root, "aspace", "runtime-tools");
      const exchange = join(root, "sandboxes", "exchange", "output");
      const exchangeInput = join(root, "sandboxes", "exchange", "input");
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(context, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(tools, { recursive: true }),
        mkdir(exchange, { recursive: true }),
        mkdir(exchangeInput, { recursive: true }),
      ]);
      await writeFile(join(context, "AGENTS.md"), "generated context");
      const executable = join(tools, "codex");
      await writeFile(executable, "runtime");
      const launcher = new RecordingExecutor();
      const result = await new ReadOnlyCliCommandExecutor(
        launcher,
        "/test/bwrap",
      ).runCommand({
        command: [executable, "exec", "hello"],
        cwd: workspace,
        timeout_seconds: 30,
        env: { HOME: home },
        run_id: "read-only-run",
        stdin: null,
        read_only: {
          workspace_cwd: workspace,
          context_cwd: context,
          sandbox_root: join(root, "sandboxes"),
          agent_space_home: join(root, "aspace"),
          cli_tools_root: tools,
          readable_paths: [exchangeInput],
          writable_paths: [home, exchange],
        },
      });

      expect(result.returncode).toBe(0);
      expect(launcher.commands).toHaveLength(2);
      const command = launcher.commands[1]!;
      expect(command).toEqual(expect.arrayContaining([
        "/test/bwrap",
        "--tmpfs", "/",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", tools, tools,
        "--ro-bind", exchangeInput, exchangeInput,
        "--bind", home, home,
        "--bind", exchange, exchange,
        "--ro-bind", join(context, "AGENTS.md"), join(workspace, "AGENTS.md"),
        "--chdir", workspace,
        "--", executable, "exec", "hello",
      ]));
      expect(command.join("\n")).not.toContain(`--bind\n${workspace}\n${workspace}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not launch the vendor command when bubblewrap preflight fails", async () => {
    const launcher = new RecordingExecutor({
      returncode: 1,
      stdout: "",
      stderr: "bwrap: No permissions to create new namespace",
      timed_out: false,
    });
    const result = await new ReadOnlyCliCommandExecutor(launcher).runCommand({
      command: ["/runtime/claude", "--print"],
      cwd: "/workspace",
      timeout_seconds: 30,
      env: {},
      run_id: "read-only-unavailable",
      stdin: null,
      read_only: {
        workspace_cwd: "/workspace",
        context_cwd: "/sandboxes/context",
        sandbox_root: "/sandboxes",
        agent_space_home: "/aspace",
        cli_tools_root: "/aspace/runtime-tools",
        readable_paths: [],
        writable_paths: [],
      },
    });

    expect(result).toMatchObject({
      returncode: -1,
      failure_code: "read_only_sandbox_unavailable",
    });
    expect(launcher.commands).toHaveLength(1);
  });

  it("rejects a context path whose ancestor symlink escapes the sandbox root", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspace-read-only-symlink-"));
    try {
      const sandboxRoot = join(root, "sandboxes");
      const outside = join(root, "outside");
      const workspace = join(root, "workspace");
      const agentHome = join(root, "aspace");
      const tools = join(agentHome, "runtime-tools");
      await Promise.all([
        mkdir(sandboxRoot, { recursive: true }),
        mkdir(outside, { recursive: true }),
        mkdir(workspace, { recursive: true }),
        mkdir(tools, { recursive: true }),
      ]);
      await symlink(outside, join(sandboxRoot, "escaped"));
      const executable = join(tools, "claude");
      await writeFile(executable, "runtime");
      const launcher = new RecordingExecutor();
      const result = await new ReadOnlyCliCommandExecutor(
        launcher,
        "/test/bwrap",
      ).runCommand({
        command: [executable],
        cwd: workspace,
        timeout_seconds: 30,
        env: {},
        run_id: "read-only-symlink",
        stdin: null,
        read_only: {
          workspace_cwd: workspace,
          context_cwd: join(sandboxRoot, "escaped"),
          sandbox_root: sandboxRoot,
          agent_space_home: agentHome,
          cli_tools_root: tools,
          readable_paths: [],
          writable_paths: [],
        },
      });

      expect(result).toMatchObject({
        returncode: -1,
        failure_code: "read_only_sandbox_unavailable",
      });
      expect(launcher.commands).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(bubblewrapAvailable)(
    "hides sibling spaces from direct paths and Project Folder symlinks",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aspace-read-only-boundary-"));
      try {
        const workspace = join(root, "workspaces", "selected-space", "project");
        const sibling = join(root, "workspaces", "other-space");
        const context = join(root, "sandboxes", "context");
        const agentHome = join(root, "aspace");
        const tools = join(agentHome, "runtime-tools");
        const executable = join(tools, "boundary-check");
        await Promise.all([
          mkdir(workspace, { recursive: true }),
          mkdir(sibling, { recursive: true }),
          mkdir(context, { recursive: true }),
          mkdir(tools, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(join(workspace, "source.txt"), "selected"),
          writeFile(join(sibling, "secret.txt"), "other-space-secret"),
          writeFile(join(context, "AGENTS.md"), "generated"),
          writeFile(executable, [
            "#!/bin/sh",
            `test ! -r ${JSON.stringify(join(sibling, "secret.txt"))} || exit 51`,
            "test ! -r sibling-leak/secret.txt || exit 52",
            "test ! -e /etc/debian_version || exit 53",
            "cat source.txt AGENTS.md",
          ].join("\n")),
          symlink("../../other-space", join(workspace, "sibling-leak")),
        ]);
        await chmod(executable, 0o700);

        const result = await new ReadOnlyCliCommandExecutor().runCommand({
          command: [executable],
          cwd: workspace,
          timeout_seconds: 30,
          env: {},
          run_id: "read-only-space-boundary",
          stdin: null,
          read_only: {
            workspace_cwd: workspace,
            context_cwd: context,
            sandbox_root: join(root, "sandboxes"),
            agent_space_home: agentHome,
            cli_tools_root: tools,
            readable_paths: [],
            writable_paths: [],
          },
        });

        expect(result).toMatchObject({
          returncode: 0,
          stdout: "selectedgenerated",
          timed_out: false,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function canCreateBubblewrapNamespace(): boolean {
  const executable = "/usr/bin/bwrap";
  if (!existsSync(executable)) return false;
  try {
    execFileSync(executable, [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--ro-bind", "/", "/",
      "--proc", "/proc",
      "--dev", "/dev",
      "--", "/bin/true",
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

class RecordingExecutor implements CliCommandExecutor {
  readonly commands: string[][] = [];

  constructor(
    private readonly firstResult: CliExecutionResult = {
      returncode: 0,
      stdout: "",
      stderr: "",
      timed_out: false,
    },
  ) {}

  async runCommand(
    input: Parameters<CliCommandExecutor["runCommand"]>[0],
  ): Promise<CliExecutionResult> {
    this.commands.push(input.command);
    return this.commands.length === 1
      ? this.firstResult
      : { returncode: 0, stdout: "", stderr: "", timed_out: false };
  }
}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
