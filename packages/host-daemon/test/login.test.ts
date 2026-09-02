import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLoginSession, resolveLoginCommand } from "../src/login.js";
import { toolsDir } from "../src/tools.js";

let configDir: string;
const LOGIN = { command: ["goose", "login"], home_subdir: ".goose", credential_file: "auth.json" };

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-host-login-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
});
afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

const hasScript = platform() !== "win32" && spawnSync("script", ["--version"], { encoding: "utf8" }).status !== null;

describe("login sessions", () => {
  it("logs the machine's own copy in as the machine, and a managed copy inside its own HOME", async () => {
    const own = resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "own", login: LOGIN });
    expect(own.command).toEqual(["goose", "login"]);
    expect(own.env.HOME).toBe(process.env.HOME);

    const dir = join(toolsDir(), "acp_goose", "1.2.3");
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "acp_goose", version: "1.2.3", command: "/opt/goose", args: [], env: { GOOSE_X: "1" }, home: join(dir, "home"),
      login_command: ["/opt/goose", "login"], login: LOGIN, installed_at: "",
    }));
    const managed = resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:1.2.3", login: null });
    expect(managed.command).toEqual(["/opt/goose", "login"]);
    expect(managed.env).toMatchObject({ HOME: join(dir, "home"), GOOSE_X: "1" });
    expect(managed.login).toEqual(LOGIN);

    // No login command declared: a shell in that copy's environment, so the
    // person can run whatever the agent's own instructions say.
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      adapter_type: "acp_goose", version: "1.2.3", command: "/opt/goose", args: [], env: {}, home: join(dir, "home"),
      login_command: null, login: null, installed_at: "",
    }));
    expect(resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:1.2.3", login: null }).command).toEqual([process.env.SHELL || "/bin/sh"]);
    expect(() => resolveLoginCommand({ session_id: "s", adapter_type: "acp_goose", installation: "managed:9", login: null })).toThrow(/not have/);
  });


  it.skipIf(!hasScript)("runs the login on a PTY, relays typed input, and reports the login state on exit", async () => {
    const frames: Record<string, unknown>[] = [];
    const home = join(configDir, "home");
    await mkdir(home, { recursive: true });
    // A fake vendor login: reads a code, then writes its credential file.
    const login = { command: ["sh", "-c", `printf 'code? '; read -r code; mkdir -p "$HOME/.fake" && echo "$code" > "$HOME/.fake/auth.json"; echo done:$code`], home_subdir: ".fake", credential_file: "auth.json" };
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const session = openLoginSession({ session_id: "s1", adapter_type: "fake", installation: "own", login }, (frame) => frames.push(frame), () => {});
      await waitFor(() => frames.some((frame) => frame.type === "login_output" && String(frame.data).includes("code?")));
      session.write("abc\n");
      await waitFor(() => frames.some((frame) => frame.type === "login_exit"));
    } finally {
      process.env.HOME = saved;
    }
    const output = frames.filter((frame) => frame.type === "login_output").map((frame) => frame.data).join("");
    expect(output).toContain("done:abc");
    expect(frames.find((frame) => frame.type === "login_exit")).toMatchObject({ session_id: "s1", exit_code: 0, logged_in: true });
  }, 20_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
