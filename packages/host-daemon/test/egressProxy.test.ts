import { createServer, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  egressProxyEnv,
  isBlockedAddress,
  policyAllows,
  proxyBypassHosts,
  startEgressProxy,
  type EgressProxyHandle,
} from "../src/egressProxy.js";

/**
 * The host's egress proxy is policy and a record, not containment: pointing a
 * Run at it with `HTTP_PROXY` is advisory, and `none` is still the only
 * profile that confines a Run's network. What is pinned here is the part that
 * holds regardless of whether the client cooperates — the proxy's own refusal
 * — and the policy a cooperating runtime is held to.
 */
describe("what a Run may reach", () => {
  it("refuses a private address however it is spelled", () => {
    // The spellings a caller uses when it does not want to be recognised.
    // A block list that only matches the canonical form is not a block list —
    // `::ffff:7f00:1` reached loopback and was recorded as allowed.
    for (const address of [
      "::ffff:7f00:1",        // 127.0.0.1, hex-mapped
      "0:0:0:0:0:0:0:1",      // ::1, expanded
      "::ffff:a9fe:a9fe",     // the cloud metadata endpoint, hex-mapped
      "::ffff:a00:5",         // 10.0.0.5, hex-mapped
      "::ffff:10.0.0.5",      // the same, dotted
      "255.255.255.255",
      "224.0.0.1",
      "192.0.0.1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("refuses this instance's own network under every profile, install included", () => {
    for (const address of ["10.0.0.5", "172.17.0.2", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    // The cloud metadata endpoint is the one that hands out instance
    // credentials; a Run reaching it is the failure this exists to prevent.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    // An IPv4-mapped address names a v4 address and is judged as one.
    expect(isBlockedAddress("::ffff:10.0.0.5")).toBe(true);
  });

  it("allows the public Internet", () => {
    for (const address of ["1.1.1.1", "140.82.121.4", "2606:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("refuses a package registry under default and allows it under install", () => {
    const refused = policyAllows("default", "registry.npmjs.org");
    expect(refused.allowed).toBe(false);
    // The reason is printed by the runtime to whoever is watching, so it has
    // to say what to do about it.
    expect(refused.reason).toMatch(/install access/i);
    expect(policyAllows("install", "registry.npmjs.org").allowed).toBe(true);
  });

  it("treats a registry's subdomains as the registry", () => {
    expect(policyAllows("default", "cdn.registry.npmjs.org").allowed).toBe(false);
    // Not by substring: a host that merely contains the name is a different
    // host, and matching it would refuse someone's own domain.
    expect(policyAllows("default", "registry.npmjs.org.example.com").allowed).toBe(true);
  });

  it("lets the general web and git through under default", () => {
    for (const host of ["github.com", "api.anthropic.com", "example.com"]) {
      expect(policyAllows("default", host).allowed, host).toBe(true);
    }
  });

  it("allows nothing at all under none", () => {
    expect(policyAllows("none", "github.com").allowed).toBe(false);
  });
});

describe("the proxy as a running server", () => {
  let proxy: EgressProxyHandle;
  let upstream: Server;
  let upstreamPort: number;

  beforeAll(async () => {
    proxy = await startEgressProxy();
    upstream = createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    upstreamPort = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  afterEach(() => {
    proxy.revoke("run-1");
  });

  async function connect(target: string, token: string | null): Promise<string> {
    const { connect: dial } = await import("node:net");
    const [host, port] = proxy.address.split(":");
    return new Promise((resolve, reject) => {
      const socket = dial({ host: host!, port: Number(port) }, () => {
        const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`run:${token}`).toString("base64")}\r\n` : "";
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes("\r\n\r\n")) { socket.destroy(); resolve(received); }
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(received));
    });
  }

  it("refuses a connection carrying no grant", async () => {
    // The token is how one Run's policy is told from another's; without it
    // there is no policy to apply, so there is nothing to allow.
    expect(await connect("example.com:443", null)).toContain("407");
  });

  it("refuses a token that was revoked when its Run finished", async () => {
    const grant = proxy.grant("run-1", "default");
    proxy.revoke("run-1");
    expect(await connect("example.com:443", grant.token)).toContain("407");
  });

  it("refuses the instance's own network even for a Run granted install", async () => {
    const grant = proxy.grant("run-1", "install");
    const response = await connect(`127.0.0.1:${upstreamPort}`, grant.token);
    expect(response).toContain("403");
    expect(response).toMatch(/own network/i);
    expect(proxy.log("run-1")).toEqual([
      expect.objectContaining({ allowed: false, host: "127.0.0.1", reason: expect.stringMatching(/own network/i) }),
    ]);
  });

  it("refuses a registry under default and records the reason for the Run", async () => {
    const grant = proxy.grant("run-1", "default");
    const response = await connect("registry.npmjs.org:443", grant.token);
    expect(response).toContain("403");
    // The record is what answers "why did the install fail" after the Run.
    expect(proxy.log("run-1")).toEqual([
      expect.objectContaining({ allowed: false, host: "registry.npmjs.org", port: 443 }),
    ]);
  });

  it("accepts CONNECT only", async () => {
    const grant = proxy.grant("run-1", "default");
    const { connect: dial } = await import("node:net");
    const [host, port] = proxy.address.split(":");
    const response = await new Promise<string>((resolve) => {
      const socket = dial({ host: host!, port: Number(port) }, () => {
        socket.write(`GET http://example.com/ HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`run:${grant.token}`).toString("base64")}\r\n\r\n`);
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
      socket.on("close", () => resolve(received));
    });
    // A plain proxied GET would put the request — its headers, its tokens —
    // through this process. Nothing here should ever hold those.
    expect(response).toContain("405");
  });

  it("dials an IPv6 literal target rather than failing to parse it", async () => {
    // `[::1]:443` is how a client writes one. With the brackets left on, the
    // host was never recognised as an address at all — so every IPv6 target
    // failed *and* skipped the block list.
    const grant = proxy.grant("run-1", "install");
    const response = await connect("[::1]:443", grant.token);
    expect(response).toContain("403");
    expect(response).toMatch(/own network/i);
  });

  it("reads a CONNECT that arrives in pieces", async () => {
    // A client that writes its request line and headers separately is
    // ordinary; reading one chunk turned that into a 405 or a 407 depending
    // on where the split fell.
    const grant = proxy.grant("run-1", "default");
    const { connect: dial } = await import("node:net");
    const [host, port] = proxy.address.split(":");
    const response = await new Promise<string>((resolve) => {
      const socket = dial({ host: host!, port: Number(port) }, () => {
        socket.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n");
        setTimeout(() => {
          socket.write(`Proxy-Authorization: Basic ${Buffer.from(`run:${grant.token}`).toString("base64")}\r\n\r\n`);
        }, 20);
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
      socket.on("close", () => resolve(received));
    });
    // The grant was read, so the answer is the policy's — not "no credential".
    expect(response).toContain("403");
    expect(response).not.toContain("407");
  });

  it("bypasses the control-plane addresses the Run was handed", () => {
    // These resolve into this instance's own network, which the proxy refuses
    // by design — so proxying them would break every Run on the default path
    // and log a refusal for each attempt.
    const bypass = proxyBypassHosts([
      "http://server:3000/api/v1",
      "http://server:9000/lease/abc",
      "not-a-url",
      // Two of the three CLI adapters receive their lease URL inside a config
      // file rather than the environment, so the file's contents are scanned
      // too — reading only the environment covered one adapter in three.
      'base_url = "http://proxy.internal:9000/lease/xyz"\nmodel = "gpt-5"',
    ]);
    expect(bypass.sort()).toEqual(["proxy.internal", "server"]);
    const env = egressProxyEnv("127.0.0.1:1", "token", bypass);
    expect(env.NO_PROXY).toContain("server");
  });

  it("gives one Run's environment a credential another Run cannot use", () => {
    const first = proxy.grant("run-1", "install");
    const second = proxy.grant("run-2", "default");
    expect(first.token).not.toBe(second.token);
    const env = egressProxyEnv(proxy.address, first.token);
    expect(env.HTTPS_PROXY).toContain(first.token);
    // Loopback is excluded, so a runtime talking to something it started
    // itself does not loop back through the proxy.
    expect(env.NO_PROXY).toContain("127.0.0.1");
    proxy.revoke("run-2");
  });
});
