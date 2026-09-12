import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TrustedProxyAddresses } from "../src/gateway/trustedProxy.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { __resetHostRegisterRateLimitForTests, HOST_REGISTER_MAX_ATTEMPTS } from "../src/modules/hosts/pairingRateLimit.js";
import { buildModuleServer } from "./support/moduleServer.js";

describe("trusted proxy addresses", () => {
  it("trusts only what the proxy name resolves to, in either socket form", async () => {
    const proxy = new TrustedProxyAddresses("frontend", async () => ["172.18.0.5"]);
    expect(proxy.trusts("172.18.0.5")).toBe(false);
    await proxy.refresh();
    expect(proxy.trusts("172.18.0.5")).toBe(true);
    expect(proxy.trusts("::ffff:172.18.0.5")).toBe(true);
    expect(proxy.trusts("172.18.0.6")).toBe(false);
  });

  it("trusts nobody once the name stops resolving", async () => {
    let answer: string[] | null = ["172.18.0.5"];
    const proxy = new TrustedProxyAddresses("frontend", async () => {
      if (!answer) throw new Error("ENOTFOUND");
      return answer;
    });
    await proxy.refresh();
    answer = null;
    await proxy.refresh();
    expect(proxy.trusts("172.18.0.5")).toBe(false);
  });
});

// The pairing limiter keys on `request.ip`, so it shows which address the
// app believes. Without a database the register route answers 502 once the
// limiter lets a request through, and 429 when it does not.
describe("client address behind the frontend proxy", () => {
  let app: FastifyInstance | undefined;
  let home: string | undefined;

  afterEach(async () => {
    __resetHostRegisterRateLimitForTests();
    await app?.close();
    app = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function build(env: Record<string, string>): FastifyInstance {
    home = mkdtempSync(join(tmpdir(), "rainver-trusted-proxy-"));
    app = buildModuleServer(loadConfig({ RAINVER_HOME: home, ...env }), [hostsModule]);
    return app;
  }

  async function register(server: FastifyInstance, forwardedFor: string): Promise<number> {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { pairing_code: "bogus" },
    });
    return response.statusCode;
  }

  it("keys on the client the trusted proxy saw, ignoring what the client prepended", async () => {
    // inject() connects from 127.0.0.1, which "localhost" resolves to.
    const server = build({ SERVER_TRUSTED_PROXY_HOST: "localhost" });
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(await register(server, "203.0.113.5")).toBe(502);
    }
    expect(await register(server, "198.51.100.1, 203.0.113.5")).toBe(429);
    expect(await register(server, "203.0.113.6")).toBe(502);
  });

  it("ignores forwarded headers from a direct peer while a proxy is configured", async () => {
    // The proxy name resolves nowhere, so the 127.0.0.1 peer is not it — the
    // production case of a Run reaching the server directly — and a failed
    // resolution trusts nobody.
    const server = build({ SERVER_TRUSTED_PROXY_HOST: "no-such-proxy.invalid" });
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(await register(server, "203.0.113.5")).toBe(502);
    }
    expect(await register(server, "203.0.113.6")).toBe(429);
  });

  it("ignores forwarded headers when no proxy is configured", async () => {
    const server = build({});
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(await register(server, "203.0.113.5")).toBe(502);
    }
    expect(await register(server, "203.0.113.6")).toBe(429);
  });
});
