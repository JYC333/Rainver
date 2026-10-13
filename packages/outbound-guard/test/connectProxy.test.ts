import { connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startGuardedConnectProxy, type GuardedConnectProxy } from "../src/connectProxy.js";
import { createOutboundGuard, type OutboundGuard } from "../src/guard.js";

const open: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

/** An upstream the tunnel is expected to reach; it echoes what it receives with a prefix. */
async function echoUpstream(): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk.toString("utf8"));
      socket.write(`echo:${chunk.toString("utf8")}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return { port: (server.address() as AddressInfo).port, received };
}

/** A guard that answers one name with the loopback upstream and everything else with the real rules. */
function guardPinning(name: string): OutboundGuard {
  const real = createOutboundGuard({ lookup: async () => [{ address: "169.254.169.254", family: 4 }] });
  return {
    pin: (url, signal) => (url.hostname === name
      ? Promise.resolve([{ address: "127.0.0.1", family: 4 as const }])
      : real.pin(url, signal)),
  };
}

async function proxyFor(guard: OutboundGuard): Promise<GuardedConnectProxy> {
  const proxy = await startGuardedConnectProxy(guard);
  open.push(proxy);
  return proxy;
}

/** Speaks CONNECT to the proxy and returns the status line plus whatever the tunnel then carries. */
function tunnel(proxy: GuardedConnectProxy, target: string, options: { authorized?: boolean; send?: string; pipelined?: string } = {}): Promise<{ status: number; body: string }> {
  const url = new URL(proxy.url);
  const credentials = Buffer.from(`${url.username}:${url.password}`).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: url.hostname, port: Number(url.port) });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (options.send && data.endsWith("\r\n\r\n") && data.startsWith("HTTP/1.1 200")) {
        socket.write(options.send);
        options.send = undefined;
        return;
      }
      if (data.includes("echo:") || !data.startsWith("HTTP/1.1 200")) {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
        if (status !== 200 && !data.includes("\r\n\r\n")) return;
        socket.destroy();
        resolve({ status, body: data.slice(data.indexOf("\r\n\r\n") + 4) });
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), body: data.slice(data.indexOf("\r\n\r\n") + 4) }));
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
      + (options.authorized === false ? "" : `Proxy-Authorization: Basic ${credentials}\r\n`)
      + "\r\n"
      + (options.pipelined ?? ""),
    );
  });
}

describe("startGuardedConnectProxy", () => {
  it("dials only the address the guard pinned and carries the tunnel both ways", async () => {
    const upstream = await echoUpstream();
    const proxy = await proxyFor(guardPinning("repo.test"));
    const result = await tunnel(proxy, `repo.test:${upstream.port}`, { send: "hello" });
    expect(result.status).toBe(200);
    expect(result.body).toBe("echo:hello");
    expect(upstream.received).toEqual(["hello"]);
    expect(proxy.refusals).toEqual([]);
  });

  it("replays bytes a client pipelined behind its CONNECT header", async () => {
    const upstream = await echoUpstream();
    const proxy = await proxyFor(guardPinning("repo.test"));
    const result = await tunnel(proxy, `repo.test:${upstream.port}`, { pipelined: "early" });
    expect(result.status).toBe(200);
    expect(result.body).toBe("echo:early");
  });

  it("refuses a name that resolves into the instance network, and records why", async () => {
    const proxy = await proxyFor(guardPinning("repo.test"));
    const result = await tunnel(proxy, "metadata.test:443");
    expect(result.status).toBe(403);
    expect(proxy.refusals).toEqual([{ host: "metadata.test", port: 443, reason: expect.any(String) }]);
  });

  it("refuses a literal private or loopback address", async () => {
    const proxy = await proxyFor(createOutboundGuard({ lookup: async () => [] }));
    expect((await tunnel(proxy, "10.0.0.5:443")).status).toBe(403);
    expect((await tunnel(proxy, "[::1]:443")).status).toBe(403);
    expect((await tunnel(proxy, "127.0.0.1:22")).status).toBe(403);
  });

  it("refuses a client without the proxy's own credential, and anything but CONNECT", async () => {
    const upstream = await echoUpstream();
    const proxy = await proxyFor(guardPinning("repo.test"));
    expect((await tunnel(proxy, `repo.test:${upstream.port}`, { authorized: false })).status).toBe(407);
    const url = new URL(proxy.url);
    const plain = await new Promise<string>((resolve, reject) => {
      const socket = netConnect({ host: url.hostname, port: Number(url.port) });
      let data = "";
      socket.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      socket.write("GET http://repo.test/ HTTP/1.1\r\nHost: repo.test\r\n\r\n");
    });
    expect(plain.startsWith("HTTP/1.1 405")).toBe(true);
    expect(upstream.received).toEqual([]);
  });

  it("judges every CONNECT on its own, so a redirect to another host is a fresh decision", async () => {
    const upstream = await echoUpstream();
    const proxy = await proxyFor(guardPinning("repo.test"));
    expect((await tunnel(proxy, `repo.test:${upstream.port}`, { send: "one" })).status).toBe(200);
    expect((await tunnel(proxy, "internal.test:443")).status).toBe(403);
    expect((await tunnel(proxy, `repo.test:${upstream.port}`, { send: "two" })).status).toBe(200);
    expect(proxy.refusals.map((entry) => entry.host)).toEqual(["internal.test"]);
  });
});
