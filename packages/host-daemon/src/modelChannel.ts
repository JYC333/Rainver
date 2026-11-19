import { mkdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { HostLaunchModelChannel } from "@rainver/protocol";

/**
 * The model channel of an egress-`none` strict Run (ADR 0030 §4a).
 *
 * The Run's network namespace is unshared, so it reaches nothing — not the
 * Host, not loopback outside it, not DNS. This keeps exactly one path open:
 * its own provider-proxy lease. Two halves:
 *
 * - **Outside** (here, in the daemon): an HTTP relay on a Unix socket that
 *   forwards only origin-form POST requests under `/<route>/<lease_id>` to the
 *   provider proxy the control plane named. No CONNECT, no upgrade, no
 *   absolute-form or authority-form target, no other path, no destination of
 *   the client's choosing. It is not a proxy a Run can point elsewhere; the
 *   lease token still authenticates each request at the proxy, which holds the
 *   upstream key (ADR 0008), admits only the `model_only` lease's inference
 *   requests (`server/src/modules/providers/proxy/modelOnlyPolicy.ts`) and
 *   stops answering once the Run's lease is revoked.
 * - **Inside** the namespace: `MODEL_CHANNEL_FORWARDER_SOURCE`, a byte pipe
 *   from `127.0.0.1:<loopback_port>` to that socket, started by the namespace
 *   wrapper before the runtime (`strictNamespace.ts`). The provider binding's
 *   URL already names that loopback address.
 *
 * The socket's directory is bound read-only into the namespace, so the Run can
 * connect to it but cannot replace it.
 */
export interface ModelChannelHandle {
  /** Directory holding the socket; bind it read-only into the namespace. */
  readonly directory: string;
  readonly socketPath: string;
  readonly loopbackPort: number;
  /** Requests forwarded and refused so far. Content-free. */
  stats(): { forwarded: number; refused: number };
  close(): Promise<void>;
}

/** Linux `sun_path` is 108 bytes including the terminator. */
const MAX_SOCKET_PATH = 107;

/**
 * RFC 9110 hop-by-hop fields and the proxy fields a relay must not pass on.
 * `host` is rewritten to the upstream's own.
 */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const named = String(headers.connection ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.includes(lower)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Whether a request target stays inside this Run's lease. Only origin-form
 * (`/path?query`); the path must already be in normal form, so no dot
 * segment, backslash or encoded separator can walk out of the lease prefix
 * after the proxy decodes it.
 */
export function modelChannelTargetAllowed(target: string | undefined, channel: Pick<HostLaunchModelChannel, "route" | "lease_id">): boolean {
  if (!target || !target.startsWith("/") || target.startsWith("//")) return false;
  if (/[\\\s]/.test(target) || /%(2e|2f|5c|00)/i.test(target)) return false;
  const path = target.split(/[?#]/, 1)[0]!;
  let parsed: URL;
  try {
    parsed = new URL(target, "http://model-channel.invalid");
  } catch {
    return false;
  }
  if (parsed.origin !== "http://model-channel.invalid" || parsed.pathname !== path) return false;
  const prefix = `/${channel.route}/${channel.lease_id}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export async function startModelChannel(
  runDirectory: string,
  channel: HostLaunchModelChannel,
  log: (line: string) => void = () => {},
): Promise<ModelChannelHandle> {
  const upstream = new URL(channel.upstream_base_url);
  if ((upstream.protocol !== "http:" && upstream.protocol !== "https:") || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("Model channel upstream must be a plain http(s) base URL");
  }
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const directory = join(runDirectory, ".model-channel");
  const socketPath = join(directory, "model.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new Error("Model channel socket path is too long for this Host");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let forwarded = 0;
  let refused = 0;
  const sockets = new Set<Socket>();
  const refuse = (reason: string): void => {
    refused += 1;
    log(`model channel refused a request: ${reason}`);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Every model request a bound CLI makes is a POST. What else the request
    // may carry (endpoint, body, tools, model) is the lease's own capability,
    // judged by the provider proxy on every request on that lease.
    if (req.method !== "POST") {
      refuse(`method ${req.method ?? "?"}`);
      res.writeHead(405, { "content-type": "text/plain", connection: "close" }).end("This Run's model channel carries model requests only.\n");
      return;
    }
    if (!modelChannelTargetAllowed(req.url, channel)) {
      refuse("target outside this Run's model lease");
      res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("This Run's network reaches only its own model service.\n");
      return;
    }
    forwarded += 1;
    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const outbound = send({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: `${basePath}${req.url}`,
      headers: { ...forwardHeaders(req.headers), host: upstream.host },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers));
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    outbound.on("error", (error) => {
      log(`model channel upstream failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("Model service unavailable.\n");
      else res.destroy();
    });
    req.on("aborted", () => outbound.destroy());
    res.on("close", () => { if (!res.writableFinished) outbound.destroy(); });
    req.pipe(outbound);
  });
  // A tunnel or protocol switch would turn the relay into a pipe to wherever
  // the client asks. Neither is served.
  server.on("connect", (_req: IncomingMessage, socket: Socket) => {
    refuse("CONNECT");
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
    refuse("upgrade");
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });

  let closed: Promise<void> | null = null;
  return {
    directory,
    socketPath,
    loopbackPort: channel.loopback_port,
    stats: () => ({ forwarded, refused }),
    close() {
      closed ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
        await rm(directory, { recursive: true, force: true });
      })();
      return closed;
    },
  };
}

/**
 * Runs inside the namespace as `node -e <source> <socket> <port> <ready-file>`:
 * listens on the namespace's own loopback and pipes each connection to the
 * relay socket. CommonJS and dependency-free, because only the Node binary is
 * guaranteed to be visible there. Writes nothing to stdout, which belongs to
 * the runtime's protocol stream.
 */
export const MODEL_CHANNEL_FORWARDER_SOURCE = [
  "const net=require('node:net'),fs=require('node:fs');",
  "const [sock,port,ready]=process.argv.slice(1);",
  "const server=net.createServer(client=>{",
  "const relay=net.connect(sock);const end=()=>{client.destroy();relay.destroy();};",
  "client.on('error',end);relay.on('error',end);client.on('close',end);relay.on('close',end);",
  "client.pipe(relay);relay.pipe(client);});",
  "server.on('error',e=>{process.stderr.write('model channel forwarder: '+e.message+'\\n');process.exit(1);});",
  "server.listen(Number(port),'127.0.0.1',()=>fs.writeFileSync(ready,''));",
].join("");
