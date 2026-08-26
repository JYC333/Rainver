import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.js";
import { existsSync } from "node:fs";
import {
  handleLaunch,
  handleStdin,
  handleStdinClose,
  handleTerminate,
  REMOTE_CWD_PLACEHOLDER,
  resolveAcpEntrypoint,
  resolveAcpLaunch,
} from "../src/execution.js";

let configDir: string;
let workspaceDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-host-exec-config-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "rainver-host-exec-workspace-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
  // Not a real control plane — uploads are expected to fail and be caught
  // internally; these tests only assert on the WS frames handleLaunch sends.
  await saveConfig({
    server_url: "http://127.0.0.1:1",
    host_id: "host-1",
    token: "secret-token",
    workspaces: { "folder-1": workspaceDir },
  });
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

function collectSend() {
  const frames: Record<string, unknown>[] = [];
  const send = (frame: Record<string, unknown>) => frames.push(frame);
  const complete = () => new Promise<Record<string, unknown>>((resolve) => {
    const check = () => {
      const found = frames.find((f) => f.type === "complete");
      if (found) resolve(found);
      else setTimeout(check, 10);
    };
    check();
  });
  return { frames, send, complete };
}

describe("handleLaunch", () => {
  it("streams stdout as output frames and reports a clean exit", async () => {
    const { frames, send, complete } = collectSend();
    await handleLaunch(
      {
        run_id: "run-1",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "printf 'hello from the run\\n'"],
      },
      send,
      () => {},
    );
    const done = await complete();
    expect(done).toMatchObject({ type: "complete", run_id: "run-1", exit_code: 0, timed_out: false, error: null });
    const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
    expect(output).toContain("hello from the run");
  });

  it("reports a non-zero exit with a stderr tail", async () => {
    const { complete, send } = collectSend();
    await handleLaunch(
      {
        run_id: "run-2",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "printf 'boom\\n' >&2; exit 3"],
      },
      send,
      () => {},
    );
    const done = await complete();
    expect(done.exit_code).toBe(3);
    expect(done.timed_out).toBe(false);
    expect(String(done.error)).toContain("boom");
  });

  it("streams stderr as live stderr frames, not only the complete frame's tail (C5)", async () => {
    const { frames, send, complete } = collectSend();
    await handleLaunch(
      {
        run_id: "run-2b",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "printf 'first line\\n' >&2; printf 'second line\\n' >&2; exit 1"],
      },
      send,
      () => {},
    );
    await complete();
    const stderrChunks = frames.filter((f) => f.type === "stderr");
    expect(stderrChunks.length).toBeGreaterThan(0);
    expect(stderrChunks.every((f) => f.run_id === "run-2b")).toBe(true);
    const joined = stderrChunks.map((f) => f.chunk).join("");
    expect(joined).toContain("first line");
    expect(joined).toContain("second line");
  });

  it("completes immediately with an error for an unregistered workspace, without spawning anything", async () => {
    const { complete, send } = collectSend();
    await handleLaunch(
      { run_id: "run-3", project_folder_id: "unknown-folder", argv: ["node", "-e", "1"] },
      send,
      () => {},
    );
    const done = await complete();
    expect(done).toMatchObject({ type: "complete", run_id: "run-3", exit_code: 1, timed_out: false });
    expect(String(done.error)).toMatch(/no local path registered/);
  });

  it("writes provided stdin to the child process", async () => {
    const { complete, send, frames } = collectSend();
    await handleLaunch(
      {
        run_id: "run-4",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "printf 'echo:%s' \"$(cat)\""],
        stdin: "ping",
      },
      send,
      () => {},
    );
    await complete();
    const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
    expect(output).toContain("echo:ping");
  });

  it("kills the process on timeout and reports timed_out", async () => {
    const { complete, send } = collectSend();
    await handleLaunch(
      {
        run_id: "run-5",
        project_folder_id: "folder-1",
        argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
        timeout_seconds: 0.1,
      },
      send,
      () => {},
    );
    const done = await complete();
    expect(done.timed_out).toBe(true);
  }, 10000);

  it("keeps stdin open across multiple stdin frames when keep_stdin_open is set", async () => {
    const { frames, send, complete } = collectSend();
    await handleLaunch(
      {
        run_id: "run-7",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "cat"],
        keep_stdin_open: true,
      },
      send,
      () => {},
    );
    handleStdin({ run_id: "run-7", value: "first " });
    handleStdin({ run_id: "run-7", value: "second" });
    handleStdinClose({ run_id: "run-7" });
    const done = await complete();
    expect(done).toMatchObject({ type: "complete", run_id: "run-7", exit_code: 0 });
    const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
    expect(output).toBe("first second");
  });

  it("substitutes the ACP remote-cwd placeholder with the run's real workspace path on both launch and stdin frames", async () => {
    const { frames, send, complete } = collectSend();
    const line = `{"cwd":"${REMOTE_CWD_PLACEHOLDER}"}\n`;
    await handleLaunch(
      {
        run_id: "run-8",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "cat"],
        keep_stdin_open: true,
        stdin: line,
      },
      send,
      () => {},
    );
    handleStdin({ run_id: "run-8", value: line });
    handleStdinClose({ run_id: "run-8" });
    await complete();
    const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
    const expectedLine = `{"cwd":"${workspaceDir}"}\n`;
    expect(output).toBe(expectedLine + expectedLine);
  });

  it("substitutes the ACP remote-cwd placeholder in argv tokens before spawning", async () => {
    const { frames, send, complete } = collectSend();
    await handleLaunch(
      {
        run_id: "run-9",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", `printf '%s' "${REMOTE_CWD_PLACEHOLDER}"`],
      },
      send,
      () => {},
    );
    const done = await complete();
    expect(done).toMatchObject({ type: "complete", run_id: "run-9", exit_code: 0 });
    const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
    expect(output).toBe(workspaceDir);
  });

  it("ignores a stdin frame for a run that is not active", () => {
    expect(() => handleStdin({ run_id: "no-such-run", value: "ignored" })).not.toThrow();
  });

  it("ignores a stdin_close frame for a run that is not active", () => {
    expect(() => handleStdinClose({ run_id: "no-such-run" })).not.toThrow();
  });

  it("terminates a running process on request", async () => {
    const { complete, send } = collectSend();
    const launched = handleLaunch(
      {
        run_id: "run-6",
        project_folder_id: "folder-1",
        argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
      },
      send,
      () => {},
    );
    await launched;
    handleTerminate({ run_id: "run-6", force: true });
    const done = await complete();
    expect(done.exit_code).not.toBe(0);
  }, 10000);

  it("resolves codex_cli's ACP adapter to this daemon's own installed, on-disk entrypoint (ACP runtime replatform P3)", () => {
    const entrypoint = resolveAcpEntrypoint("codex-acp");
    expect(entrypoint).not.toBeNull();
    expect(existsSync(entrypoint!)).toBe(true);
  });

  it("resolves Claude's bundled ACP adapter to this daemon's own entrypoint (ACP runtime replatform P4)", () => {
    const entrypoint = resolveAcpEntrypoint("claude-agent-acp");
    expect(entrypoint).not.toBeNull();
    expect(existsSync(entrypoint!)).toBe(true);
  });

  it("resolves an ACP launch the same way for a job and for the options probe: vendor CLI as named, bundled adapter through node", () => {
    // A vendor CLI that speaks ACP itself (opencode) is spawned as the spec
    // renders it — nothing in this daemon needs to know it exists.
    expect(resolveAcpLaunch("opencode", ["acp", "--cwd", "/w"])).toEqual({
      command: "opencode",
      args: ["acp", "--cwd", "/w"],
      env: {},
    });
    const codex = resolveAcpLaunch("codex-acp", []);
    expect(codex.command).toBe(process.execPath);
    expect(codex.args).toEqual([resolveAcpEntrypoint("codex-acp")]);
    expect(codex.env).toEqual({ CODEX_PATH: "codex", NO_BROWSER: "1" });
    const claude = resolveAcpLaunch("claude-agent-acp", []);
    expect(claude.args).toEqual([resolveAcpEntrypoint("claude-agent-acp")]);
    expect(claude.env).toEqual({});
  });

  it("spawns codex_cli's pinned codex-acp dependency through node rather than a PATH lookup, without setting CODEX_PATH for other adapters", async () => {
    const { frames, send } = collectSend();
    const launched = handleLaunch(
      {
        run_id: "run-7",
        project_folder_id: "folder-1",
        argv: ["codex-acp"],
      },
      send,
      () => {},
    );
    await launched;
    // A bare "codex-acp" is not on PATH anywhere — reaching "launched" (not
    // an immediate "complete" with an error) proves the daemon resolved and
    // spawned its own bundled adapter through `node`, not a PATH lookup of
    // the literal command name.
    expect(frames.some((f) => f.type === "launched")).toBe(true);
    expect(frames.some((f) => f.type === "complete")).toBe(false);
    handleTerminate({ run_id: "run-7", force: true });

    const other = collectSend();
    await handleLaunch(
      {
        run_id: "run-8",
        project_folder_id: "folder-1",
        argv: ["sh", "-c", "printf '%s' \"${CODEX_PATH-unset}\""],
      },
      other.send,
      () => {},
    );
    await other.complete();
    const output = other.frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
    expect(output).toBe("unset");
  }, 10000);
});

describe("handleLaunch with a provider binding", () => {
  // The end of the path that shipped inert once: the frame arrives, and the
  // child either runs against the backend the control plane chose or against
  // this machine's own login. Only the spawned environment can tell them apart.
  it("runs the child against the injected backend and none of this machine's", async () => {
    const { frames, send, complete } = collectSend();
    process.env.ANTHROPIC_API_KEY = "sk-this-machine";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "machine-oauth";
    try {
      await handleLaunch(
        {
          run_id: "run-bound",
          project_folder_id: "folder-1",
          argv: ["sh", "-c", "printf '%s|%s|%s|%s\n' \"$ANTHROPIC_BASE_URL\" \"$ANTHROPIC_AUTH_TOKEN\" \"${ANTHROPIC_API_KEY:-none}\" \"${CLAUDE_CODE_OAUTH_TOKEN:-none}\"; cat \"$CODEX_HOME/config.toml\""],
          provider_binding: {
            profile_key: "codex_cli/provider-1",
            env: { ANTHROPIC_BASE_URL: "http://control-plane:8021/anthropic/l1", ANTHROPIC_AUTH_TOKEN: "lease-token" },
            profile_env: { HOME: ".", CODEX_HOME: ".codex" },
            files: [{ relative_path: ".codex/config.toml", contents: "catalog = \"{{RAINVER_RUN_PROFILE}}/x.json\"" }],
          },
        },
        send,
        () => {},
      );
      await complete();
      const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
      expect(output).toContain("http://control-plane:8021/anthropic/l1|lease-token|none|none");
      // The placeholder is resolved against the real profile directory, which
      // is keyed by adapter and provider rather than by this run.
      expect(output).toMatch(/catalog = ".*\/profiles\/codex_cli\/provider-1\/x\.json"/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("leaves the machine's own environment alone for an unbound run", async () => {
    const { frames, send, complete } = collectSend();
    process.env.ANTHROPIC_API_KEY = "sk-this-machine";
    try {
      await handleLaunch(
        {
          run_id: "run-unbound",
          project_folder_id: "folder-1",
          argv: ["sh", "-c", "printf '%s\n' \"${ANTHROPIC_API_KEY:-none}\""],
        },
        send,
        () => {},
      );
      await complete();
      const output = frames.filter((f) => f.type === "output").map((f) => f.chunk).join("");
      expect(output).toContain("sk-this-machine");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("fails the run rather than building a path out of a traversing profile key", async () => {
    // The key becomes a directory on a machine the daemon runs unsandboxed on.
    for (const profile_key of ["../../etc", "claude_code/../../etc", "one-segment", ".hidden/x", "a/b/c"]) {
      const { frames, send, complete } = collectSend();
      await handleLaunch(
        {
          run_id: `run-${profile_key.replace(/[^a-z]/gi, "")}`,
          project_folder_id: "folder-1",
          argv: ["sh", "-c", "echo should-not-run"],
          provider_binding: { profile_key, env: {}, profile_env: { HOME: "." }, files: [] },
        },
        send,
        () => {},
      );
      await complete();
      const completion = frames.find((f) => f.type === "complete");
      expect(completion?.exit_code, profile_key).toBe(1);
      expect(String(completion?.error), profile_key).toContain("profile key");
      expect(frames.some((f) => f.type === "output"), profile_key).toBe(false);
    }
  });
});
