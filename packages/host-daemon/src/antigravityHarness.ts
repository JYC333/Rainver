import { spawn } from "node:child_process";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** Only the harness initialization config is adapted. Workspace and permissions stay opaque. */
export function configureAntigravitySkills(value: string, destination: string, skillRoot?: string): string {
  const event = JSON.parse(value);
  if (!event.config || typeof event.config !== "object") throw new Error("Expected Antigravity harness initialization");
  const config = event.config;
  config.skillsConfig = { ...config.skillsConfig, materializedSkillsDir: destination };
  if (skillRoot) config.skillsPaths = [...new Set([...(config.skillsPaths ?? []), skillRoot])];
  return JSON.stringify(event);
}

/** ACP has no output-directory option; use its supported harness executable override. */
export async function prepareAntigravityHarness(command: string, runDirectory: string): Promise<Record<string, string>> {
  const executable = await realpath(command);
  const binary = join(dirname(executable), process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
  if (process.platform === "win32") throw new Error("Antigravity managed skill isolation requires a POSIX Host");
  const { access } = await import("node:fs/promises");
  await access(binary);
  const script = join(runDirectory, "antigravity-harness");
  const cli = fileURLToPath(new URL("cli.js", import.meta.url));
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(script, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} __antigravity-harness ${quote(binary)}\n`, { mode: 0o700 });
  return { ANTIGRAVITY_HARNESS_PATH: script };
}

// The vendor's stdout handshake is a length-prefixed OutputConfig (port + local API key).
function handshake(raw: Buffer): { port: number; key: string; portEnd: number } {
  if (raw[0] !== 8) throw new Error("Unsupported Antigravity harness handshake");
  let port = 0, i = 1, shift = 0;
  for (; i < raw.length && shift <= 28; shift += 7) {
    const b = raw[i++]!; port += (b & 127) * 2 ** shift;
    if (!(b & 128)) break;
  }
  const portEnd = i;
  if (port < 1 || port > 65535 || raw[i++] !== 18) throw new Error("Invalid harness port/key");
  let length = 0; shift = 0;
  for (; i < raw.length && shift <= 28; shift += 7) {
    const b = raw[i++]!; length += (b & 127) * 2 ** shift;
    if (!(b & 128)) break;
  }
  if (!length || length > 4096 || i + length > raw.length) throw new Error("Invalid harness key");
  return { port, key: raw.subarray(i, i + length).toString(), portEnd };
}

function varint(n: number): Buffer {
  const bytes: number[] = [];
  do { const b = n & 127; n >>>= 7; bytes.push(n ? b | 128 : b); } while (n);
  return Buffer.from(bytes);
}

export async function runAntigravityHarness(binary: string): Promise<void> {
  const home = process.env.GEMINI_HOME;
  if (!home || !isAbsolute(home)) throw new Error("Antigravity requires its managed absolute GEMINI_HOME");
  const destination = join(home, "antigravity-acp", "materialized");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  delete env.ANTIGRAVITY_HARNESS_PATH;
  const child = spawn(binary, [], { env, stdio: ["pipe", "pipe", "inherit"] });
  let server: WebSocketServer | undefined;
  const connections = new Set<WebSocket>();
  const stop = () => {
    for (const ws of connections) ws.terminate();
    server?.close();
    child.kill("SIGTERM");
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  child.once("error", () => { stop(); process.exitCode = 1; });
  child.once("exit", code => { stop(); process.exitCode = code ?? 1; });
  child.stdin.on("error", stop);
  process.stdin.pipe(child.stdin);
  let buffer = Buffer.alloc(0), started = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (started) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32LE();
    if (length > 65536) { stop(); process.exitCode = 1; return; }
    if (buffer.length < length + 4) return;
    started = true;
    void (async () => {
      const raw = buffer.subarray(4, 4 + length);
      const { port, key, portEnd } = handshake(raw);
      server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 64 * 1024 * 1024,
        verifyClient: ({ req }: { req: IncomingMessage }) => {
          const header = req.headers["x-goog-api-key"];
          return typeof header === "string" && Buffer.byteLength(header) === Buffer.byteLength(key)
            && timingSafeEqual(Buffer.from(header), Buffer.from(key));
        } });
      server.on("error", stop);
      server.on("connection", local => {
        const remote = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { "x-goog-api-key": key }, maxPayload: 64 * 1024 * 1024 });
        connections.add(local); connections.add(remote);
        let first = true;
        const pending: Array<{ data: Buffer; binary: boolean }> = [];
        local.on("message", (data, binary) => {
          try {
            const payload = first ? Buffer.from(configureAntigravitySkills(data.toString(), destination, process.env.RAINVER_SKILL_ROOT)) : Buffer.from(data as Buffer);
            first = false;
            if (remote.readyState === WebSocket.OPEN) remote.send(payload, { binary });
            else { if (pending.length >= 16) throw new Error("Harness initialization queue exceeded"); pending.push({ data: payload, binary }); }
          } catch { local.close(1008, "Invalid harness initialization"); remote.terminate(); }
        });
        remote.on("open", () => { for (const item of pending) remote.send(item.data, { binary: item.binary }); pending.length = 0; });
        remote.on("message", (data, binary) => { if (local.readyState === WebSocket.OPEN) local.send(data, { binary }); });
        local.on("close", () => { connections.delete(local); remote.terminate(); });
        remote.on("close", () => { connections.delete(remote); local.close(); });
        local.on("error", () => remote.terminate()); remote.on("error", () => local.close());
      });
      await new Promise<void>(resolve => server!.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing proxy address");
      const output = Buffer.concat([Buffer.from([8]), varint(address.port), raw.subarray(portEnd)]);
      const prefix = Buffer.alloc(4); prefix.writeUInt32LE(output.length);
      process.stdout.write(Buffer.concat([prefix, output]));
    })().catch(() => { stop(); process.exitCode = 1; });
  });
}
