import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { OutboundGuardError } from "./errors.js";
import { type OutboundGuard } from "./guard.js";

/**
 * A loopback HTTP CONNECT proxy that applies the outbound guard to every
 * tunnel it opens.
 *
 * For a client this process cannot pin itself — git, whose transport is
 * libcurl's — pointing it here is how the guard still decides every
 * connection: the client asks for `host:port`, this resolves the name through
 * the guard, refuses anything the block list covers, and dials only the pinned
 * address. A redirect the client follows is a new CONNECT and is judged again,
 * so a public name that redirects into the instance's own network is refused
 * at the hop that tries it rather than trusted on the strength of the first.
 *
 * CONNECT only: the tunnel carries TLS end to end, so this never holds a
 * request, a header, or a credential. A plain proxied request is refused.
 * The proxy listens on loopback and a per-proxy token tells its one client
 * apart from any other local process.
 */
export interface GuardedConnectProxy {
  /** `http://token:<secret>@127.0.0.1:<port>`, what the client's proxy setting is set to. */
  readonly url: string;
  /** Destinations that were refused, oldest first, for the caller's own error text. */
  readonly refusals: ReadonlyArray<{ host: string; port: number; reason: string }>;
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_HEADER_BYTES = 16_384;

export async function startGuardedConnectProxy(guard: OutboundGuard): Promise<GuardedConnectProxy> {
  const secret = randomBytes(24).toString("hex");
  const expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`token:${secret}`).toString("base64")}`);
  const refusals: Array<{ host: string; port: number; reason: string }> = [];
  const clients = new Set<Socket>();

  const server: Server = createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEADER_BYTES) {
          client.removeListener("data", onData);
          refuse(client, 431, "Request header is too large.");
        }
        return;
      }
      client.removeListener("data", onData);
      client.pause();
      void handle(client, head.subarray(0, end + 4).toString("latin1"), head.subarray(end + 4));
    };
    client.on("data", onData);
  });

  async function handle(client: Socket, header: string, pipelined: Buffer): Promise<void> {
    const [requestLine, ...headerLines] = header.split("\r\n");
    const [method, target] = (requestLine ?? "").split(" ");
    if (method !== "CONNECT" || !target) return refuse(client, 405, "This proxy accepts CONNECT only.");
    const authorization = headerLines
      .map((line) => /^proxy-authorization:\s*(.+?)\s*$/i.exec(line)?.[1])
      .find((value): value is string => typeof value === "string");
    if (!authorization || !constantTimeEquals(Buffer.from(authorization), expectedAuthorization)) {
      return refuse(client, 407, "This client is not authorized to use the proxy.");
    }
    const separator = target.lastIndexOf(":");
    const rawHost = separator > 0 ? target.slice(0, separator) : target;
    const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    const port = separator > 0 ? Number(target.slice(separator + 1)) : 443;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return refuse(client, 400, `${target} is not a host and port this proxy can dial.`);
    }
    let address: string;
    try {
      const pinned = await guard.pin(new URL(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`));
      address = pinned[0]!.address;
    } catch (error) {
      const reason = error instanceof OutboundGuardError ? error.message : "The destination could not be resolved.";
      refusals.push({ host, port, reason });
      return refuse(client, 403, reason);
    }
    let established = false;
    const upstream = connect({ host: address, port }, () => {
      if (client.destroyed) { upstream.destroy(); return; }
      established = true;
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (pipelined.length > 0) upstream.write(pipelined);
      upstream.pipe(client);
      client.pipe(upstream);
      client.resume();
    });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!established) upstream.destroy(new Error(`Timed out connecting to ${host}`));
    });
    upstream.on("error", (error) => {
      if (established) { client.destroy(); return; }
      refuse(client, 502, `Could not reach ${host}: ${error.message}`);
    });
    client.once("close", () => upstream.destroy());
  }

  function refuse(client: Socket, status: number, reason: string): void {
    if (client.destroyed) return;
    const body = `${reason}\n`;
    client.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Forbidden"}\r\n`
      + "Content-Type: text/plain\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + (status === 407 ? 'Proxy-Authenticate: Basic realm="rainver"\r\n' : "")
      + "Connection: close\r\n\r\n"
      + body,
    );
    client.end(() => client.destroy());
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const listening = server.address();
  const port = typeof listening === "object" && listening ? listening.port : 0;
  return {
    url: `http://token:${secret}@127.0.0.1:${port}`,
    refusals,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  407: "Proxy Authentication Required",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
};

function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
