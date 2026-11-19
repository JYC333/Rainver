import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelChannelTargetAllowed, startModelChannel } from "../src/modelChannel.js";
import { buildStrictNamespaceCommand } from "../src/strictNamespace.js";

const LEASE = "11111111-1111-4111-8111-111111111111";
const channel = { route: "anthropic" as const, lease_id: LEASE };

describe("model channel request targets", () => {
  it("admits only origin-form paths under the Run's own lease", () => {
    expect(modelChannelTargetAllowed(`/anthropic/${LEASE}`, channel)).toBe(true);
    expect(modelChannelTargetAllowed(`/anthropic/${LEASE}/v1/messages?beta=true`, channel)).toBe(true);
    for (const target of [
      undefined, "", "*", "http://evil.example/anthropic/" + LEASE, "//evil.example/x", "evil.example:443",
      `/anthropic/${LEASE}x/v1`, `/openai/${LEASE}/v1`, `/anthropic/${LEASE}/../other/v1`,
      `/anthropic/${LEASE}/%2e%2e/other`, `/anthropic/${LEASE}%2fother`, `/anthropic/${LEASE}/a\\b`,
      `/anthropic/${LEASE}/./v1`, `/anthropic/${LEASE}/%00`,
    ]) expect(modelChannelTargetAllowed(target, channel), String(target)).toBe(false);
  });
});

describe("the model channel relay", () => {
  let dir: string | null = null;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

  it("forwards its lease to the named upstream without proxy credentials, refuses the rest, and closes", async () => {
    dir = await mkdtemp(join(tmpdir(), "rv-mc-unit-"));
    const seen: Array<{ url?: string; host?: string; proxy?: string }> = [];
    const upstream = createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, proxy: req.headers["proxy-authorization"] });
      res.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    const relay = await startModelChannel(dir, { version: 1, upstream_base_url: `http://127.0.0.1:${port}/base`, route: "anthropic", lease_id: LEASE, loopback_port: 18790 });
    const call = (path: string, method = "POST") => new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, path, method, headers: { "proxy-authorization": "Basic eDp5" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      req.end();
    });
    try {
      expect(await call(`/anthropic/${LEASE}/v1/messages`)).toBe(200);
      expect(await call(`/anthropic/other/v1/messages`)).toBe(403);
      for (const method of ["GET", "HEAD", "DELETE", "PUT"]) expect(await call(`/anthropic/${LEASE}/v1/files`, method)).toBe(405);
      expect(seen).toEqual([{ url: `/base/anthropic/${LEASE}/v1/messages`, host: `127.0.0.1:${port}`, proxy: undefined }]);
      expect(relay.stats()).toEqual({ forwarded: 1, refused: 5 });
      await relay.close();
      await expect(call(`/anthropic/${LEASE}/v1/messages`)).rejects.toThrow();
    } finally {
      await relay.close();
      upstream.close();
    }
  });

  it("refuses an upstream carrying credentials or a query", async () => {
    dir = await mkdtemp(join(tmpdir(), "rv-mc-unit-"));
    for (const upstream_base_url of ["http://user:pw@proxy:1", "http://proxy:1/?x=1", "file:///etc/passwd"]) {
      await expect(startModelChannel(dir, { version: 1, upstream_base_url, route: "anthropic", lease_id: LEASE, loopback_port: 18790 })).rejects.toThrow();
    }
  });
});

describe("the namespace with a model channel", () => {
  const base = { command: "/usr/bin/true", args: [], cwd: "/work", home: "/run/home", binds: [{ path: "/run", access: "read_write" as const }], env: {} };
  const modelChannel = { node: "/usr/bin/node", directory: "/run/.model-channel", socketPath: "/run/.model-channel/model.sock", port: 18790 };

  it("exists only with egress none", () => {
    for (const egress_profile of ["default", "install"] as const) {
      expect(() => buildStrictNamespaceCommand({ ...base, isolation: { sandbox_mode: "read_write", egress_profile }, modelChannel })).toThrow(/egress none/);
    }
  });

  it("unshares the network, binds the socket directory read-only over the writable run directory and starts the forwarder first", () => {
    const { args } = buildStrictNamespaceCommand({ ...base, isolation: { sandbox_mode: "read_write", egress_profile: "none" }, modelChannel });
    expect(args).toContain("--unshare-net");
    const rw = args.findIndex((value, index) => value === "--bind" && args[index + 1] === "/run");
    const ro = args.findIndex((value, index) => value === "--ro-bind" && args[index + 1] === "/run/.model-channel");
    expect(rw).toBeGreaterThan(-1);
    expect(ro).toBeGreaterThan(rw);
    const script = args[args.indexOf("-c") + 1]!;
    expect(script.indexOf("-e")).toBeLessThan(script.indexOf("ready"));
    expect(script).toContain("</dev/null >/dev/null 3>&-");
    expect(args.slice(args.indexOf("strict-launch") + 1, args.indexOf("strict-launch") + 5)[0]).toBe("/usr/bin/node");
    expect(args.slice(-1)[0]).toBe("/usr/bin/true");
  });
});
