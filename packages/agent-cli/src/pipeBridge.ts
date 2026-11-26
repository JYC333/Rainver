import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolRequest, toolRequestTimeoutMs, TOOL_REQUEST_LIMIT, TOOL_RESPONSE_LIMIT, type ToolRequest, type ToolResponse } from "./toolRequest.ts";

const ENDPOINT = /^pipe:([0-9a-f-]{36}):([A-Za-z0-9_-]{43})$/;
const RESPONSE_LIMIT = TOOL_RESPONSE_LIMIT * 6 + 1024;
const pipePath = (id: string) => process.platform === "win32" ? `\\\\.\\pipe\\rainver-run-${id}` : join(tmpdir(), `rainver-tool-${id}.sock`);

async function readJson(socket: Socket, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new Error("Rainver local tool message is too large");
    const end = buffer.indexOf(10);
    if (end !== -1) {
      chunks.push(buffer.subarray(0, end));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    chunks.push(buffer);
  }
  throw new Error("Rainver local tool bridge closed before responding");
}

/**
 * Native Windows has no pinned directory bridge. Use a per-launch named pipe
 * and a separate local capability since pipe names can be enumerated.
 */
export async function startPipeToolBridge(
  invoke: (request: ToolRequest, signal: AbortSignal) => Promise<ToolResponse>,
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const id = randomUUID();
  const key = randomBytes(32).toString("base64url");
  const capability = Buffer.from(key);
  const active = new Set<Socket>();
  const abort = new AbortController();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.setTimeout(75_000, () => socket.destroy());
    if (abort.signal.aborted || active.size >= 8) { socket.destroy(); return; }
    active.add(socket);
    const disconnected = new AbortController();
    socket.once("close", () => { active.delete(socket); disconnected.abort(); });
    void (async () => {
      const message = await readJson(socket, TOOL_REQUEST_LIMIT + 1024) as { key?: unknown; request?: unknown } | null;
      const supplied = typeof message?.key === "string" ? Buffer.from(message.key) : Buffer.alloc(0);
      if (supplied.byteLength !== capability.byteLength || !timingSafeEqual(supplied, capability)) {
        socket.destroy();
        return;
      }
      const request = parseToolRequest(message?.request);
      const result = await invoke(request, AbortSignal.any([abort.signal, disconnected.signal]));
      const payload = JSON.stringify({ status: result.status, text: result.text });
      if (Buffer.byteLength(payload) > RESPONSE_LIMIT) throw new Error("Rainver local tool response is too large");
      if (!socket.destroyed) socket.end(payload + "\n", () => result.acknowledge?.());
    })().catch((error) => {
      if (!socket.destroyed) socket.end(JSON.stringify({ error: error instanceof Error ? error.message : "Local tool bridge failed" }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath(id), () => { server.off("error", reject); resolve(); });
  });
  server.on("error", () => abort.abort());
  return {
    endpoint: `pipe:${id}:${key}`,
    async close() {
      abort.abort();
      for (const socket of active) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function pipeToolRequest(endpoint: string, input: ToolRequest, timeoutMs?: number): Promise<ToolResponse> {
  const matched = ENDPOINT.exec(endpoint);
  if (!matched) throw new Error("Invalid Rainver local tool bridge");
  const request = parseToolRequest(input);
  const payload = JSON.stringify({ key: matched[2], request });
  if (Buffer.byteLength(JSON.stringify(request)) > TOOL_REQUEST_LIMIT) throw new Error("Rainver tool request is too large");
  const socket = createConnection(pipePath(matched[1]!));
  socket.setTimeout(timeoutMs ?? toolRequestTimeoutMs(request) + 5_000, () => {
    socket.destroy(new Error("Rainver tool response timed out; the action outcome is unknown. Do not blindly repeat a write."));
  });
  try {
    const result = readJson(socket, RESPONSE_LIMIT);
    socket.write(payload + "\n");
    const response = await result as Partial<ToolResponse> & { error?: string };
    if (typeof response?.error === "string") throw new Error(response.error);
    if (!Number.isInteger(response?.status) || typeof response.text !== "string") throw new Error("Invalid Rainver bridge response");
    return response as ToolResponse;
  } finally {
    socket.destroy();
  }
}
