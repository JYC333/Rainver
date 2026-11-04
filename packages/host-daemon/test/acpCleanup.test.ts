import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeAcpIdentity, probeAcpOptions } from "../src/acpProbe.js";
import { resolvePackagedAdapter } from "../src/adapterInstallation.js";
import { killProcessGroup } from "../src/processGroup.js";
import { helperProcessEnv } from "../src/providerBinding.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rainver-acp-cleanup-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Simulate native credential persistence on EOF, without credentials or network. */
const delayedFlush = `
  process.on("SIGTERM", () => {
    require("node:fs").writeFileSync("interrupted", "SIGTERM");
    process.exit(1);
  });
  rl.on("close", () => setTimeout(() => {
    require("node:fs").writeFileSync("flushed", String(process.pid));
  }, 200));
`;

describe("ACP probe cleanup", () => {
  it.each(["identity", "options"])("waits for %s probe EOF cleanup before releasing its result", async (kind) => {
    const script = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      ${delayedFlush}
      rl.on("line", line => {
        const msg = JSON.parse(line);
        const result = msg.method === "initialize"
          ? { protocolVersion: 1, agentInfo: { name: "fixture", version: "1" } }
          : { sessionId: "fixture", configOptions: [] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
      });
    `;
    const probe = kind === "identity" ? probeAcpIdentity : probeAcpOptions;
    expect(await probe(process.execPath, ["-e", script], {}, dir, 2_000)).not.toBeNull();
    expect(existsSync(join(dir, "flushed"))).toBe(true);
    expect(existsSync(join(dir, "interrupted"))).toBe(false);
    expect(() => process.kill(Number(readFileSync(join(dir, "flushed"), "utf8")), 0)).toThrow();
  });

  it("also waits for EOF cleanup when session setup times out", async () => {
    const script = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      ${delayedFlush}
      rl.on("line", line => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: msg.id, result: { authMethods: [{ id: "browser", name: "Browser" }] }
        }) + "\\n");
      });
    `;
    const reasons: string[] = [];
    const result = await probeAcpOptions(process.execPath, ["-e", script], {}, dir, 1_000, r => reasons.push(r));
    expect(result?.session_available).toBeNull();
    expect(reasons.join(" ")).toContain("no answer within 1s");
    expect(existsSync(join(dir, "flushed"))).toBe(true);
    expect(existsSync(join(dir, "interrupted"))).toBe(false);
  });

  it.runIf(process.platform === "linux")("bounds a wedged probe and kills its descendants", async () => {
    const script = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.pause();
      setInterval(() => {}, 1000);
      const child = require("node:child_process").spawn(process.execPath, ["-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready\\\\n");'
      ], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.once("data", () => {
        require("node:fs").writeFileSync("descendant", String(child.pid));
        rl.on("line", line => {
          const msg = JSON.parse(line);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
            protocolVersion: 1, agentInfo: { name: "wedged", version: "1" }
          } }) + "\\n");
        });
        rl.resume();
      });
    `;
    expect(await probeAcpIdentity(process.execPath, ["-e", script], {}, dir, 2_000)).toEqual({ version: "1" });
    const pid = Number(await readFile(join(dir, "descendant"), "utf8"));
    // SIGKILL delivery and the kernel's exit bookkeeping are asynchronous.
    await expect.poll(() => {
      const stat = `/proc/${pid}/stat`;
      try { return readFileSync(stat, "utf8").split(") ")[1]?.startsWith("Z"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    }).toBe(true);
  }, 20_000);
});

describe("packaged Claude ACP shutdown", () => {
  it.each(["EOF", "SIGTERM"])("lets the native CLI finish persistence on %s", async (shutdown) => {
    const executable = join(dir, "fake-claude.cjs");
    await writeFile(executable, `#!${process.execPath}
      const rl = require("node:readline").createInterface({ input: process.stdin });
      ${delayedFlush}
      rl.on("line", line => {
        const msg = JSON.parse(line);
        if (msg.type !== "control_request") return;
        process.stdout.write(JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: msg.request_id, response: {
            commands: [], agents: [], account: {},
            models: [{ value: "default", displayName: "Fixture", description: "Offline fixture" }]
          }
        } }) + "\\n");
      });
    `);
    await chmod(executable, 0o755);
    const entry = resolvePackagedAdapter("claude-agent-acp", {});
    expect(entry).not.toBeNull();
    const child = spawn(process.execPath, [entry!], {
      cwd: dir, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...helperProcessEnv(process.env), HOME: dir, USERPROFILE: dir,
        CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_CONFIG_DIR: dir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
      },
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
    const deadline = setTimeout(() => killProcessGroup(child, "SIGKILL"), 10_000);
    child.once("close", () => {
      for (const request of pending.values()) request.reject(new Error(`Adapter exited before answering: ${stderr}`));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      const msg = JSON.parse(line);
      const request = pending.get(msg.id);
      if (!request) return;
      pending.delete(msg.id);
      if (msg.error) request.reject(new Error(JSON.stringify(msg.error)));
      else request.resolve(msg.result);
    });
    let id = 0;
    function request(method: string, params: object): Promise<any> {
      return new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    try {
      await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = await request("session/new", { cwd: dir, mcpServers: [] });
      expect(session.sessionId).toEqual(expect.any(String));
      if (shutdown === "EOF") child.stdin.end();
      else child.kill("SIGTERM");
      expect(await closed, stderr).toBe(0);
      expect(existsSync(join(dir, "flushed")), stderr).toBe(true);
      expect(existsSync(join(dir, "interrupted")), stderr).toBe(false);
    } finally {
      clearTimeout(deadline);
      killProcessGroup(child, "SIGKILL");
      await closed;
      lines.close();
    }
  }, 15_000);
});
